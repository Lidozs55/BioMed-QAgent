import type {
  DatasetManifestV2,
  PublicationCandidateRef,
  RelationCardinality,
  RelationDefinition,
  RelationMissingPolicy,
  TableDefinition,
  TableRole,
} from "@biomed/contracts";
import {
  assertBoolean,
  assertExactKeys,
  assertJsonRecord,
  assertNonEmptyString,
  assertNonNegativeInt,
  assertRecord,
  assertSafeId,
  assertSha256,
  assertStringArray,
} from "./primitives.js";
import { parseManifestArtifactEntry } from "./manifest.js";

const TABLE_ROLES = new Set<TableRole>(["primary", "supporting", "derived"]);
const CARDINALITIES = new Set<RelationCardinality>(["one_to_one", "one_to_many", "many_to_one", "many_to_many"]);
const MISSING_POLICIES = new Set<RelationMissingPolicy>(["reject", "allow_empty", "allow_missing", "profile_defined"]);

const TABLE_KEYS = ["table_id", "schema_ref", "role", "required", "allow_empty", "primary_key", "field_names"] as const;
const RELATION_KEYS = ["relation_id", "from_table_id", "from_fields", "to_table_id", "to_fields", "cardinality", "missing_policy"] as const;
const CANDIDATE_KEYS = ["candidate_id", "table_ids", "relation_ids", "provenance_refs", "confidence_refs", "audit_refs"] as const;

function unique(values: string[], name: string): string[] {
  if (new Set(values).size !== values.length) throw new TypeError(`${name} must not contain duplicates`);
  return values;
}
function id(value: unknown, name: string): string { return assertSafeId(value, name); }
function enumValue<T extends string>(value: unknown, values: Set<T>, name: string): T {
  const text = assertNonEmptyString(value, name);
  if (!values.has(text as T)) throw new TypeError(`${name} is invalid`);
  return text as T;
}

export function parseTableDefinition(value: unknown): TableDefinition {
  const record = assertRecord(value, "TableDefinition");
  assertExactKeys(record, TABLE_KEYS, "TableDefinition");
  const fieldNames = unique(assertStringArray(record.field_names, "TableDefinition.field_names"), "TableDefinition.field_names");
  if (fieldNames.length === 0) throw new TypeError("TableDefinition.field_names must be non-empty");
  const primaryKey = unique(assertStringArray(record.primary_key, "TableDefinition.primary_key"), "TableDefinition.primary_key");
  if (primaryKey.length === 0 || primaryKey.some((field) => !fieldNames.includes(field))) {
    throw new TypeError("TableDefinition.primary_key must be non-empty and reference declared fields");
  }
  return {
    table_id: id(record.table_id, "TableDefinition.table_id"),
    schema_ref: assertNonEmptyString(record.schema_ref, "TableDefinition.schema_ref"),
    role: enumValue(record.role, TABLE_ROLES, "TableDefinition.role"),
    required: assertBoolean(record.required, "TableDefinition.required"),
    allow_empty: assertBoolean(record.allow_empty, "TableDefinition.allow_empty"),
    primary_key: primaryKey,
    field_names: fieldNames,
  };
}

export function parseRelationDefinition(value: unknown): RelationDefinition {
  const record = assertRecord(value, "RelationDefinition");
  assertExactKeys(record, RELATION_KEYS, "RelationDefinition");
  const fromFields = unique(assertStringArray(record.from_fields, "RelationDefinition.from_fields"), "RelationDefinition.from_fields");
  const toFields = unique(assertStringArray(record.to_fields, "RelationDefinition.to_fields"), "RelationDefinition.to_fields");
  if (fromFields.length === 0 || fromFields.length !== toFields.length) throw new TypeError("RelationDefinition field arity must match and be non-empty");
  return {
    relation_id: id(record.relation_id, "RelationDefinition.relation_id"),
    from_table_id: id(record.from_table_id, "RelationDefinition.from_table_id"),
    from_fields: fromFields,
    to_table_id: id(record.to_table_id, "RelationDefinition.to_table_id"),
    to_fields: toFields,
    cardinality: enumValue(record.cardinality, CARDINALITIES, "RelationDefinition.cardinality"),
    missing_policy: enumValue(record.missing_policy, MISSING_POLICIES, "RelationDefinition.missing_policy"),
  };
}

export function parsePublicationCandidateRef(value: unknown): PublicationCandidateRef {
  const record = assertRecord(value, "PublicationCandidateRef");
  assertExactKeys(record, CANDIDATE_KEYS, "PublicationCandidateRef");
  const tableIds = assertStringArray(record.table_ids, "PublicationCandidateRef.table_ids");
  if (tableIds.length === 0) throw new TypeError("PublicationCandidateRef.table_ids must be non-empty");
  return {
    candidate_id: id(record.candidate_id, "PublicationCandidateRef.candidate_id"),
    table_ids: unique(tableIds.map((v, i) => id(v, `PublicationCandidateRef.table_ids[${i}]`)), "PublicationCandidateRef.table_ids"),
    relation_ids: unique(assertStringArray(record.relation_ids, "PublicationCandidateRef.relation_ids").map((v, i) => id(v, `PublicationCandidateRef.relation_ids[${i}]`)), "PublicationCandidateRef.relation_ids"),
    provenance_refs: unique(assertStringArray(record.provenance_refs, "PublicationCandidateRef.provenance_refs"), "PublicationCandidateRef.provenance_refs"),
    confidence_refs: unique(assertStringArray(record.confidence_refs, "PublicationCandidateRef.confidence_refs"), "PublicationCandidateRef.confidence_refs"),
    audit_refs: unique(assertStringArray(record.audit_refs, "PublicationCandidateRef.audit_refs"), "PublicationCandidateRef.audit_refs"),
  };
}

