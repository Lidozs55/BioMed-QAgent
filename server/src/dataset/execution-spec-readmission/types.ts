import type {
  DatasetExecutionProposal2,
  FamilySpec,
  ResolvedDatasetExecutionSpec2,
} from "@biomed/contracts";

export type ExecutionSpecResolutionErrorCode =
  | "invalid_context"
  | "invalid_proposal"
  | "family_spec_digest_mismatch"
  | "family_not_activated"
  | "family_revoked"
  | "unknown_capability"
  | "capability_ambiguous"
  | "capability_not_activated"
  | "unknown_binding"
  | "duplicate_binding"
  | "ambiguous_binding"
  | "cross_task_binding"
  | "stale_generation"
  | "requirement_mismatch"
  | "binding_mismatch"
  | "example_execution_forbidden";

export class ExecutionSpecResolutionError extends Error {
  readonly code: ExecutionSpecResolutionErrorCode;
  readonly path: string;

  constructor(code: ExecutionSpecResolutionErrorCode, message: string, path = "$") {
    super(message);
    this.name = "ExecutionSpecResolutionError";
    this.code = code;
    this.path = path;
  }
}

export type FamilyStatus = "submitted" | "sandbox_executable" | "fixture_verified" | "shadow_verified" | "trusted_e2e_verified" | "activated" | "revoked" | "retired";

export interface ExecutionSpecRegistryFamilyRecord {
  family_spec: FamilySpec;
  family_status: FamilyStatus;
}

export interface ExecutionSpecCapabilityRecord {
  kind: "dataset_transform" | "policy";
  scope: "example" | "task" | "user" | "curated" | "system";
  id: string;
  version: string;
  digest: string;
  status: FamilyStatus;
}

export interface ExecutionSpecRegisteredRecord {
  binding_id: string;
  source: string;
  input_requirement_ref: string;
  task_id: string | null;
  requirement_id: string | null;
  generation: number;
  registered_ref: string;
  receipt_digest: string;
}

export interface ExecutionSpecResolutionContext {
  task_id: string;
  requirement_id: string;
  registry_generation: number;
  registry_snapshot_digest: string;
  family: ExecutionSpecRegistryFamilyRecord;
  transforms: readonly ExecutionSpecCapabilityRecord[];
  policies: readonly ExecutionSpecCapabilityRecord[];
  assets: readonly ExecutionSpecRegisteredRecord[];
  results: readonly ExecutionSpecRegisteredRecord[];
}

export interface ExecutionSpecResolutionEvidence {
  task_id: string;
  requirement_id: string;
  registry_generation: number;
  proposal_digest: string;
  resolved_digest: string;
  registry_snapshot_digest: string;
  ordered_receipt_digests: string[];
  ordered_capability_refs: string[];
}

export interface ExecutionSpecResolution {
  resolved: ResolvedDatasetExecutionSpec2;
  evidence: ExecutionSpecResolutionEvidence;
}

export type ExecutionSpecProposal = DatasetExecutionProposal2;
