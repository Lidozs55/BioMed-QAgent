import type { JsonValue } from "./json.js";
import type { RegisteredSourceAssetRef } from "./source-asset.js";

/** The only derive position in the Dataset Core's fixed execution skeleton. */
export type DeterministicDeriveSlot = "derive";
export const DETERMINISTIC_DERIVE_SLOT: DeterministicDeriveSlot = "derive";

export type DeriveInputKind = "registered_asset" | "committed_result";
export type DeriveOutputKind = "derived_evidence";
export type DeriveCommittedOutputKind =
  | "canonical_table"
  | "integrated_table"
  | "derived_evidence";

export interface DeriveReferenceVersion {
  schema_version: "1.0";
  reference_id: string;
  version: string;
  digest: string;
}

export interface DeriveCommittedResultRef {
  schema_version: "1.0";
  result_manifest_id: string;
  output_kind: DeriveCommittedOutputKind;
  output_digest: string;
  commit_id: string;
}

export interface DeterministicDeriveInput {
  schema_version: "1.0";
  input_id: string;
  kind: DeriveInputKind;
  digest: string;
  asset_ref: RegisteredSourceAssetRef | null;
  committed_result_ref: DeriveCommittedResultRef | null;
}

export interface DeterministicDeriveRequest {
  schema_version: "1.0";
  slot: DeterministicDeriveSlot;
  request_id: string;
  task_id: string;
  requirement_id: string;
  algorithm_id: string;
  algorithm_version: string;
  implementation_digest: string;
  parameters: Record<string, JsonValue>;
  reference: DeriveReferenceVersion;
  inputs: DeterministicDeriveInput[];
  output_schema_ref: string;
  request_identity_digest: string;
}

export interface DeterministicDeriveProvenance {
  schema_version: "1.0";
  slot: DeterministicDeriveSlot;
  request_id: string;
  request_identity_digest: string;
  algorithm_id: string;
  algorithm_version: string;
  implementation_digest: string;
  parameters: Record<string, JsonValue>;
  reference: DeriveReferenceVersion;
  inputs: DeterministicDeriveInput[];
  output_schema_ref: string;
  output_digest: string;
}

export interface DeterministicDeriveResultReceipt {
  schema_version: "1.0";
  result_id: string;
  task_id: string;
  requirement_id: string;
  slot: DeterministicDeriveSlot;
  request_id: string;
  request_identity_digest: string;
  output_kind: DeriveOutputKind;
  output_schema_ref: string;
  output_digest: string;
  output_summary: Record<string, JsonValue>;
  provenance: DeterministicDeriveProvenance;
}
