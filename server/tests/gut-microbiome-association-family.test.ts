import { describe, expect, it } from "vitest";

import {
  createDefaultDatasetFamilyRegistry,
  registeredTableSchemasById,
} from "../src/dataset/families/index.js";
import { createDefaultFamilyAssemblerRegistry } from "../src/dataset/assembly/index.js";

const FAMILY_ID = "gut_microbiome";
const EXPECTED_TABLES = [
  "study_records",
  "taxon_records",
  "differential_abundance_records",
  "reference_prevalence_records",
] as const;

describe("gut microbiome disease-association family", () => {
  it("reproduces the missing four-table production contract", () => {
    const family = createDefaultDatasetFamilyRegistry().get(FAMILY_ID);
    const tableSchemas = registeredTableSchemasById(family);

    expect([...tableSchemas.keys()].sort()).toEqual([...EXPECTED_TABLES].sort());
    expect(family.schemas.map((schema) => schema.schema_id).sort()).toEqual([
      "gut_microbiome.differential_abundance.v1",
      "gut_microbiome.reference_prevalence.v1",
      "gut_microbiome.study.v1",
      "gut_microbiome.taxon_name_crosswalk.v1",
    ]);
    expect(createDefaultFamilyAssemblerRegistry().list()).toContain(FAMILY_ID);
  });
});
