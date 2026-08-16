/**
 * Per-source data, mapping, lineage and confidence contracts (Python
 * ``DataBatch`` / ``FieldMapping`` / ``ProvenanceRecord`` /
 * ``ConfidenceRecord`` / ``BindingRejection``).
 */

import type { JsonValue } from "@biomed/contracts";
import type { SchemaVersion } from "./primitives.js";
import {
  assertBoolean,
  assertExactKeys,
  assertJsonRecord,
  assertNonEmptyString,
  assertNonNegativeInt,
  assertRecord,
  assertString,
  assertStringArray,
  parseSchemaVersion,
} from "./primitives.js";
import type { ConfidenceLevel, MappingMethod, MappingReviewStatus, ValueScale } from "./enums.js";
import {
  MAPPING_METHOD,
  assertConfidenceLevel,
  assertMappingMethod,
  assertMappingReviewStatus,
  assertValueScale,
} from "./enums.js";
import { parseFileAsset, parseSourceLocator } from "./source.js";
import type { FileAsset, SourceLocator } from "./source.js";

export interface FieldMapping {
  schema_version?: SchemaVersion;
  mapping_id: string;
  source_schema_ref: string;
  target_schema_ref: string;
  source_field: string;
  target_field: string;
  transform: string;
  mapping_method: MappingMethod;
  confidence_level: ConfidenceLevel;
  evidence: string;
  review_status: MappingReviewStatus;
}

const FIELD_MAPPING_KEYS = [
  "schema_version",
  "mapping_id",
  "source_schema_ref",
  "target_schema_ref",
  "source_field",
  "target_field",
  "transform",
  "mapping_method",
  "confidence_level",
  "evidence",
  "review_status",
] as const;

export function parseFieldMapping(value: unknown): FieldMapping {
  const record = assertRecord(value, "FieldMapping");
  assertExactKeys(record, FIELD_MAPPING_KEYS, "FieldMapping");
  const mappingMethod = assertMappingMethod(
    record.mapping_method,
    "FieldMapping.mapping_method",
  );
  const reviewStatus = assertMappingReviewStatus(
    record.review_status,
    "FieldMapping.review_status",
  );
  if (
    mappingMethod === MAPPING_METHOD.STRING_SIMILARITY &&
    reviewStatus !== "proposed"
  ) {
    throw new TypeError("string-similarity mappings must remain proposed");
  }
  return {
    schema_version: parseSchemaVersion(record),
    mapping_id: assertNonEmptyString(record.mapping_id, "FieldMapping.mapping_id"),
    source_schema_ref: assertNonEmptyString(
      record.source_schema_ref,
      "FieldMapping.source_schema_ref",
    ),
    target_schema_ref: assertNonEmptyString(
      record.target_schema_ref,
      "FieldMapping.target_schema_ref",
    ),
    source_field: assertNonEmptyString(
      record.source_field,
      "FieldMapping.source_field",
    ),
    target_field: assertNonEmptyString(
      record.target_field,
      "FieldMapping.target_field",
    ),
    transform: assertString(record.transform, "FieldMapping.transform"),
    mapping_method: mappingMethod,
    confidence_level: record.confidence_level === undefined
      ? "medium"
      : assertConfidenceLevel(record.confidence_level, "FieldMapping.confidence_level"),
    evidence: assertNonEmptyString(record.evidence, "FieldMapping.evidence"),
    review_status: reviewStatus,
  };
}

export interface TransformRecord {
  schema_version?: SchemaVersion;
  transform_id: string;
  input: string;
  output: string;
}

const TRANSFORM_RECORD_KEYS = [
  "schema_version",
  "transform_id",
  "input",
  "output",
] as const;

export function parseTransformRecord(value: unknown): TransformRecord {
  const record = assertRecord(value, "TransformRecord");
  assertExactKeys(record, TRANSFORM_RECORD_KEYS, "TransformRecord");
  return {
    schema_version: parseSchemaVersion(record),
    transform_id: assertNonEmptyString(
      record.transform_id,
      "TransformRecord.transform_id",
    ),
    input: assertString(record.input, "TransformRecord.input"),
    output: assertString(record.output, "TransformRecord.output"),
  };
}

export interface ProvenanceRecord {
  schema_version?: SchemaVersion;
  provenance_id: string;
  record_id: string;
  source_asset_id: string;
  source_locator: SourceLocator;
  transforms: TransformRecord[];
}

