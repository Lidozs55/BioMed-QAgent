/**
 * Server-side fixed build skeleton executor (ARCHITECTURE §3.4/§5; Design
 * §12.2; Python ``app/datasets/runtime/executor.py``).
 *
 * The skeleton is fixed in code (``buildOperationPlan``); the Agent cannot
 * declare steps.  Each operation records an append-only ``OperationAttempt``
 * with digest-matched idempotent reuse, checkpointed output, cooperative
 * cancellation and typed outcomes.  The TS port is the deterministic
 * orchestrator: the Python executor's asyncio worker-thread machinery,
 * operation timeouts, build locks, straggler markers and event sinks are
 * runtime infrastructure that lands with the TS Host integration — the
 * rerun/resume and no-fake-success semantics below mirror the Python
 * executor exactly.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { BindingRejection, SourceAsset } from "../contracts/index.js";
import { AdapterError, BindingRejectedError, BuildError, EmptySourceError } from "../adapters/errors.js";
import { OperationAbortedError } from "../cooperative.js";
import {
  appendAttempt,
  findReusable,
  loadBuildState,
  loadOperationOutput,
  markCompleted,
  saveBuildState,
  saveOperationOutput,
  validateAttemptLogPrefix,
} from "./checkpoint.js";
import { computeInputDigest, computeParameterDigest, sha256Json, type DigestScope } from "./digests.js";
import {
  makeErrorDetail,
  type OperationAttempt,
  type OperationKind,
  type OperationOutput,
  type OperationSpec,
  type RuntimeErrorDetail,
} from "./operations.js";

export type BuildRunStatus = "completed" | "failed" | "cancelled";

export interface BuildRunOutcome {
  status: BuildRunStatus;
  error: RuntimeErrorDetail | null;
  completedOperationIds: string[];
}

/** One operation handler (Python ``OperationRunner``); may be async (M2). */
export type OperationRunner = (
  op: OperationSpec,
  upstream: Record<string, Record<string, unknown>>,
  signal?: AbortSignal,
) => OperationOutput | Promise<OperationOutput>;

/** Typed per-operation wall-clock timeout (M2, I-03). */
export class OperationTimeoutError extends Error {
  constructor(
    readonly operationId: string,
    readonly timeoutMs: number,
  ) {
    super(`operation ${operationId} timed out after ${timeoutMs}ms`);
    this.name = "OperationTimeoutError";
  }
}

/** Core operation lifecycle events (M2, I-05) — the service layer maps these
 * onto stable EventPayloads before they reach the durable event log. */
export type CoreOperationEvent =
  | { type: "build_started" }
  | { type: "operation_started"; operationId: string; label: string | null; category: string; attempt: number }
  | { type: "operation_completed"; operationId: string; label: string | null; category: string; status: "succeeded" | "skipped"; outputDigest: string | null; reusedOperationAttemptId: string | null }
  | { type: "operation_failed"; operationId: string; label: string | null; category: string; status: "failed" | "cancelled"; error: { code: string; message: string } | null }
  | { type: "build_completed" }
  | { type: "build_failed"; error: { code: string; message: string } | null }
  | { type: "build_cancelled" };

export type CoreEventSink = (event: CoreOperationEvent) => void | Promise<void>;

/** Raised when cooperative cancellation stops the skeleton. */
export class BuildCancelledError extends Error {}

/**
 * Phase A rejected every source binding (Phase 5 T7 D5).  ``reasonCode``
 * collapses to the single distinct rejection reason when every binding
 * failed for the same reason, otherwise ``all_bindings_rejected``.
 */
export class AllBindingsRejectedError extends BuildError {
  readonly perBindingOutcomes: Record<string, BindingRejection>;
  readonly reasonCode: string;

