/**
 * Versioned Schema Registry (Python ``backend/app/datasets/schema_registry.py``):
 * in-memory registry of canonical ``DatasetSchema`` objects plus the two
 * built-in expression schemas. Semantics mirror the Python class: registering
 * a different schema under an existing id raises, identical re-registration is
 * idempotent, ``get`` on an unknown id raises, ``list`` is sorted.
 */

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

/** Order-sensitive deep equality over JSON-compatible objects (Python ``!=``). */
export function schemasDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => schemasDeepEqual(item, b[index]));
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const aKeys = Object.keys(aRecord).sort();
  const bKeys = Object.keys(bRecord).sort();
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key, index) => {
    if (key !== bKeys[index]) return false;
    return schemasDeepEqual(aRecord[key], bRecord[key]);
  });
}

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

/** Build ``gene_expression.long.v1`` (Python ``build_gene_expression_schema``). */
export function buildGeneExpressionSchema(): DatasetSchema {
  return finishExpressionSchema({
    schemaId: "gene_expression.long.v1",
    datasetFamily: "gene_expression",
    rowGranularity: "gene_sample_measurement",
    primaryKey: EXPRESSION_PRIMARY_KEY,
    fields: EXPRESSION_FAMILY_FIELDS.map((name) => fieldFromGeneTable(name)),
  });
}

/** Build ``gene_expression.probe_long.v1`` (Python ``build_probe_expression_schema``). */
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

/** In-memory versioned registry of canonical dataset schemas. */
export class SchemaRegistry {
  private readonly schemas = new Map<string, DatasetSchema>();

  constructor(initial: readonly DatasetSchema[] = []) {
    for (const schema of initial) this.register(schema);
  }

  register(schema: DatasetSchema): void {
    const existing = this.schemas.get(schema.schema_id);
    if (existing !== undefined && !schemasDeepEqual(existing, schema)) {
      throw new Error(`schema '${schema.schema_id}' already registered`);
    }
    this.schemas.set(schema.schema_id, schema);
  }

  contains(schemaId: string): boolean {
    return this.schemas.has(schemaId);
  }

  get(schemaId: string): DatasetSchema {
    const schema = this.schemas.get(schemaId);
    if (schema === undefined) {
      throw new Error(`schema '${schemaId}' is not registered`);
    }
    return schema;
  }

  list(): string[] {
    return [...this.schemas.keys()].sort();
  }
}

/** Production default registry (Python ``_build_schema_registry``). */
export function createDefaultSchemaRegistry(): SchemaRegistry {
  return new SchemaRegistry([buildGeneExpressionSchema(), buildProbeExpressionSchema()]);
}