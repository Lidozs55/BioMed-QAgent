import type {
  OperationResultOutputKind,
} from "./operation-result.js";
import type {
  RelationDefinition,
  TableDefinition,
} from "./dataset-multitable.js";

/**
 * Immutable reference to one file receipt owned by a committed Core operation
 * result. Paths are deliberately absent: consumers resolve the result manifest
 * inside the Dataset Core boundary.
 */
export interface PublicationCandidateResultRef {
  result_manifest_id: string;
  output_kind: OperationResultOutputKind;
  output_file_index: number;
  output_file_sha256: string;
}

export interface PublicationCandidateTable {
  definition: TableDefinition;
  data_ref: PublicationCandidateResultRef;
  row_count: number;
}

/**
 * Core-only assembled publication input. The Agent cannot submit this object or
 * name files; every payload is bound to committed Core results or registered,
 * content-addressed asset IDs.
 */
export interface PublicationCandidate {
  schema_version: "1.0";
  candidate_id: string;
  task_id: string;
  requirement_id: string;
  dataset_family: string;
  row_granularity: string;
  tables: PublicationCandidateTable[];
  relations: RelationDefinition[];
  provenance_refs: PublicationCandidateResultRef[];
  confidence_refs: PublicationCandidateResultRef[];
  audit_refs: PublicationCandidateResultRef[];
  registered_asset_ids: string[];
}
