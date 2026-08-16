import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseHILRequest,
  parseHumanReviewRecord,
  parseResumeHILInput,
  type HILDecision,
  type HILKind,
  type HILRequest,
  type HILReviewItem,
  type HILReviewType,
  type HILSubject,
  type HumanReviewRecord,
  type JsonValue,
  type ResumeHILInput,
  type EventEnvelope,
} from "@biomed/contracts";

import type { DurableTaskRepository } from "./task-repository.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface CreateHILRequestInput {
  task_id: string;
  run_id: string;
  build_id: string | null;
  kind: HILKind;
  review_type: HILReviewType | null;
  blocking: boolean;
  subject: HILSubject;
  review_items: HILReviewItem[];
  summary: string;
  evidence: JsonValue;
  policy_ref: string;
  idempotency_key: string;
}

export interface CreateHILRequestOptions {
  /**
   * When the deterministic request id already exists in a terminal state
   * (cancelled/expired) without a review — e.g. a previous attempt was
   * aborted and the same operation replays — write a new generation request
   * (``hil_<digest>_g<N>``) instead of silently returning the terminal one.
   * A replay must never await a request the store would refuse to resolve.
   */
  recreateIfTerminal?: boolean;
}

export interface DurableHILStoreOptions {
  now?: () => Date;
}

export interface HILRecovery {
  task_id: string;
  run_id: string;
  request: HILRequest;
  review: HumanReviewRecord | null;
}

export class HILConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HILConflictError";
  }
}

