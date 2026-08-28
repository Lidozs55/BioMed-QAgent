import { describe, expect, it, vi } from "vitest";

import {
  computeDynamicFamilyPreflightReceiptDigest,
  computeFamilySpecDigest,
  DEFAULT_RUNTIME_LIMITS,
  type DynamicFamilyPreflightReceipt,
  type FamilySpec,
  type Projection,
} from "@biomed/contracts";

import { canonicalDigest } from "../src/dataset/adapters/identity.js";
import type { CoreAcquisitionPlan } from "../src/dataset/acquisition/runtime.js";
import {
  prepareDynamicFamilyPublication as prepareDynamicFamilyPublicationCore,
  validateDynamicFamilyPreflightReceipt as validateDynamicFamilyPreflightReceiptCore,
} from "../src/dataset/dynamic-family/preflight.js";
import { submitDynamicFamilyPublication } from "../src/dataset/dynamic-family/submission.js";
import type { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";
import { parseDynamicFamilyPublicationSubmission } from "../src/agent/tools/dynamic-family-publication.js";
import {
  createDynamicFamilyPublicationTool,
  createPrepareDynamicFamilyPublicationTool,
} from "../src/agent/tools/dynamic-family-publication.js";
import { createDynamicFamilyPreflightCoordinator } from "../src/runtime/dynamic-family-preflight-coordinator.js";

const DIGEST = "b".repeat(64);
const PRODUCT_REQUIREMENTS = {
  schema_version: "1.0" as const,
  profile_ref: "policy_assessment",
  dataset_family: "family_preflight",
  tables: [
    { table_id: "records", role: "primary" as const, schema_ref: "schema_records", min_rows: 1 },
  ],
  relations: [],
};

function prepareDynamicFamilyPublication(
  input: Omit<Parameters<typeof prepareDynamicFamilyPublicationCore>[0], "productRequirements">,
) {
  return prepareDynamicFamilyPublicationCore({
    ...input,
    productRequirements: PRODUCT_REQUIREMENTS,
  });
}

function validateDynamicFamilyPreflightReceipt(
  input: Omit<Parameters<typeof validateDynamicFamilyPreflightReceiptCore>[0], "productRequirements">,
) {
  return validateDynamicFamilyPreflightReceiptCore({
    ...input,
    productRequirements: PRODUCT_REQUIREMENTS,
  });
}

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
    execution_proposal: {
      schema_version: "2.0", spec_kind: "proposal", requirement_id: "build_preflight",
      family_spec_ref: { scope: "task", id: family.family_spec_id, version: family.semantic_version, digest: family.canonical_digest },
      projection_ref: projection.projection_id,
      transform_refs: [{ scope: "task", id: "transform_preflight", version: "1.0.0", digest: DIGEST }],
      policy_refs: [], output_format: "long_table", idempotency_identity: "preflight_identity",
      source_bindings: [{ binding_id: "binding_1", source: "registered_asset", input_requirement_ref: "source", parameters: {} }],
    },
  };
}

async function redigestReceipt(
  receipt: DynamicFamilyPreflightReceipt,
  changes: Partial<DynamicFamilyPreflightReceipt>,
): Promise<DynamicFamilyPreflightReceipt> {
  const unsigned = { ...receipt, ...changes, receipt_digest: "0".repeat(64) };
  return { ...unsigned, receipt_digest: await computeDynamicFamilyPreflightReceiptDigest(unsigned) };
}

