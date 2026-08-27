import type {
  DatasetSchemaV2,
  JsonValue,
  SourceAssetRegistrationReceipt,
} from "@biomed/contracts";
import type { SourceLocator } from "../../contracts/source.js";

export type RegisteredTableFormat = "csv" | "tsv" | "json" | "xlsx";

export interface RegisteredTableParserLimits {
  max_bytes: number;
  max_rows: number;
  max_columns: number;
  max_line_characters: number;
}

export interface RegisteredDelimitedFieldMapping {
  source_column: string;
  target_field: string;
}

export interface RegisteredJsonFieldMapping {
  source_pointer: string;
  target_field: string;
}

interface RegisteredTableParserDefinitionBase {
  adapter_id: string;
  parser_version: string;
  schema_ref: string;
  media_types: readonly string[];
  limits: RegisteredTableParserLimits;
}

export interface RegisteredSampleMatrixLayout {
  sample_id_header: string;
  row_label_column: string;
  value_column: string;
}

export interface RegisteredDelimitedParserDefinition
  extends RegisteredTableParserDefinitionBase {
  format: "csv" | "tsv";
  fields: readonly RegisteredDelimitedFieldMapping[];
  layout?: "records" | "sample_matrix";
  sample_matrix?: RegisteredSampleMatrixLayout;
}

export interface RegisteredXlsxParserDefinition
  extends RegisteredTableParserDefinitionBase {
  format: "xlsx";
  sheet_name: string;
  fields: readonly RegisteredDelimitedFieldMapping[];
}

export interface RegisteredJsonParserDefinition
  extends RegisteredTableParserDefinitionBase {
  format: "json";
  rows_pointer: string;
  fields: readonly RegisteredJsonFieldMapping[];
}

export type RegisteredTableParserDefinition =
  | RegisteredDelimitedParserDefinition
  | RegisteredJsonParserDefinition
  | RegisteredXlsxParserDefinition;

export interface RegisteredTableAdapterRequest {
  schema_version: "1.0";
  task_id: string;
  asset_id: string;
  schema_ref: string;
  adapter_id: string;
  parser_version: string;
}

/** C1I supplies this value after resolving the request's asset ID. */
export interface CoreResolvedRegisteredAsset {
  registration_receipt: SourceAssetRegistrationReceipt;
  content: AsyncIterable<Uint8Array>;
}

export type RegisteredTableValue = JsonValue;

export interface RegisteredTableRow {
  row_index: number;
  values: Readonly<Record<string, RegisteredTableValue>>;
  locators: Readonly<Record<string, SourceLocator>>;
}

export type RegisteredTableRejectionCode =
  | "malformed_delimited_row"
  | "row_width_mismatch"
  | "missing_field"
  | "nullability_violation"
  | "type_mismatch"
  | "row_limit_exceeded";

export interface RegisteredTableRejectedRow {
  row_index: number;
  reason_code: RegisteredTableRejectionCode;
  reason: string;
  source_locator: SourceLocator;
}

export type RegisteredTableAuditStatus =
  | "accepted"
  | "accepted_with_rejections"
  | "rejected";

export interface RegisteredTableAudit {
  schema_version: "1.0";
  status: RegisteredTableAuditStatus;
  task_id: string;
  asset_id: string;
  registration_receipt_id: string;
  source_id: string;
  schema_ref: string;
  dataset_family: string;
  row_granularity: string;
  adapter_id: string;
  parser_version: string;
  format: RegisteredTableFormat;
  locator_version: "1.0" | "2.0";
  media_type: string;
  declared_size_bytes: number;
  actual_size_bytes: number | null;
  declared_sha256: string;
  actual_sha256: string | null;
  accepted_row_count: number;
  rejected_row_count: number;
  rejection_reason_counts: Readonly<Record<string, number>>;
  rejected_rows: readonly RegisteredTableRejectedRow[];
  fatal_reason_code: string | null;
  fatal_reason: string | null;
}

export interface RegisteredTableAdapterResult {
  schema: DatasetSchemaV2;
  audit: RegisteredTableAudit;
}

/**
 * Implementations must stage writes until commit. rollback must remove every
 * row staged for the current invocation so unverified bytes cannot escape.
 */
export interface RegisteredTableSink {
  writeRow(row: RegisteredTableRow): void | Promise<void>;
  writeRejectedRow(row: RegisteredTableRejectedRow): void | Promise<void>;
  commit(result: RegisteredTableAdapterResult): void | Promise<void>;
  rollback(audit: RegisteredTableAudit): void | Promise<void>;
}