  constructor(perBindingOutcomes: Readonly<Record<string, BindingRejection>>) {
    const outcomes = { ...perBindingOutcomes };
    const reasons = new Set(
      Object.values(outcomes).map((rejection) => rejection.reason_code),
    );
    const reasonCode =
      reasons.size === 1 ? [...reasons][0] : "all_bindings_rejected";
    const detail = Object.entries(outcomes)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([bindingId, rejection]) => `${bindingId}=${rejection.reason_code}`)
      .join("; ");
    super(`all source bindings rejected: ${detail}`);
    this.name = "AllBindingsRejectedError";
    this.perBindingOutcomes = outcomes;
    this.reasonCode = reasonCode;
  }
}

/** Phase-A operation kinds: a failure is a per-binding rejection (never
 * aborting the other bindings); phase-B is the fan-in over successes. */
export const PHASE_A_KINDS: ReadonlySet<OperationKind> = new Set([
  "acquire",
  "parse",
  "canonicalize",
]);

export interface ExecutorOptions {
  taskId: string;
  buildId: string;
  stateDir: string;
  taskRoot: string;
  plan: readonly OperationSpec[];
  runOperation: OperationRunner;
  cancellationRequested?: (() => boolean) | null;
  cancellationSignal?: AbortSignal | null;
  parameterScope?: Readonly<Record<string, unknown>> | null;
  implementationVersions?: Readonly<Record<string, string>> | null;
  sourceAssets?: Readonly<Record<string, SourceAsset>> | null;
  mappingAssets?: Readonly<Record<string, SourceAsset>> | null;
  resumeFrom?: string | null;
  perBindingOutcomes?: Record<string, BindingRejection> | null;
  /** Best-effort workspace hygiene for a cancelled operation (K1). */
  discardOutputs?: ((op: OperationSpec) => void) | null;
  /** Per-operation wall-clock timeout in ms (M2 I-03; 0 = unlimited). */
  operationTimeoutMs?: number;
  /** Core operation lifecycle sink (M2 I-05). */
  eventSink?: CoreEventSink | null;
}

/** Executes one fixed skeleton with idempotent recovery and cancel support. */
export class DatasetBuildExecutor {
  private readonly taskId: string;
  private readonly buildId: string;
  private readonly stateDir: string;
  private readonly taskRoot: string;
  private readonly plan: readonly OperationSpec[];
  private readonly runOperation: OperationRunner;
  private readonly cancellationRequested: (() => boolean) | null;
  private readonly cancellationSignal: AbortSignal | null;
  private readonly parameterScope: Readonly<Record<string, unknown>>;
  private readonly implementationVersions: Readonly<Record<string, string>>;
  private readonly sourceAssets: Readonly<Record<string, SourceAsset>>;
  private readonly mappingAssets: Readonly<Record<string, SourceAsset>>;
  private readonly resumeFrom: string | null;
  private readonly discardOutputs: ((op: OperationSpec) => void) | null;
  private readonly perBindingOutcomes: Record<string, BindingRejection>;
  private readonly operationTimeoutMs: number;
  private readonly eventSink: CoreEventSink | null;

  private state: ReturnType<typeof loadBuildState> | null = null;
  private outputs: Record<string, Record<string, unknown>> = {};
  private persistedAttemptCount = 0;
  private lastReusedAttemptId: string | null = null;

  constructor(options: ExecutorOptions) {
    this.taskId = options.taskId;
    this.buildId = options.buildId;
    this.stateDir = options.stateDir;
    this.taskRoot = options.taskRoot;
    this.plan = options.plan;
    this.runOperation = options.runOperation;
    this.cancellationRequested = options.cancellationRequested ?? null;
    this.cancellationSignal = options.cancellationSignal ?? null;
    this.parameterScope = options.parameterScope ?? {};
    this.implementationVersions = options.implementationVersions ?? {};
    this.sourceAssets = options.sourceAssets ?? {};
    this.mappingAssets = options.mappingAssets ?? {};
    this.resumeFrom = options.resumeFrom ?? null;
    this.discardOutputs = options.discardOutputs ?? null;
    this.perBindingOutcomes = options.perBindingOutcomes ?? {};
    this.operationTimeoutMs = options.operationTimeoutMs ?? 0;
    this.eventSink = options.eventSink ?? null;
    if (
      this.resumeFrom !== null &&
      !this.plan.some((op) => op.operation_id === this.resumeFrom)
    ) {
      throw new Error(
        `resume_from must name a plan operation, got '${this.resumeFrom}'`,
      );
    }
  }

