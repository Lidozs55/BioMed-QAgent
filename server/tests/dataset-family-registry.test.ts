import { describe, expect, test } from "vitest";

import {
  DatasetFamilyRegistry,
  createDefaultDatasetFamilyRegistry,
} from "../src/dataset/families/index.js";

describe("DatasetFamilyRegistry", () => {
  test("registers the expression family as one complete runtime definition", () => {
    const registry = createDefaultDatasetFamilyRegistry();

    expect(registry.list()).toEqual(["gene_expression"]);
    expect(registry.schemaRegistry().list()).toEqual([
      "gene_expression.long.v1",
      "gene_expression.probe_long.v1",
    ]);
    expect(registry.validationProfileRefs()).toEqual([
      "gene_expression.probe_release.v1",
      "gene_expression.release.v1",
    ]);
    expect(registry.get("gene_expression")).toMatchObject({
      id: "gene_expression",
      runtime_id: "gene_expression.runtime.v1",
      default_normalization_profile_ref: "gene_expression.normalization.v1",
      validation_profiles_by_schema: {
        "gene_expression.long.v1": ["gene_expression.release.v1"],
        "gene_expression.probe_long.v1": ["gene_expression.probe_release.v1"],
      },
      granularities: [
        { id: "gene_sample_measurement", target_entity_level: "gene" },
        { id: "probe_sample_measurement", target_entity_level: "probe" },
      ],
      merge_strategies: ["append_by_canonical_row"],
    });
  });

  test("rejects a family without a registered Core runtime", () => {
    const expression = createDefaultDatasetFamilyRegistry().get("gene_expression");

    expect(() => new DatasetFamilyRegistry([{
      ...expression,
      runtime_id: "missing.runtime.v1",
    }])).toThrow(/has no registered runtime implementation/);
  });

  test("rejects a source whose adapter is not registered", () => {
    const expression = createDefaultDatasetFamilyRegistry().get("gene_expression");

    expect(() => new DatasetFamilyRegistry([{
      ...expression,
      sources: [{
        ...expression.sources[0]!,
        adapter_id: "missing.adapter.v1",
      }],
    }])).toThrow(/unknown source adapter/);
  });

  test("rejects declared profiles without runtime implementations", () => {
    const expression = createDefaultDatasetFamilyRegistry().get("gene_expression");

    expect(() => new DatasetFamilyRegistry([{
      ...expression,
      validation_profile_refs: ["missing.release.v1"],
      validation_profiles_by_schema: {
        "gene_expression.long.v1": ["missing.release.v1"],
        "gene_expression.probe_long.v1": ["missing.release.v1"],
      },
    }])).toThrow(/validation profile 'missing.release.v1' is not registered/);
    expect(() => new DatasetFamilyRegistry([{
      ...expression,
      normalization_profile_refs: ["missing.normalization.v1"],
      default_normalization_profile_ref: "missing.normalization.v1",
    }])).toThrow(/normalization profile 'missing.normalization.v1' is not registered/);
  });

  test("rejects a family whose schema declares a different family", () => {
    const expression = createDefaultDatasetFamilyRegistry().get("gene_expression");

    expect(() => new DatasetFamilyRegistry([{
      ...expression,
      schemas: [{
        ...expression.schemas[0]!,
        dataset_family: "variant_evidence",
      }, expression.schemas[1]!],
    }])).toThrow(/schema .* belongs to family variant_evidence/);
  });

  test("rejects duplicate source definitions", () => {
    const expression = createDefaultDatasetFamilyRegistry().get("gene_expression");

    expect(() => new DatasetFamilyRegistry([{
      ...expression,
      sources: [expression.sources[0]!, expression.sources[0]!],
    }])).toThrow(/source ids must not contain duplicates/);
  });

  test("rejects a family whose schema granularity is not declared", () => {
    const expression = createDefaultDatasetFamilyRegistry().get("gene_expression");

    expect(() => new DatasetFamilyRegistry([{
      ...expression,
      granularities: [],
    }])).toThrow(/undeclared granularity/);
  });
});
