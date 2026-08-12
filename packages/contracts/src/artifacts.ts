/** V2 build artifact role (mirrors backend ArtifactRole). */
export type ArtifactRole =
  | "primary_dataset"
  | "supporting_dataset"
  | "schema"
  | "provenance"
  | "audit_report";

/** One manifest-registered artifact of a V2 build (backend ManifestArtifactEntry). */
export interface ManifestArtifactEntry {
  schema_version?: "1.0";
  artifact_id: string;
  role: ArtifactRole;
  relative_path: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
}

export interface ArtifactRecord {
  artifact_id: string;
  name: string;
  role?: string;
  size: number;
  sha256: string;
  media_type: string;
}

export interface ArtifactManifestEntry {
  schema_version?: "1.0";
  artifact_id: string;
  name: string;
  role?: string;
  relative_path: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
  generated_by_step_id: string;
}