function requireSafeId(value: string, name: string): void {
  if (!SAFE_ID.test(value)) throw new TypeError(`${name} must be a safe identifier`);
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function digest(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function generationOf(requestId: string): number {
  const match = /_g(\d+)$/.exec(requestId);
  return match === null ? 1 : Number(match[1]);
}

function decisionJson(decision: HILDecision, reason: string | null): JsonValue {
  return { decision: decision as JsonValue, reason };
}

export class DurableHILStore {
  private readonly repository: DurableTaskRepository;
  private readonly now: () => Date;
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(repository: DurableTaskRepository, options: DurableHILStoreOptions = {}) {
    this.repository = repository;
    this.now = options.now ?? (() => new Date());
  }

  async createRequest(
    input: CreateHILRequestInput,
    options: CreateHILRequestOptions = {},
  ): Promise<HILRequest> {
    requireSafeId(input.task_id, "task_id");
    requireSafeId(input.run_id, "run_id");
    if (input.idempotency_key.trim() === "") {
      throw new TypeError("idempotency_key must not be empty");
    }
    const evidenceSnapshot: Record<string, JsonValue> = {
      kind: input.kind,
      review_type: input.review_type,
      subject: { ...input.subject },
      review_items: input.review_items.map((item) => ({
        ...item,
        subject: { ...item.subject },
        evidence: { ...item.evidence },
      })),
      summary: input.summary,
      evidence: input.evidence,
      policy_ref: input.policy_ref,
    };
    const evidenceDigest = digest(evidenceSnapshot);
    const baseRequestId = `hil_${digest({
      task_id: input.task_id,
      run_id: input.run_id,
      policy_ref: input.policy_ref,
      idempotency_key: input.idempotency_key,
      evidence_digest: evidenceDigest,
    }).slice(0, 32)}`;
    return this.serialized(`${input.task_id}:${input.run_id}`, async () => {
      const existing = await this.readRequest(input.task_id, baseRequestId);
      if (existing !== null) {
        const review = await this.readReview(input.task_id, existing.request_id);
        if (review !== null || existing.status === "pending") {
          return this.withEffectiveStatus(input.task_id, existing);
        }
        // Terminal (cancelled/expired) without a review: a replay must not
        // silently await a request the store would refuse to resolve.
        if (!options.recreateIfTerminal) return existing;
        const requestId = `${baseRequestId}_g${generationOf(existing.request_id) + 1}`;
        return this.writeNewRequest(input, requestId, evidenceDigest);
      }
      return this.writeNewRequest(input, baseRequestId, evidenceDigest);
    });
  }

  private async writeNewRequest(
    input: CreateHILRequestInput,
    requestId: string,
    evidenceDigest: string,
  ): Promise<HILRequest> {
    const snapshot = await this.repository.getSnapshot(input.task_id);
    if (
      snapshot === null ||
      !snapshot.runs.some((run) => run.run_id === input.run_id)
    ) {
      throw new ReferenceError("Run not found");
    }
    if (input.blocking) {
      const pending = await this.findPendingForRunUnlocked(input.task_id, input.run_id);
      if (pending !== null) {
        throw new HILConflictError("another blocking HIL request is already pending for this run");
      }
    }
    const request = parseHILRequest({
      schema_version: "1.0",
      request_id: requestId,
      task_id: input.task_id,
      run_id: input.run_id,
      build_id: input.build_id,
      kind: input.kind,
      review_type: input.review_type,
      status: "pending",
      blocking: input.blocking,
      subject: input.subject,
      review_items: input.review_items,
      summary: input.summary,
      evidence_digest: evidenceDigest,
      policy_ref: input.policy_ref,
      created_at: this.now().toISOString(),
      resolved_at: null,
    });
    await this.writeJson(this.requestPath(input.task_id, requestId), request);
    return request;
  }

  async getRequest(taskId: string, requestId: string): Promise<HILRequest | null> {
    requireSafeId(taskId, "task_id");
    requireSafeId(requestId, "request_id");
    const request = await this.readRequest(taskId, requestId);
    return request === null ? null : this.withEffectiveStatus(taskId, request);
  }

  async findPendingForRun(taskId: string, runId: string): Promise<HILRequest | null> {
    requireSafeId(taskId, "task_id");
    requireSafeId(runId, "run_id");
    return this.findPendingForRunUnlocked(taskId, runId);
  }

  async getReviewForRequest(
    taskId: string,
    requestId: string,
  ): Promise<HumanReviewRecord | null> {
    requireSafeId(taskId, "task_id");
    requireSafeId(requestId, "request_id");
    return this.readReview(taskId, requestId);
  }

  async reconcileTaskTimeline(): Promise<HILRecovery[]> {
    await mkdir(this.repository.tasksRoot, { recursive: true });
    const entries = await readdir(this.repository.tasksRoot, { withFileTypes: true });
    const recoveries: HILRecovery[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      const snapshot = await this.repository.getSnapshot(entry.name);
      if (snapshot === null) continue;
      const runId = snapshot.task.active_run_id;
      if (runId === null) continue;
      const activeRun = snapshot.runs.find((run) => run.run_id === runId);
      if (activeRun?.status !== "running" && activeRun?.status !== "awaiting_user_input") {
        continue;
      }
      const requests = (await this.listRequestsForRun(entry.name, runId)).filter(
        (request) => request.blocking,
      );
      if (requests.length === 0) continue;
      const events: EventEnvelope[] = [];
      let afterSequence = 0;
      for (;;) {
        const page = await this.repository.listEvents(entry.name, afterSequence);
        events.push(...page);
        if (page.length < 1_000) break;
        afterSequence = page.at(-1)?.sequence ?? afterSequence;
      }
      const pending = requests.find((request) => request.status === "pending");
      const request = pending ?? requests.at(-1);
      if (request === undefined) continue;
      if (request.status !== "pending" && request.status !== "resolved") continue;
      const hasRequired = events.some(
        (event) => event.run_id === runId
          && event.payload.type === "user_input_required"
          && event.payload.request_id === request.request_id,
      );
      if (!hasRequired) {
        await this.repository.appendRunEvent(entry.name, runId, {
          type: "user_input_required",
          request_id: request.request_id,
          prompt_kind: request.kind === "permission" ? "api_key_or_credential" : "data_correction",
          summary: request.summary,
          expires_at: null,
          fixture_exempt: false,
          detail: {
            review_type: request.review_type,
            evidence_digest: request.evidence_digest,
            policy_ref: request.policy_ref,
          },
          hil_request: request,
        });
      }
      const review = await this.readReview(entry.name, request.request_id);
      if (review !== null) {
        const hasResumed = events.some(
          (event) => event.run_id === runId
            && event.payload.type === "user_input_resumed"
            && event.payload.request_id === request.request_id,
        );
        // A resolved formal request cannot itself leave the reducer awaiting.
        // In that state a newer legacy prompt owns the pause and must not be
        // bypassed by reconstructing the older continuation.
        if (activeRun.status === "awaiting_user_input" && hasResumed) continue;
        if (!hasResumed) {
          await this.repository.appendRunEvent(entry.name, runId, {
            type: "user_input_resumed",
            request_id: request.request_id,
            decision: review.decision,
            detail: {
              evidence_digest: review.evidence_digest,
              review_id: review.review_id,
              reason: review.reason,
            },
          });
        }
      }
      recoveries.push({ task_id: entry.name, run_id: runId, request, review });
    }
    return recoveries;
  }

  async resolveRequest(
    taskId: string,
    runId: string,
    rawInput: ResumeHILInput,
  ): Promise<HumanReviewRecord> {
    requireSafeId(taskId, "task_id");
    requireSafeId(runId, "run_id");
    const input = parseResumeHILInput(rawInput);
    return this.serialized(`${taskId}:${runId}`, async () => {
      const request = await this.readRequest(taskId, input.request_id);
      if (request === null || request.run_id !== runId || request.task_id !== taskId) {
        throw new ReferenceError("HIL request not found");
      }
      if (request.evidence_digest !== input.evidence_digest) {
        throw new HILConflictError("HIL evidence digest does not match the reviewed snapshot");
      }
      this.validateDecision(request.kind, input.decision);
      const existingReview = await this.readReview(taskId, request.request_id);
      if (existingReview !== null) {
        if (
          canonicalJson(decisionJson(existingReview.decision, existingReview.reason)) ===
          canonicalJson(decisionJson(input.decision, input.reason))
        ) {
          return existingReview;
        }
        throw new HILConflictError("HIL request was already resolved with a different decision");
      }
      if (request.status !== "pending") {
        throw new HILConflictError(`HIL request is ${request.status}`);
      }
      const reviewedAt = this.now().toISOString();
      const review = parseHumanReviewRecord({
        schema_version: "1.0",
        review_id: `review_${digest({
          request_id: request.request_id,
          evidence_digest: request.evidence_digest,
          resolution: decisionJson(input.decision, input.reason),
        }).slice(0, 32)}`,
        request_id: request.request_id,
        decision: input.decision,
        reviewer: "user",
        reviewed_at: reviewedAt,
        evidence_digest: request.evidence_digest,
        reason: input.reason,
      });
      // The immutable review is the commit point. If the process exits before
      // the request projection is updated, withEffectiveStatus still observes
      // the request as resolved on the next read.
      await this.writeJson(this.reviewPath(taskId, request.request_id), review);
      await this.writeJson(this.requestPath(taskId, request.request_id), {
        ...request,
        status: "resolved",
        resolved_at: reviewedAt,
      });
      return review;
    });
  }

  async cancelPendingForRun(taskId: string, runId: string): Promise<HILRequest | null> {
    return this.serialized(`${taskId}:${runId}`, async () => {
      const request = await this.findPendingForRunUnlocked(taskId, runId);
      if (request === null) return null;
      const cancelled = {
        ...request,
        status: "cancelled" as const,
        resolved_at: this.now().toISOString(),
      };
      await this.writeJson(this.requestPath(taskId, request.request_id), cancelled);
      return cancelled;
    });
  }

  async cancelRequest(
    taskId: string,
    runId: string,
    requestId: string,
  ): Promise<HILRequest | null> {
    return this.serialized(`${taskId}:${runId}`, async () => {
      const request = await this.readRequest(taskId, requestId);
      if (request === null || request.run_id !== runId || request.status !== "pending") {
        return null;
      }
      const cancelled = {
        ...request,
        status: "cancelled" as const,
        resolved_at: this.now().toISOString(),
      };
      await this.writeJson(this.requestPath(taskId, requestId), cancelled);
      return cancelled;
    });
  }

  private validateDecision(kind: HILKind, decision: HILDecision): void {
    if (kind === "permission") {
      if (decision.action !== "approve" && decision.action !== "reject") {
        throw new TypeError("permission HIL decisions must be approve or reject");
      }
      return;
    }
    if (decision.action === "approve") {
      throw new TypeError("review HIL decisions must be accept, correct, reject, or skip");
    }
  }

  private async findPendingForRunUnlocked(
    taskId: string,
    runId: string,
  ): Promise<HILRequest | null> {
    const directory = this.requestsDirectory(taskId);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const request = await this.readRequest(taskId, name.slice(0, -5));
      if (request === null || request.run_id !== runId || !request.blocking) continue;
      const effective = await this.withEffectiveStatus(taskId, request);
      if (effective.status === "pending") return effective;
    }
    return null;
  }

  private async listRequestsForRun(taskId: string, runId: string): Promise<HILRequest[]> {
    let names: string[];
    try {
      names = await readdir(this.requestsDirectory(taskId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const requests: HILRequest[] = [];
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue;
      const request = await this.readRequest(taskId, name.slice(0, -5));
      if (request !== null && request.run_id === runId) {
        requests.push(await this.withEffectiveStatus(taskId, request));
      }
    }
    return requests.sort((left, right) => left.created_at.localeCompare(right.created_at));
  }

  private async withEffectiveStatus(taskId: string, request: HILRequest): Promise<HILRequest> {
    if (request.status !== "pending") return request;
    const review = await this.readReview(taskId, request.request_id);
    if (review === null) return request;
    return { ...request, status: "resolved", resolved_at: review.reviewed_at };
  }

  private async readRequest(taskId: string, requestId: string): Promise<HILRequest | null> {
    const value = await this.readJson(this.requestPath(taskId, requestId));
    return value === null ? null : parseHILRequest(value);
  }

  private async readReview(taskId: string, requestId: string): Promise<HumanReviewRecord | null> {
    const value = await this.readJson(this.reviewPath(taskId, requestId));
    return value === null ? null : parseHumanReviewRecord(value);
  }

  private async readJson(target: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(target, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeJson(target: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  private requestsDirectory(taskId: string): string {
    return path.join(this.repository.tasksRoot, taskId, "state", "hil", "requests");
  }

  private requestPath(taskId: string, requestId: string): string {
    requireSafeId(requestId, "request_id");
    return path.join(this.requestsDirectory(taskId), `${requestId}.json`);
  }

  private reviewPath(taskId: string, requestId: string): string {
    requireSafeId(requestId, "request_id");
    return path.join(
      this.repository.tasksRoot,
      taskId,
      "state",
      "hil",
      "reviews",
      `${requestId}.json`,
    );
  }

  private async serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.pending.get(key) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    this.pending.set(key, current);
    const cleanup = (): void => {
      if (this.pending.get(key) === current) this.pending.delete(key);
    };
    void current.then(cleanup, cleanup);
    return current;
  }
}

export { canonicalJson as canonicalHILEvidenceJson, digest as digestHILEvidence };
