import { describe, expect, it, vi } from "vitest";

import { computeFamilySpecDigest, DEFAULT_RUNTIME_LIMITS, type FamilySpec, type Projection } from "@biomed/contracts";

import { canonicalDigest } from "../src/dataset/adapters/identity.js";
import {
  prepareDynamicFamilyBuild,
  validateDynamicFamilyPreflightReceipt,
} from "../src/dataset/dynamic-family/preflight.js";
import { submitDynamicFamilyBuild } from "../src/dataset/dynamic-family/submission.js";
import type { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";
import { parseDynamicFamilyBuildSubmission } from "../src/agent/tools/dynamic-family-build.js";
import {
  createDynamicFamilyBuildTool,
  createPrepareDynamicFamilyBuildTool,
} from "../src/agent/tools/dynamic-family-build.js";

const DIGEST = "b".repeat(64);

async function rawSubmission(): Promise<Record<string, unknown>> {
  const projection: Projection = {
    projection_id: "projection_preflight",
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
    family_spec_id: "family_preflight",
    semantic_version: "1.0.0",
    canonical_digest: DIGEST,
    projections: [projection],
    table_definitions: [{
      table_id: "records", schema_ref: "schema_records", role: "primary",
      required: true, allow_empty: false, primary_key: ["record_id"], field_names: ["record_id", "value"],
    }],
    relations: [],
    identity: {
      dataset_id_scheme: "ds_hash", dataset_revision_id_scheme: "dsrev_hash", asset_id_scheme: "asset_sha256",
      sample_identity_fields: ["dataset_revision_id", "sample_id"], probe_mapping_assertion_pk: "mapping_assertion_id",
    },
    transform_capability_refs: [],
    declared_outputs: [{ table_id: "records", schema_ref: "schema_records" }],
    integration_policy_ref: "policy_integration", validation_policy_ref: "policy_validation",
    assessment_policy_ref: "policy_assessment", resource_class_request: "small", scope: "task",
    author: "agent", evidence_refs: [],
  };
  const family = { ...unsigned, canonical_digest: await computeFamilySpecDigest(unsigned) };
  return {
    schema_version: "1.0",
    execution_backend: "in_process_unisolated",
    family_spec: family,
    projection_id: projection.projection_id,
    transform_source: "export const transform = { run() { return { outputs: [] }; } };",
    transform_metadata: {
      transform_id: "transform_preflight", version: "1.0.0", entrypoint: "transform.run",
      declared_input_roles: [{ role: "source", media_type: "text/csv", constraint_ref: null }],
      declared_output_tables: [{ table_id: "records", schema_ref: "schema_records" }],
      bound_family_spec_digest: family.canonical_digest,
      bound_projection_digest: canonicalDigest(projection),
      determinism_profile: "deterministic", resource_class: "small", origin: "agent", scope: "task", review_refs: [],
    },
    registered_sources: { binding_1: `asset_${DIGEST}` },
    acquisition_requests: {},
    build_proposal: {
      schema_version: "2.0", spec_kind: "proposal", build_id: "build_preflight",
      family_spec_ref: { scope: "task", id: family.family_spec_id, version: family.semantic_version, digest: family.canonical_digest },
      projection_ref: projection.projection_id,
      transform_refs: [{ scope: "task", id: "transform_preflight", version: "1.0.0", digest: DIGEST }],
      policy_refs: [], output_format: "long_table", idempotency_identity: "preflight_identity",
      source_bindings: [{ binding_id: "binding_1", source: "registered_asset", input_requirement_ref: "source", parameters: {} }],
    },
  };
}

describe("dynamic family prepare/submit preflight", () => {
  it("exposes a fixed prepare tool and makes production submit receipt-only", async () => {
    let called = false;
    const raw = await rawSubmission();
    const parsed = await parseDynamicFamilyBuildSubmission(raw);
    const receipt = await prepareDynamicFamilyBuild({
      taskId: "task_preflight", buildId: "build_preflight", generation: 0, submission: parsed,
    });
    const prepare = createPrepareDynamicFamilyBuildTool({
      prepare: async () => receipt,
    });
    const prepared = await prepare.execute(raw);
    expect(prepared.isError).not.toBe(true);
    expect(JSON.parse(prepared.content)).toMatchObject({
      ok: true,
      status: "prepared",
      preflight_receipt: { receipt_digest: receipt.receipt_digest },
    });
    const submit = createDynamicFamilyBuildTool({
      submit: async (_submission, _signal, _context, submittedReceipt) => {
        called = submittedReceipt?.receipt_digest === receipt.receipt_digest;
        return { ok: true };
      },
    });
    const missing = await submit.execute(raw);
    expect(missing.isError).toBe(true);
    expect(called).toBe(false);
    (raw.build_proposal as { transform_refs: Array<{ digest: string }> }).transform_refs[0]!.digest = receipt.host_descriptor_digest;
    raw.preflight_receipt = receipt;
    const accepted = await submit.execute(raw);
    expect(accepted.isError).not.toBe(true);
    expect(called).toBe(true);
  });

  it("prepares facts without acquisition or prohibited result objects", async () => {
    let planned = 0;
    const submission = await parseDynamicFamilyBuildSubmission(await rawSubmission());
    const receipt = await prepareDynamicFamilyBuild({
      taskId: "task_preflight",
      buildId: "build_preflight",
      generation: 0,
      submission,
      planAcquisition: async () => { planned += 1; },
    });
    expect(planned).toBe(0);
    expect(receipt.required_input_roles).toEqual(["source"]);
    expect(receipt.output_closure).toEqual(["records"]);
    expect(receipt.topology_diagnostics).toEqual([]);
    expect(receipt.host_descriptor_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("plans fixed Core acquisition without invoking acquisition", async () => {
    const raw = await rawSubmission();
    raw.registered_sources = {};
    raw.acquisition_requests = {
      binding_1: {
        provider_id: "pubchem.files.v1",
        parameters: { source: "pubchem", accession: "2244", entities: { pubchem_cids: ["2244"] } },
      },
    };
    const submission = await parseDynamicFamilyBuildSubmission(raw);
    let planned = 0;
    const receipt = await prepareDynamicFamilyBuild({
      taskId: "task_preflight", buildId: "build_preflight", generation: 0, submission,
      planAcquisition: async () => { planned += 1; },
    });
    expect(planned).toBe(1);
    expect(receipt.acquisition_plan).toMatchObject([{
      binding_id: "binding_1", mode: "builtin", provider_id: "pubchem.files.v1", asset_id: null,
    }]);
  });

  it("binds the Core planner identity and rechecks it during submit validation", async () => {
    const raw = await rawSubmission();
    raw.registered_sources = {};
    raw.acquisition_requests = {
      binding_1: {
        provider_id: "pubchem.files.v1",
        parameters: { source: "pubchem", accession: "2244", entities: { pubchem_cids: ["2244"] } },
      },
    };
    const preparedSubmission = await parseDynamicFamilyBuildSubmission(raw);
    const requestIdentityDigest = "d".repeat(64);
    const planner = vi.fn(async () => ({ requestIdentityDigest }));
    const receipt = await prepareDynamicFamilyBuild({
      taskId: "task_preflight", buildId: "build_preflight", generation: 0,
      submission: preparedSubmission, planAcquisition: planner,
    });
    expect(receipt.acquisition_plan[0]?.request_digest).toBe(requestIdentityDigest);
    (raw.build_proposal as { transform_refs: Array<{ digest: string }> }).transform_refs[0]!.digest = receipt.host_descriptor_digest;
    const submittedSubmission = await parseDynamicFamilyBuildSubmission(raw);
    await expect(validateDynamicFamilyPreflightReceipt({
      receipt,
      submission: submittedSubmission,
      taskId: "task_preflight",
      buildId: "build_preflight",
      generation: 0,
      planAcquisition: planner,
    })).resolves.toEqual(receipt);
    planner.mockResolvedValue({ requestIdentityDigest: "e".repeat(64) });
    await expect(validateDynamicFamilyPreflightReceipt({
      receipt,
      submission: submittedSubmission,
      taskId: "task_preflight",
      buildId: "build_preflight",
      generation: 0,
      planAcquisition: planner,
    })).rejects.toThrow(/acquisition plan/);
  });

  it("rejects stale, cross-task, cross-build, tampered, and digest-drifted receipts", async () => {
    const submission = await parseDynamicFamilyBuildSubmission(await rawSubmission());
    const receipt = await prepareDynamicFamilyBuild({
      taskId: "task_preflight", buildId: "build_preflight", generation: 3, submission,
    });
    const cases = [
      { taskId: "task_preflight", buildId: "build_preflight", generation: 4, label: "stale generation" },
      { taskId: "task_other", buildId: "build_preflight", generation: 3, label: "cross-task" },
      { taskId: "task_preflight", buildId: "build_other", generation: 3, label: "cross-build" },
    ];
    for (const item of cases) {
      await expect(validateDynamicFamilyPreflightReceipt({
        receipt, submission, ...item,
      })).rejects.toThrow(new RegExp(item.label));
    }
    await expect(validateDynamicFamilyPreflightReceipt({
      receipt: { ...receipt, receipt_digest: "c".repeat(64) },
      submission, taskId: "task_preflight", buildId: "build_preflight", generation: 3,
    })).rejects.toThrow(/digest/);
    const changed = await rawSubmission();
    changed.transform_source = "export const transform = { run() { return { outputs: [{ nope: true }] }; } };";
    const changedSubmission = await parseDynamicFamilyBuildSubmission(changed);
    await expect(validateDynamicFamilyPreflightReceipt({
      receipt, submission: changedSubmission, taskId: "task_preflight", buildId: "build_preflight", generation: 3,
    })).rejects.toThrow(/descriptor|submission|digest/);
  });

  it("validates the receipt before resolving any registered bytes", async () => {
    const submission = await parseDynamicFamilyBuildSubmission(await rawSubmission());
    const receipt = await prepareDynamicFamilyBuild({
      taskId: "task_preflight", buildId: "build_preflight", generation: 0, submission,
    });
    const resolveCoreAcquired = vi.fn();
    const stale = { ...receipt, generation: 1 };
    await expect(submitDynamicFamilyBuild({
      taskId: "task_preflight",
      runId: "run_preflight",
      submission,
      sourceAssetRegistry: { resolveCoreAcquired } as unknown as SourceAssetRegistry,
      taskRoot: "C:\\preflight-no-side-effects",
      runtimeLimits: DEFAULT_RUNTIME_LIMITS,
      generation: 0,
      preflightReceipt: stale,
      preflightSubmission: submission,
    })).rejects.toThrow(/tampered|digest/);
    expect(resolveCoreAcquired).not.toHaveBeenCalled();
  });
});
