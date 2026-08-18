/**
 * Immutable file and source-locator contracts (Python
 * ``app.domain.contracts.source``). ``SourceAsset`` is the source-flavoured
 * ``FileAsset`` subclass carrying download/derivation lineage; it is ported
 * in migration plan Phase 4 step 3.
 */

import type { SchemaVersion } from "./primitives.js";
import type { SourceLocatorV2 } from "@biomed/contracts";
import {
  assertExactKeys,
  assertNonEmptyString,
  assertNonNegativeInt,
  assertOptionalNonEmptyString,
  assertOptionalString,
  assertRecord,
  assertRelativePath,
  assertSha256,
  assertIsoDateTime,
  assertString,
  isoDateTimeMillis,
  parseSchemaVersion,
} from "./primitives.js";
import type { DataLevel, Database, DownloadStatus, ErrorCode } from "./enums.js";
import { assertDataLevel, assertDatabase, assertDownloadStatus, assertErrorCode } from "./enums.js";

export type FileAssetKind = "source" | "parsed" | "normalized" | "artifact";

function isFileAssetKind(value: string): value is FileAssetKind {
  return value === "source" || value === "parsed" || value === "normalized" || value === "artifact";
}

export interface FileAsset {
  schema_version?: SchemaVersion;
  asset_id: string;
  kind: FileAssetKind;
  relative_path: string;
  sha256: string;
  size_bytes: number;
  media_type: string;
  generated_by_step_id: string | null;
}

const FILE_ASSET_KEYS = [
  "schema_version",
  "asset_id",
  "kind",
  "relative_path",
  "sha256",
  "size_bytes",
  "media_type",
  "generated_by_step_id",
] as const;

function parseFileAssetFromRecord(record: Record<string, unknown>): FileAsset {
  const kind = assertString(record.kind, "FileAsset.kind");
  if (!isFileAssetKind(kind)) {
    throw new TypeError("FileAsset.kind must be one of source, parsed, normalized, artifact");
  }
  const sha256 = assertSha256(record.sha256, "FileAsset.sha256");
  const assetId = assertNonEmptyString(record.asset_id, "FileAsset.asset_id");
  if (assetId !== `asset_${sha256}`) {
    throw new TypeError("FileAsset.asset_id must be derived from the full sha256");
  }
  return {
    schema_version: parseSchemaVersion(record),
    asset_id: assetId,
    kind: kind,
    relative_path: assertRelativePath(record.relative_path, "FileAsset.relative_path"),
    sha256,
    size_bytes: assertNonNegativeInt(record.size_bytes, "FileAsset.size_bytes"),
    media_type: assertNonEmptyString(record.media_type, "FileAsset.media_type"),
    generated_by_step_id: assertOptionalString(
      record.generated_by_step_id,
      "FileAsset.generated_by_step_id",
    ),
  };
}

export function parseFileAsset(value: unknown): FileAsset {
  const record = assertRecord(value, "FileAsset");
  assertExactKeys(record, FILE_ASSET_KEYS, "FileAsset");
  return parseFileAssetFromRecord(record);
}

export interface SourceAsset extends FileAsset {
  source_id: string;
  successful_attempt_id: string | null;
  derived_from_asset_id: string | null;
  data_level: DataLevel;
}

const SOURCE_ASSET_KEYS = [
  "schema_version",
  "asset_id",
  "kind",
  "relative_path",
  "sha256",
  "size_bytes",
  "media_type",
  "generated_by_step_id",
  "source_id",
  "successful_attempt_id",
  "derived_from_asset_id",
  "data_level",
] as const;