const PROVENANCE_RECORD_KEYS = [
  "schema_version",
  "provenance_id",
  "record_id",
  "source_asset_id",
  "source_locator",
  "transforms",
] as const;

export function parseProvenanceRecord(value: unknown): ProvenanceRecord {
  const record = assertRecord(value, "ProvenanceRecord");
  assertExactKeys(record, PROVENANCE_RECORD_KEYS, "ProvenanceRecord");
  return {
    schema_version: parseSchemaVersion(record),
    provenance_id: assertNonEmptyString(
      record.provenance_id,
      "ProvenanceRecord.provenance_id",
    ),
    record_id: assertNonEmptyString(record.record_id, "ProvenanceRecord.record_id"),
    source_asset_id: assertNonEmptyString(
      record.source_asset_id,
      "ProvenanceRecord.source_asset_id",
    ),
    source_locator: parseSourceLocator(record.source_locator),
    transforms: record.transforms === undefined
      ? []
      : (() => {
          if (!Array.isArray(record.transforms)) {
            throw new TypeError("ProvenanceRecord.transforms must be an array");
          }
          return record.transforms.map((transform) => parseTransformRecord(transform));
        })(),
  };
}

export interface ConfidenceComponents {
  schema_version?: SchemaVersion;
  source_reliability: ConfidenceReliability;
  extraction_reliability: ConfidenceReliability;
  mapping_reliability: ConfidenceReliability;
  cross_source_consistency: CrossSourceConsistency;
  human_review_state: HumanReviewState;
}

export type ConfidenceReliability = ConfidenceLevel | "not_applicable";
export type CrossSourceConsistency =
  | "consistent"
  | "partially_consistent"
  | "conflicting"
  | "not_checked";
export type HumanReviewState =
  | "not_required"
  | "pending"
  | "accepted"
  | "corrected"
  | "rejected";

const CONFIDENCE_COMPONENTS_KEYS = [
  "schema_version",
  "source_reliability",
  "extraction_reliability",
  "mapping_reliability",
  "cross_source_consistency",
  "human_review_state",
] as const;

function confidenceReliability(value: unknown, name: string): ConfidenceReliability {
  if (value === undefined || value === "not_applicable") return "not_applicable";
  return assertConfidenceLevel(value, name);
}

function crossSourceConsistency(value: unknown): CrossSourceConsistency {
  if (value === undefined) return "not_checked";
  if (
    value === "consistent" ||
    value === "partially_consistent" ||
    value === "conflicting" ||
    value === "not_checked"
  ) return value;
  throw new TypeError("ConfidenceComponents.cross_source_consistency is invalid");
}

function humanReviewState(value: unknown): HumanReviewState {
  if (value === undefined) return "not_required";
  if (
    value === "not_required" ||
    value === "pending" ||
    value === "accepted" ||
    value === "corrected" ||
    value === "rejected"
  ) return value;
  throw new TypeError("ConfidenceComponents.human_review_state is invalid");
}

export function parseConfidenceComponents(value: unknown): ConfidenceComponents {
  const record = assertRecord(value, "ConfidenceComponents");
  assertExactKeys(record, CONFIDENCE_COMPONENTS_KEYS, "ConfidenceComponents");
  return {
    schema_version: parseSchemaVersion(record),
    source_reliability: confidenceReliability(
      record.source_reliability,
      "ConfidenceComponents.source_reliability",
    ),
    extraction_reliability: confidenceReliability(
      record.extraction_reliability,
      "ConfidenceComponents.extraction_reliability",
    ),
    mapping_reliability: confidenceReliability(
      record.mapping_reliability,
      "ConfidenceComponents.mapping_reliability",
    ),
    cross_source_consistency: crossSourceConsistency(record.cross_source_consistency),
    human_review_state: humanReviewState(record.human_review_state),
  };
}

export interface ConfidenceRecord {
  schema_version?: SchemaVersion;
  confidence_id: string;
  batch_id: string;
  record_id: string;
  level: ConfidenceLevel;
  channel: string;
  components: ConfidenceComponents;
  reasons: string[];
}

const CONFIDENCE_RECORD_KEYS = [
  "schema_version",
  "confidence_id",
  "batch_id",
  "record_id",
  "level",
  "channel",
  "components",
  "reasons",
] as const;

