/**
 * Versioned canonical dataset schema contracts (Python ``DatasetSchema`` /
 * ``SchemaField``). Registered schemas are the Schema Registry's payload
 * (migration plan Phase 4 step 2).
 */

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
  schema_version?: SchemaVersion;
  name: string;
  data_type: string;
  semantic_role: string;
  required: boolean;
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
  "unit_policy",
  "ontology",
  "description",
  "derivation_policy",
] as const;

export function parseSchemaField(value: unknown): SchemaField {
  const record = assertRecord(value, "SchemaField");
  assertExactKeys(record, SCHEMA_FIELD_KEYS, "SchemaField");
  return {
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
}

export interface DatasetSchema {
  schema_version?: SchemaVersion;
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
    dataset_family: assertNonEmptyString(
      record.dataset_family,
      "DatasetSchema.dataset_family",
    ),
    row_granularity: assertNonEmptyString(
      record.row_granularity,
      "DatasetSchema.row_granularity",
    ),
    primary_key: primaryKey,
    fields,
  };
}