export function parseSourceAsset(value: unknown): SourceAsset {
  const record = assertRecord(value, "SourceAsset");
  assertExactKeys(record, SOURCE_ASSET_KEYS, "SourceAsset");
  const kind = assertString(record.kind, "SourceAsset.kind");
  if (kind !== "source") {
    throw new TypeError("SourceAsset.kind must be 'source'");
  }
  const base = parseFileAssetFromRecord(record);
  if (base.relative_path.split("/")[0] !== "source_assets") {
    throw new TypeError("SourceAsset path must be inside source_assets");
  }
  const successfulAttemptId = assertOptionalNonEmptyString(
    record.successful_attempt_id,
    "SourceAsset.successful_attempt_id",
  );
  const derivedFromAssetId = assertOptionalNonEmptyString(
    record.derived_from_asset_id,
    "SourceAsset.derived_from_asset_id",
  );
  const lineageCount =
    (successfulAttemptId !== null ? 1 : 0) + (derivedFromAssetId !== null ? 1 : 0);
  if (lineageCount !== 1) {
    throw new TypeError("SourceAsset requires exactly one download or derivation lineage");
  }
  if (derivedFromAssetId !== null) {
    if (derivedFromAssetId === base.asset_id) {
      throw new TypeError("derived SourceAsset cannot reference itself");
    }
    if (base.generated_by_step_id === null) {
      throw new TypeError("derived SourceAsset requires generated_by_step_id");
    }
  }
  return {
    ...base,
    source_id: assertNonEmptyString(record.source_id, "SourceAsset.source_id"),
    successful_attempt_id: successfulAttemptId,
    derived_from_asset_id: derivedFromAssetId,
    data_level: assertDataLevel(record.data_level, "SourceAsset.data_level"),
  };
}

export interface SourceLocatorV1 {
  schema_version?: SchemaVersion;
  asset_id: string;
  logical_file: string;
  source_line_number: number;
  source_column_index: number;
  source_column_name: string;
  raw_value: string;
}

export type SourceLocator = SourceLocatorV1 | SourceLocatorV2;

const SOURCE_LOCATOR_KEYS = [
  "schema_version",
  "asset_id",
  "logical_file",
  "source_line_number",
  "source_column_index",
  "source_column_name",
  "raw_value",
] as const;

export function parseSourceLocator(value: unknown): SourceLocator {
  const record = assertRecord(value, "SourceLocator");
  if (record.locator_version === "2.0") return parseSourceLocatorV2(record);
  assertExactKeys(record, SOURCE_LOCATOR_KEYS, "SourceLocator");
  const line = assertNonNegativeInt(
    record.source_line_number,
    "SourceLocator.source_line_number",
  );
  if (line < 1) {
    throw new TypeError("SourceLocator.source_line_number must be >= 1");
  }
  return {
    schema_version: parseSchemaVersion(record),
    asset_id: assertNonEmptyString(record.asset_id, "SourceLocator.asset_id"),
    logical_file: assertRelativePath(
      record.logical_file,
      "SourceLocator.logical_file",
    ),
    source_line_number: line,
    source_column_index: assertNonNegativeInt(
      record.source_column_index,
      "SourceLocator.source_column_index",
    ),
    source_column_name: assertString(
      record.source_column_name,
      "SourceLocator.source_column_name",
    ),
    raw_value: assertString(record.raw_value, "SourceLocator.raw_value"),
  };
}