export interface MultiTableManifestParseOptions {
  knownSchemaRefs?: ReadonlySet<string>;
  schemaFieldsByRef?: ReadonlyMap<string, ReadonlySet<string>>;
}

export function parseDatasetManifestV2(
  value: Record<string, unknown>,
  options: MultiTableManifestParseOptions = {},
): DatasetManifestV2 {
  assertExactKeys(value, [
    "schema_version", "manifest_id", "task_id", "requirement_id", "dataset_family",
    "row_granularity", "schema_ref", "primary_key", "row_count", "sha256", "artifacts",
    "source_summary", "validation_summary", "confidence_summary", "provenance_summary",
    "tables", "relations", "candidate_refs",
  ], "DatasetManifest");
  if (value.schema_version !== "2.0") throw new TypeError("DatasetManifest v2 requires schema_version 2.0");
  const tables = (() => {
    if (!Array.isArray(value.tables) || value.tables.length === 0) throw new TypeError("DatasetManifest.tables must be a non-empty array");
    const parsed = value.tables.map(parseTableDefinition);
    if (new Set(parsed.map((table) => table.table_id)).size !== parsed.length) throw new TypeError("DatasetManifest table IDs must be unique");
    return parsed;
  })();
  if (tables.filter((table) => table.role === "primary").length === 0) throw new TypeError("DatasetManifest must declare a primary table");
  const tableMap = new Map(tables.map((table) => [table.table_id, table]));
  for (const table of tables) {
    if (options.knownSchemaRefs !== undefined && !options.knownSchemaRefs.has(table.schema_ref)) throw new TypeError(`unknown schema ref: ${table.schema_ref}`);
    const knownFields = options.schemaFieldsByRef?.get(table.schema_ref);
    if (knownFields !== undefined) {
      const unknown = table.field_names.filter((field) => !knownFields.has(field));
      if (unknown.length > 0) throw new TypeError(`unknown schema field(s) in ${table.table_id}: ${unknown.join(", ")}`);
    }
  }
  const relations = (() => {
    if (!Array.isArray(value.relations)) throw new TypeError("DatasetManifest.relations must be an array");
    const parsed = value.relations.map(parseRelationDefinition);
    if (new Set(parsed.map((relation) => relation.relation_id)).size !== parsed.length) throw new TypeError("DatasetManifest relation IDs must be unique");
    for (const relation of parsed) {
      const from = tableMap.get(relation.from_table_id);
      const to = tableMap.get(relation.to_table_id);
      if (from === undefined || to === undefined) throw new TypeError(`relation references unknown table: ${relation.relation_id}`);
      if (relation.from_fields.some((field) => !from.field_names.includes(field)) || relation.to_fields.some((field) => !to.field_names.includes(field))) throw new TypeError(`relation references unknown field: ${relation.relation_id}`);
    }
    return parsed;
  })();
  const candidates = (() => {
    if (!Array.isArray(value.candidate_refs) || value.candidate_refs.length === 0) throw new TypeError("DatasetManifest.candidate_refs must be a non-empty array");
    const parsed = value.candidate_refs.map(parsePublicationCandidateRef);
    if (new Set(parsed.map((candidate) => candidate.candidate_id)).size !== parsed.length) throw new TypeError("PublicationCandidateRef IDs must be unique");
    const relationIds = new Set(relations.map((relation) => relation.relation_id));
    for (const candidate of parsed) {
      if (candidate.table_ids.some((tableId) => !tableMap.has(tableId))) throw new TypeError(`candidate references unknown table: ${candidate.candidate_id}`);
      if (candidate.relation_ids.some((relationId) => !relationIds.has(relationId))) throw new TypeError(`candidate references unknown relation: ${candidate.candidate_id}`);
    }
    return parsed;
  })();
  const artifacts = (() => {
    if (!Array.isArray(value.artifacts)) throw new TypeError("DatasetManifest.artifacts must be an array");
    return value.artifacts.map(parseManifestArtifactEntry);
  })();
  if (artifacts.filter((entry) => entry.role === "primary_dataset").length > 1) throw new TypeError("manifest may declare at most one primary_dataset");
  return {
    schema_version: "2.0",
    manifest_id: assertNonEmptyString(value.manifest_id, "DatasetManifest.manifest_id"),
    task_id: assertNonEmptyString(value.task_id, "DatasetManifest.task_id"),
    requirement_id: assertNonEmptyString(value.requirement_id, "DatasetManifest.requirement_id"),
    dataset_family: assertNonEmptyString(value.dataset_family, "DatasetManifest.dataset_family"),
    row_granularity: assertNonEmptyString(value.row_granularity, "DatasetManifest.row_granularity"),
    schema_ref: assertNonEmptyString(value.schema_ref, "DatasetManifest.schema_ref"),
    primary_key: assertStringArray(value.primary_key, "DatasetManifest.primary_key"),
    row_count: assertNonNegativeInt(value.row_count, "DatasetManifest.row_count"),
    sha256: assertSha256(value.sha256, "DatasetManifest.sha256"),
    artifacts,
    source_summary: assertJsonRecord(value.source_summary, "DatasetManifest.source_summary"),
    validation_summary: assertJsonRecord(value.validation_summary, "DatasetManifest.validation_summary"),
    confidence_summary: assertJsonRecord(value.confidence_summary, "DatasetManifest.confidence_summary"),
    provenance_summary: assertJsonRecord(value.provenance_summary, "DatasetManifest.provenance_summary"),
    tables,
    relations,
    candidate_refs: candidates,
  };
}
