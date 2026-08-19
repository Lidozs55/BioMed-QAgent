/**
 * V2 build execution operations (Python ``app/datasets/runtime/operations.py``;
 * Design §12.2; ARCHITECTURE §5).
 *
 * An Operation is one step of the server-side fixed build skeleton. Operations
 * are recorded via append-only ``OperationAttempt`` history with digest
 * matching for idempotent reuse; they are internal execution records, never an
 * Agent-declared workflow node (no BuildRecipe, no public BuildStep).
 */

import type { AttemptStatus } from "@biomed/contracts";
import {
  assertExactKeys,
  assertIsoDateTime,
  assertNonEmptyString,
  assertNonNegativeInt,
  assertOptionalString,
  assertRecord,
  assertSha256,
  assertString,
} from "../contracts/primitives.js";

export type { AttemptStatus };

/** One node of the fixed build skeleton (Python frozen dataclass). */
export interface OperationSpec {
  operation_id: string;
  kind: OperationKind;
  label: string;
  category: string;
  upstream: string[];
}

/** Typed output of one operation, checkpointed by the executor. */
export interface OperationOutput {
  output: Record<string, unknown>;
  files: StageOutputFile[];
}

/** Deterministic file output of one operation (Python ``StageOutputFile``). */
export interface StageOutputFile {
  relative_path: string;
  size_bytes: number;
  sha256: string;
}

/** Structured error carried by a failed operation attempt. */
export interface RuntimeErrorDetail {
  code: string;
  message: string;
  retryable: boolean;
  stage: string | null;
  details: Record<string, unknown>;
}

/** Value-level mirror of Python ``OperationKind(StrEnum)``. */
export const OperationKind = {
  ACQUIRE: "acquire",
  PARSE: "parse",
  CANONICALIZE: "canonicalize",
  COMPATIBILITY_GATE: "compatibility_gate",
  INTEGRATE: "integrate",
  DERIVE: "derive",
  VALIDATE_PROFILE: "validate_profile",
  PUBLISH: "publish",
} as const;

export type OperationKind = (typeof OperationKind)[keyof typeof OperationKind];

export const OPERATION_KINDS: readonly OperationKind[] = Object.values(OperationKind);

export function isOperationKind(value: string): value is OperationKind {
  return (OPERATION_KINDS as readonly string[]).includes(value);
}

/** Append-only execution record for one operation (Python ``OperationAttempt``). */
export interface OperationAttempt {
  operation_attempt_id: string;
  task_id: string;
  build_id: string;
  operation_id: string;
  attempt: number;
  input_digest: string;
  parameter_digest: string;
  output_digest: string | null;
  status: AttemptStatus;
  implementation_version: string | null;
  started_at: string | null;
  finished_at: string | null;
  error: RuntimeErrorDetail | null;
  reused_operation_attempt_id: string | null;
}

const OPERATION_ATTEMPT_KEYS = [
  "operation_attempt_id",
  "task_id",
  "build_id",
  "operation_id",
  "attempt",
  "input_digest",
  "parameter_digest",
  "output_digest",
  "status",
  "implementation_version",
  "started_at",
  "finished_at",
  "error",
  "reused_operation_attempt_id",
] as const;

const ATTEMPT_STATUS_VALUES: readonly string[] = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
];

function assertAttemptStatus(value: unknown, name: string): AttemptStatus {
  const text = assertString(value, name);
  if (!ATTEMPT_STATUS_VALUES.includes(text)) {
    throw new TypeError(`${name} is not a valid AttemptStatus`);
  }
  return text as AttemptStatus;
}

function parseRuntimeErrorDetail(value: unknown): RuntimeErrorDetail | null {
  if (value === null || value === undefined) return null;
  const record = assertRecord(value, "OperationAttempt.error");
  const retryable = record.retryable;
  if (typeof retryable !== "boolean") {
    throw new TypeError("OperationAttempt.error.retryable must be a boolean");
  }
  const details = record.details;
  if (
    details !== null &&
    details !== undefined &&
    (typeof details !== "object" || Array.isArray(details))
  ) {
    throw new TypeError("OperationAttempt.error.details must be a record");
  }
  return {
    code: assertNonEmptyString(record.code, "OperationAttempt.error.code"),
    message: assertNonEmptyString(record.message, "OperationAttempt.error.message"),
    retryable,
    stage:
      record.stage === null || record.stage === undefined
        ? null
        : assertString(record.stage, "OperationAttempt.error.stage"),
    details: (details ?? {}) as Record<string, unknown>,
  };
}

/**
 * Parse an ``OperationAttempt`` from Python-serialized JSON and enforce the
 * Pydantic invariants of ``OperationAttempt`` (digest patterns, attempt >= 1,
 * state-machine consistency).
 */
