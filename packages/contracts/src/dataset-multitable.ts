import type { JsonValue } from "./json.js";

export type DatasetManifestSchemaVersion = "1.0" | "2.0";
export type TableRole = "primary" | "supporting" | "derived";
export type RelationCardinality = "one_to_one" | "one_to_many" | "many_to_one" | "many_to_many";
export type RelationMissingPolicy = "reject" | "allow_empty" | "allow_missing" | "profile_defined";

export interface SchemaFieldV2 {
  schema_version: "2.0";
  name: string;
  data_type: string;
  semantic_role: string;
  required: boolean;
  nullable: boolean;
  unit_policy: string | null;
  ontology: string | null;
  description: string;
  derivation_policy: string | null;
}

export interface DatasetSchemaV2 {
  schema_version: "2.0";
  schema_id: string;
  dataset_family: string;
  row_granularity: string;
  primary_key: string[];
  fields: SchemaFieldV2[];
}

export interface TableDefinition {
  table_id: string;
  schema_ref: string;
  role: TableRole;
  required: boolean;
  allow_empty: boolean;
  primary_key: string[];
  field_names: string[];
}

export interface RelationDefinition {
  relation_id: string;
  from_table_id: string;
  from_fields: string[];
  to_table_id: string;
  to_fields: string[];
  cardinality: RelationCardinality;
  missing_policy: RelationMissingPolicy;
}

export interface PublicationCandidateRef {
  candidate_id: string;
  table_ids: string[];
  relation_ids: string[];
  provenance_refs: string[];
  confidence_refs: string[];
  audit_refs: string[];
}

export interface DatasetManifestV2 {
  schema_version: "2.0";
  manifest_id: string;
  task_id: string;
  requirement_id: string;
  dataset_family: string;
  row_granularity: string;
  schema_ref: string;
  primary_key: string[];
  row_count: number;
  sha256: string;
  artifacts: import("./artifacts.js").ManifestArtifactEntry[];
  source_summary: Record<string, JsonValue>;
  validation_summary: Record<string, JsonValue>;
  confidence_summary: Record<string, JsonValue>;
  provenance_summary: Record<string, JsonValue>;
  tables: TableDefinition[];
  relations: RelationDefinition[];
  candidate_refs: PublicationCandidateRef[];
}
