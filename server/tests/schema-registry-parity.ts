/**
 * Phase 4 step 2 (Schema Registry) parity checks: prove the TypeScript
 * ``buildGeneExpressionSchema`` reproduces the Python-generated golden
 * artifact (tests/migration/golden/succeeded/artifacts/schema.json), the
 * probe schema satisfies every invariant of the Python registry tests, and
 * the registry semantics match ``backend/tests/test_schema_registry.py``.
 *
 * Vitest-free so the same checks run under vitest and as a plain Node script.
 */

import type { DatasetSchema } from "../src/dataset/contracts/index.js";
import { parseDatasetSchema } from "../src/dataset/contracts/index.js";
import {
  SchemaRegistry,
  buildGeneExpressionSchema,
  buildProbeExpressionSchema,
  createDefaultSchemaRegistry,
  schemasDeepEqual,
} from "../src/dataset/schema/index.js";

function check(issues: string[], condition: boolean, message: string): void {
  if (!condition) issues.push(message);
}

function customSchema(required: boolean): DatasetSchema {
  return parseDatasetSchema({
    schema_id: "custom.v1",
    dataset_family: "custom",
    row_granularity: "custom_row",
    primary_key: ["id"],
    fields: [
      {
        name: "id",
        data_type: "string",
        semantic_role: "row_identifier",
        required,
        unit_policy: null,
        ontology: null,
        description: "",
        derivation_policy: null,
      },
    ],
  });
}

/** Gene-schema parity against the Python golden artifact. */
export function checkGeneSchemaParity(geneGolden: unknown): string[] {
  const issues: string[] = [];
  const gene = buildGeneExpressionSchema();
  check(
    issues,
    schemasDeepEqual(gene, geneGolden),
    "gene schema does not match the Python golden artifact",
  );
  try {
    const parsedGolden = parseDatasetSchema(geneGolden);
    check(
      issues,
      schemasDeepEqual(parsedGolden, gene),
      "gene schema does not round-trip through the parser",
    );
  } catch (error) {
    issues.push(
      `gene golden failed to parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return issues;
}

/** Probe-schema invariants mirroring backend/tests/test_schema_registry.py. */
export function checkProbeSchemaParity(): string[] {
  const issues: string[] = [];
  const schema = buildProbeExpressionSchema();
  check(issues, schema.schema_id === "gene_expression.probe_long.v1", "probe schema_id");
  check(issues, schema.dataset_family === "gene_expression", "probe dataset_family");
  check(
    issues,
    schema.row_granularity === "probe_sample_measurement",
    "probe row_granularity",
  );
  check(
    issues,
    schemasDeepEqual(schema.primary_key, ["probe_id", "platform_id", "sample_id"]),
    "probe primary_key",
  );
  const names = schema.fields.map((field) => field.name);
  check(issues, names.length === 21, "probe schema must carry 21 fields");
  check(issues, new Set(names).size === 21, "probe field names must be unique");
  for (const required of [
    "probe_id",
    "platform_id",
    "sample_id",
    "value",
    "gene_id_namespace",
    "value_semantics",
    "value_scale",
    "expression_unit",
    "is_normalized",
  ]) {
    check(issues, names.includes(required), `probe schema must carry '${required}'`);
  }
  for (const absent of ["gene_id", "gene_symbol", "ensembl_gene"]) {
    check(issues, !names.includes(absent), `probe schema must not carry '${absent}'`);
  }
  const byName = new Map(schema.fields.map((field) => [field.name, field]));
  for (const pk of ["probe_id", "platform_id", "sample_id"]) {
    check(issues, byName.get(pk)?.required === true, `probe '${pk}' must be required`);
  }
  check(issues, byName.get("value")?.unit_policy === "declared_per_record", "probe value unit_policy");
  check(issues, byName.get("value")?.data_type === "float", "probe value data_type");
  check(
    issues,
    byName.get("probe_id")?.semantic_role === "entity_identifier",
    "probe probe_id semantic_role",
  );
  check(
    issues,
    byName.get("platform_id")?.semantic_role === "attribute",
    "probe platform_id semantic_role",
  );
  check(
    issues,
    byName.get("gene_id_namespace")?.semantic_role === "entity_identifier",
    "probe gene_id_namespace semantic_role",
  );
  const optional = schema.fields
    .filter((field) => !field.required)
    .map((field) => field.name)
    .sort();
  check(
    issues,
    schemasDeepEqual(optional, ["source_sample_alias"]),
    `probe optional fields must be exactly ['source_sample_alias'], got ${JSON.stringify(optional)}`,
  );
  // The built schema must pass its own parser (unique names, PK coverage).
  try {
    const reparsed = parseDatasetSchema(schema);
    check(issues, schemasDeepEqual(reparsed, schema), "probe schema round-trip mismatch");
  } catch (error) {
    issues.push(
      `probe schema failed to parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return issues;
}

/** Registry behavior mirroring backend/tests/test_schema_registry.py. */
export function checkRegistrySemantics(): string[] {
  const issues: string[] = [];

  const registry = new SchemaRegistry();
  registry.register(customSchema(true));
  check(issues, registry.contains("custom.v1"), "registry.contains after register");
  check(issues, registry.get("custom.v1").dataset_family === "custom", "registry.get value");
  check(issues, schemasDeepEqual(registry.list(), ["custom.v1"]), "registry.list sorted");

  const duplicateDifferent = new SchemaRegistry([customSchema(true)]);
  let duplicateRejected = false;
  try {
    duplicateDifferent.register(customSchema(false));
  } catch (error) {
    duplicateRejected = error instanceof Error && error.message.includes("already registered");
  }
  check(issues, duplicateRejected, "different duplicate must be rejected");

  const duplicateIdentical = new SchemaRegistry();
  duplicateIdentical.register(customSchema(true));
  let identicalOk = true;
  try {
    duplicateIdentical.register(customSchema(true));
  } catch {
    identicalOk = false;
  }
  check(issues, identicalOk, "identical re-registration must be idempotent");

  const missing = new SchemaRegistry();
  let missingRejected = false;
  try {
    missing.get("missing.v1");
  } catch (error) {
    missingRejected = error instanceof Error && error.message.includes("not registered");
  }
  check(issues, missingRejected, "get on an unknown id must raise");

  const defaults = createDefaultSchemaRegistry();
  check(
    issues,
    defaults.contains("gene_expression.long.v1") &&
      defaults.contains("gene_expression.probe_long.v1"),
    "default registry must contain both built-in schemas",
  );
  check(
    issues,
    defaults.get("gene_expression.probe_long.v1").row_granularity ===
      "probe_sample_measurement",
    "default registry probe lookup",
  );
  return issues;
}