import { describe, expect, it } from "vitest";

import { resolveCoreProductTopologyRequirements } from "../src/dataset/dynamic-family/product-requirement-registry.js";
import {
  buildCoreProfilePrepareSubmission,
  coreProductProfileScaffold,
} from "../src/dataset/dynamic-family/profile-scaffold.js";
import {
  prepareDynamicFamilyPublication,
  validateDynamicFamilyPreflightReceipt,
} from "../src/dataset/dynamic-family/preflight.js";
import {
  dynamicFamilyPublicationWire,
  parseDynamicFamilyPublicationPrepareSubmission,
  parseDynamicFamilyPublicationSubmission,
} from "../src/agent/tools/dynamic-family-publication.js";
import { createDatasetProfileScaffoldTool, datasetRouteCapabilities } from "../src/agent/tools/dataset-route-preflight.js";

const PROFILE_REF = "scientific_assertion.table.release.v1";
const FAMILY_ID = "scientific_assertion";
const TASK_ID = "task_scientific_assertion";
const REQUIREMENT_ID = "build_scientific_assertion";
const ASSET_ID = `asset_${"a".repeat(64)}`;

const FLAT_TRANSFORM_SOURCE = [
  "export const transform = { run({ inputs }) {",
  "  const [assertions] = inputs;",
  "  return { outputs: [{",
  "    content: 'assertion_id,subject,predicate,object,value,unit,study_id,source_url\\n',",
  "    handle: 'out_0',",
  "    locator_ref: assertions.receipt_id,",
  "    row_count: 0,",
  "    schema_ref: 'scientific_assertion.assertion_records.v1',",
  "    table_id: 'assertion_records',",
  "  }] };",
  "} };",
].join("\n");