export function parseConfidenceRecord(value: unknown): ConfidenceRecord {
  const record = assertRecord(value, "ConfidenceRecord");
  assertExactKeys(record, CONFIDENCE_RECORD_KEYS, "ConfidenceRecord");
  return {
    schema_version: parseSchemaVersion(record),
    confidence_id: assertNonEmptyString(
      record.confidence_id,
      "ConfidenceRecord.confidence_id",
    ),
    batch_id: assertNonEmptyString(record.batch_id, "ConfidenceRecord.batch_id"),
    record_id: assertNonEmptyString(record.record_id, "ConfidenceRecord.record_id"),
    level: assertConfidenceLevel(record.level, "ConfidenceRecord.level"),
    channel: assertNonEmptyString(record.channel, "ConfidenceRecord.channel"),
    components: record.components === undefined
      ? parseConfidenceComponents({})
      : parseConfidenceComponents(record.components),
    reasons: record.reasons === undefined
      ? []
      : assertStringArray(record.reasons, "ConfidenceRecord.reasons"),
  };
}

export interface BatchConfidence {
  schema_version?: SchemaVersion;
  batch_id: string;
  record_count: number;
  level: ConfidenceLevel;
  channel: string;
  components: ConfidenceComponents;
  reasons: string[];
}

const BATCH_CONFIDENCE_KEYS = [
  "schema_version",
  "batch_id",
  "record_count",
  "level",
  "channel",
  "components",
  "reasons",
] as const;

export function parseBatchConfidence(value: unknown): BatchConfidence {
  const record = assertRecord(value, "BatchConfidence");
  assertExactKeys(record, BATCH_CONFIDENCE_KEYS, "BatchConfidence");
  return {
    schema_version: parseSchemaVersion(record),
    batch_id: assertNonEmptyString(record.batch_id, "BatchConfidence.batch_id"),
    record_count: assertNonNegativeInt(record.record_count, "BatchConfidence.record_count"),
    level: assertConfidenceLevel(record.level, "BatchConfidence.level"),
    channel: assertNonEmptyString(record.channel, "BatchConfidence.channel"),
    components: parseConfidenceComponents(record.components),
    reasons: record.reasons === undefined
      ? []
      : assertStringArray(record.reasons, "BatchConfidence.reasons"),
  };
}

export interface BindingRejection {
  schema_version?: SchemaVersion;
  binding_id: string;
  kind: "no_primary" | "error";
  reason_code: string;
  message: string;
}

const BINDING_REJECTION_KEYS = [
  "schema_version",
  "binding_id",
  "kind",
  "reason_code",
  "message",
] as const;

export function parseBindingRejection(value: unknown): BindingRejection {
  const record = assertRecord(value, "BindingRejection");
  assertExactKeys(record, BINDING_REJECTION_KEYS, "BindingRejection");
  const kind = assertString(record.kind, "BindingRejection.kind");
  if (kind !== "no_primary" && kind !== "error") {
    throw new TypeError("BindingRejection.kind must be one of no_primary, error");
  }
  return {
    schema_version: parseSchemaVersion(record),
    binding_id: assertNonEmptyString(record.binding_id, "BindingRejection.binding_id"),
    kind,
    reason_code: assertNonEmptyString(
      record.reason_code,
      "BindingRejection.reason_code",
    ),
    message: assertString(record.message, "BindingRejection.message"),
  };
}

export interface DataBatch {
  schema_version?: SchemaVersion;
  batch_id: string;
  binding_id: string;
  dataset_family: string;
  row_granularity: string;
  schema_ref: string;
  file_asset: FileAsset | null;
  row_count: number;
  column_count: number;
  parser_id: string;
  parser_version: string;
  statistics: Record<string, JsonValue>;
  warnings: string[];
  declared_mappings: FieldMapping[];
}

const DATA_BATCH_KEYS = [
  "schema_version",
  "batch_id",
  "binding_id",
  "dataset_family",
  "row_granularity",
  "schema_ref",
  "file_asset",
  "row_count",
  "column_count",
  "parser_id",
  "parser_version",
  "statistics",
  "warnings",
  "declared_mappings",
] as const;

