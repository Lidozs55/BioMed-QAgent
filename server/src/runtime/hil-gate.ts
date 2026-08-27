import type {
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

export class DurableHILGate implements HILGateHandle {
  private readonly taskId: string;
  private readonly repository: DurableTaskRepository;
  private readonly store: DurableHILStore;
  private runId: string | null;
  private permissionInvocation = 0;
  private readonly pending = new Map<string, PendingReview>();

  constructor(
    taskId: string,
    repository: DurableTaskRepository,
    runId?: string,
    store = new DurableHILStore(repository),
  ) {
    this.taskId = taskId;
    this.repository = repository;
    this.store = store;
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
