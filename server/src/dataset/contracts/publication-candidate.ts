import type {
  OperationResultOutputKind,
  PublicationCandidate,
  PublicationCandidateResultRef,
  PublicationCandidateTable,
} from "@biomed/contracts";
import {
  assertExactKeys,
  assertNonEmptyString,
  assertNonNegativeInt,
  assertRecord,
  assertSafeId,
  assertSha256,
  assertStringArray,
} from "./primitives.js";
import {
  parseRelationDefinition,
  parseTableDefinition,
} from "./multitable.js";

const RESULT_OUTPUT_KINDS = new Set<OperationResultOutputKind>([
  "source_asset",
  "parsed_table",
  "canonical_table",
  "compatibility_report",
  "integrated_table",
  "publication_candidate",
  "derived_evidence",
  "validation_result",
  "publication_manifest",
]);
const RESULT_REF_KEYS = [
  "result_manifest_id",
  "output_kind",
  "output_file_index",
  "output_file_sha256",
] as const;
const TABLE_KEYS = ["definition", "data_ref", "row_count"] as const;
const CANDIDATE_KEYS = [
  "schema_version",
  "candidate_id",
  "task_id",
  "build_id",
  "dataset_family",
  "row_granularity",
  "tables",
  "relations",
  "provenance_refs",
  "confidence_refs",
  "audit_refs",
  "registered_asset_ids",
] as const;

function unique<T>(values: T[], name: string, key: (value: T) => string): T[] {
  const keys = values.map(key);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError(`${name} must not contain duplicates`);
  }
  return values;
}

function parseOutputKind(value: unknown): OperationResultOutputKind {
  const kind = assertNonEmptyString(value, "PublicationCandidateResultRef.output_kind");
  if (!RESULT_OUTPUT_KINDS.has(kind as OperationResultOutputKind)) {
    throw new TypeError("PublicationCandidateResultRef.output_kind is invalid");
  }
  return kind as OperationResultOutputKind;
}

export function parsePublicationCandidateResultRef(
  value: unknown,
): PublicationCandidateResultRef {
  const record = assertRecord(value, "PublicationCandidateResultRef");
  assertExactKeys(record, RESULT_REF_KEYS, "PublicationCandidateResultRef");
  return {
    result_manifest_id: assertSafeId(
      record.result_manifest_id,
      "PublicationCandidateResultRef.result_manifest_id",
    ),
    output_kind: parseOutputKind(record.output_kind),
    output_file_index: assertNonNegativeInt(
      record.output_file_index,
      "PublicationCandidateResultRef.output_file_index",
    ),
    output_file_sha256: assertSha256(
      record.output_file_sha256,
      "PublicationCandidateResultRef.output_file_sha256",
    ),
  };
}

export function parsePublicationCandidateTable(
  value: unknown,
): PublicationCandidateTable {
  const record = assertRecord(value, "PublicationCandidateTable");
  assertExactKeys(record, TABLE_KEYS, "PublicationCandidateTable");
  return {
    definition: parseTableDefinition(record.definition),
    data_ref: parsePublicationCandidateResultRef(record.data_ref),
    row_count: assertNonNegativeInt(
      record.row_count,
      "PublicationCandidateTable.row_count",
    ),
  };
}

export function parsePublicationCandidate(value: unknown): PublicationCandidate {
  const record = assertRecord(value, "PublicationCandidate");
  assertExactKeys(record, CANDIDATE_KEYS, "PublicationCandidate");
  if (record.schema_version !== "1.0") {
    throw new TypeError("PublicationCandidate.schema_version must be 1.0");
  }
  if (!Array.isArray(record.tables) || record.tables.length === 0) {
    throw new TypeError("PublicationCandidate.tables must be a non-empty array");
  }
  const tables = unique(
    record.tables.map(parsePublicationCandidateTable),
    "PublicationCandidate table IDs",
    (table) => table.definition.table_id,
  );
  if (tables.filter((table) => table.definition.role === "primary").length !== 1) {
    throw new TypeError("PublicationCandidate must declare exactly one primary table");
  }
  for (const table of tables) {
    if (table.definition.required && !table.definition.allow_empty && table.row_count === 0) {
      throw new TypeError(`required table '${table.definition.table_id}' must not be empty`);
    }
  }
  if (!Array.isArray(record.relations)) {
    throw new TypeError("PublicationCandidate.relations must be an array");
  }
  const relations = unique(
    record.relations.map(parseRelationDefinition),
    "PublicationCandidate relation IDs",
    (relation) => relation.relation_id,
  );
  const tableMap = new Map(tables.map((table) => [table.definition.table_id, table]));
  for (const relation of relations) {
    const from = tableMap.get(relation.from_table_id)?.definition;
    const to = tableMap.get(relation.to_table_id)?.definition;
    if (from === undefined || to === undefined) {
      throw new TypeError(`relation references unknown table: ${relation.relation_id}`);
    }
    if (
      relation.from_fields.some((field) => !from.field_names.includes(field)) ||
      relation.to_fields.some((field) => !to.field_names.includes(field))
    ) {
      throw new TypeError(`relation references unknown field: ${relation.relation_id}`);
    }
  }
  const resultRefs = (field: string, value: unknown): PublicationCandidateResultRef[] => {
    if (!Array.isArray(value)) throw new TypeError(`PublicationCandidate.${field} must be an array`);
    return unique(
      value.map(parsePublicationCandidateResultRef),
      `PublicationCandidate.${field}`,
      (ref) => `${ref.result_manifest_id}\0${ref.output_file_index}`,
    );
  };
  const registeredAssetIds = unique(
    assertStringArray(
      record.registered_asset_ids,
      "PublicationCandidate.registered_asset_ids",
    ).map((assetId, index) => {
      const parsed = assertSafeId(
        assetId,
        `PublicationCandidate.registered_asset_ids[${index}]`,
      );
      if (!/^asset_[0-9a-f]{64}$/.test(parsed)) {
        throw new TypeError("PublicationCandidate registered assets must be content-addressed asset IDs");
      }
      return parsed;
    }),
    "PublicationCandidate.registered_asset_ids",
    (assetId) => assetId,
  );
  return {
    schema_version: "1.0",
    candidate_id: assertSafeId(record.candidate_id, "PublicationCandidate.candidate_id"),
    task_id: assertSafeId(record.task_id, "PublicationCandidate.task_id"),
    build_id: assertSafeId(record.build_id, "PublicationCandidate.build_id"),
    dataset_family: assertNonEmptyString(
      record.dataset_family,
      "PublicationCandidate.dataset_family",
    ),
    row_granularity: assertNonEmptyString(
      record.row_granularity,
      "PublicationCandidate.row_granularity",
    ),
    tables,
    relations,
    provenance_refs: resultRefs("provenance_refs", record.provenance_refs),
    confidence_refs: resultRefs("confidence_refs", record.confidence_refs),
    audit_refs: resultRefs("audit_refs", record.audit_refs),
    registered_asset_ids: registeredAssetIds,
  };
}
