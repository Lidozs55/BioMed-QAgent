import { readFileSync } from "node:fs";

import { describe, expect, test } from "vitest";

import {
  parseDatasetSchema,
  parseDatasetSchemaV2,
} from "../src/dataset/contracts/index.js";
import {
  buildGeneExpressionSchema,
  buildProbeExpressionSchema,
  createDefaultSchemaRegistry,
  schemasDeepEqual,
} from "../src/dataset/schema/index.js";
import {
  checkGeneSchemaParity,
  checkProbeSchemaParity,
  checkRegistrySemantics,
} from "./schema-registry-parity.js";

function loadGeneGolden(): unknown {
  return JSON.parse(
    readFileSync(
      new URL(
        "../../tests/migration/golden/succeeded/artifacts/schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
}

describe("Phase 4 step 2 schema registry parity", () => {
  test("gene schema reproduces the Python golden artifact", () => {
    expect(checkGeneSchemaParity(loadGeneGolden())).toEqual([]);
  });

  test("probe schema satisfies the Python registry invariants", () => {
    expect(checkProbeSchemaParity()).toEqual([]);
  });

  test("registry behavior mirrors the Python registry tests", () => {
    expect(checkRegistrySemantics()).toEqual([]);
  });

  test("built-in schemas carry schema_version 1.0 on every field", () => {
    for (const schema of [buildGeneExpressionSchema(), buildProbeExpressionSchema()]) {
      expect(schema.schema_version).toBe("1.0");
      expect(schema.fields.every((field) => field.schema_version === "1.0")).toBe(true);
    }
  });

  test("default registry returns parsed schemas that re-parse identically", () => {
    const registry = createDefaultSchemaRegistry();
    for (const schemaId of registry.list()) {
      const schema = registry.get(schemaId);
      const parsed = schema.schema_version === "2.0"
        ? parseDatasetSchemaV2(schema)
        : parseDatasetSchema(schema);
      expect(parsed).toEqual(schema);
    }
  });

  test("gene golden and gene builder agree on every field", () => {
    const golden = loadGeneGolden();
    const builder = buildGeneExpressionSchema();
    const byName = new Map(builder.fields.map((field) => [field.name, field]));
    for (const raw of (golden as { fields: unknown[] }).fields) {
      const field = raw as Record<string, unknown>;
      const name = field.name as string;
      const built = byName.get(name);
      expect(built, `missing field ${name}`).toBeDefined();
      expect(schemasDeepEqual(built, raw), `field ${name} mismatch`).toBe(true);
    }
  });
});