  /** Execute the skeleton, guaranteeing a terminal outcome. */
  async run(): Promise<BuildRunOutcome> {
    await this.emit({ type: "build_started" });
    try {
      this.state = loadBuildState(this.stateDir, this.taskId, this.buildId);
      this.persistedAttemptCount = validateAttemptLogPrefix(
        this.state,
        this.attemptsPath(),
      );
      this.recoverInflightAttempt();
    } catch (error) {
      return this.outcomeFailed(
        "internal_error",
        `build state could not be loaded or recovered: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      const outcome = await this.runPlan();
      await this.emit({ type: "build_completed" });
      return outcome;
    } catch (error) {
      if (error instanceof BuildCancelledError) {
        await this.emit({ type: "build_cancelled" });
        return this.finalizeCancelled();
      }
      await this.emit({
        type: "build_failed",
        error: error instanceof Error
          ? { code: error instanceof OperationTimeoutError ? "timeout" : "internal_error", message: error.message }
          : { code: "internal_error", message: String(error) },
      });
      return this.finalizeFailed(error, error instanceof OperationTimeoutError ? "timeout" : "internal_error");
    }
  }

  private async emit(event: CoreOperationEvent): Promise<void> {
    if (this.eventSink === null) return;
    await this.eventSink(event);
  }

  private attemptsPath(): string {
    return join(this.stateDir, "operation_attempts.jsonl");
  }

  private isCancelled(): boolean {
    return this.cancellationRequested !== null && this.cancellationRequested();
  }

  private recoverInflightAttempt(): void {
    const state = this.state;
    if (state === null) return;
    const inflight = state.inflight_attempt;
    if (inflight === null) return;
    const cancelled = this.buildAttempt(
      inflight.operation_id,
      inflight.input_digest,
      inflight.parameter_digest,
      "cancelled",
      inflight.attempt,
      inflight.operation_attempt_id,
      inflight.started_at,
      this.nowIso(),
    );
    appendAttempt(state, cancelled);
    state.inflight_attempt = null;
    saveBuildState(this.stateDir, state);
    this.persistAttempts();
  }

  private async runPlan(): Promise<BuildRunOutcome> {
    const state = this.state;
    if (state === null) {
      throw new Error("build state not loaded");
    }
    let phaseADone = false;
    for (const op of this.plan) {
      if (this.isCancelled()) {
        throw new BuildCancelledError("build was cancelled before an operation");
      }
      if (PHASE_A_KINDS.has(op.kind)) {
        if (op.category in this.perBindingOutcomes) {
          continue; // binding already rejected: skip its remaining phase-A ops
        }
        try {
          await this.runOperationOnce(op, op.operation_id === this.resumeFrom);
        } catch (error) {
          if (
            error instanceof BindingRejectedError ||
            error instanceof EmptySourceError ||
            error instanceof AdapterError ||
            error instanceof BuildError
          ) {
            const rejection = this.rejectionForException(op.category, error);
            this.perBindingOutcomes[op.category] = rejection;
            this.finalizeBindingRejected(error, rejection);
          } else {
            throw error;
          }
        }
        continue;
      }
      if (!phaseADone) {
        phaseADone = true;
        if (this.allBindingsRejected()) {
          throw new AllBindingsRejectedError(this.perBindingOutcomes);
        }
      }
      await this.runOperationOnce(op, op.operation_id === this.resumeFrom);
    }
    return {
      status: "completed",
      error: null,
      completedOperationIds: Object.keys(state.completed_operations),
    };
  }

  private phaseABindingIds(): Set<string> {
    const ids = new Set<string>();
    for (const op of this.plan) {
      if (PHASE_A_KINDS.has(op.kind) && op.category.length > 0) {
        ids.add(op.category);
      }
    }
    return ids;
  }

  private allBindingsRejected(): boolean {
    const rejected = new Set(Object.keys(this.perBindingOutcomes));
    for (const bindingId of this.phaseABindingIds()) {
      if (!rejected.has(bindingId)) return false;
    }
    return true;
  }

  private rejectionForException(
    bindingId: string,
    exc: Error,
  ): BindingRejection {
    if (exc instanceof BindingRejectedError) {
      return exc.rejection;
    }
    if (exc instanceof EmptySourceError) {
      return {
        schema_version: "1.0",
        binding_id: bindingId,
        kind: "no_primary",
        reason_code: exc.reason_code,
        message: exc.message,
      };
    }
    if (exc instanceof AdapterError) {
      return {
        schema_version: "1.0",
        binding_id: bindingId,
        kind: "error",
        reason_code: "parse_error",
        message: exc.message,
      };
    }
    return {
      schema_version: "1.0",
      binding_id: bindingId,
      kind: "error",
      reason_code: "build_error",
      message: exc.message,
    };
  }

  private finalizeBindingRejected(exc: Error, rejection: BindingRejection): void {
    const state = this.state;
    if (state === null || state.inflight_attempt === null) return;
    const error = makeErrorDetail({
      code: "parse_error",
      message: exc.message,
      retryable: false,
      details: {
        reason_code: rejection.reason_code,
        failed_operation: state.inflight_attempt.operation_id,
      },
    });
    const inflight = state.inflight_attempt;
    const failed = this.buildAttempt(
      inflight.operation_id,
      inflight.input_digest,
      inflight.parameter_digest,
      "failed",
      inflight.attempt,
      inflight.operation_attempt_id,
      inflight.started_at,
      this.nowIso(),
      error,
    );
    appendAttempt(state, failed);
    state.inflight_attempt = null;
    saveBuildState(this.stateDir, state);
    this.persistAttempts();
  }

  /** Run (or reuse) one operation with digest matching and checkpointing. */
  private async runOperationOnce(op: OperationSpec, force: boolean): Promise<void> {
    const scope = this.digestScope(op);
    const inputDigest = computeInputDigest(op, scope);
    const parameterDigest = computeParameterDigest(op, scope);

    if (!force && this.tryReuseOperation(op, inputDigest, parameterDigest)) {
      await this.emit({
        type: "operation_completed",
        operationId: op.operation_id,
        label: op.label ?? null,
        category: op.category,
        status: "skipped",
        outputDigest: null,
        reusedOperationAttemptId: this.lastReusedAttemptId,
      });
      return;
    }

    const state = this.state;
    if (state === null) throw new Error("build state not loaded");
    const started = this.nowIso();
    const running = this.buildAttempt(
      op.operation_id,
      inputDigest,
      parameterDigest,
      "running",
      this.nextAttemptNumber(op.operation_id),
      undefined,
      started,
    );
    state.inflight_attempt = running;
    saveBuildState(this.stateDir, state);
    await this.emit({
      type: "operation_started",
      operationId: op.operation_id,
      label: op.label ?? null,
      category: op.category,
      attempt: running.attempt,
    });

    let result: OperationOutput;
    try {
      const upstream = this.availableUpstream(op);
      result = await this.executeOperation(op, upstream);
    } catch (error) {
      await this.emit({
        type: "operation_failed",
        operationId: op.operation_id,
        label: op.label ?? null,
        category: op.category,
        status: error instanceof BuildCancelledError ? "cancelled" : "failed",
        error: error instanceof Error
          ? { code: error instanceof OperationTimeoutError ? "timeout" : "failed", message: error.message }
          : { code: "failed", message: String(error) },
      });
      if (error instanceof BuildCancelledError) {
        const cancelled = this.buildAttempt(
          op.operation_id,
          inputDigest,
          parameterDigest,
          "cancelled",
          running.attempt,
          running.operation_attempt_id,
          started,
          this.nowIso(),
        );
        appendAttempt(state, cancelled);
        state.inflight_attempt = null;
        saveBuildState(this.stateDir, state);
        this.persistAttempts();
      }
      throw error;
    }

    const outputDigest = sha256Json(result.output);
    const finished = this.nowIso();
    saveOperationOutput(this.stateDir, {
      task_id: this.taskId,
      build_id: this.buildId,
      operation_id: op.operation_id,
      operation_attempt_id: running.operation_attempt_id,
      output_digest: outputDigest,
      output_sha256: sha256Json(result.output),
      output: result.output,
      files: [...result.files],
    });
    const succeeded = this.buildAttempt(
      op.operation_id,
      inputDigest,
      parameterDigest,
      "succeeded",
      running.attempt,
      running.operation_attempt_id,
      started,
      finished,
      undefined,
      outputDigest,
    );
    appendAttempt(state, succeeded);
    state.inflight_attempt = null;
    markCompleted(state, op.operation_id, outputDigest);
    saveBuildState(this.stateDir, state);
    this.persistAttempts();

    this.outputs[op.operation_id] = result.output;
    await this.emit({
      type: "operation_completed",
      operationId: op.operation_id,
      label: op.label ?? null,
      category: op.category,
      status: "succeeded",
      outputDigest,
      reusedOperationAttemptId: null,
    });
  }

  /** Reuse a digest-matched SUCCEEDED attempt when its checkpoint verifies. */
  private tryReuseOperation(
    op: OperationSpec,
    inputDigest: string,
    parameterDigest: string,
  ): boolean {
    const state = this.state;
    if (state === null) throw new Error("build state not loaded");
    const reusable = findReusable(state, op.operation_id, inputDigest, parameterDigest);
    if (reusable === null || reusable.output_digest === null) return false;
    const completed = state.completed_operations[op.operation_id];
    if (completed !== reusable.output_digest) return false;
    const loaded = loadOperationOutput(this.stateDir, {
      taskRoot: this.taskRoot,
      taskId: this.taskId,
      buildId: this.buildId,
      operationId: op.operation_id,
      operationAttemptId: reusable.operation_attempt_id,
      outputDigest: reusable.output_digest,
    });
    if (loaded === null) return false;

    this.lastReusedAttemptId = reusable.operation_attempt_id;
    this.outputs[op.operation_id] = loaded;
    const skipped = this.buildAttempt(
      op.operation_id,
      inputDigest,
      parameterDigest,
      "skipped",
      this.nextAttemptNumber(op.operation_id),
      undefined,
      undefined,
      undefined,
      undefined,
      reusable.output_digest,
      reusable.operation_attempt_id,
    );
    appendAttempt(state, skipped);
    saveBuildState(this.stateDir, state);
    this.persistAttempts();
    return true;
  }

  /**
   * Bounded grace for a straggler operation after a timeout/cancel (M2): the
   * aborted operation may still be unwinding (e.g. a ``copyFile`` already in
   * flight cannot be interrupted), so we hold the build lock — we are still
   * inside ``executeOperation`` — until the straggler settles or this grace
   * expires.  This prevents a timed-out build from releasing the lock while
   * the old operation could still promote a publication behind its failed
   * record ("no fake-success publication" invariant).
   */
  static readonly STRAGGLER_SETTLE_GRACE_MS = 10_000;

  /** Run one operation under cooperative cancel checks + wall-clock timeout. */
  private async executeOperation(
    op: OperationSpec,
    upstream: Record<string, Record<string, unknown>>,
  ): Promise<OperationOutput> {
    if (this.isCancelled()) {
      throw new BuildCancelledError(`operation ${op.operation_id} was cancelled`);
    }
    const operationController = new AbortController();
    const onCancellation = (): void => operationController.abort();
    this.cancellationSignal?.addEventListener("abort", onCancellation, { once: true });
    let result: OperationOutput;
    try {
      try {
        if (this.operationTimeoutMs > 0) {
          let timeout: NodeJS.Timeout | undefined;
          let pending: Promise<OperationOutput> | null = null;
          try {
            pending = Promise.resolve(
              this.runOperation(op, upstream, operationController.signal),
            );
            result = await Promise.race([
              pending,
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(
                  () => {
                    operationController.abort();
                    reject(new OperationTimeoutError(op.operation_id, this.operationTimeoutMs));
                  },
                  this.operationTimeoutMs,
                );
              }),
            ]);
          } finally {
            if (timeout !== undefined) clearTimeout(timeout);
            if (operationController.signal.aborted && pending !== null) {
              // Straggler safety: wait for the aborted operation to actually
              // settle (bounded) so the build lock stays held until it stops.
              await Promise.race([
                pending.then(() => undefined, () => undefined),
                new Promise<void>((resolve) => {
                  setTimeout(resolve, DatasetBuildExecutor.STRAGGLER_SETTLE_GRACE_MS);
                }),
              ]);
            }
          }
        } else {
          result = await this.runOperation(op, upstream, operationController.signal);
        }
      } catch (error) {
        // The real Core runner checks the signal cooperatively; map its
        // abort marker onto the executor's cancel semantics so a cancelled
        // build finalizes as ``cancelled`` (not ``failed``).
        if (error instanceof OperationAbortedError) {
          throw new BuildCancelledError(
            `operation ${op.operation_id} was cancelled or timed out`,
          );
        }
        throw error;
      }
    } finally {
      this.cancellationSignal?.removeEventListener("abort", onCancellation);
    }
    if (this.isCancelled()) {
      // K1: the operation's files are finished but must be discarded — the
      // completed-too-late outputs never become part of the build state.
      this.discardOutputs?.(op);
      throw new BuildCancelledError(
        `operation ${op.operation_id} completed after cancel request`,
      );
    }
    return result;
  }

  private digestScope(op: OperationSpec): DigestScope {
    return {
      buildId: this.buildId,
      upstream: this.availableUpstream(op),
      parameterScope: this.parameterScope,
      sourceAssets: this.sourceAssets,
      mappingAssets: this.mappingAssets,
      implementationVersions: this.implementationVersions,
    };
  }

  private availableUpstream(
    op: OperationSpec,
  ): Record<string, Record<string, unknown>> {
    const upstream: Record<string, Record<string, unknown>> = {};
    for (const upstreamId of op.upstream) {
      if (upstreamId in this.outputs) {
        upstream[upstreamId] = this.outputs[upstreamId];
      }
    }
    return upstream;
  }

  private buildAttempt(
    operationId: string,
    inputDigest: string,
    parameterDigest: string,
    status: OperationAttempt["status"],
    attempt: number,
    operationAttemptId?: string,
    started?: string | null,
    finished?: string | null,
    error?: RuntimeErrorDetail | null,
    outputDigest?: string | null,
    reusedOperationAttemptId?: string | null,
  ): OperationAttempt {
    return {
      operation_attempt_id:
        operationAttemptId ?? `operation_attempt_${randomUUID()}`,
      task_id: this.taskId,
      build_id: this.buildId,
      operation_id: operationId,
      attempt,
      input_digest: inputDigest,
      parameter_digest: parameterDigest,
      output_digest: outputDigest ?? null,
      status,
      implementation_version: this.implementationVersions[operationId] ?? null,
      started_at: started ?? null,
      finished_at: finished ?? null,
      error: error ?? null,
      reused_operation_attempt_id: reusedOperationAttemptId ?? null,
    };
  }

  private nextAttemptNumber(operationId: string): number {
    const state = this.state;
    if (state === null) throw new Error("build state not loaded");
    let max = 0;
    for (const attempt of state.operation_attempts) {
      if (attempt.operation_id === operationId && attempt.attempt > max) {
        max = attempt.attempt;
      }
    }
    if (
      state.inflight_attempt !== null &&
      state.inflight_attempt.operation_id === operationId &&
      state.inflight_attempt.attempt > max
    ) {
      max = state.inflight_attempt.attempt;
    }
    return max + 1;
  }

  private finalizeCancelled(): BuildRunOutcome {
    const state = this.state;
    if (state === null) return { status: "cancelled", error: null, completedOperationIds: [] };
    const inflight = state.inflight_attempt;
    if (inflight !== null) {
      const cancelled = this.buildAttempt(
        inflight.operation_id,
        inflight.input_digest,
        inflight.parameter_digest,
        "cancelled",
        inflight.attempt,
        inflight.operation_attempt_id,
        inflight.started_at,
        this.nowIso(),
      );
      appendAttempt(state, cancelled);
      state.inflight_attempt = null;
      saveBuildState(this.stateDir, state);
      this.persistAttempts();
    }
    return {
      status: "cancelled",
      error: null,
      completedOperationIds: Object.keys(state.completed_operations),
    };
  }

  private finalizeFailed(exc: unknown, errorCode: string): BuildRunOutcome {
    const details: Record<string, unknown> = {};
    const reasonCode = (exc as { reason_code?: string }).reason_code;
    if (reasonCode !== undefined && reasonCode !== null) {
      details["reason_code"] = String(reasonCode);
    }
    const state = this.state;
    if (state !== null && state.inflight_attempt !== null) {
      details["failed_operation"] = state.inflight_attempt.operation_id;
    }
    const perBinding = (exc as { perBindingOutcomes?: Record<string, BindingRejection> })
      .perBindingOutcomes;
    if (perBinding && Object.keys(perBinding).length > 0) {
      details["per_binding_outcomes"] = Object.fromEntries(
        Object.entries(perBinding)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([bindingId, rejection]) => [bindingId, rejection]),
      );
    }
    const message = exc instanceof Error ? exc.message : String(exc);
    const error = makeErrorDetail({
      code: errorCode,
      message,
      retryable: errorCode === "timeout" || errorCode === "network_error",
      details,
    });
    if (state === null) {
      return { status: "failed", error, completedOperationIds: [] };
    }
    const inflight = state.inflight_attempt;
    if (inflight !== null) {
      const failed = this.buildAttempt(
        inflight.operation_id,
        inflight.input_digest,
        inflight.parameter_digest,
        "failed",
        inflight.attempt,
        inflight.operation_attempt_id,
        inflight.started_at,
        this.nowIso(),
        error,
      );
      appendAttempt(state, failed);
      state.inflight_attempt = null;
      saveBuildState(this.stateDir, state);
      this.persistAttempts();
    }
    return {
      status: "failed",
      error,
      completedOperationIds: Object.keys(state.completed_operations),
    };
  }

  private outcomeFailed(code: string, message: string): BuildRunOutcome {
    return {
      status: "failed",
      error: makeErrorDetail({ code, message, retryable: false }),
      completedOperationIds: [],
    };
  }

  private persistAttempts(): void {
    const state = this.state;
    if (state === null) return;
    const lines: string[] = [];
    for (
      let index = this.persistedAttemptCount;
      index < state.operation_attempts.length;
      index += 1
    ) {
      lines.push(JSON.stringify(state.operation_attempts[index]));
    }
    if (lines.length === 0) return;
    mkdirSync(this.stateDir, { recursive: true });

    appendFileSync(this.attemptsPath(), `${lines.join("\n")}\n`, "utf8");
    this.persistedAttemptCount = state.operation_attempts.length;
  }

  private nowIso(): string {
    return new Date().toISOString();
  }
}

export type { OperationOutput, OperationSpec };
