import { describe, expect, test } from "vitest";

import {
  parseDynamicFamilyPublicationPrepareSubmission,
} from "../src/agent/tools/dynamic-family-publication.js";
import {
  createDatasetProfileScaffoldTool,
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
    expect(supplementary?.blocker).toMatch(/provenance-bound UTF-8 extraction asset/i);
    expect(capabilities.dynamic.direct_bindings).not.toContainEqual(
      expect.objectContaining({ provider_id: "europepmc.supplementary.v1" }),
    );
  });

  test("reports Core-owned product topology profiles without claiming source closure", () => {
    const capabilities = datasetRouteCapabilities();
    const profile = capabilities.dynamic.product_requirement_profiles.find(
      (item) => item.profile_ref === "bioactivity_measurement.chart_evidence.release.v1",
    );

    expect(profile).toMatchObject({
      dataset_family: "bioactivity_measurement",
      route_status: "core_owned_topology_only",
    });
    expect(profile?.tables.map((table) => table.table_id)).toEqual([
      "activities", "compounds", "assays", "targets",
      "chart_series", "chart_points", "papers", "sources",
    ]);
    expect(profile?.blocker).toMatch(/does not prove source|extraction closure/i);
  });

  test("generates the formal six-table literature chart scaffold from Core facts", async () => {
    const tool = createDatasetProfileScaffoldTool();
    const result = await tool.execute({
      profile_ref: "literature_experiment_chart.release.v1",
    });

    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({
      ok: true,
      status: "scaffolded",
      scaffold: {
        dataset_family: "literature_experiment_chart",
        projection: {
          projection_id: "literature_experiment_chart.six_table.v1",
          primary_tables: ["activity_value_records"],
        },
      },
    });
    const scaffold = (result.details as {
      scaffold: {
        family_spec: { table_definitions: Array<{ table_id: string }> };
        transform_output_tables: Array<{ table_id: string }>;
      };
    }).scaffold;
    expect(scaffold.family_spec.table_definitions.map((table) => table.table_id)).toEqual([
      "activity_value_records", "paper_records", "experiment_records",
      "chart_series", "chart_points", "supplementary_asset_records",
    ]);
    expect(scaffold.transform_output_tables.map((table) => table.table_id)).toEqual([
      "activity_value_records", "paper_records", "experiment_records",
      "chart_series", "supplementary_asset_records", "chart_points",
    ]);
  });

  test("builds the complete prepare wire from source and extraction facts only", async () => {
    const result = await createDatasetProfileScaffoldTool().execute({
      profile_ref: "literature_experiment_chart.release.v1",
      requirement_id: "build_literature_chart",
      source_bindings: [{
        binding_id: "paper_xml",
        source: "registered_asset",
        input_requirement_ref: "paper_source",
        parameters: {},
      }],
      registered_sources: { paper_xml: `asset_${"a".repeat(64)}` },
      acquisition_requests: {},
      transform_source: "export const transform = { run() { return { outputs: [] }; } };",
      transform_input_roles: [{ role: "paper_source", media_type: "application/xml", constraint_ref: null }],
    });
    expect(result.isError).not.toBe(true);
    const submission = (result.details as { prepare_submission: Record<string, unknown> }).prepare_submission;
    expect(submission).toMatchObject({
      family_spec: {
        family_spec_id: "literature_experiment_chart",
        author: "dataset_core",
      },
      projection_id: "literature_experiment_chart.six_table.v1",
      transform_metadata: {
        declared_output_tables: [
          { table_id: "activity_value_records" },
          { table_id: "paper_records" },
          { table_id: "experiment_records" },
          { table_id: "chart_series" },
          { table_id: "supplementary_asset_records" },
          { table_id: "chart_points" },
        ],
      },
    });
    await expect(parseDynamicFamilyPublicationPrepareSubmission(submission)).resolves.toMatchObject({
      family_spec: { family_spec_id: "literature_experiment_chart" },
      projection: { projection_id: "literature_experiment_chart.six_table.v1" },
    });
  });

  test("returns actionable profile options instead of inviting an unchanged retry", async () => {
    const result = await createDatasetProfileScaffoldTool().execute({ profile_ref: "missing.profile" });
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      ok: false,
      error: {
        code: "profile_scaffold_rejected",
        retryable: false,
      },
    });
    expect(JSON.stringify(result.details)).toContain("literature_experiment_chart.release.v1");
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
