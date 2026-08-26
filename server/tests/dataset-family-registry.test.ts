import { describe, expect, test } from "vitest";

import { createDefaultRegisteredTableRegistry } from "../src/dataset/adapters/registered/index.js";
import {
  DatasetFamilyRegistry,
  createDefaultDatasetFamilyRegistry,
  registeredTableSchemasById,
} from "../src/dataset/families/index.js";
import { providerCarrierBinding } from "../src/dataset/runtime/provider-bindings.js";

describe("DatasetFamilyRegistry", () => {
  test("registers the expression family as one complete runtime definition", () => {
    const registry = createDefaultDatasetFamilyRegistry();

    expect(registry.list()).toEqual([
      "bioactivity_measurement",
      "gene_expression",
      "gut_microbiome",
      "literature_evidence",
      "protein_structure",
      "target_evidence",
      "variant_evidence",
    ]);
    expect(registry.schemaRegistry().list()).toEqual(expect.arrayContaining([
      "gene_expression.long.v1",
      "gene_expression.probe_long.v1",
      "literature_evidence.experiment_evidence.v1",
      "target_evidence.target.v1",
      "variant_evidence.assertion.v1",
      "protein_structure.structure.v1",
      "bioactivity_measurement.activity.v1",
      "gut_microbiome.taxon.v1",
    ]));
    expect(registry.validationProfileRefs()).toEqual(expect.arrayContaining([
      "gene_expression.probe_release.v1",
      "gene_expression.release.v1",
      "literature_evidence.release.v1",
      "target_evidence.release.v1",
      "variant_evidence.release.v1",
      "protein_structure.release.v1",
      "bioactivity_measurement.release.v1",
      "gut_microbiome.release.v1",
    ]));
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

  test("derives provider table schemas from registered family table bindings", () => {
    const registry = createDefaultDatasetFamilyRegistry();

    expect(Object.fromEntries(registeredTableSchemasById(registry.get("target_evidence"))))
      .toMatchObject({
        targets: { schema_id: "target_evidence.target.v1" },
        evidence: { schema_id: "target_evidence.evidence.v1" },
        sources: { schema_id: "target_evidence.source.v1" },
        supporting: { schema_id: "target_evidence.supporting.v1" },
      });
    expect(Object.fromEntries(registeredTableSchemasById(registry.get("protein_structure"))))
      .toMatchObject({
        structures: { schema_id: "protein_structure.structure.v1" },
        chains: { schema_id: "protein_structure.chain.v1" },
        ligands: { schema_id: "protein_structure.ligand.v1" },
        sources: { schema_id: "protein_structure.source.v1" },
      });
    expect(Object.fromEntries(registeredTableSchemasById(registry.get("bioactivity_measurement"))))
      .toMatchObject({
        activities: { schema_id: "bioactivity_measurement.activity.v1" },
        compounds: { schema_id: "bioactivity_measurement.compound.v1" },
        assays: { schema_id: "bioactivity_measurement.assay.v1" },
        targets: { schema_id: "bioactivity_measurement.target.v1" },
        compound_crosswalks: { schema_id: "bioactivity_measurement.compound_crosswalk.v1" },
      });
  });

  test("registers the PubChem identity carrier without an Agent table parser", () => {
    const family = createDefaultDatasetFamilyRegistry().get("bioactivity_measurement");

    expect(family.schemas.map((schema) => schema.schema_id)).toContain(
      "bioactivity_measurement.compound_crosswalk.v1",
    );
    expect(family.sources.find((source) => source.source === "pubchem")).toMatchObject({
      source: "pubchem",
      table_id: "compound_crosswalks",
      adapter_id: "bioactivity.pubchem_identity.v1",
      schema_refs: ["bioactivity_measurement.compound_crosswalk.v1"],
      parameters_required: false,
    });
    expect(providerCarrierBinding(
      "bioactivity_measurement",
      "pubchem",
      "bioactivity.pubchem_identity.v1",
    )).not.toBeNull();
    expect(createDefaultRegisteredTableRegistry().list()).not.toEqual(expect.arrayContaining([
      expect.stringContaining("bioactivity.pubchem_identity.v1"),
      expect.stringContaining("registered_bioactivity_compound_crosswalks"),
    ]));
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
        "gene_expression.long.v2": ["missing.release.v1"],
        "gene_expression.probe_long.v2": ["missing.release.v1"],
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
