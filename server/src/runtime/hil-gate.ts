import type {
  HILDecision,
  HILRequest,
  HumanReviewRecord,
} from "@biomed/contracts";

import { OperationAbortedError } from "../dataset/cooperative.js";
import type { ToolApprovalGate } from "../agent/tools/tool-hooks.js";
import {
  DurableHILStore,
  userInputRequiredPayload,
  type CreateHILRequestInput,
} from "./hil-store.js";
import type { HILGatePreReview } from "./hil-pre-review.js";
import type { DurableTaskRepository } from "./task-repository.js";

export type BoundHILRequestInput = Omit<
  CreateHILRequestInput,
  "task_id" | "run_id"
>;

export interface HILGateHandle extends ToolApprovalGate {
  setRunId(runId: string): void;
  requestHIL(
    input: BoundHILRequestInput,
    signal?: AbortSignal,
  ): Promise<HumanReviewRecord>;
  resolvePending(runId: string, review: HumanReviewRecord): boolean;
  rejectPending(runId: string, error: Error): void;
  hasPending(runId: string): boolean;
  getPendingRequest(runId: string): Promise<HILRequest | null>;
  recordAdvisoryHIL(input: BoundHILRequestInput): Promise<HILRequest>;
}

interface PendingReview {
  requestId: string;
  resolve: (review: HumanReviewRecord) => void;
  reject: (error: Error) => void;
}

/**
 * In-flight credential decisions keyed by ``<run_id>:<operation>``. Parallel
 * governed tool calls in one run share one credential approval: the first
 * caller creates the durable request, later callers await the SAME pending
 * decision instead of conflict-failing with "another HIL request is already
 * pending".
 */
type CredentialDecision = Promise<"approve" | "reject">;

export class DurableHILGate implements HILGateHandle {
  private readonly taskId: string;
  private readonly repository: DurableTaskRepository;
  private readonly store: DurableHILStore;
  private readonly preReview: HILGatePreReview | null;
  private runId: string | null;
  private permissionInvocation = 0;
  private readonly pending = new Map<string, PendingReview>();
  private readonly credentialRequests = new Map<string, CredentialDecision>();

  constructor(
    taskId: string,
    repository: DurableTaskRepository,
    runId?: string,
    store = new DurableHILStore(repository),
    preReview: HILGatePreReview | null = null,
  ) {
    this.taskId = taskId;
    this.repository = repository;
    this.store = store;
    this.preReview = preReview;
    this.runId = runId ?? null;
  }

  setRunId(runId: string): void {
    this.runId = runId;
    this.permissionInvocation = 0;
  }

  hasPending(runId: string): boolean {
    return this.pending.has(runId);
  }

  getPendingRequest(runId: string): Promise<HILRequest | null> {
    return this.store.findPendingForRun(this.taskId, runId);
  }

  async request(
    operation: string,
    signal?: AbortSignal,
    invocationId?: string,
  ): Promise<"approve" | "reject"> {
    const runId = this.runId;
    if (runId === null) throw new Error("HIL gate is not bound to a run");
    // Coalesce concurrent credential approvals per run + operation scope:
    // parallel governed tool calls await ONE durable decision.
    const key = `${runId}:${operation}`;
    const existing = this.credentialRequests.get(key);
    if (existing !== undefined) return existing;
    const decision = this.requestCredential(operation, signal, invocationId);
    this.credentialRequests.set(key, decision);
    void decision
      .catch(() => undefined)
      .finally(() => {
        if (this.credentialRequests.get(key) === decision) {
          this.credentialRequests.delete(key);
        }
      });
    return decision;
  }

  private async requestCredential(
    operation: string,
    signal?: AbortSignal,
    invocationId?: string,
  ): Promise<"approve" | "reject"> {
    this.permissionInvocation += 1;
    const review = await this.requestHIL({
      requirement_id: null,
      kind: "permission",
      review_type: null,
      blocking: true,
      subject: {},
      review_items: [],
      summary: `Approve credential use for ${operation}`,
      evidence: { operation },
      policy_ref: "runtime.credential.v1",
      idempotency_key:
        invocationId === undefined
          ? `credential:${operation}:${this.permissionInvocation}`
          : `credential:${operation}:${invocationId}`,
    }, signal);
    if (review.decision.action !== "approve" && review.decision.action !== "reject") {
      throw new Error("permission review resolved with an invalid decision");
    }
    return review.decision.action;
  }

