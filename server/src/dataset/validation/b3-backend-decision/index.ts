/**
 * B3 backend decision gate (C-T4/T11 production boundary).
 *
 * Pure Core decision boundary that selects the validator backend for one
 * Core-owned build generation: in-memory Maps, the injected disk tuple
 * index, or a typed reject. It never falls back to the legacy Map-backed
 * scan: when disk is requested but any capability is missing, the answer
 * is reject, never a silent downgrade to memory.
 *
 * The gate is wired into the production multitable validator
 * (`validateMultiTableCandidate`), which feeds it the measured resource
 * decision and the injected disk capabilities. The gate stays pure: it
 * performs no I/O, never invokes the factory, persists nothing, emits no
 * telemetry, and returns only a plain typed decision value. The injected
 * factory creates the real SQLite-backed `TupleIndex` instances after the
 * gate admits disk mode.
 */
import type { TupleIndex } from "../disk-index.js";
import type { ResourceBaselineDecision } from "../resource-baseline.js";

/** Core-owned identity of one build generation the gate decides for. */
export interface B3CoreIdentity {
  readonly taskId: string;
  readonly buildId: string;
  readonly generation: number;
}

/** Owner capability binding a disk index to the Core-owned identity. */
export interface B3DiskOwner {
  readonly taskId: string;
  readonly buildId: string;
  readonly generation: number;
}

/**
 * The real disk tuple index created by the injected factory. Alias of the
 * SQLite-backed `TupleIndex`; the gate never invokes `createIndex` and only
 * checks presence and identity.
 */
export type B3DiskTupleIndex = TupleIndex;

export interface B3DiskIndexCreationOptions {
  readonly owner: B3DiskOwner;
  readonly directory?: string;
  readonly quotaBytes?: number;
  readonly signal?: AbortSignal | null;
  readonly batchSize?: number;
}

/**
 * Injected disk tuple index factory. Null on the input means disk mode is
 * unavailable; the gate only checks presence and identity, never calls it.
 */
export interface B3DiskTupleIndexFactory {
  readonly factoryId: string;
  createIndex(options: B3DiskIndexCreationOptions): Promise<B3DiskTupleIndex>;
}

/** Memory/disk parity proof: digest plus an artifact reference. */
export interface B3ParityProof {
  /** sha256 hex digest of the parity evidence. */
  readonly digest: string;
  /** Reference to the parity evidence artifact. */
  readonly ref: string;
}

/** Cleanup capability the production disk-mode wiring owns for its owner. */
export interface B3CleanupCapability {
  readonly ownerId: string;
  cleanup(owner: B3DiskOwner): void | Promise<void>;
}

export interface B3BackendDecisionInput {
  /** Core-owned identity (task_id/build_id/generation). */
  readonly taskId: string;
  readonly buildId: string;
  readonly generation: number;
  /** Measured resource decision produced by `decideValidatorResources`. */
  readonly measured: ResourceBaselineDecision;
  /** Injected disk tuple index factory, or null when disk is unavailable. */
  readonly factory: B3DiskTupleIndexFactory | null;
  /** True only when the validator inputs were snapshotted immutably. */
  readonly snapshotImmutable: boolean;
  /** Memory/disk parity proof, or null when no parity evidence exists. */
  readonly parityProof: B3ParityProof | null;
  /** Cancel capability; null or already-aborted fails closed for disk. */
  readonly signal: AbortSignal | null;
  /** Cleanup capability for the disk index owner. */
  readonly cleanup: B3CleanupCapability | null;
  /** Owner capability binding the disk index to this Core identity. */
  readonly owner: B3DiskOwner | null;
}

export type B3BackendRejectReason =
  | "invalid_input"
  | "invalid_decision"
  | "measured_rejected"
  | "threshold_exceeded"
  | "disk_unavailable"
  | "snapshot_mutable"
  | "parity_proof_missing"
  | "owner_mismatch"
  | "late_generation"
  | "cancel_unavailable"
  | "cleanup_unavailable"
  | "temp_quota_exceeded";

export interface B3MemoryDecision {
  readonly outcome: "memory";
  readonly taskId: string;
  readonly buildId: string;
  readonly generation: number;
  readonly estimatedHeapBytes: number;
  readonly effectiveMemoryThresholdBytes: number;
}

export interface B3DiskDecision {
  readonly outcome: "disk";
  readonly taskId: string;
  readonly buildId: string;
  readonly generation: number;
  readonly factoryId: string;
  readonly parityProofRef: string;
  readonly estimatedTempBytes: number;
  readonly effectiveTempQuotaBytes: number;
}

export interface B3RejectDecision {
  readonly outcome: "reject";
  readonly reason: B3BackendRejectReason;
  readonly detail: string;
}

export type B3BackendDecision = B3MemoryDecision | B3DiskDecision | B3RejectDecision;

const SHA256_HEX = /^[0-9a-f]{64}$/;

