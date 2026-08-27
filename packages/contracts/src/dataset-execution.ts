import type { ManifestArtifactEntry } from "./artifacts.js";
import type { JsonValue } from "./json.js";
import type { DatasetManifestV2 } from "./dataset-multitable.js";

export interface DatasetExecutionSourceAcquisition {
  schema_version?: "1.0";
  mode: "builtin" | "workflow_recipe";
  provider_id: string | null;
  recipe_id: string | null;
  recipe_version: number | null;
}

export interface DatasetExecutionSourceBinding {
  schema_version?: "1.0";
  binding_id: string;
  source: string;
  acquisition: DatasetExecutionSourceAcquisition;
  adapter_id: string;
  accession: string | null;
  parameters: Record<string, JsonValue>;
}

/** Frozen V2 DatasetExecutionSpec wire DTO accepted by both Agent runtimes. */
export interface DatasetExecutionSpec {
  schema_version?: "1.0";
  requirement_id: string;
  objective: string;
  dataset_family: string;
  row_granularity: string;
  entities: Record<string, string[]>;
  cohort_filters: Record<string, string[]>;
  required_fields: string[];
  schema_ref: string;
  source_bindings: DatasetExecutionSourceBinding[];
  normalization_profile_ref: string | null;
  merge_strategy: string;
  validation_profile_ref: string;
  output_format: string;
  target_entity_level: string | null;
}

/** Immutable V2 dataset manifest summary (backend DatasetManifest). */
export interface DatasetManifestV1 {
  schema_version?: "1.0";
  manifest_id: string;
  task_id: string;
  requirement_id: string;
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

/** Existing single-table consumer shape; product consumers migrate in TASK-048-B2W. */
export type DatasetManifest = DatasetManifestV1;
/** Strict parser result for version-aware contract and assembly code. */
export type VersionedDatasetManifest = DatasetManifestV1 | DatasetManifestV2;

/** Immutable publication receipt verified by product consumers. */
export interface DatasetPublication {
  schema_version: "1.1";
  publication_id: string;
  manifest_ref: string;
  /** SHA-256 of the ``dataset_manifest.json`` file bytes. */
  manifest_sha256: string;
  validation_result_ref: string;
  published_at: string;
  supersedes_publication_id: string | null;
}

/** One immutable publication listing entry. */
export interface PublicationSummary {
  publication_id: string;
  requirement_id: string;
  run_id: string;
  task_id: string;
  dataset_family: string;
  row_granularity: string;
  schema_ref: string;
  row_count: number;
  manifest_ref: string;
  manifest_sha256: string;
  published_at: string;
}

/** One page of immutable publications, newest first. */
export interface PublicationPage {
  items: PublicationSummary[];
  next_cursor: string | null;
}

/** One publication and its verified manifest/artifacts. */
export interface PublicationDetail {
  publication_id: string;
  requirement_id: string;
  run_id: string;
  task_id: string;
  manifest_ref: string;
  manifest: VersionedDatasetManifest;
  publication: DatasetPublication;
  artifacts: ManifestArtifactEntry[];
}