function parseSourceLocatorV2(record: Record<string, unknown>): SourceLocatorV2 {
  const type = assertNonEmptyString(record.locator_type, "SourceLocator.locator_type");
  const base = {
    locator_version: "2.0" as const,
    locator_type: type,
    asset_id: assertNonEmptyString(record.asset_id, "SourceLocator.asset_id"),
    logical_file: assertRelativePath(record.logical_file, "SourceLocator.logical_file"),
    raw_value: assertString(record.raw_value, "SourceLocator.raw_value"),
  };
  if (type === "json_pointer") {
    assertExactKeys(record, ["locator_version", "locator_type", "asset_id", "logical_file", "raw_value", "json_pointer"], "SourceLocator.json_pointer");
    const pointer = assertString(record.json_pointer, "SourceLocator.json_pointer");
    if (!pointer.startsWith("/")) throw new TypeError("SourceLocator.json_pointer must start with '/'");
    return { ...base, locator_type: "json_pointer", json_pointer: pointer };
  }
  if (type === "xml_cell") {
    assertExactKeys(record, ["locator_version", "locator_type", "asset_id", "logical_file", "raw_value", "xml_path", "table_id", "row_index", "column_index"], "SourceLocator.xml_cell");
    return { ...base, locator_type: "xml_cell", xml_path: assertNonEmptyString(record.xml_path, "SourceLocator.xml_path"), table_id: assertNonEmptyString(record.table_id, "SourceLocator.table_id"), row_index: assertPositiveCoordinate(record.row_index, "SourceLocator.row_index"), column_index: assertPositiveCoordinate(record.column_index, "SourceLocator.column_index") };
  }
  if (type === "pdf_region") {
    assertExactKeys(record, ["locator_version", "locator_type", "asset_id", "logical_file", "raw_value", "page_number", "table_id", "figure_id", "row_label", "column_label"], "SourceLocator.pdf_region");
    return { ...base, locator_type: "pdf_region", page_number: assertPositiveCoordinate(record.page_number, "SourceLocator.page_number"), table_id: nullableString(record.table_id, "SourceLocator.table_id"), figure_id: nullableString(record.figure_id, "SourceLocator.figure_id"), row_label: nullableString(record.row_label, "SourceLocator.row_label"), column_label: nullableString(record.column_label, "SourceLocator.column_label") };
  }
  if (type === "image_bbox") {
    assertExactKeys(record, ["locator_version", "locator_type", "asset_id", "logical_file", "raw_value", "page_number", "figure_id", "bbox"], "SourceLocator.image_bbox");
    const bbox = record.bbox;
    if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((value) => typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new TypeError("SourceLocator.bbox must contain four non-negative numbers");
    if (Number(bbox[2]) < Number(bbox[0]) || Number(bbox[3]) < Number(bbox[1])) throw new TypeError("SourceLocator.bbox coordinates must be ordered");
    return { ...base, locator_type: "image_bbox", page_number: record.page_number === null ? null : assertPositiveCoordinate(record.page_number, "SourceLocator.page_number"), figure_id: nullableString(record.figure_id, "SourceLocator.figure_id"), bbox: bbox as [number, number, number, number] };
  }
  throw new TypeError("SourceLocator.locator_type is invalid");
}

function assertPositiveCoordinate(value: unknown, name: string): number {
  const coordinate = assertNonNegativeInt(value, name);
  if (coordinate < 1) throw new TypeError(`${name} must be >= 1`);
  return coordinate;
}
function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  return assertNonEmptyString(value, name);
}
export interface SourceRecord {
  schema_version?: SchemaVersion;
  source_id: string;
  database: Database;
  accession: string;
  url: string;
  title: string;
  retrieved_at: string;
}

const SOURCE_RECORD_KEYS = [
  "schema_version",
  "source_id",
  "database",
  "accession",
  "url",
  "title",
  "retrieved_at",
] as const;

export function parseSourceRecord(value: unknown): SourceRecord {
  const record = assertRecord(value, "SourceRecord");
  assertExactKeys(record, SOURCE_RECORD_KEYS, "SourceRecord");
  return {
    schema_version: parseSchemaVersion(record),
    source_id: assertNonEmptyString(record.source_id, "SourceRecord.source_id"),
    database: assertDatabase(record.database, "SourceRecord.database"),
    accession: assertNonEmptyString(record.accession, "SourceRecord.accession"),
    url: assertNonEmptyString(record.url, "SourceRecord.url"),
    title: assertString(record.title, "SourceRecord.title"),
    retrieved_at: assertIsoDateTime(record.retrieved_at, "SourceRecord.retrieved_at"),
  };
}

export interface SourceRelation {
  schema_version?: SchemaVersion;
  relation_id: string;
  from_source_id: string;
  to_source_id: string;
  relation_type: string;
  evidence_type: string;
  evidence_value: string;
  evidence_url: string;
}

const SOURCE_RELATION_KEYS = [
  "schema_version",
  "relation_id",
  "from_source_id",
  "to_source_id",
  "relation_type",
  "evidence_type",
  "evidence_value",
  "evidence_url",
] as const;

