import type {
  CancellationState,
  FamilySpec,
  ImplementationDigestInput,
  InputAssetReceipt,
  InputResultReceipt,
  ResourceLimits,
  SandboxBackend,
  SourceLocatorV2,
  TransformDescriptorDigestInput,
} from "@biomed/contracts";

/** Explicitly marks a receipt emitted by a production Host transport. */
export interface ProductionTransformReceiptEvidence {
  evidence_class: "production_host_receipt";
  wire_receipt: unknown;
}

/**
 * Explicitly marks a synthetic receipt. Successful tests must use this class;
 * fixtures must never masquerade as production Host evidence.
 */
export interface TransformFixtureReceipt {
  evidence_class: "synthetic_test_fixture_receipt";
  fixture_id: string;
  fixture_receipt: unknown;
}

export type TransformReceiptEvidence =
  | ProductionTransformReceiptEvidence
  | TransformFixtureReceipt;

/** Core-local closure missing from the Host receipt's output shape. */
export interface ExpectedTransformOutputDescriptor {
  table_id: string;
  schema_ref: string;
  artifact_ref: string;
  locator_ref: string;
  relative_path: string;
  delimiter: "," | "\t";
  header: readonly string[];
  source_locators: readonly SourceLocatorV2[];
}

export interface ExpectedTransformBackendPolicy {
  sandbox_backend: SandboxBackend;
  sandbox_config_digest: string;
  policy_digest: string;
  granted_capabilities: readonly string[];
  resource_limits: ResourceLimits;
}

export interface ExpectedTransformDeadlineFence {
  deadline_at: string;
}

export interface ExpectedTransformCancelFence {
  cancellation_state: CancellationState;
  cancel_requested_at: string | null;
}

/**
 * Core-owned authorization snapshot for exactly one invocation. It is not a
 * wire DTO and is never reconstructed from the Host receipt.
 */
export interface ExpectedTransformInvocation {
  owner: "dataset_core";
  task_id: string;
  run_id: string;
  build_id: string;
  invocation_id: string;
  attempt: number;
  generation: number;
  request_digest: string;
  parameters_digest: string;
  family_spec: FamilySpec;
  projection_digest: string;
  transform_descriptor: TransformDescriptorDigestInput;
  transform_descriptor_digest: string;
  implementation: ImplementationDigestInput;
  implementation_digest: string;
  compiler_digest: string;
  runtime_digest: string;
  input_asset_receipts: readonly InputAssetReceipt[];
  input_result_receipts: readonly InputResultReceipt[];
  backend_policy: ExpectedTransformBackendPolicy;
  expected_outputs: readonly ExpectedTransformOutputDescriptor[];
  deadline_fence: ExpectedTransformDeadlineFence;
  cancel_fence: ExpectedTransformCancelFence;
}

export interface TransformAdmissionRequest {
  receipt_evidence: TransformReceiptEvidence;
  expected_invocation: ExpectedTransformInvocation;
  quarantine_root: string;
  /** Existing Core-owned parent; admission creates a fresh atomic commit root below it. */
  core_commit_parent: string;
  /** Read immediately before work, before rename, and after rename to close late-cancel races. */
  read_current_cancel_fence: () =>
    | ExpectedTransformCancelFence
    | Promise<ExpectedTransformCancelFence>;
  now?: () => Date;
}

export type TransformAdmissionRejectionCode =
  | "INVALID_RECEIPT"
  | "INVALID_EXPECTED_INVOCATION"
  | "INVALID_FAMILY_SPEC_DIGEST"
  | "INVOCATION_BINDING_MISMATCH"
  | "NON_SUCCESS_TERMINAL_STATE"
  | "DEADLINE_FENCE_VIOLATION"
  | "LATE_CANCELLATION"
  | "INPUT_CLOSURE_MISMATCH"
  | "OUTPUT_CLOSURE_MISMATCH"
  | "LOCATOR_CLOSURE_MISMATCH"
  | "INVALID_QUARANTINE_PATH"
  | "OUTPUT_BYTES_MISMATCH"
  | "OUTPUT_HEADER_MISMATCH"
  | "OUTPUT_ROW_COUNT_MISMATCH"
  | "ATOMIC_COMMIT_FAILED";

export interface CoreCommittedTransformOutput {
  table_id: string;
  schema_ref: string;
  artifact_ref: string;
  locator_ref: string;
  relative_path: string;
  delimiter: "," | "\t";
  header: string[];
  size_bytes: number;
  sha256: string;
  row_count: number;
  source_locators: SourceLocatorV2[];
}

/**
 * The only successful admission product. This is quarantine evidence only: it
 * is not an OperationResult, ProductAssessment, Publication, or authority to
 * publish.
 */
export interface TransformQuarantineAdmissionEvidence {
  schema_version: "1.0";
  evidence_kind: "transform_quarantine_admission";
  evidence_id: string;
  owner: "dataset_core";
  decision: "admitted" | "rejected";
  receipt_evidence_class:
    | "production_host_receipt"
    | "synthetic_test_fixture_receipt";
  fixture_id: string | null;
  host_receipt_digest: string | null;
  task_id: string | null;
  run_id: string | null;
  build_id: string | null;
  invocation_id: string | null;
  attempt: number | null;
  generation: number | null;
  rejection_code: TransformAdmissionRejectionCode | null;
  rejection_detail: string | null;
  committed_root: string | null;
  output_digest: string | null;
  outputs: CoreCommittedTransformOutput[];
  issued_at: string;
}

