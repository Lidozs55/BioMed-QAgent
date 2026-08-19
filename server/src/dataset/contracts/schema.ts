import type { DatasetSchemaV2, SchemaFieldV2 } from "@biomed/contracts";
import type { SchemaVersion } from "./primitives.js";
import {
  assertBoolean,
  assertExactKeys,
  assertNonEmptyString,
  assertOptionalString,
  assertRecord,
  assertString,
  assertStringArray,
  parseSchemaVersion,
} from "./primitives.js";

export interface SchemaField {
  schema_version?: SchemaVersion | "2.0";
  name: string;
  data_type: string;
  semantic_role: string;
  /** Whether the column must be present in a table. */
  required: boolean;
  /** Whether a present cell may contain JSON null/blank according to profile. */
  nullable?: boolean;
  unit_policy: string | null;
  ontology: string | null;
  description: string;
  derivation_policy: string | null;
}

const SCHEMA_FIELD_KEYS = [
  "schema_version",
  "name",
  "data_type",
  "semantic_role",
  "required",
  "nullable",
  "unit_policy",
  "ontology",
  "description",
  "derivation_policy",
] as const;

export function parseSchemaField(value: unknown): SchemaField {
  const record = assertRecord(value, "SchemaField");
  assertExactKeys(record, SCHEMA_FIELD_KEYS, "SchemaField");
  const parsed = {
    schema_version: parseSchemaVersion(record),
    name: assertNonEmptyString(record.name, "SchemaField.name"),
    data_type: assertNonEmptyString(record.data_type, "SchemaField.data_type"),
    semantic_role: assertNonEmptyString(
      record.semantic_role,
      "SchemaField.semantic_role",
    ),
    required: assertBoolean(record.required, "SchemaField.required"),
    unit_policy: assertOptionalString(record.unit_policy, "SchemaField.unit_policy"),
    ontology: assertOptionalString(record.ontology, "SchemaField.ontology"),
    description: assertString(record.description, "SchemaField.description"),
    derivation_policy: assertOptionalString(
      record.derivation_policy,
      "SchemaField.derivation_policy",
    ),
  };
  if (record.nullable !== undefined) {
    return { ...parsed, nullable: assertBoolean(record.nullable, "SchemaField.nullable") };
  }
  return parsed;
}

const SCHEMA_FIELD_V2_KEYS = [
  "schema_version",
  "name",
  "data_type",
  "semantic_role",
  "required",
  "nullable",
  "unit_policy",
  "ontology",
  "description",
  "derivation_policy",
] as const;

export function parseSchemaFieldV2(value: unknown): SchemaFieldV2 {
  const record = assertRecord(value, "SchemaFieldV2");
  assertExactKeys(record, SCHEMA_FIELD_V2_KEYS, "SchemaFieldV2");
  if (record.schema_version !== "2.0") throw new TypeError("SchemaFieldV2.schema_version must be 2.0");
  return {
    schema_version: "2.0",
    name: assertNonEmptyString(record.name, "SchemaFieldV2.name"),
    data_type: assertNonEmptyString(record.data_type, "SchemaFieldV2.data_type"),
    semantic_role: assertNonEmptyString(record.semantic_role, "SchemaFieldV2.semantic_role"),
    required: assertBoolean(record.required, "SchemaFieldV2.required"),
    nullable: assertBoolean(record.nullable, "SchemaFieldV2.nullable"),
    unit_policy: assertOptionalString(record.unit_policy, "SchemaFieldV2.unit_policy"),
    ontology: assertOptionalString(record.ontology, "SchemaFieldV2.ontology"),
    description: assertString(record.description, "SchemaFieldV2.description"),
    derivation_policy: assertOptionalString(record.derivation_policy, "SchemaFieldV2.derivation_policy"),
  };
}

export interface DatasetSchema {
  schema_version?: SchemaVersion | "2.0";
  schema_id: string;
  dataset_family: string;
  row_granularity: string;
  primary_key: string[];
  fields: SchemaField[];
}

const DATASET_SCHEMA_KEYS = [
  "schema_version",
  "schema_id",
  "dataset_family",
  "row_granularity",
  "primary_key",
  "fields",
] as const;

export function parseDatasetSchema(value: unknown): DatasetSchema {
  const record = assertRecord(value, "DatasetSchema");
  assertExactKeys(record, DATASET_SCHEMA_KEYS, "DatasetSchema");
  const fields = (() => {
    if (!Array.isArray(record.fields) || record.fields.length === 0) {
      throw new TypeError("DatasetSchema.fields must be a non-empty array");
    }
    return record.fields.map((field) => parseSchemaField(field));
  })();
  const names = fields.map((field) => field.name);
  if (new Set(names).size !== names.length) {
    throw new TypeError("DatasetSchema field names must be unique");
  }
  const primaryKey = assertStringArray(record.primary_key, "DatasetSchema.primary_key");
  if (primaryKey.length === 0) {
    throw new TypeError("DatasetSchema.primary_key must be a non-empty array");
  }
  const missing = primaryKey.filter((key) => !names.includes(key));
  if (missing.length > 0) {
    throw new TypeError(
      `DatasetSchema primary_key fields missing from fields: ${missing.join(", ")}`,
    );
  }
  return {
    schema_version: parseSchemaVersion(record),
    schema_id: assertNonEmptyString(record.schema_id, "DatasetSchema.schema_id"),
    dataset_family: assertNonEmptyString(record.dataset_family, "DatasetSchema.dataset_family"),
    row_granularity: assertNonEmptyString(record.row_granularity, "DatasetSchema.row_granularity"),
    primary_key: primaryKey,
    fields,
  };
}

const DATASET_SCHEMA_V2_KEYS = [
  "schema_version",
  "schema_id",
  "dataset_family",
  "row_granularity",
  "primary_key",
  "fields",
] as const;

export function parseDatasetSchemaV2(value: unknown): DatasetSchemaV2 {
  const record = assertRecord(value, "DatasetSchemaV2");
  assertExactKeys(record, DATASET_SCHEMA_V2_KEYS, "DatasetSchemaV2");
  if (record.schema_version !== "2.0") throw new TypeError("DatasetSchemaV2.schema_version must be 2.0");
  if (!Array.isArray(record.fields) || record.fields.length === 0) throw new TypeError("DatasetSchemaV2.fields must be non-empty");
  const fields = record.fields.map(parseSchemaFieldV2);
  const names = fields.map((field) => field.name);
  if (new Set(names).size !== names.length) throw new TypeError("DatasetSchemaV2 field names must be unique");
  const primaryKey = assertStringArray(record.primary_key, "DatasetSchemaV2.primary_key");
  if (primaryKey.length === 0 || primaryKey.some((key) => !names.includes(key))) throw new TypeError("DatasetSchemaV2.primary_key must be non-empty and reference declared fields");
  return {
    schema_version: "2.0",
    schema_id: assertNonEmptyString(record.schema_id, "DatasetSchemaV2.schema_id"),
    dataset_family: assertNonEmptyString(record.dataset_family, "DatasetSchemaV2.dataset_family"),
    row_granularity: assertNonEmptyString(record.row_granularity, "DatasetSchemaV2.row_granularity"),
    primary_key: primaryKey,
    fields,
  };
}