export function parseDataBatch(value: unknown): DataBatch {
  const record = assertRecord(value, "DataBatch");
  assertExactKeys(record, DATA_BATCH_KEYS, "DataBatch");
  return {
    schema_version: parseSchemaVersion(record),
    batch_id: assertNonEmptyString(record.batch_id, "DataBatch.batch_id"),
    binding_id: assertNonEmptyString(record.binding_id, "DataBatch.binding_id"),
    dataset_family: assertNonEmptyString(
      record.dataset_family,
      "DataBatch.dataset_family",
    ),
    row_granularity: assertNonEmptyString(
      record.row_granularity,
      "DataBatch.row_granularity",
    ),
    schema_ref: assertNonEmptyString(record.schema_ref, "DataBatch.schema_ref"),
    file_asset: record.file_asset === undefined || record.file_asset === null
      ? null
      : parseFileAsset(record.file_asset),
    row_count: assertNonNegativeInt(record.row_count, "DataBatch.row_count"),
    column_count: assertNonNegativeInt(
      record.column_count,
      "DataBatch.column_count",
    ),
    parser_id: assertNonEmptyString(record.parser_id, "DataBatch.parser_id"),
    parser_version: assertNonEmptyString(
      record.parser_version,
      "DataBatch.parser_version",
    ),
    statistics: record.statistics === undefined
      ? {}
      : assertJsonRecord(record.statistics, "DataBatch.statistics"),
    warnings: record.warnings === undefined
      ? []
      : assertStringArray(record.warnings, "DataBatch.warnings"),
    declared_mappings: record.declared_mappings === undefined
      ? []
      : (() => {
          if (!Array.isArray(record.declared_mappings)) {
            throw new TypeError("DataBatch.declared_mappings must be an array");
          }
          return record.declared_mappings.map((mapping) => parseFieldMapping(mapping));
        })(),
  };
}

const GPL_PATTERN = /^GPL\d+$/;

export interface AdapterParams {
  schema_version?: SchemaVersion;
  format: "tximport_counts" | "series_matrix" | "supplementary_matrix";
  value_semantics: string;
  value_scale: ValueScale;
  expression_unit: string;
  is_normalized: boolean;
  platform_ids: string[];
  delimiter: string;
}

const ADAPTER_PARAMS_KEYS = [
  "schema_version",
  "format",
  "value_semantics",
  "value_scale",
  "expression_unit",
  "is_normalized",
  "platform_ids",
  "delimiter",
] as const;

export function parseAdapterParams(value: unknown): AdapterParams {
  const record = assertRecord(value, "AdapterParams");
  assertExactKeys(record, ADAPTER_PARAMS_KEYS, "AdapterParams");
  const format = assertString(record.format, "AdapterParams.format");
  if (
    format !== "tximport_counts" &&
    format !== "series_matrix" &&
    format !== "supplementary_matrix"
  ) {
    throw new TypeError(
      "AdapterParams.format must be one of tximport_counts, series_matrix, supplementary_matrix",
    );
  }
  const platformIds = (() => {
    if (record.platform_ids === undefined) return [];
    if (!Array.isArray(record.platform_ids)) {
      throw new TypeError("AdapterParams.platform_ids must be an array");
    }
    return record.platform_ids.map((item, index) => {
      const platformId = assertString(item, `AdapterParams.platform_ids[${index}]`);
      if (!GPL_PATTERN.test(platformId)) {
        throw new TypeError(`platform_id ${platformId} must match ^GPL\\d+$`);
      }
      return platformId;
    });
  })();
  const delimiter =
    record.delimiter === undefined
      ? "auto"
      : assertString(record.delimiter, "AdapterParams.delimiter");
  if (delimiter !== "auto" && delimiter.length !== 1) {
    throw new TypeError("delimiter must be 'auto' or a single character");
  }
  if (delimiter !== "auto" && format !== "supplementary_matrix") {
    throw new TypeError("delimiter is only applicable to supplementary_matrix format");
  }
  return {
    schema_version: parseSchemaVersion(record),
    format,
    value_semantics: assertNonEmptyString(
      record.value_semantics,
      "AdapterParams.value_semantics",
    ),
    value_scale: assertValueScale(record.value_scale, "AdapterParams.value_scale"),
    expression_unit: assertNonEmptyString(
      record.expression_unit,
      "AdapterParams.expression_unit",
    ),
    is_normalized:
      record.is_normalized === undefined
        ? false
        : assertBoolean(record.is_normalized, "AdapterParams.is_normalized"),
    platform_ids: platformIds,
    delimiter,
  };
}
