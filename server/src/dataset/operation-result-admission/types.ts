import type {
  JsonValue,
  OperationResultKind,
  OperationResultOutputKind,
  TerminalReason,
} from "@biomed/contracts";
import type { TransformQuarantineAdmissionEvidence } from "../transform-admission/types.js";

/**
 * C-T8 operation result admission rejection codes (pure adapter). Every
 * rejection is a typed error; nothing is emitted to disk and no
 * PublicationCandidate/Publication is ever constructed.
 */
export type OperationResultAdmissionRejectionCode =
  | "INVALID_EVIDENCE"
  | "REJECTED_EVIDENCE"
  | "EVIDENCE_DIGEST_MISMATCH"
  | "NON_SUCCESS_TERMINAL_STATE"
  | "CROSS_TASK_MISMATCH"
  | "LATE_GENERATION"
  | "UNKNOWN_SCHEMA"
  | "UNKNOWN_LOCATOR"
  | "UNKNOWN_INPUT"
  | "ABSOLUTE_PATH"
  | "INVALID_COMMITTED_ROOT"
  | "CLOSED_WORLD_MISMATCH"
  | "OUTPUT_BYTES_MISMATCH"
  | "OUTPUT_KIND_MISMATCH"
  | "INVALID_EXPECTED_OPERATION";

/**
 * Core-local expectation for exactly one quarantined operation invocation.
 * The caller (Dataset Core) must supply verified evidence: the expected
 * invocation was already bound to the Host receipt by
 * `admitTransformExecution`, so this adapter never re-parses the Host
 * receipt and never trusts it.
 */
export interface ExpectedOperationAdmission {
  task_id: string;
  run_id?: string;
  requirement_id: string;
  attempt: number;
  generation: number;
  /**
   * Core-declared terminal state of the quarantined invocation. Only
   * "succeeded" may be admitted; sandbox_unavailable / failed / cancelled /
   * timeout / oom / quota_exceeded / policy_violation are all rejected.
   */
  expected_exit_state: TerminalReason;
  operation_id: string;
  operation_attempt_id: string;
  operation_kind: OperationResultKind;
  output_kind: OperationResultOutputKind;
  output_summary: Record<string, JsonValue>;
  input_digest: string;
  parameter_digest: string;
  implementation_digest: string;
  /** Declared input closure; every output locator must cite one of these. */
  input_asset_ids: readonly string[];
  upstream_result_manifest_ids: readonly string[];
  /** Declared schema closure; every committed output must cite one of these. */
  declared_schemas: readonly string[];
  /** Declared locator closure; every committed output must cite one of these. */
  declared_locators: readonly string[];
  /** Deterministic manifest commit timestamp (ISO-8601); defaults to now(). */
  committed_at?: string;
}

/**
 * Pure adapter input. `evidence` is the existing Core-owned
 * `TransformQuarantineAdmissionEvidence`; `resolve_committed_root` maps its
 * opaque committed root ref to an absolute directory the Core owns.
 */
export interface OperationResultAdmissionInput {
  evidence: TransformQuarantineAdmissionEvidence;
  expected: ExpectedOperationAdmission;
  resolve_committed_root: (committed_root_ref: string) => string | Promise<string>;
  now?: () => Date;
}
