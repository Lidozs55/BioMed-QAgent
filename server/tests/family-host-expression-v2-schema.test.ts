import { describe, expect, it } from "vitest";

import {
  buildGeneExpressionSchema,
  buildGeneExpressionSchemaV2,
  buildProbeExpressionSchema,
  buildProbeExpressionSchemaV2,
  createDefaultSchemaRegistry,
} from "../src/dataset/schema/index.js";
import { parseDatasetSchemaV2 } from "../src/dataset/contracts/index.js";

describe("family-host expression revision-scoped V2 schema primitives", () => {
  it("adds dataset_revision_id without silently changing the V1 gene schema", () => {
    const legacy = buildGeneExpressionSchema();
    const revisionScoped = buildGeneExpressionSchemaV2();

    expect(legacy.schema_id).toBe("gene_expression.long.v1");
    expect(legacy.fields.some((field) => field.name === "dataset_revision_id")).toBe(false);
    expect(revisionScoped.schema_id).toBe("gene_expression.long.v2");
    expect(revisionScoped.fields.map((field) => field.name)).toEqual([
      ...legacy.fields.slice(0, 2).map((field) => field.name),
      "dataset_revision_id",
      ...legacy.fields.slice(2).map((field) => field.name),
    ]);
    expect(revisionScoped.primary_key).toEqual([
      "dataset_revision_id",
      "sample_id",
      "gene_id",
      "measurement_type",
    ]);
    expect(parseDatasetSchemaV2(revisionScoped)).toEqual(revisionScoped);
  });

  it("binds the probe primary key to dataset revision while preserving declared tuple order", () => {
    const legacy = buildProbeExpressionSchema();
    const revisionScoped = buildProbeExpressionSchemaV2();

    expect(legacy.schema_id).toBe("gene_expression.probe_long.v1");
    expect(legacy.fields.some((field) => field.name === "dataset_revision_id")).toBe(false);
    expect(revisionScoped.schema_id).toBe("gene_expression.probe_long.v2");
    expect(revisionScoped.fields.map((field) => field.name)).toEqual([
      ...legacy.fields.slice(0, 2).map((field) => field.name),
      "dataset_revision_id",
      ...legacy.fields.slice(2).map((field) => field.name),
    ]);
    expect(revisionScoped.primary_key).toEqual([
      "dataset_revision_id",
      "probe_id",
      "platform_id",
      "sample_id",
    ]);
    expect(parseDatasetSchemaV2(revisionScoped)).toEqual(revisionScoped);
  });

  it("uses explicit V2 nullability and is registered after receipt wiring", () => {
    for (const schema of [buildGeneExpressionSchemaV2(), buildProbeExpressionSchemaV2()]) {
      expect(schema.schema_version).toBe("2.0");
      expect(schema.fields.every((field) =>
        field.schema_version === "2.0" && typeof field.nullable === "boolean"
      )).toBe(true);
    }

    const registry = createDefaultSchemaRegistry();
    expect(registry.contains("gene_expression.long.v2")).toBe(true);
    expect(registry.contains("gene_expression.probe_long.v2")).toBe(true);
  });
});
