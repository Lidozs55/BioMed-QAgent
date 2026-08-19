import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";

import type {
  BuildResult,
  CancelDatasetBuildRequest,
  CancelDatasetBuildResponse,
  DurableBuildApiError,
  DurableBuildEventRef,
  DurableBuildRecord,
  EventPayload,
  StartDatasetBuildRequest,
  StartDatasetBuildResponse,
} from "@biomed/contracts";
import {
  canTransitionDurableBuildStatus,
  isDurableBuildTerminalStatus,
  matchesDurableBuildStart,
  parseDurableBuildRecord,
} from "@biomed/contracts";

import { canonicalJson } from "../dataset/adapters/identity.js";
import { writeJsonAtomic, readJsonFileOrNull } from "../persistence/atomic-json.js";
import { requireSafeId } from "./safe-id.js";
import { DurableTaskRepository } from "./task-repository.js";

export class DurableBuildStoreError extends Error {
  constructor(readonly api: DurableBuildApiError, readonly httpStatus = 409) {
    super(api.message);
    this.name = "DurableBuildStoreError";
  }
}

export interface DurableBuildStoreOptions {
  repository?: DurableTaskRepository;
  id?: () => string;
  now?: () => Date;
  leaseMs?: number;
}

function digestRequest(request: StartDatasetBuildRequest): string {
  const content = {
    schema_version: request.schema_version,
    task_id: request.task_id,
    run_id: request.run_id,
    spec: request.spec,
  };
  return createHash("sha256").update(canonicalJson(content), "utf8").digest("hex");
}

function apiError(code: DurableBuildApiError["code"], message: string, record?: DurableBuildRecord): DurableBuildStoreError {
  return new DurableBuildStoreError({
    schema_version: "1.0", code, message, retryable: false,
    task_id: record?.task_id ?? null, run_id: record?.run_id ?? null,
    build_id: record?.build_id ?? null, current_status: record?.status ?? null, details: {},
  });
}

export class DurableBuildStore {
  private readonly repository: DurableTaskRepository;
  private readonly id: () => string;
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly locks = new Map<string, Promise<void>>();
  private startLock: Promise<void> = Promise.resolve();
  private readonly root: string;

  constructor(tasksRoot: string, options: DurableBuildStoreOptions = {}) {
    this.root = path.join(path.resolve(tasksRoot), "_durable_builds");
    this.repository = options.repository ?? new DurableTaskRepository(tasksRoot);
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 30_000;
  }

