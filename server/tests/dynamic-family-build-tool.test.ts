import { computeFamilySpecDigest, type FamilySpec, type Projection } from "@biomed/contracts";
import { describe, expect, test } from "vitest";

import { canonicalDigest } from "../src/dataset/adapters/identity.js";
import { parseDynamicFamilyBuildSubmission } from "../src/agent/tools/dynamic-family-build.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

async function submission(): Promise<Record<string, unknown>> {
  const projection: Projection = {
    projection_id: "projection_dynamic",
    schema_version: "2.0",
    primary_tables: ["records"],
    supporting_tables: [],
    derived_tables: [],
    required: ["records"],
    optional: [],
    allow_empty: [],
    relations: [],
    row_granularity: "record",
    compatibility_dimensions: [],
    merge_identity_fields: ["record_id"],
    validation_policy_ref: "policy_validation",
    assessment_policy_ref: "policy_assessment",
  };
  const unsigned: FamilySpec = {
    family_spec_id: "family_dynamic",
    semantic_version: "1.0.0",
    canonical_digest: A,
    projections: [projection],
    table_definitions: [{
      table_id: "records", schema_ref: "schema_records", role: "primary",
      required: true, allow_empty: false, primary_key: ["record_id"],
      field_names: ["record_id", "value"],
    }],
    relations: [],
    identity: {
      dataset_id_scheme: "ds_hash", dataset_revision_id_scheme: "dsrev_hash",
      asset_id_scheme: "asset_sha256", sample_identity_fields: ["dataset_revision_id", "sample_id"],
      probe_mapping_assertion_pk: "mapping_assertion_id",
    },
    transform_capability_refs: [],
    declared_outputs: [{ table_id: "records", schema_ref: "schema_records" }],
    integration_policy_ref: "policy_integration",
    validation_policy_ref: "policy_validation",
    assessment_policy_ref: "policy_assessment",
    resource_class_request: "small",
    scope: "task",
    author: "agent",
    evidence_refs: [],
  };
  const family = { ...unsigned, canonical_digest: await computeFamilySpecDigest(unsigned) };
  return {
    schema_version: "1.0",
    execution_backend: "in_process_unisolated",
    family_spec: family,
    projection_id: projection.projection_id,
    transform_source: "export const transform = { run() { return { outputs: [] }; } };",
    transform_metadata: {
      transform_id: "transform_dynamic", version: "1.0.0", entrypoint: "transform.run",
      declared_input_roles: [{ role: "source", media_type: "text/csv", constraint_ref: null }],
      declared_output_tables: [{ table_id: "records", schema_ref: "schema_records" }],
      bound_family_spec_digest: family.canonical_digest,
      bound_projection_digest: canonicalDigest(projection),
      determinism_profile: "deterministic", resource_class: "small", origin: "agent",
      scope: "task", review_refs: [],
    },
    build_proposal: {
      schema_version: "2.0", spec_kind: "proposal", build_id: "build_dynamic",
      family_spec_ref: { scope: "task", id: family.family_spec_id, version: family.semantic_version, digest: family.canonical_digest },
      projection_ref: projection.projection_id,
      transform_refs: [{ scope: "task", id: "transform_dynamic", version: "1.0.0", digest: B }],
      policy_refs: [], output_format: "long_table", idempotency_identity: "dynamic_identity",
      source_bindings: [{
        binding_id: "source_binding", source: "registered_asset",
        input_requirement_ref: "source", parameters: {},
      }],
    },
  };
}

describe("dynamic family build tool boundary", () => {
  test("parses only an explicitly unisolated, digest-bound submission", async () => {
    const parsed = await parseDynamicFamilyBuildSubmission(await submission());
    expect(parsed.execution_backend).toBe("in_process_unisolated");
    expect(parsed.family_spec.scope).toBe("task");
    expect(parsed.projection.projection_id).toBe("projection_dynamic");
  });

  test("rejects sandbox claims, direct paths, examples, and unknown fields", async () => {
    const sandbox = await submission();
    sandbox.execution_backend = "container";
    await expect(parseDynamicFamilyBuildSubmission(sandbox)).rejects.toThrow(/explicit/);
    const directPath = { ...await submission(), workspace_path: "workspace/data.csv" };
    await expect(parseDynamicFamilyBuildSubmission(directPath)).rejects.toThrow(/unknown/);
    const example = await submission();
    example.family_spec = { ...(example.family_spec as FamilySpec), scope: "example" };
    await expect(parseDynamicFamilyBuildSubmission(example)).rejects.toThrow(/example|digest/);
  });

  test("rejects accessors, Proxies, and symbols without reads", async () => {
    let reads = 0;
    const accessor = await submission();
    Object.defineProperty(accessor, "transform_source", {
      enumerable: true,
      get() { reads += 1; return "malicious"; },
    });
    await expect(parseDynamicFamilyBuildSubmission(accessor)).rejects.toThrow(/data property/);
    expect(reads).toBe(0);
    const proxy = new Proxy(await submission(), {
      get() { reads += 1; return undefined; },
    });
    await expect(parseDynamicFamilyBuildSubmission(proxy)).rejects.toThrow(/non-Proxy/);
    expect(reads).toBe(0);
    const symbol = { ...await submission(), [Symbol("sandbox")]: true };
    await expect(parseDynamicFamilyBuildSubmission(symbol)).rejects.toThrow(/unknown/);
  });
});
