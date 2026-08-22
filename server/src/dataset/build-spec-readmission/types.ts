import type {
  DatasetBuildProposal2,
  FamilySpec,
  ResolvedDatasetBuildSpec2,
} from "@biomed/contracts";

export type BuildSpecResolutionErrorCode =
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
  | "build_mismatch"
  | "binding_mismatch"
  | "example_execution_forbidden";

export class BuildSpecResolutionError extends Error {
  readonly code: BuildSpecResolutionErrorCode;
  readonly path: string;

  constructor(code: BuildSpecResolutionErrorCode, message: string, path = "$") {
    super(message);
    this.name = "BuildSpecResolutionError";
    this.code = code;
    this.path = path;
  }
}

export type FamilyStatus = "submitted" | "sandbox_executable" | "fixture_verified" | "shadow_verified" | "trusted_e2e_verified" | "activated" | "revoked" | "retired";

export interface BuildSpecRegistryFamilyRecord {
  family_spec: FamilySpec;
  family_status: FamilyStatus;
}

export interface BuildSpecCapabilityRecord {
  kind: "dataset_transform" | "policy";
  scope: "example" | "task" | "user" | "curated" | "system";
  id: string;
  version: string;
  digest: string;
  status: FamilyStatus;
}

export interface BuildSpecRegisteredRecord {
  binding_id: string;
  source: string;
  input_requirement_ref: string;
  task_id: string | null;
  build_id: string | null;
  generation: number;
  registered_ref: string;
  receipt_digest: string;
}

export interface BuildSpecResolutionContext {
  task_id: string;
  build_id: string;
  registry_generation: number;
  registry_snapshot_digest: string;
  family: BuildSpecRegistryFamilyRecord;
  transforms: readonly BuildSpecCapabilityRecord[];
  policies: readonly BuildSpecCapabilityRecord[];
  assets: readonly BuildSpecRegisteredRecord[];
  results: readonly BuildSpecRegisteredRecord[];
}

export interface BuildSpecResolutionEvidence {
  task_id: string;
  build_id: string;
  registry_generation: number;
  proposal_digest: string;
  resolved_digest: string;
  registry_snapshot_digest: string;
  ordered_receipt_digests: string[];
  ordered_capability_refs: string[];
}

export interface BuildSpecResolution {
  resolved: ResolvedDatasetBuildSpec2;
  evidence: BuildSpecResolutionEvidence;
}

export type BuildSpecProposal = DatasetBuildProposal2;
