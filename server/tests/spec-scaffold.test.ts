import { describe, expect, it } from "vitest";

import { createDefaultDatasetFamilyRegistry } from "../src/dataset/families/index.js";
import { SpecValidator } from "../src/dataset/validation/spec_validator.js";
import { buildDatasetExecutionScaffold } from "../src/dataset/scaffold/spec-scaffold.js";
import {
  GUT_MICROBIOME_FAMILY_ID,
  GUT_MICROBIOME_ROW_GRANULARITY,
  GUT_MICROBIOME_STUDY_SCHEMA_ID,
} from "../src/dataset/families/gut-microbiome/index.js";

const STUDY_ID = "MGYS00000001";

const BINDINGS = [
  { source: "mgnify", adapter_id: "registered_gut_microbiome_study_json", accession: STUDY_ID },
  { source: "mgnify", adapter_id: "registered_gut_microbiome_taxon_long_tsv", accession: STUDY_ID },
  { source: "mgnify", adapter_id: "registered_gut_microbiome_differential_abundance_xlsx", accession: STUDY_ID },
  { source: "ncbi_taxonomy", adapter_id: "gut_microbiome.ncbi_taxonomy_esearch_json.v1", accession: "Blautia obeum" },
  { source: "gmrepo", adapter_id: "gut_microbiome.gmrepo_taxon_phenotypes_json.v1", accession: "1234" },
];

describe("dataset spec scaffold", () => {
  it("composes a spec that passes strict validation unchanged", () => {
    const registry = createDefaultDatasetFamilyRegistry();
    const { spec, notes } = buildDatasetExecutionScaffold(registry, {
      family_id: GUT_MICROBIOME_FAMILY_ID,
      requirement_id: "req_scaffold_valid",
      entities: {
        study_id: STUDY_ID,
        disease_id: "D006262",
        disease_name: "Type 2 diabetes mellitus",
        host_taxon_id: "9606",
      },
      bindings: BINDINGS,
    });
    expect(spec.dataset_family).toBe(GUT_MICROBIOME_FAMILY_ID);
    expect(spec.schema_ref).toBe(GUT_MICROBIOME_STUDY_SCHEMA_ID);
    expect(spec.row_granularity).toBe(GUT_MICROBIOME_ROW_GRANULARITY);
    expect(spec.merge_strategy).toBe("registered_multitable_identity");
    expect(spec.validation_profile_ref).toBe("gut_microbiome.release.v1");
    expect(spec.normalization_profile_ref).toBe("gut_microbiome.registered.v1");
    expect(spec.source_bindings.map((binding) => [binding.source, binding.adapter_id, binding.accession]))
      .toEqual(BINDINGS.map((binding) => [binding.source, binding.adapter_id, binding.accession]));
    expect(spec.source_bindings.every((binding) => binding.parameters && Object.keys(binding.parameters).length === 0))
      .toBe(true);
    expect(notes).toEqual([]);
    const validator = new SpecValidator(registry.schemaRegistry(), registry.validationProfileRefs(), registry);
    expect(validator.validate(spec)).toEqual({ valid: true, reason_codes: [], reasons: [] });
  });

  it("normalizes scalar entities and reports empty accessions as notes", () => {
    const registry = createDefaultDatasetFamilyRegistry();
    const { spec, notes } = buildDatasetExecutionScaffold(registry, {
      family_id: GUT_MICROBIOME_FAMILY_ID,
      requirement_id: "req_scaffold_notes",
      entities: { disease_id: ["D003924", "ignored"], host_taxon_id: "" },
      bindings: [
        { source: "mgnify", adapter_id: "registered_gut_microbiome_study_json", accession: null },
      ],
    });
    expect(spec.entities).toEqual({ disease_id: ["D003924"] });
    expect(notes.length).toBeGreaterThanOrEqual(2);
    expect(notes.join("\n")).toContain("empty accession");
    expect(notes.join("\n")).toContain("entities.host_taxon_id");
  });

  it("fails closed on unknown families and unknown adapter pairs", () => {
    const registry = createDefaultDatasetFamilyRegistry();
    expect(() => buildDatasetExecutionScaffold(registry, {
      family_id: "no_such_family",
      requirement_id: "req_x",
      entities: {},
      bindings: BINDINGS,
    })).toThrow(/unknown dataset family/);
    expect(() => buildDatasetExecutionScaffold(registry, {
      family_id: GUT_MICROBIOME_FAMILY_ID,
      requirement_id: "req_x",
      entities: {},
      bindings: [{ source: "gmrepo", adapter_id: "registered_gut_microbiome_study_json", accession: "1234" }],
    })).toThrow(/known adapters for this source/);
    expect(() => buildDatasetExecutionScaffold(registry, {
      family_id: GUT_MICROBIOME_FAMILY_ID,
      requirement_id: "req_x",
      entities: {},
      bindings: [],
    })).toThrow(/at least one/);
  });
});
