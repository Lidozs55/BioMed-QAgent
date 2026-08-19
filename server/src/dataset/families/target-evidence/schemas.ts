import type {
  DatasetSchemaV2,
  RelationDefinition,
  TableDefinition,
} from "@biomed/contracts";
import {
  buildBiomedicalRelation,
  buildEntityTable,
  buildSourceTable,
} from "../../schema/common/index.js";
import {
  parseDatasetSchemaV2,
  parseTableDefinition,
  type MultiTableValidationPolicy,
} from "../../contracts/index.js";

export const TARGET_EVIDENCE_FAMILY_ID = "target_evidence";
export const TARGET_EVIDENCE_ROW_GRANULARITY = "one target identity";

const TARGET_SCHEMA_REF = "target_evidence.target.v1";
const EVIDENCE_SCHEMA_REF = "target_evidence.evidence.v1";
const SOURCE_SCHEMA_REF = "target_evidence.source.v1";
const SUPPORTING_SCHEMA_REF = "target_evidence.supporting.v1";

function field(
  name: string,
  options: {
    dataType?: string;
    semanticRole?: string;
    required?: boolean;
    nullable?: boolean;
    ontology?: string | null;
    description: string;
  },
) {
  return {
    schema_version: "2.0" as const,
    name,
    data_type: options.dataType ?? "string",
    semantic_role: options.semanticRole ?? "attribute",
    required: options.required ?? true,
    nullable: options.nullable ?? false,
    unit_policy: null,
    ontology: options.ontology ?? null,
    description: options.description,
    derivation_policy: null,
  };
}

function optionalField(
  name: string,
  options: Parameters<typeof field>[1],
) {
  return field(name, { ...options, required: false, nullable: true });
}

export const targetSchema: DatasetSchemaV2 = buildEntityTable({
  datasetFamily: TARGET_EVIDENCE_FAMILY_ID,
  schemaId: TARGET_SCHEMA_REF,
  rowGranularity: TARGET_EVIDENCE_ROW_GRANULARITY,
  tableId: "targets",
  role: "primary",
}).schema;

export const evidenceSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: EVIDENCE_SCHEMA_REF,
  dataset_family: TARGET_EVIDENCE_FAMILY_ID,
  row_granularity: "one target evidence assertion",
  primary_key: ["evidence_id"],
  fields: [
    field("evidence_id", {
      semanticRole: "row_identifier",
      description: "Stable identifier for one evidence assertion.",
    }),
    field("target_id", {
      semanticRole: "foreign_key",
      description: "Identifier of the asserted target.",
    }),
    field("target_namespace", {
      semanticRole: "identifier_namespace",
      ontology: "biomed:id_namespace.v1",
      description: "Controlled namespace for target_id.",
    }),
    field("evidence_type", {
      semanticRole: "evidence_type",
      description: "Type of target evidence, such as disease association or mechanism.",
    }),
    field("assertion", {
      semanticRole: "evidence_assertion",
      description: "Normalized assertion made about the target.",
    }),
    optionalField("evidence_value", {
      dataType: "json",
      semanticRole: "evidence_measurement",
      description: "Structured value supporting the assertion when present.",
    }),
    field("source_id", {
      semanticRole: "foreign_key",
      description: "Source carrier record supporting the assertion.",
    }),
    field("source_locator", {
      dataType: "json",
      semanticRole: "source_locator",
      description: "Locator for the exact source record or field.",
    }),
  ],
});

export const sourceSchema: DatasetSchemaV2 = buildSourceTable({
  datasetFamily: TARGET_EVIDENCE_FAMILY_ID,
  schemaId: SOURCE_SCHEMA_REF,
  rowGranularity: "one target evidence source carrier",
  tableId: "sources",
  role: "supporting",
}).schema;