describe("dynamic family prepare/submit preflight", () => {
  it("requires and digest-binds Core-owned product topology before preparation", async () => {
    const submission = await parseDynamicFamilyPublicationSubmission(await rawSubmission());
    await expect(prepareDynamicFamilyPublicationCore({
      taskId: "task_preflight",
      requirementId: "build_preflight",
      generation: 0,
      submission,
    } as unknown as Parameters<typeof prepareDynamicFamilyPublicationCore>[0]))
      .rejects.toThrow(/Core-owned product requirements/i);

    const receipt = await prepareDynamicFamilyPublicationCore({
      taskId: "task_preflight",
      requirementId: "build_preflight",
      generation: 0,
      submission,
      productRequirements: PRODUCT_REQUIREMENTS,
    });
    expect(receipt).toMatchObject({
      product_requirement_digest: canonicalDigest(PRODUCT_REQUIREMENTS),
    });
  });

  it("exposes a fixed prepare tool and makes production submit receipt-only", async () => {
    let called = false;
    const raw = await rawSubmission();
    const parsed = await parseDynamicFamilyPublicationSubmission(raw);
    const receipt = await prepareDynamicFamilyPublication({
      taskId: "task_preflight", requirementId: "build_preflight", generation: 0, submission: parsed,
    });
    const prepare = createPrepareDynamicFamilyPublicationTool({
      prepare: async () => receipt,
    });
    const prepared = await prepare.execute(raw);
    expect(prepared.isError).not.toBe(true);
    expect(JSON.parse(prepared.content)).toMatchObject({
      ok: true,
      status: "prepared",
      preflight_receipt: { receipt_digest: receipt.receipt_digest },
    });
    const submit = createDynamicFamilyPublicationTool({
      submit: async (_submission, _signal, _context, submittedReceipt) => {
        called = submittedReceipt?.receipt_digest === receipt.receipt_digest;
        return { ok: true };
      },
    });
    const missing = await submit.execute(raw);
    expect(missing.isError).toBe(true);
    expect(called).toBe(false);
    (raw.execution_proposal as { transform_refs: Array<{ digest: string }> }).transform_refs[0]!.digest = receipt.host_descriptor_digest;
    raw.preflight_receipt = receipt;
    const accepted = await submit.execute(raw);
    expect(accepted.isError).not.toBe(true);
    expect(called).toBe(true);
  });

  it("prepares facts without acquisition or prohibited result objects", async () => {
    let planned = 0;
    const submission = await parseDynamicFamilyPublicationSubmission(await rawSubmission());
    const receipt = await prepareDynamicFamilyPublication({
      taskId: "task_preflight",
      requirementId: "build_preflight",
      generation: 0,
      submission,
      planAcquisition: async () => {
        planned += 1;
        return {
          requestIdentityDigest: "a".repeat(64),
          providerId: "fixture.files.v1",
          implementationDigest: "b".repeat(64),
          recipe: null,
        };
      },
    });
    expect(planned).toBe(0);
    expect(receipt.required_input_roles).toEqual(["source"]);
    expect(receipt.output_closure).toEqual(["records"]);
    expect(receipt.topology_diagnostics).toEqual([]);
    expect(receipt.host_descriptor_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("composition prepare tool exposes only the receipt and no publication side effects", async () => {
    let acquisitionCalls = 0;
    const raw = await rawSubmission();
    const parsed = await parseDynamicFamilyPublicationSubmission(raw);
    const prepare = createPrepareDynamicFamilyPublicationTool({
      prepare: async (submission) => prepareDynamicFamilyPublication({
        taskId: "task_preflight",
        requirementId: "build_preflight",
        generation: 0,
        submission,
        planAcquisition: async () => {
          acquisitionCalls += 1;
          return {
            requestIdentityDigest: "a".repeat(64),
            providerId: "fixture.files.v1",
            implementationDigest: "b".repeat(64),
            recipe: null,
          };
        },
      }),
    });
    const result = await prepare.execute(raw);
    expect(result.isError).not.toBe(true);
    expect(acquisitionCalls).toBe(0);
    expect(result.content).toContain("preflight_receipt");
    expect(result.content).not.toMatch(/OperationResult|ProductAssessment|DatasetPublication|artifact/i);
    expect(parsed.execution_proposal.requirement_id).toBe("build_preflight");
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
    const submission = await parseDynamicFamilyPublicationSubmission(raw);
    let planned = 0;
    const receipt = await prepareDynamicFamilyPublication({
      taskId: "task_preflight", requirementId: "build_preflight", generation: 0, submission,
      planAcquisition: async () => {
        planned += 1;
        return {
          requestIdentityDigest: "a".repeat(64),
          providerId: "pubchem.files.v1",
          implementationDigest: "b".repeat(64),
          recipe: null,
        };
      },
    });
    expect(planned).toBe(1);
    expect(receipt.acquisition_plan).toMatchObject([{
      binding_id: "binding_1", mode: "builtin", provider_id: "pubchem.files.v1", asset_id: null,
    }]);
  });

  it("rejects missing and malformed Core plans for every builtin request", async () => {
    const raw = await rawSubmission();
    raw.registered_sources = {};
    raw.acquisition_requests = {
      binding_1: {
        provider_id: "pubchem.files.v1",
        parameters: { source: "pubchem", accession: "2244", entities: { pubchem_cids: ["2244"] } },
      },
    };
    const submission = await parseDynamicFamilyPublicationSubmission(raw);
    await expect(prepareDynamicFamilyPublication({
      taskId: "task_preflight", requirementId: "build_preflight", generation: 0, submission,
    })).rejects.toThrow(/Core acquisition plan/);
    await expect(prepareDynamicFamilyPublication({
      taskId: "task_preflight", requirementId: "build_preflight", generation: 0, submission,
      planAcquisition: async () => undefined as unknown as CoreAcquisitionPlan,
    })).rejects.toThrow(/Core acquisition plan/);
    await expect(prepareDynamicFamilyPublication({
      taskId: "task_preflight", requirementId: "build_preflight", generation: 0, submission,
      planAcquisition: async () => ({ requestIdentityDigest: "not-a-digest" }) as unknown as CoreAcquisitionPlan,
    })).rejects.toThrow(/Core acquisition plan/);
    await expect(prepareDynamicFamilyPublication({
      taskId: "task_preflight", requirementId: "build_preflight", generation: 0, submission,
      planAcquisition: async () => ({
        requestIdentityDigest: "a".repeat(64),
        providerId: "pubchem.files.v1",
        implementationDigest: "b".repeat(64),
        recipe: {},
      }) as unknown as CoreAcquisitionPlan,
    })).rejects.toThrow(/Core acquisition plan/);
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
    const preparedSubmission = await parseDynamicFamilyPublicationSubmission(raw);
    const requestIdentityDigest = "d".repeat(64);
    const planner = vi.fn(async () => ({
      requestIdentityDigest,
      providerId: "pubchem.files.v1",
      implementationDigest: "b".repeat(64),
      recipe: null,
    }));
    const receipt = await prepareDynamicFamilyPublication({
      taskId: "task_preflight", requirementId: "build_preflight", generation: 0,
      submission: preparedSubmission, planAcquisition: planner,
    });
    expect(receipt.acquisition_plan[0]?.request_digest).toBe(requestIdentityDigest);
    (raw.execution_proposal as { transform_refs: Array<{ digest: string }> }).transform_refs[0]!.digest = receipt.host_descriptor_digest;
    const submittedSubmission = await parseDynamicFamilyPublicationSubmission(raw);
    await expect(validateDynamicFamilyPreflightReceipt({
      receipt,
      submission: submittedSubmission,
      taskId: "task_preflight",
      requirementId: "build_preflight",
      generation: 0,
      planAcquisition: planner,
    })).resolves.toEqual(receipt);
    planner.mockResolvedValue({
      requestIdentityDigest: "e".repeat(64),
      providerId: "pubchem.files.v1",
      implementationDigest: "b".repeat(64),
      recipe: null,
    });
    await expect(validateDynamicFamilyPreflightReceipt({
      receipt,
      submission: submittedSubmission,
      taskId: "task_preflight",
      requirementId: "build_preflight",
      generation: 0,
      planAcquisition: planner,
    })).rejects.toThrow(/acquisition plan/);
  });

  it("rejects stale, cross-task, cross-build, tampered, and digest-drifted receipts", async () => {
    const submission = await parseDynamicFamilyPublicationSubmission(await rawSubmission());
    const receipt = await prepareDynamicFamilyPublication({
      taskId: "task_preflight", requirementId: "build_preflight", generation: 3, submission,
    });
    const cases = [
      { taskId: "task_preflight", requirementId: "build_preflight", generation: 4, label: "stale generation" },
      { taskId: "task_other", requirementId: "build_preflight", generation: 3, label: "cross-task" },
      { taskId: "task_preflight", requirementId: "build_other", generation: 3, label: "cross-build" },
    ];
    for (const item of cases) {
      await expect(validateDynamicFamilyPreflightReceipt({
        receipt, submission, ...item,
      })).rejects.toThrow(new RegExp(item.label));
    }
    await expect(validateDynamicFamilyPreflightReceipt({
      receipt: { ...receipt, receipt_digest: "c".repeat(64) },
      submission, taskId: "task_preflight", requirementId: "build_preflight", generation: 3,
    })).rejects.toThrow(/digest/);
    const changed = await rawSubmission();
    changed.transform_source = "export const transform = { run() { return { outputs: [{ nope: true }] }; } };";
    const changedSubmission = await parseDynamicFamilyPublicationSubmission(changed);
    await expect(validateDynamicFamilyPreflightReceipt({
      receipt, submission: changedSubmission, taskId: "task_preflight", requirementId: "build_preflight", generation: 3,
    })).rejects.toThrow(/descriptor|submission|digest/);
  });

  it("validates the receipt before resolving any registered bytes", async () => {
    const submission = await parseDynamicFamilyPublicationSubmission(await rawSubmission());
    const receipt = await prepareDynamicFamilyPublication({
      taskId: "task_preflight", requirementId: "build_preflight", generation: 0, submission,
    });
    const resolveCoreAcquired = vi.fn();
    const stale = { ...receipt, generation: 1 };
    await expect(submitDynamicFamilyPublication({
      taskId: "task_preflight",
      runId: "run_preflight",
      submission,
      sourceAssetRegistry: { resolveCoreAcquired } as unknown as SourceAssetRegistry,
      taskRoot: "C:\\preflight-no-side-effects",
      runtimeLimits: DEFAULT_RUNTIME_LIMITS,
      generation: 0,
      preflightReceipt: stale,
      preflightSubmission: submission,
      productRequirements: PRODUCT_REQUIREMENTS,
    })).rejects.toThrow(/tampered|digest/);
    expect(resolveCoreAcquired).not.toHaveBeenCalled();
  });

  it("requires a validated receipt before the public submit executor can resolve bytes", async () => {
    const submission = await parseDynamicFamilyPublicationSubmission(await rawSubmission());
    const resolveCoreAcquired = vi.fn();
    const submit = submitDynamicFamilyPublication as unknown as (input: Record<string, unknown>) => Promise<unknown>;
    await expect(submit({
      taskId: "task_preflight",
      runId: "run_preflight",
      submission,
      sourceAssetRegistry: { resolveCoreAcquired } as unknown as SourceAssetRegistry,
      taskRoot: "C:\\preflight-no-side-effects",
      runtimeLimits: DEFAULT_RUNTIME_LIMITS,
    })).rejects.toThrow(/preflight receipt|generation|prepared submission/i);
    expect(resolveCoreAcquired).not.toHaveBeenCalled();
  });
});

describe("dynamic family preflight composition fencing", () => {
  it("uses per-build generations, supersedes active receipts, and cleans consumed entries", async () => {
    const coordinator = createDynamicFamilyPreflightCoordinator();
    const submission = await parseDynamicFamilyPublicationSubmission(await rawSubmission());
    const submissionDigest = "1".repeat(64);

    const firstPreparation = coordinator.beginPrepare("build_preflight");
    const firstReceipt = await prepareDynamicFamilyPublication({
      taskId: "task_preflight", requirementId: "build_preflight", generation: firstPreparation.generation, submission,
    });
    coordinator.commitPrepare(firstPreparation, firstReceipt, submissionDigest);
    const otherBuildPreparation = coordinator.beginPrepare("build_other");
    expect(otherBuildPreparation.generation).toBe(firstPreparation.generation);

    const secondPreparation = coordinator.beginPrepare("build_preflight");
    expect(secondPreparation.generation).toBe(firstPreparation.generation + 1);
    const secondReceipt = await prepareDynamicFamilyPublication({
      taskId: "task_preflight", requirementId: "build_preflight", generation: secondPreparation.generation, submission,
    });
    coordinator.commitPrepare(secondPreparation, secondReceipt, submissionDigest);

    const validStaleReceipt = await redigestReceipt(firstReceipt, {
      generation: firstReceipt.generation,
    });
    expect(() => coordinator.reserve(validStaleReceipt, submissionDigest)).toThrow(/stale generation/);
    const reservation = coordinator.reserve(secondReceipt, submissionDigest);
    expect(coordinator.isCurrent(reservation)).toBe(true);
    coordinator.complete(reservation);
    expect(() => coordinator.reserve(secondReceipt, submissionDigest)).toThrow(/consumed|unknown/);
  });

  it("atomically consumes duplicate submits and fences transform side effects after supersession", async () => {
    const coordinator = createDynamicFamilyPreflightCoordinator();
    const submission = await parseDynamicFamilyPublicationSubmission(await rawSubmission());
    const submissionDigest = "2".repeat(64);
    const preparation = coordinator.beginPrepare("build_preflight");
    const receipt = await prepareDynamicFamilyPublication({
      taskId: "task_preflight", requirementId: "build_preflight", generation: preparation.generation, submission,
    });
    coordinator.commitPrepare(preparation, receipt, submissionDigest);
    let acquisitions = 0;
    let transforms = 0;
    const run = async (): Promise<boolean> => {
      let reservation;
      try {
        reservation = coordinator.reserve(receipt, submissionDigest);
      } catch {
        return false;
      }
      acquisitions += 1;
      await Promise.resolve();
      if (!coordinator.isCurrent(reservation)) return false;
      transforms += 1;
      coordinator.complete(reservation);
      return true;
    };
    const duplicateResults = await Promise.all([run(), run()]);
    expect(duplicateResults.filter(Boolean)).toHaveLength(1);
    expect(acquisitions).toBe(1);
    expect(transforms).toBe(1);

    const nextPreparation = coordinator.beginPrepare("build_preflight");
    const nextReceipt = await prepareDynamicFamilyPublication({
      taskId: "task_preflight", requirementId: "build_preflight", generation: nextPreparation.generation, submission,
    });
    coordinator.commitPrepare(nextPreparation, nextReceipt, submissionDigest);
    const staleReservation = coordinator.reserve(nextReceipt, submissionDigest);
    const inFlight = (async () => {
      acquisitions += 1;
      await Promise.resolve();
      if (!coordinator.isCurrent(staleReservation)) return;
      transforms += 1;
    })();
    coordinator.beginPrepare("build_preflight");
    await inFlight;
    expect(acquisitions).toBe(2);
    expect(transforms).toBe(1);
  });
});