  async requestHIL(
    input: BoundHILRequestInput,
    signal?: AbortSignal,
  ): Promise<HumanReviewRecord> {
    if (!input.blocking) {
      throw new TypeError("non-blocking reviews must use recordAdvisoryHIL");
    }
    const runId = this.runId;
    if (runId === null) throw new Error("HIL gate is not bound to a run");
    if (this.pending.has(runId)) {
      throw new Error("another HIL request is already pending for this run");
    }
    const request = await this.store.createRequest({
      ...input,
      task_id: this.taskId,
      run_id: runId,
    }, { recreateIfTerminal: true });
    const existing = await this.store.getReviewForRequest(this.taskId, request.request_id);
    if (existing !== null) return existing;
    // Never silently await a terminal request: with recreateIfTerminal the
    // store produced a fresh generation for cancelled/expired requests, so
    // anything left here is a store invariant violation.
    if (request.status !== "pending") {
      await this.store.cancelPendingForRun(this.taskId, runId);
      throw new Error(
        `HIL request ${request.request_id} is ${request.status} and cannot be awaited`,
      );
    }
    if (signal?.aborted === true) {
      await this.store.cancelPendingForRun(this.taskId, runId);
      throw new OperationAbortedError("operation aborted before human review could be awaited");
    }

    const preResolved = await this.tryPreReviewResolve(runId, request);
    if (preResolved !== null) return preResolved;

    const decision = new Promise<HumanReviewRecord>((resolve, reject) => {
      const cleanup = (): void => signal?.removeEventListener("abort", abort);
      const abort = (): void => {
        if (this.pending.get(runId)?.requestId !== request.request_id) return;
        this.pending.delete(runId);
        void this.store.cancelRequest(this.taskId, runId, request.request_id);
        cleanup();
        reject(new OperationAbortedError("operation aborted while awaiting human review"));
      };
      const pending: PendingReview = {
        requestId: request.request_id,
        resolve: (review) => {
          if (this.pending.get(runId)?.requestId === request.request_id) {
            this.pending.delete(runId);
          }
          cleanup();
          resolve(review);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
      this.pending.set(runId, pending);
      if (signal !== undefined) {
        if (signal.aborted) {
          // The signal aborted between the pre-check above and waiter
          // registration; an already-aborted signal never fires its abort
          // listener, so cancel the waiter directly (otherwise the executor
          // would hang forever — its suspension timer only covers compute).
          abort();
        } else {
          signal.addEventListener("abort", abort, { once: true });
        }
      }
    });
    void decision.catch(() => undefined);

    const alreadyEmitted = (await this.repository.listEvents(this.taskId, 0)).some(
      (event) =>
        event.type === "user_input_required" &&
        event.run_id === runId &&
        event.payload.type === "user_input_required" &&
        event.payload.request_id === request.request_id,
    );
    if (!alreadyEmitted) {
      try {
        await this.repository.appendRunEvent(
          this.taskId,
          runId,
          userInputRequiredPayload(request, request.kind === "permission" &&
            input.evidence !== null &&
            typeof input.evidence === "object" &&
            !Array.isArray(input.evidence)
            ? input.evidence
            : {}),
        );
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("failed to persist HIL event");
        this.rejectPending(runId, failure);
        await this.store.cancelPendingForRun(this.taskId, runId);
        throw failure;
      }
    }
    const resolvedDuringEmission = await this.store.getReviewForRequest(
      this.taskId,
      request.request_id,
    );
    if (resolvedDuringEmission !== null) {
      this.resolvePending(runId, resolvedDuringEmission);
    }
    return decision;
  }

  /**
   * Approval-policy short-circuit (three-tier HIL approval settings):
   * ``auto_approve`` resolves immediately with the kind's affirmative
   * decision (reviewer ``auto``); ``llm_pre_review`` consults the model —
   * whose prompt directs it to fail bypass-shaped requests — and resolves on
   * a pass (reviewer ``model``). A model ``fail`` verdict or any reviewer
   * error escalates to the classic human flow (fail-safe; never a silent
   * pass). Resolved requests never emit ``user_input_required``, so the run
   * is not paused.
   */
  private async tryPreReviewResolve(
    runId: string,
    request: HILRequest,
  ): Promise<HumanReviewRecord | null> {
    if (this.preReview === null) return null;
    const mode = await this.preReview.modeFor(request.kind, request.review_type);
    if (mode === "human_review") return null;
    if (mode === "auto_approve") {
      return this.resolveWithoutHuman(runId, request, {
        decision: request.kind === "permission" ? { action: "approve" } : { action: "accept" },
        reason: "auto-approved by HIL approval policy (auto_approve)",
        reviewer: "auto",
        warningCode: "HIL_PRE_APPROVED",
        message: `HIL request ${request.request_id} auto-approved by approval policy (auto_approve)`,
      });
    }
    let verdict: "pass" | "fail";
    let verdictReason: string;
    try {
      const review = await this.preReview.modelReview(request);
      verdict = review.verdict;
      verdictReason = review.reason;
    } catch (error) {
      verdict = "fail";
      verdictReason = `model pre-review unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    if (verdict !== "pass") return null;
    return this.resolveWithoutHuman(runId, request, {
      decision: request.kind === "permission" ? { action: "approve" } : { action: "accept" },
      reason: `approved by model pre-review: ${verdictReason}`,
      reviewer: "model",
      warningCode: "HIL_PRE_APPROVED",
      message: `HIL request ${request.request_id} approved by model pre-review: ${verdictReason}`,
    });
  }

  private async resolveWithoutHuman(
    runId: string,
    request: HILRequest,
    resolution: {
      decision: HILDecision;
      reason: string;
      reviewer: "auto" | "model";
      warningCode: string;
      message: string;
    },
  ): Promise<HumanReviewRecord> {
    const review = await this.store.resolveRequest(this.taskId, runId, {
      request_id: request.request_id,
      evidence_digest: request.evidence_digest,
      decision: resolution.decision,
      reason: resolution.reason,
    }, { reviewer: resolution.reviewer });
    await this.repository.appendRunEvent(this.taskId, runId, {
      type: "warning",
      code: `${resolution.warningCode}:${request.request_id}`,
      message: resolution.message,
    });
    return review;
  }

  async recordAdvisoryHIL(input: BoundHILRequestInput): Promise<HILRequest> {
    if (input.blocking) {
      throw new TypeError("blocking reviews must use requestHIL");
    }
    const runId = this.runId;
    if (runId === null) throw new Error("HIL gate is not bound to a run");
    const request = await this.store.createRequest({
      ...input,
      task_id: this.taskId,
      run_id: runId,
    });
    const alreadyEmitted = (await this.repository.listEvents(this.taskId, 0)).some(
      (event) => event.run_id === runId
        && event.payload.type === "warning"
        && event.payload.code === `HIL_ADVISORY:${request.request_id}`,
    );
    if (!alreadyEmitted) {
      await this.repository.appendRunEvent(this.taskId, runId, {
        type: "warning",
        code: `HIL_ADVISORY:${request.request_id}`,
        message: request.summary,
      });
    }
    return request;
  }

  resolvePending(runId: string, review: HumanReviewRecord): boolean {
    const pending = this.pending.get(runId);
    if (pending === undefined || pending.requestId !== review.request_id) return false;
    this.pending.delete(runId);
    pending.resolve(review);
    return true;
  }

  rejectPending(runId: string, error: Error): void {
    const pending = this.pending.get(runId);
    if (pending === undefined) return;
    this.pending.delete(runId);
    pending.reject(error);
  }
}