export const supportingSchema: DatasetSchemaV2 = parseDatasetSchemaV2({
  schema_version: "2.0",
  schema_id: SUPPORTING_SCHEMA_REF,
  dataset_family: TARGET_EVIDENCE_FAMILY_ID,
  row_granularity: "one supporting target evidence assertion",
  primary_key: ["supporting_id"],
  fields: [
    field("supporting_id", {
      semanticRole: "row_identifier",
      description: "Stable identifier for a supporting assertion.",
    }),
    field("evidence_id", {
      semanticRole: "foreign_key",
      description: "Evidence assertion supported by this record.",
    }),
    field("supporting_type", {
      semanticRole: "supporting_evidence_type",
      description: "Supporting record type, such as target annotation or trial result.",
    }),
    field("supporting_value", {
      dataType: "json",
      semanticRole: "supporting_evidence",
      description: "Structured supporting value; source-specific payload remains normalized JSON.",
    }),
    field("source_id", {
      semanticRole: "foreign_key",
      description: "Source carrier record for the supporting assertion.",
    }),
  ],
});

export const targetEvidenceTableSchemas = Object.freeze({
  targets: targetSchema,
  evidence: evidenceSchema,
  sources: sourceSchema,
  supporting: supportingSchema,
});

export const TARGET_SOURCE_DATABASES = ["uniprot", "ncbi_clinvar", "clinicaltrials_gov"] as const;
export type TargetEvidenceSourceDatabase = typeof TARGET_SOURCE_DATABASES[number];

export function isTargetEvidenceSourceDatabase(value: string): value is TargetEvidenceSourceDatabase {
  return TARGET_SOURCE_DATABASES.includes(value as TargetEvidenceSourceDatabase);
}

export const targetEvidenceRelations: readonly RelationDefinition[] = Object.freeze([
  buildBiomedicalRelation({
    relationType: "entity_identity_link",
    relationId: "target_evidence_target",
    fromTableId: "evidence",
    fromFields: ["target_id", "target_namespace"],
    toTableId: "targets",
    toFields: ["entity_id", "entity_namespace"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
  buildBiomedicalRelation({
    relationType: "entity_identity_link",
    relationId: "target_evidence_target_source",
    fromTableId: "targets",
    fromFields: ["source_id"],
    toTableId: "sources",
    toFields: ["source_id"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
  buildBiomedicalRelation({
    relationType: "entity_identity_link",
    relationId: "target_evidence_source",
    fromTableId: "evidence",
    fromFields: ["source_id"],
    toTableId: "sources",
    toFields: ["source_id"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
  buildBiomedicalRelation({
    relationType: "entity_identity_link",
    relationId: "target_evidence_supporting",
    fromTableId: "supporting",
    fromFields: ["evidence_id"],
    toTableId: "evidence",
    toFields: ["evidence_id"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
  buildBiomedicalRelation({
    relationType: "entity_identity_link",
    relationId: "target_evidence_supporting_source",
    fromTableId: "supporting",
    fromFields: ["source_id"],
    toTableId: "sources",
    toFields: ["source_id"],
    cardinality: "many_to_one",
    missingPolicy: "reject",
  }),
]);

export const targetEvidenceSchemas = Object.freeze([
  targetSchema,
  evidenceSchema,
  sourceSchema,
  supportingSchema,
]);

export function targetEvidenceTableDefinitions(): TableDefinition[] {
  return [
    buildEntityTable({
      datasetFamily: TARGET_EVIDENCE_FAMILY_ID,
      schemaId: TARGET_SCHEMA_REF,
      rowGranularity: TARGET_EVIDENCE_ROW_GRANULARITY,
      tableId: "targets",
      role: "primary",
    }).definition,
    parseTableDefinition({
      table_id: "evidence",
      schema_ref: evidenceSchema.schema_id,
      role: "supporting",
      required: true,
      allow_empty: false,
      primary_key: [...evidenceSchema.primary_key],
      field_names: evidenceSchema.fields.map((item) => item.name),
    }),
    buildSourceTable({
      datasetFamily: TARGET_EVIDENCE_FAMILY_ID,
      schemaId: SOURCE_SCHEMA_REF,
      rowGranularity: "one target evidence source carrier",
      tableId: "sources",
      role: "supporting",
    }).definition,
    parseTableDefinition({
      table_id: "supporting",
      schema_ref: supportingSchema.schema_id,
      role: "supporting",
      required: true,
      allow_empty: true,
      primary_key: [...supportingSchema.primary_key],
      field_names: supportingSchema.fields.map((item) => item.name),
    }),
  ];
}

export function targetEvidenceValidationPolicy(): MultiTableValidationPolicy {
  return {
    token_preservation_rules: [],
    profile_relation_missing_policies: {},
  };
}
