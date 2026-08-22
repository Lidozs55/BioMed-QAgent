import type {
  DatasetBuildProposal2,
  FamilySpec,
  ResolvedDatasetBuildSpec2,
} from "@biomed/contracts";

export type BuildSpecResolutionErrorCode =
  | "invalid_context"
  | "family_spec_digest_mismatch"
  | "family_not_activated"
  | "family_revoked"
  | "unknown_binding"
  | "duplicate_binding"
  | "ambiguous_binding"
  | "cross_task_binding"
  | "stale_generation"
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

export interface BuildSpecRegisteredRecord {
  binding_id: string;
  task_id: string;
  generation: number;
  registered_ref: string;
  receipt_digest: string;
}

export interface BuildSpecResolutionContext {
  registry_generation: number;
  registry_snapshot_digest: string;
  family: BuildSpecRegistryFamilyRecord;
  assets: readonly BuildSpecRegisteredRecord[];
  results: readonly BuildSpecRegisteredRecord[];
}

export interface BuildSpecResolutionEvidence {
  proposal_digest: string;
  resolved_digest: string;
  registry_snapshot_digest: string;
  ordered_receipt_refs: string[];
}

export interface BuildSpecResolution {
  resolved: ResolvedDatasetBuildSpec2;
  evidence: BuildSpecResolutionEvidence;
}

export type BuildSpecProposal = DatasetBuildProposal2;
