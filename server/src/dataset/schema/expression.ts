import type { DatasetSchema, SchemaField } from "../contracts/index.js";
import { parseDatasetSchema, SCHEMA_VERSION } from "../contracts/index.js";
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