function reject(reason: B3BackendRejectReason, detail: string): B3RejectDecision {
  return { outcome: "reject", reason, detail };
}

function validIdentity(input: B3BackendDecisionInput): boolean {
  return input.taskId.trim().length > 0 &&
    input.buildId.trim().length > 0 &&
    Number.isSafeInteger(input.generation) &&
    input.generation >= 0;
}

function validParityProof(proof: B3ParityProof | null): proof is B3ParityProof {
  return proof !== null &&
    SHA256_HEX.test(proof.digest) &&
    proof.ref.trim().length > 0;
}

function validCleanup(cleanup: B3CleanupCapability | null): cleanup is B3CleanupCapability {
  return cleanup !== null &&
    cleanup.ownerId.trim().length > 0 &&
    typeof cleanup.cleanup === "function";
}

/**
 * Decide the B3 validator backend for one Core-owned build generation.
 *
 * Deterministic and synchronous: the same input always yields the same
 * decision, and every failure condition is a typed reject rather than a
 * throw or a fallback. Check order for disk mode is factory, snapshot,
 * parity proof, owner, cancel, cleanup, temp quota.
 */
export function decideB3Backend(input: B3BackendDecisionInput): B3BackendDecision {
  if (!validIdentity(input)) {
    return reject("invalid_input", "task_id/build_id/generation must be Core-owned and well formed");
  }
  const measured = input.measured;
  if (measured.failureReason !== null) {
    return reject("measured_rejected", `measured resource decision failed: ${measured.failureReason}`);
  }
  const basis = measured.thresholdBasis;
  if (basis === null || measured.estimatedHeapBytes === null) {
    return reject("invalid_decision", "measured decision carries no threshold basis or heap estimate");
  }
  const estimatedHeapBytes = measured.estimatedHeapBytes;
  const effectiveMemoryThresholdBytes = basis.effectiveMemoryThresholdBytes;

  if (measured.validatorMode === "memory") {
    // Memory is chosen only at or below the effective threshold; the first
    // byte above it is never silently downgraded or kept in memory.
    if (estimatedHeapBytes > effectiveMemoryThresholdBytes) {
      return reject("threshold_exceeded",
        `heap estimate ${estimatedHeapBytes} exceeds effective memory threshold ${effectiveMemoryThresholdBytes}`);
    }
    return {
      outcome: "memory",
      taskId: input.taskId,
      buildId: input.buildId,
      generation: input.generation,
      estimatedHeapBytes,
      effectiveMemoryThresholdBytes,
    };
  }
  if (measured.validatorMode !== "disk") {
    return reject("invalid_decision", `measured validator mode ${measured.validatorMode} is not admissible`);
  }
  if (estimatedHeapBytes <= effectiveMemoryThresholdBytes) {
    return reject("invalid_decision",
      `disk mode measured while heap estimate ${estimatedHeapBytes} stays within the memory threshold`);
  }
  if (input.factory === null || input.factory.factoryId.trim().length === 0) {
    return reject("disk_unavailable", "no disk tuple index factory injected");
  }
  if (!input.snapshotImmutable) {
    return reject("snapshot_mutable", "input snapshot is not immutable");
  }
  if (!validParityProof(input.parityProof)) {
    return reject("parity_proof_missing", "memory/disk parity proof is missing or malformed");
  }
  if (input.owner === null) {
    return reject("owner_mismatch", "no disk index owner capability injected");
  }
  if (input.owner.taskId !== input.taskId || input.owner.buildId !== input.buildId) {
    return reject("owner_mismatch",
      `owner identity ${input.owner.taskId}/${input.owner.buildId} does not match ${input.taskId}/${input.buildId}`);
  }
  if (input.owner.generation !== input.generation) {
    return reject("late_generation",
      `owner generation ${input.owner.generation} is late against ${input.generation}`);
  }
  if (input.signal === null || input.signal.aborted) {
    return reject("cancel_unavailable",
      input.signal === null ? "no cancel capability injected" : "cancel signal is already aborted");
  }
  if (!validCleanup(input.cleanup)) {
    return reject("cleanup_unavailable", "no cleanup capability injected");
  }
  if (measured.estimatedTempBytes === null) {
    return reject("invalid_decision", "disk decision carries no temp estimate");
  }
  if (measured.estimatedTempBytes > basis.effectiveTempQuotaBytes) {
    return reject("temp_quota_exceeded",
      `temp estimate ${measured.estimatedTempBytes} exceeds effective temp quota ${basis.effectiveTempQuotaBytes}`);
  }
  return {
    outcome: "disk",
    taskId: input.taskId,
    buildId: input.buildId,
    generation: input.generation,
    factoryId: input.factory.factoryId,
    parityProofRef: input.parityProof.ref,
    estimatedTempBytes: measured.estimatedTempBytes,
    effectiveTempQuotaBytes: basis.effectiveTempQuotaBytes,
  };
}