export function parseSourceRelation(value: unknown): SourceRelation {
  const record = assertRecord(value, "SourceRelation");
  assertExactKeys(record, SOURCE_RELATION_KEYS, "SourceRelation");
  return {
    schema_version: parseSchemaVersion(record),
    relation_id: assertNonEmptyString(record.relation_id, "SourceRelation.relation_id"),
    from_source_id: assertNonEmptyString(
      record.from_source_id,
      "SourceRelation.from_source_id",
    ),
    to_source_id: assertNonEmptyString(record.to_source_id, "SourceRelation.to_source_id"),
    relation_type: assertNonEmptyString(
      record.relation_type,
      "SourceRelation.relation_type",
    ),
    evidence_type: assertNonEmptyString(
      record.evidence_type,
      "SourceRelation.evidence_type",
    ),
    evidence_value: assertNonEmptyString(
      record.evidence_value,
      "SourceRelation.evidence_value",
    ),
    evidence_url: assertNonEmptyString(record.evidence_url, "SourceRelation.evidence_url"),
  };
}

export interface DownloadAttempt {
  schema_version?: SchemaVersion;
  attempt_id: string;
  source_id: string;
  url: string;
  status: DownloadStatus;
  bytes_received: number;
  error_code: ErrorCode | null;
  error_message: string | null;
  started_at: string;
  finished_at: string;
}

const DOWNLOAD_ATTEMPT_KEYS = [
  "schema_version",
  "attempt_id",
  "source_id",
  "url",
  "status",
  "bytes_received",
  "error_code",
  "error_message",
  "started_at",
  "finished_at",
] as const;

export function parseDownloadAttempt(value: unknown): DownloadAttempt {
  const record = assertRecord(value, "DownloadAttempt");
  assertExactKeys(record, DOWNLOAD_ATTEMPT_KEYS, "DownloadAttempt");
  const status = assertDownloadStatus(record.status, "DownloadAttempt.status");
  const errorCode =
    record.error_code === undefined || record.error_code === null
      ? null
      : assertErrorCode(record.error_code, "DownloadAttempt.error_code");
  const errorMessage = assertOptionalString(
    record.error_message,
    "DownloadAttempt.error_message",
  );
  const startedAt = assertIsoDateTime(record.started_at, "DownloadAttempt.started_at");
  const finishedAt = assertIsoDateTime(
    record.finished_at,
    "DownloadAttempt.finished_at",
  );
  if (isoDateTimeMillis(finishedAt) < isoDateTimeMillis(startedAt)) {
    throw new TypeError("DownloadAttempt.finished_at must not precede started_at");
  }
  const hasError = errorCode !== null || errorMessage !== null;
  if (status === "succeeded" && hasError) {
    throw new TypeError("successful download must not contain an error");
  }
  if (status !== "succeeded" && !hasError) {
    throw new TypeError("failed download must contain an error");
  }
  return {
    schema_version: parseSchemaVersion(record),
    attempt_id: assertNonEmptyString(record.attempt_id, "DownloadAttempt.attempt_id"),
    source_id: assertNonEmptyString(record.source_id, "DownloadAttempt.source_id"),
    url: assertNonEmptyString(record.url, "DownloadAttempt.url"),
    status,
    bytes_received: assertNonNegativeInt(
      record.bytes_received,
      "DownloadAttempt.bytes_received",
    ),
    error_code: errorCode,
    error_message: errorMessage,
    started_at: startedAt,
    finished_at: finishedAt,
  };
}

export interface AcquisitionResult {
  schema_version?: SchemaVersion;
  attempt: DownloadAttempt;
  asset: SourceAsset | null;
}

const ACQUISITION_RESULT_KEYS = ["schema_version", "attempt", "asset"] as const;

export function parseAcquisitionResult(value: unknown): AcquisitionResult {
  const record = assertRecord(value, "AcquisitionResult");
  assertExactKeys(record, ACQUISITION_RESULT_KEYS, "AcquisitionResult");
  const attempt = parseDownloadAttempt(record.attempt);
  const asset =
    record.asset === undefined || record.asset === null
      ? null
      : parseSourceAsset(record.asset);
  const succeeded = attempt.status === "succeeded";
  if (succeeded !== (asset !== null)) {
    throw new TypeError("successful attempts require an asset and failures forbid one");
  }
  if (asset !== null && asset.successful_attempt_id !== attempt.attempt_id) {
    throw new TypeError("asset must reference its successful attempt");
  }
  return {
    schema_version: parseSchemaVersion(record),
    attempt,
    asset,
  };
}