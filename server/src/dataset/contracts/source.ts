/**
 * Immutable file and source-locator contracts (Python
 * ``app.domain.contracts.source``). ``SourceAsset`` is the source-flavoured
 * ``FileAsset`` subclass carrying download/derivation lineage; it is ported
 * in migration plan Phase 4 step 3.
 */

import type { SchemaVersion } from "./primitives.js";
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

export interface SourceLocator {
  schema_version?: SchemaVersion;
  asset_id: string;
  logical_file: string;
  source_line_number: number;
  source_column_index: number;
  source_column_name: string;
  raw_value: string;
}

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