export function parseOperationAttempt(value: unknown): OperationAttempt {
  const record = assertRecord(value, "OperationAttempt");
  assertExactKeys(record, OPERATION_ATTEMPT_KEYS, "OperationAttempt");
  const status = assertAttemptStatus(record.status, "OperationAttempt.status");
  const startedAt = assertOptionalString(record.started_at, "OperationAttempt.started_at");
  const finishedAt = assertOptionalString(
    record.finished_at,
    "OperationAttempt.finished_at",
  );
  if (startedAt !== null) assertIsoDateTime(startedAt, "OperationAttempt.started_at");
  if (finishedAt !== null) assertIsoDateTime(finishedAt, "OperationAttempt.finished_at");
  const attempt = assertNonNegativeInt(record.attempt, "OperationAttempt.attempt");
  if (attempt < 1) {
    throw new TypeError("OperationAttempt.attempt must be >= 1");
  }
  const inputDigest = assertSha256(record.input_digest, "OperationAttempt.input_digest");
  const parameterDigest = assertSha256(
    record.parameter_digest,
    "OperationAttempt.parameter_digest",
  );
  const outputDigest =
    record.output_digest === null || record.output_digest === undefined
      ? null
      : assertSha256(record.output_digest, "OperationAttempt.output_digest");
  const result: OperationAttempt = {
    operation_attempt_id: assertNonEmptyString(
      record.operation_attempt_id,
      "OperationAttempt.operation_attempt_id",
    ),
    task_id: assertNonEmptyString(record.task_id, "OperationAttempt.task_id"),
    build_id: assertNonEmptyString(record.build_id, "OperationAttempt.build_id"),
    operation_id: assertNonEmptyString(record.operation_id, "OperationAttempt.operation_id"),
    attempt,
    input_digest: inputDigest.toLowerCase(),
    parameter_digest: parameterDigest.toLowerCase(),
    output_digest: outputDigest === null ? null : outputDigest.toLowerCase(),
    status,
    implementation_version: assertOptionalString(
      record.implementation_version,
      "OperationAttempt.implementation_version",
    ),
    started_at: startedAt,
    finished_at: finishedAt,
    error: parseRuntimeErrorDetail(record.error),
    reused_operation_attempt_id: assertOptionalString(
      record.reused_operation_attempt_id,
      "OperationAttempt.reused_operation_attempt_id",
    ),
  };
  validateOperationAttemptState(result);
  return result;
}

/**
 * State-machine invariant checks (Python ``OperationAttempt.validate_state``).
 * A SKIPPED attempt must reference a digest-matched SUCCEEDED predecessor.
 */
export function validateOperationAttemptState(attempt: OperationAttempt): void {
  if (attempt.finished_at !== null && attempt.started_at === null) {
    throw new TypeError("finished_at requires started_at");
  }
  if (
    attempt.started_at !== null &&
    attempt.finished_at !== null &&
    Date.parse(attempt.finished_at) < Date.parse(attempt.started_at)
  ) {
    throw new TypeError("finished_at must not precede started_at");
  }
  if (attempt.status === "succeeded") {
    if (attempt.output_digest === null) {
      throw new TypeError("succeeded attempt requires output_digest");
    }
    if (attempt.error !== null) {
      throw new TypeError("succeeded attempt must not contain error");
    }
  }
  if (attempt.status === "failed" && attempt.error === null) {
    throw new TypeError("failed attempt requires error");
  }
  if (attempt.status === "skipped") {
    if (attempt.output_digest === null) {
      throw new TypeError("skipped attempt requires output_digest");
    }
    if (attempt.reused_operation_attempt_id === null) {
      throw new TypeError("skipped attempt requires reused_operation_attempt_id");
    }
  }
}

/** Construct an OperationSpec with Python defaults (category "", upstream []). */
export function makeOperationSpec(spec: {
  operation_id: string;
  kind: OperationKind;
  label: string;
  category?: string;
  upstream?: readonly string[];
}): OperationSpec {
  return {
    operation_id: spec.operation_id,
    kind: spec.kind,
    label: spec.label,
    category: spec.category ?? "",
    upstream: [...(spec.upstream ?? [])],
  };
}

/** Construct an OperationOutput with Python defaults (files []). */
export function makeOperationOutput(
  output: Record<string, unknown>,
  files: readonly StageOutputFile[] = [],
): OperationOutput {
  return { output, files: [...files] };
}

/** Construct a RuntimeErrorDetail with Python defaults (stage null, details {}). */
export function makeErrorDetail(detail: {
  code: string;
  message: string;
  retryable: boolean;
  stage?: string | null;
  details?: Record<string, unknown>;
}): RuntimeErrorDetail {
  return {
    code: detail.code,
    message: detail.message,
    retryable: detail.retryable,
    stage: detail.stage ?? null,
    details: detail.details ?? {},
  };
}