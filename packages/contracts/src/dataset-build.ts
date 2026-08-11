import type { ManifestArtifactEntry } from "./artifacts.js";
import type { JsonValue } from "./json.js";

export type BuildResultStatus =
  | "succeeded"
  | "partial_success"
  | "no_data"
  | "spec_rejected";

/** Per-binding failure detail on a NO_DATA ``BuildResult`` (backend BindingFailureDetail, K2). */
export interface BindingFailureDetail {
  binding_id: string;
  reason_code: string;
  message: string;
}

export interface BuildResult {
  status: BuildResultStatus;
  valid_row_count: number;
  successful_sources: string[];
  rejected_sources: string[];
  available_artifact_roles: string[];
  publication_id: string | null;
  reason_codes: string[];
  user_summary: string;
  recommended_next_action: string;
  /** Stable build identity correlating the envelope back to its build dir (C1e). */
  build_id?: string | null;
  /** Per-source rejection trace on NO_DATA builds (K2); absent on older payloads. */
  binding_failures?: BindingFailureDetail[];
}

/** Immutable V2 dataset manifest summary (backend DatasetManifest). */
export interface DatasetManifest {
  manifest_id: string;
  task_id: string;
  build_id: string;
  dataset_family: string;
  row_granularity: string;
  schema_ref: string;
  primary_key: string[];
  row_count: number;
  sha256: string;
  artifacts: ManifestArtifactEntry[];
  source_summary: Record<string, JsonValue>;
  validation_summary: Record<string, JsonValue>;
  confidence_summary: Record<string, JsonValue>;
  provenance_summary: Record<string, JsonValue>;
}

/** Immutable publication record of a V2 build (backend DatasetPublication). */
export interface DatasetPublication {
  publication_id: string;
  manifest_ref: string;
  validation_result_ref: string;
  published_at: string;
  supersedes_publication_id: string | null;
}

/** One V2 build listing entry (backend BuildSummary). */
export interface BuildSummary {
  build_id: string;
  task_id: string;
  dataset_family: string;
  row_granularity: string;
  schema_ref: string;
  row_count: number;
  status: BuildResultStatus;
  publication_id: string | null;
  manifest_ref: string;
  manifest_sha256: string;
  published_at: string | null;
  build_result: BuildResult | null;
}

/** One ascending page of V2 builds, newest manifest first (backend BuildPage). */
export interface BuildPage {
  items: BuildSummary[];
  next_cursor: string | null;
}

/** One build's authoritative BuildResult + manifest summary (backend BuildDetail). */
export interface BuildDetail {
  build_id: string;
  task_id: string;
  manifest_ref: string;
  build_result: BuildResult | null;
  manifest: DatasetManifest;
  publication: DatasetPublication | null;
  artifacts: ManifestArtifactEntry[];
}
