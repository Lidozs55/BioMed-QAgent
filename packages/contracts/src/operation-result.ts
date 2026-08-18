import type { JsonValue } from "./json.js";

export type OperationResultStatus = "succeeded" | "failed" | "cancelled" | "skipped";
export type OperationResultKind =
  | "acquire"
  | "parse"
  | "canonicalize"
  | "compatibility_gate"
  | "integrate"
  | "assemble"
  | "derive"
  | "validate_profile"
  | "publish";
export type OperationResultOutputKind =
  | "source_asset"
  | "parsed_table"
  | "canonical_table"
  | "compatibility_report"
  | "integrated_table"
  | "publication_candidate"
  | "derived_evidence"
  | "validation_result"
  | "publication_manifest";

export interface OperationResultFileReceipt {
  relative_path: string;
  size_bytes: number;
  sha256: string;
}

export interface OperationResultDependencyClosure {
  input_asset_ids: string[];
  upstream_result_manifest_ids: string[];
  parameter_digest: string;
  implementation_digest: string;
}

export interface OperationResultCommitReceipt {
  state: "committed";
  commit_id: string;
  committed_at: string;
}

export interface OperationResultMigration {
  mode: "native" | "legacy_read_only";
  legacy_checkpoint_path: string | null;
  migrated_at: string | null;
}

export interface OperationResultManifest {
  schema_version: "1.0";
  result_manifest_id: string;
  task_id: string;
  build_id: string;
  operation_id: string;
  operation_kind: OperationResultKind;
  operation_attempt_id: string;
  attempt: number;
  status: OperationResultStatus;
  input_digest: string;
  parameter_digest: string;
  implementation_digest: string;
  output_digest: string | null;
  output_kind: OperationResultOutputKind;
  output_summary: Record<string, JsonValue>;
  output_files: OperationResultFileReceipt[];
  dependency_closure: OperationResultDependencyClosure;
  commit: OperationResultCommitReceipt;
  migration: OperationResultMigration;
}