  async start(request: StartDatasetBuildRequest): Promise<StartDatasetBuildResponse> {
    const previous = this.startLock;
    let release!: () => void;
    this.startLock = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const digest = digestRequest(request);
      const existing = await this.findByIdempotency(request.idempotency_key);
      if (existing !== null) {
        if (!matchesDurableBuildStart(existing, request, digest)) {
          throw apiError("idempotency_key_reused", "Idempotency key was reused with different request content", existing);
        }
        return { schema_version: "1.0", idempotent_replay: true, build: existing };
      }
      const buildRecord = await this.get(request.spec.build_id);
      if (buildRecord !== null) {
        throw apiError("build_identity_mismatch", "Build ID is already owned by another start request", buildRecord);
      }
      const timestamp = this.now().toISOString();
      const queued = await this.append(request.task_id, request.run_id, request.spec.build_id, {
        type: "build_queued", idempotency_key: request.idempotency_key, request_digest: digest,
      });
      const record: DurableBuildRecord = {
        schema_version: "1.0", task_id: request.task_id, run_id: request.run_id,
        build_id: request.spec.build_id, idempotency_key: request.idempotency_key,
        request_digest: digest, spec: request.spec, status: "queued", attempt: 0,
        lease: null, cancellation: null, terminal_result: null, failure: null,
        created_at: timestamp, updated_at: timestamp, started_at: null, finished_at: null,
        event_refs: { schema_version: "1.0", queued, latest: queued, terminal: null },
      };
      await this.save(record);
      return { schema_version: "1.0", idempotent_replay: false, build: record };
    } finally {
      release();
    }
  }

  async get(buildId: string): Promise<DurableBuildRecord | null> {
    requireSafeId(buildId, "build_id");
    const value = await readJsonFileOrNull<unknown>(this.file(buildId));
    return value === null ? null : parseDurableBuildRecord(value);
  }

  async claim(buildId: string, ownerId = `scheduler_${this.id()}`): Promise<DurableBuildRecord> {
    return this.update(buildId, async (record) => {
      if (!canTransitionDurableBuildStatus(record.status, "running")) throw apiError("invalid_build_transition", "Build cannot start", record);
      const timestamp = this.now();
      const lease = { schema_version: "1.0" as const, lease_id: `lease_${this.id()}`, owner_id: ownerId,
        attempt: record.attempt + 1, acquired_at: timestamp.toISOString(),
        expires_at: new Date(timestamp.getTime() + this.leaseMs).toISOString() };
      const event = await this.append(record.task_id, record.run_id, record.build_id,
        { type: "build_started", attempt: lease.attempt, lease_id: lease.lease_id });
      return { ...record, status: "running" as const, attempt: lease.attempt, lease,
        started_at: record.started_at ?? timestamp.toISOString(), updated_at: timestamp.toISOString(),
        event_refs: { ...record.event_refs, latest: event } };
    });
  }

  async recoverExpiredLeases(): Promise<DurableBuildRecord[]> {
    const records = await this.all();
    const recovered: DurableBuildRecord[] = [];
    for (const record of records) {
      if (record.status !== "running" || record.lease === null || Date.parse(record.lease.expires_at) > this.now().getTime()) continue;
      recovered.push(await this.update(record.build_id, async (current) => {
        if (current.lease === null || Date.parse(current.lease.expires_at) > this.now().getTime()) return current;
        const timestamp = this.now();
        const lease = { schema_version: "1.0" as const, lease_id: `lease_${this.id()}`, owner_id: `recovery_${this.id()}`,
          attempt: current.attempt + 1, acquired_at: timestamp.toISOString(),
          expires_at: new Date(timestamp.getTime() + this.leaseMs).toISOString() };
        const event = await this.append(current.task_id, current.run_id, current.build_id,
          { type: "build_recovered", attempt: lease.attempt, previous_lease_id: current.lease.lease_id, lease_id: lease.lease_id });
        return { ...current, attempt: lease.attempt, lease, updated_at: timestamp.toISOString(), event_refs: { ...current.event_refs, latest: event } };
      }));
    }
    return recovered;
  }

  async cancel(request: CancelDatasetBuildRequest, buildId: string): Promise<CancelDatasetBuildResponse> {
    const record = await this.get(buildId);
    if (record === null) throw apiError("build_not_found", "Build not found");
    if (record.task_id !== request.task_id || record.run_id !== request.run_id) throw apiError("build_identity_mismatch", "Build identity does not match request", record);
    if (isDurableBuildTerminalStatus(record.status)) return this.cancelResponse(request, record, "already_terminal");
    if (record.status === "cancel_requested") return this.cancelResponse(request, record, "already_requested");
    return this.update(buildId, async (current) => {
      if (isDurableBuildTerminalStatus(current.status)) return this.cancelResponse(request, current, "already_terminal");
      if (!canTransitionDurableBuildStatus(current.status, "cancel_requested")) throw apiError("build_not_cancellable", "Build is not cancellable", current);
      const timestamp = this.now().toISOString();
      const event = await this.append(current.task_id, current.run_id, current.build_id,
        { type: "build_cancel_requested", request_id: request.request_id, reason: request.reason });
      const cancellation = { schema_version: "1.0" as const, request_id: request.request_id, reason: request.reason, requested_at: timestamp, event_ref: event };
      const next = { ...current, status: "cancel_requested" as const, cancellation, updated_at: timestamp, event_refs: { ...current.event_refs, latest: event } };
      await this.save(next);
      return this.cancelResponse(request, next, "accepted");
    }) as unknown as Promise<CancelDatasetBuildResponse>;
  }

  async complete(buildId: string, result: BuildResult): Promise<DurableBuildRecord> {
    return this.update(buildId, async (record) => {
      if (!canTransitionDurableBuildStatus(record.status, result.status)) throw apiError("invalid_build_transition", "Build cannot complete", record);
      const event = await this.append(record.task_id, record.run_id, record.build_id, { type: "build_completed", result });
      const timestamp = this.now().toISOString();
      return { ...record, status: result.status, lease: null, terminal_result: result, finished_at: timestamp, updated_at: timestamp, event_refs: { ...record.event_refs, latest: event, terminal: event } };
    });
  }

  async cancelTerminal(buildId: string): Promise<DurableBuildRecord> {
    return this.update(buildId, async (record) => {
      if (record.status !== "cancel_requested") throw apiError("invalid_build_transition", "Build is not awaiting cancellation", record);
      const event = await this.append(record.task_id, record.run_id, record.build_id, { type: "build_cancelled", request_id: record.cancellation!.request_id, reason: record.cancellation!.reason });
      const timestamp = this.now().toISOString();
      return { ...record, status: "cancelled", lease: null, finished_at: timestamp, updated_at: timestamp, event_refs: { ...record.event_refs, latest: event, terminal: event } };
    });
  }

  private async update<T>(buildId: string, operation: (record: DurableBuildRecord) => Promise<T>): Promise<T> {
    const previous = this.locks.get(buildId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = previous.then(() => gate);
    this.locks.set(buildId, pending);
    await previous;
    try {
      const record = await this.get(buildId);
      if (record === null) throw apiError("build_not_found", "Build not found");
      const result = await operation(record);
      if (result !== record && !("disposition" in (result as object))) await this.save(result as DurableBuildRecord);
      return result;
    } finally {
      release();
      if (this.locks.get(buildId) === pending) this.locks.delete(buildId);
    }
  }

  private async append(taskId: string, runId: string, buildId: string, payload: EventPayload): Promise<DurableBuildEventRef> {
    const event = await this.repository.appendBuildEvent(taskId, runId, buildId, payload);
    return { schema_version: "1.0", event_id: event.event_id, type: payload.type as DurableBuildEventRef["type"], task_id: taskId, run_id: runId, build_id: buildId, sequence: event.sequence, timestamp: event.timestamp };
  }
  private async save(record: DurableBuildRecord): Promise<void> { await writeJsonAtomic(this.file(record.build_id), record); }
  private file(buildId: string): string {
    requireSafeId(buildId, "build_id");
    return path.join(this.root, `${buildId}.json`);
  }
  private async all(): Promise<DurableBuildRecord[]> {
    let entries: string[];
    try { entries = await readdir(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const records: DurableBuildRecord[] = [];
    for (const entry of entries.filter((name) => name.endsWith(".json"))) { const value = await this.get(entry.slice(0, -5)); if (value !== null) records.push(value); }
    return records;
  }
  private async findByIdempotency(key: string): Promise<DurableBuildRecord | null> { return (await this.all()).find((record) => record.idempotency_key === key) ?? null; }
  private cancelResponse(request: CancelDatasetBuildRequest, record: DurableBuildRecord, disposition: CancelDatasetBuildResponse["disposition"]): CancelDatasetBuildResponse {
    return { schema_version: "1.0", request_id: request.request_id, task_id: record.task_id, run_id: record.run_id, build_id: record.build_id, disposition, status: record.status, terminal: isDurableBuildTerminalStatus(record.status), cancel_requested_event: record.cancellation?.event_ref ?? null, terminal_event: record.event_refs.terminal };
  }
}
