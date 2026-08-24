import type { DatasetSchemaV2, SchemaFieldV2 } from "@biomed/contracts";

import type { DatasetSchema, SchemaField } from "../contracts/index.js";
import {
  parseDatasetSchema,
  parseDatasetSchemaV2,
  SCHEMA_VERSION,
} from "../contracts/index.js";
import {
  EXPRESSION_FAMILY_FIELDS,
  EXPRESSION_PRIMARY_KEY,
  FIELD_DESCRIPTIONS,
  PROBE_EXPRESSION_FIELDS,
  PROBE_FIELD_META,
  PROBE_PRIMARY_KEY,
  inferOntology,
  inferSemanticRole,
} from "./fields.js";

function makeField(
  name: string,
  dataType: string,
  description: string,
  required: boolean,
  semanticRole: string,
  unitPolicy: string | null,
  ontology: string | null,
): SchemaField {
  return {
    schema_version: SCHEMA_VERSION,
    name,
    data_type: dataType,
    semantic_role: semanticRole,
    required,
    unit_policy: unitPolicy,
    ontology,
    description,
    derivation_policy: null,
  };
}

function fieldFromGeneTable(name: string): SchemaField {
  const description = FIELD_DESCRIPTIONS[name];
  return makeField(
    name,
    description.dataType,
    description.description,
    description.required,
    inferSemanticRole(name),
    name === "expression_value" ? "declared_per_record" : null,
    inferOntology(name),
  );
}

interface ExpressionSchemaArgs {
  schemaId: string;
  datasetFamily: string;
  rowGranularity: string;
  primaryKey: readonly string[];
  fields: SchemaField[];
}

function finishExpressionSchema(args: ExpressionSchemaArgs): DatasetSchema {
  const fields = args.fields.map((field) =>
    field.name === "source_sample_alias" ? { ...field, required: false } : field,
  );
  return parseDatasetSchema({
    schema_version: SCHEMA_VERSION,
    schema_id: args.schemaId,
    dataset_family: args.datasetFamily,
    row_granularity: args.rowGranularity,
    primary_key: [...args.primaryKey],
    fields,
  });
}

export function buildGeneExpressionSchema(): DatasetSchema {
  return finishExpressionSchema({
    schemaId: "gene_expression.long.v1",
    datasetFamily: "gene_expression",
    rowGranularity: "gene_sample_measurement",
    primaryKey: EXPRESSION_PRIMARY_KEY,
    fields: EXPRESSION_FAMILY_FIELDS.map((name) => fieldFromGeneTable(name)),
  });
}

export function buildProbeExpressionSchema(): DatasetSchema {
  const fields = PROBE_EXPRESSION_FIELDS.map((name) => {
    const meta = PROBE_FIELD_META[name];
    if (meta !== undefined) {
      return makeField(
        name,
        meta.dataType,
        meta.description,
        true,
        meta.semanticRole,
        name === "value" ? "declared_per_record" : null,
        inferOntology(name),
      );
    }
    const description = FIELD_DESCRIPTIONS[name];
    return makeField(
      name,
      description.dataType,
      description.description,
      description.required,
      inferSemanticRole(name),
      null,
      inferOntology(name),
    );
  });
  return finishExpressionSchema({
    schemaId: "gene_expression.probe_long.v1",
    datasetFamily: "gene_expression",
    rowGranularity: "probe_sample_measurement",
    primaryKey: PROBE_PRIMARY_KEY,
    fields,
  });
}

function revisionIdentityField(): SchemaFieldV2 {
  return {
    schema_version: "2.0",
    name: "dataset_revision_id",
    data_type: "string",
    semantic_role: "foreign_key",
    required: true,
    nullable: false,
    unit_policy: null,
    ontology: null,
    description:
      "Content-addressed dataset revision identity derived from dataset identity, provider snapshot, and carrier assets",
    derivation_policy: "core_owned_dataset_revision_identity.v1",
  };
}

function v2Field(field: SchemaField): SchemaFieldV2 {
  return {
    schema_version: "2.0",
    name: field.name,
    data_type: field.data_type,
    semantic_role: field.semantic_role,
    required: field.required,
    nullable: !field.required,
    unit_policy: field.unit_policy,
    ontology: field.ontology,
    description: field.description,
    derivation_policy: field.derivation_policy,
  };
}

function revisionScopedFields(schema: DatasetSchema): SchemaFieldV2[] {
  const fields = schema.fields.map(v2Field);
  const datasetIdIndex = fields.findIndex((field) => field.name === "dataset_id");
  if (datasetIdIndex < 0) {
    throw new TypeError("expression schema must declare dataset_id before revision scoping");
  }
  fields.splice(datasetIdIndex + 1, 0, revisionIdentityField());
  return fields;
}

/**
 * Revision-scoped Family Host target schema. It is registered only alongside
 * the Core identity derivation path; V1 remains the production/golden
 * compatibility path.
 */
export function buildGeneExpressionSchemaV2(): DatasetSchemaV2 {
  return parseDatasetSchemaV2({
    schema_version: "2.0",
    schema_id: "gene_expression.long.v2",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    primary_key: [
      "dataset_revision_id",
      "sample_id",
      "gene_id",
      "measurement_type",
    ],
    fields: revisionScopedFields(buildGeneExpressionSchema()),
  });
}

/** Probe-level V2 target with revision-scoped composite identity. */
export function buildProbeExpressionSchemaV2(): DatasetSchemaV2 {
  return parseDatasetSchemaV2({
    schema_version: "2.0",
    schema_id: "gene_expression.probe_long.v2",
    dataset_family: "gene_expression",
    row_granularity: "probe_sample_measurement",
    primary_key: [
      "dataset_revision_id",
      "probe_id",
      "platform_id",
      "sample_id",
    ],
    fields: revisionScopedFields(buildProbeExpressionSchema()),
  });
}
