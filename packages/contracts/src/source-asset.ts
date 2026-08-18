export type RegisteredSourceAssetRole = "source" | "mapping" | "metadata" | "carrier";
export type SourceAssetReferenceMode = "asset_id" | "legacy_task_path";
export type SourceAssetReferenceTelemetry =
  | "asset_ref_used"
  | "legacy_path_compatibility_used";

export interface RegisteredSourceAssetRef {
  schema_version: "1.0";
  asset_id: string;
  task_id: string;
  role: RegisteredSourceAssetRole;
}

export interface SourceAssetPathCompatibility {
  schema_version: "1.0";
  mode: SourceAssetReferenceMode;
  legacy_path: string | null;
  telemetry_event: SourceAssetReferenceTelemetry;
}

export interface SourceAssetRegistrationReceipt {
  schema_version: "1.0";
  receipt_id: string;
  task_id: string;
  asset_ref: RegisteredSourceAssetRef;
  source_id: string;
  relative_path: string;
  sha256: string;
  size_bytes: number;
  media_type: string;
  registered_at: string;
  path_compatibility: SourceAssetPathCompatibility;
}
