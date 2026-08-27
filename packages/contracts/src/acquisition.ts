import type { JsonValue } from "./json.js";
import type { RegisteredSourceAssetRef } from "./source-asset.js";

export type AcquisitionRequestMode = "builtin" | "workflow_recipe";
export type WorkflowRecipeStatus = "PROMOTED" | "DRAFT" | "RETIRED";
export type AcquisitionAttemptStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface CoreAcquisitionRequest {
  schema_version: "1.0";
  request_id: string;
  task_id: string;
  requirement_id: string;
  binding_id: string;
  mode: AcquisitionRequestMode;
  provider_id: string | null;
  recipe_id: string | null;
  recipe_version: number | null;
  parameters: Record<string, JsonValue>;
}

export interface WorkflowRecipeRef {
  schema_version: "1.0";
  recipe_id: string;
  recipe_version: number;
  status: WorkflowRecipeStatus;
  implementation_digest: string;
}

export interface AcquisitionCacheLineage {
  schema_version: "1.0";
  cache_key: string;
  request_identity_digest: string;
  cache_blob_sha256: string | null;
  resumed_from_attempt_id: string | null;
  part_relative_path: string | null;
}

export interface CoreDownloadAttempt {
  schema_version: "1.0";
  attempt_id: string;
  request_id: string;
  task_id: string;
  provider_id: string;
  attempt_number: number;
  status: AcquisitionAttemptStatus;
  url: string;
  bytes_received: number;
  error_code: string | null;
  retryable: boolean;
  started_at: string;
  finished_at: string | null;
  cache_lineage: AcquisitionCacheLineage;
  asset: RegisteredSourceAssetRef | null;
}