describe("scientific_assertion flat-table product profile", () => {
  it("registers a generic flat-assertion topology in the Core product requirement registry", () => {
    const requirements = resolveCoreProductTopologyRequirements(PROFILE_REF);
    expect(requirements).toMatchObject({
      schema_version: "1.0",
      profile_ref: PROFILE_REF,
      dataset_family: FAMILY_ID,
    });
    expect(requirements.tables).toEqual([
      {
        table_id: "assertion_records",
        role: "primary",
        schema_ref: "scientific_assertion.assertion_records.v1",
        min_rows: 1,
      },
      {
        table_id: "study_records",
        role: "supporting",
        schema_ref: "scientific_assertion.study_records.v1",
        min_rows: 0,
      },
    ]);
    expect(requirements.relations).toEqual([]);
  });

  it("scaffolds the flat-table FamilySpec through the registry descriptor and the scaffold tool", async () => {
    const scaffold = coreProductProfileScaffold(PROFILE_REF);
    expect(scaffold).toMatchObject({
      schema_version: "1.0",
      profile_ref: PROFILE_REF,
      dataset_family: FAMILY_ID,
      projection: { projection_id: "scientific_assertion.assertion_table.v1" },
    });
    expect(scaffold.family_spec.table_definitions.map((table) => table.table_id)).toEqual([
      "assertion_records", "study_records",
    ]);
    expect(scaffold.family_spec.table_definitions.map((table) => table.allow_empty)).toEqual([
      false, true,
    ]);
    expect(scaffold.family_spec.relations).toEqual([]);

    const tool = await createDatasetProfileScaffoldTool().execute({ profile_ref: PROFILE_REF });
    expect(tool.isError).not.toBe(true);
    expect(tool.details).toMatchObject({
      ok: true,
      status: "scaffolded",
      scaffold: {
        dataset_family: FAMILY_ID,
        projection: { projection_id: "scientific_assertion.assertion_table.v1" },
      },
    });
  });

  it("prepares and submit-validates a two-table flat gold7-shaped publication", async () => {
    const raw = buildCoreProfilePrepareSubmission({
      profileRef: PROFILE_REF,
      requirementId: REQUIREMENT_ID,
      sourceBindings: [{
        binding_id: "binding_assertions",
        source: "registered_asset",
        input_requirement_ref: "assertion_source",
        parameters: {},
      }],
      registeredSources: { binding_assertions: ASSET_ID },
      acquisitionRequests: {},
      transformSource: FLAT_TRANSFORM_SOURCE,
      transformInputRoles: [{ role: "assertion_source", media_type: "text/csv", constraint_ref: null }],
    });
    const parsed = await parseDynamicFamilyPublicationPrepareSubmission(raw);
    expect(parsed.family_spec.family_spec_id).toBe(FAMILY_ID);
    expect(parsed.family_spec.assessment_policy_ref).toBe(PROFILE_REF);

    const productRequirements = resolveCoreProductTopologyRequirements(PROFILE_REF);
    const receipt = await prepareDynamicFamilyPublication({
      taskId: TASK_ID,
      requirementId: REQUIREMENT_ID,
      generation: 0,
      submission: parsed,
      productRequirements,
    });
    expect(receipt.output_closure).toEqual(["assertion_records", "study_records"]);
    expect(receipt.topology_diagnostics).toEqual([]);

    // Submit re-parses the stored prepared wire and revalidates the receipt
    // against the same registry-resolved Core profile (phase3 submit path).
    const wire = dynamicFamilyPublicationWire(parsed, receipt.host_descriptor_digest);
    const submitted = await parseDynamicFamilyPublicationSubmission(wire);
    await expect(validateDynamicFamilyPreflightReceipt({
      receipt,
      submission: submitted,
      taskId: TASK_ID,
      requirementId: REQUIREMENT_ID,
      generation: 0,
      productRequirements,
    })).resolves.toEqual(receipt);
  });

  it("still rejects unknown profiles with the available profile list", () => {
    expect(() => resolveCoreProductTopologyRequirements("ad_gwas_risk_loci.assessment.v1"))
      .toThrow(/unknown Core product requirement profile 'ad_gwas_risk_loci\.assessment\.v1'/);
    expect(() => resolveCoreProductTopologyRequirements("ad_gwas_risk_loci.assessment.v1"))
      .toThrow(/scientific_assertion\.table\.release\.v1/);
    expect(() => coreProductProfileScaffold("ad_gwas_risk_loci.assessment.v1"))
      .toThrow(/no registered scaffold/);
  });

  it("leaves the two chart profiles and their route guidance unchanged", () => {
    const bioactivity = resolveCoreProductTopologyRequirements(
      "bioactivity_measurement.chart_evidence.release.v1",
    );
    expect(bioactivity.dataset_family).toBe("bioactivity_measurement");
    expect(bioactivity.tables.map((table) => table.table_id)).toEqual([
      "activities", "compounds", "assays", "targets",
      "chart_series", "chart_points", "papers", "sources",
    ]);
    const literature = resolveCoreProductTopologyRequirements("literature_experiment_chart.release.v1");
    expect(literature.dataset_family).toBe("literature_experiment_chart");
    expect(literature.tables.map((table) => table.table_id)).toEqual([
      "activity_value_records", "paper_records", "experiment_records",
      "chart_series", "chart_points", "supplementary_asset_records",
    ]);
    expect(resolveCoreProductTopologyRequirements("literature_experiment_chart.release.v1").relations)
      .toHaveLength(6);

    const capabilities = datasetRouteCapabilities();
    expect(capabilities.dynamic.product_requirement_profiles[0]?.profile_ref)
      .toBe("literature_experiment_chart.release.v1");
    const assertion = capabilities.dynamic.product_requirement_profiles.find(
      (item) => item.profile_ref === PROFILE_REF,
    );
    expect(assertion).toMatchObject({
      dataset_family: FAMILY_ID,
      route_status: "core_owned_topology_only",
    });
    expect(assertion?.use_when).toMatch(/flat assertion/i);
    expect(assertion?.do_not_use_when).toMatch(/chart|activity_value_records/i);
  });
});
