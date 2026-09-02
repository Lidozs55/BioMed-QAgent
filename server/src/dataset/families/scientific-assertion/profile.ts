import type { Projection, TableDefinition } from "@biomed/contracts";

import { parseTableDefinition } from "../../contracts/index.js";

export const SCIENTIFIC_ASSERTION_FAMILY_ID = "scientific_assertion";
export const SCIENTIFIC_ASSERTION_PROFILE_REF =
  "scientific_assertion.table.release.v1";
export const SCIENTIFIC_ASSERTION_PROJECTION_ID =
  "scientific_assertion.assertion_table.v1";

function table(options: {
  tableId: string;
  schemaRef: string;
  role: TableDefinition["role"];
  primaryKey: readonly string[];
  fields: readonly string[];
  allowEmpty?: boolean;
}): TableDefinition {
  return parseTableDefinition({
    table_id: options.tableId,
    schema_ref: options.schemaRef,
    role: options.role,
    required: true,
    allow_empty: options.allowEmpty ?? false,
    primary_key: [...options.primaryKey],
    field_names: [...options.fields],
  });
}

/**
 * Generic flat assertion-table topology (gold7/gold8 shape): one primary
 * assertion table plus one optional supporting study table. No chart tables,
 * no VLM locators, and no review/confidence fields, so the dynamic
 * publication_acceptance HIL gate never applies to this profile.
 */
export const scientificAssertionTables: readonly TableDefinition[] = Object.freeze([
  table({
    tableId: "assertion_records",
    schemaRef: "scientific_assertion.assertion_records.v1",
    role: "primary",
    primaryKey: ["assertion_id"],
    fields: [
      "assertion_id", "subject", "predicate", "object", "value", "unit",
      "study_id", "source_url",
    ],
  }),
  table({
    tableId: "study_records",
    schemaRef: "scientific_assertion.study_records.v1",
    role: "supporting",
    primaryKey: ["study_id"],
    fields: [
      "study_id", "study_type", "design", "population", "sample_size",
      "source_url",
    ],
    allowEmpty: true,
  }),
]);

export const scientificAssertionProjection: Projection = Object.freeze({
  projection_id: SCIENTIFIC_ASSERTION_PROJECTION_ID,
  schema_version: "2.0",
  primary_tables: ["assertion_records"],
  supporting_tables: ["study_records"],
  derived_tables: [],
  required: scientificAssertionTables.map((item) => item.table_id),
  optional: [],
  allow_empty: ["study_records"],
  relations: [],
  row_granularity: "scientific_assertion",
  compatibility_dimensions: ["predicate", "unit"],
  merge_identity_fields: ["assertion_id"],
  validation_policy_ref: "scientific_assertion.validation.v1",
  assessment_policy_ref: SCIENTIFIC_ASSERTION_PROFILE_REF,
});
