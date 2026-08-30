import { describe, expect, test } from "vitest";

import {
  createDatasetRoutePreflightTool,
  datasetRouteCapabilities,
} from "../src/agent/tools/dataset-route-preflight.js";

describe("dataset formal-route capability preflight", () => {
  test("does not classify a dynamic provider as unavailable because no static family lists its source", () => {
    const capabilities = datasetRouteCapabilities();
    const gwas = capabilities.dynamic.direct_bindings.find(
      (provider) => provider.provider_id === "gwas-catalog.associations.v1",
    );

    expect(capabilities.static.families.some(
      (family) => family.sources.some((source) => source.source === "gwas_catalog"),
    )).toBe(false);
    expect(gwas).toMatchObject({
      source: "gwas_catalog",
      input_kind: "utf8",
      route_status: "dynamic_bindable",
    });
    expect(capabilities.rules).toContain(
      "A source missing from the static families can still use Dynamic Family when it appears in dynamic.direct_bindings.",
    );
  });

  test("reports binary supplementary acquisition without implying Dynamic Family input closure", () => {
    const capabilities = datasetRouteCapabilities();
    const supplementary = capabilities.core_acquisition_only.find(
      (provider) => provider.provider_id === "europepmc.supplementary.v1",
    );

    expect(supplementary).toMatchObject({
      source: "europepmc_supplementary",
      input_kind: "binary_archive",
      route_status: "requires_formal_extraction",
    });
    expect(supplementary?.blocker).toMatch(/acquire_core_carrier/i);
    expect(capabilities.dynamic.direct_bindings).not.toContainEqual(
      expect.objectContaining({ provider_id: "europepmc.supplementary.v1" }),
    );
  });

  test("directs the Agent to acquire one Europe PMC PDF carrier per frozen PMCID", () => {
    const capabilities = datasetRouteCapabilities();
    const pdf = capabilities.core_acquisition_only.find(
      (provider) => provider.provider_id === "europepmc.pdf.v1",
    );

    expect(pdf).toMatchObject({
      source: "europepmc_pdf",
      input_kind: "binary_archive",
      route_status: "requires_formal_extraction",
    });
    expect(pdf?.input_hint).toMatch(/PMCID/);
    expect(pdf?.blocker).toMatch(/acquire_core_carrier/i);
    expect(capabilities.dynamic.direct_bindings).not.toContainEqual(
      expect.objectContaining({ provider_id: "europepmc.pdf.v1" }),
    );
  });

  test("directs the Agent to acquire one Europe PMC full-text XML carrier per frozen PMCID", () => {
    const capabilities = datasetRouteCapabilities();
    const xml = capabilities.core_acquisition_only.find(
      (provider) => provider.provider_id === "europepmc.fulltext_xml.v1",
    );

    expect(xml).toMatchObject({
      source: "europepmc_fulltext_xml",
      input_kind: "binary_archive",
      route_status: "requires_formal_extraction",
    });
    expect(xml?.input_hint).toMatch(/PMCID/);
    expect(xml?.blocker).toMatch(/acquire_core_carrier/i);
    expect(capabilities.dynamic.direct_bindings).not.toContainEqual(
      expect.objectContaining({ provider_id: "europepmc.fulltext_xml.v1" }),
    );
  });

  test("returns the same bounded, side-effect-free facts through the Agent tool", async () => {
    const tool = createDatasetRoutePreflightTool();
    const result = await tool.execute({});

    expect(tool.name).toBe("inspect_dataset_execution_routes");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {},
      additionalProperties: false,
    });
    expect(result.isError).not.toBe(true);
    expect(result.details).toEqual(datasetRouteCapabilities());
    expect(result.content.length).toBeLessThan(20_000);
  });
});
