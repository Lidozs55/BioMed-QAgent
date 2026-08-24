import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_RUNTIME_LIMITS, computeFamilySpecDigest, type FamilySpec, type Projection } from "@biomed/contracts";
import { describe, expect, test, vi } from "vitest";

import { canonicalDigest } from "../src/dataset/adapters/identity.js";
import {
  createDynamicFamilyBuildTool,
  parseDynamicFamilyBuildSubmission,
} from "../src/agent/tools/dynamic-family-build.js";
import { submitDynamicFamilyBuild } from "../src/dataset/dynamic-family/submission.js";
import { computeHILEvidenceDigest } from "../src/dataset/contracts/hil-evidence.js";
import { expectedOutputLocatorClosure } from "../src/dataset/dynamic-family/execution.js";
import { publishDynamicFamily, type PublishDynamicFamilyInput } from "../src/dataset/dynamic-family/publication.js";
import {
  PRODUCTION_B3_CONFIGURED_HEAP_BYTES,
  PRODUCTION_B3_CONFIGURED_TEMP_BYTES,
  PRODUCTION_B3_RESOURCE_POLICY,
} from "../src/dataset/validation/b3-production-policy.js";
import {
  DiskIndexResourceLimitError,
  TupleIndex,
} from "../src/dataset/validation/disk-index.js";
import { OperationAbortedError } from "../src/dataset/cooperative.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

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
    registered_sources: { source_binding: `asset_${A}` },
    acquisition_requests: {},
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
  test("requires committed outputs only for locators used by declared outputs", () => {
    const output = (tableId: string, locatorRef: string) => ({
      table_id: tableId,
      schema_ref: `schema_${tableId}`,
      artifact_ref: `artifact_${tableId}`,
      locator_ref: locatorRef,
      relative_path: `tables/${tableId}.csv`,
      delimiter: "," as const,
      header: ["id"],
      source_locators: [],
    });
    expect(expectedOutputLocatorClosure([
      output("primary", "asset_source_a"),
      output("supporting", "asset_source_a"),
      output("derived", "asset_source_b"),
    ])).toEqual(["asset_source_a", "asset_source_b"]);
  });

  test("parses only an explicitly unisolated, digest-bound submission", async () => {
    const parsed = await parseDynamicFamilyBuildSubmission(await submission());
    expect(parsed.execution_backend).toBe("in_process_unisolated");
    expect(parsed.family_spec.scope).toBe("task");
    expect(parsed.projection.projection_id).toBe("projection_dynamic");
  });

  test("accepts a fixed Core provider request instead of a pre-registered carrier", async () => {
    const raw = await submission();
    raw.registered_sources = {};
    raw.acquisition_requests = {
      source_binding: {
        provider_id: "chembl.files.v1",
        parameters: {
          source: "chembl",
          accession: "CHEMBL203",
          entities: { target_ids: ["CHEMBL203"], compound_ids: ["CHEMBL25"] },
        },
      },
    };
    const parsed = await parseDynamicFamilyBuildSubmission(raw);
    expect(parsed.acquisition_requests.source_binding?.provider_id).toBe("chembl.files.v1");
    expect(parsed.registered_sources).toEqual({});
  });

  test("accepts a PubMed full-text Core acquisition request", async () => {
    const raw = await submission();
    raw.registered_sources = {};
    raw.acquisition_requests = {
      source_binding: {
        provider_id: "pubmed.files.v1",
        parameters: {
          source: "pubmed",
          accession: "PMC10408569",
          entities: {},
        },
      },
    };
    const parsed = await parseDynamicFamilyBuildSubmission(raw);
    expect(parsed.acquisition_requests.source_binding?.provider_id).toBe("pubmed.files.v1");
    expect(parsed.registered_sources).toEqual({});
  });

  test("exposes the complete nested contract and fixed-provider parameter guidance", () => {
    const tool = createDynamicFamilyBuildTool({ submit: async () => ({ ok: true }) });
    const schema = JSON.stringify(tool.parameters);
    expect(schema).toContain('"table_definitions"');
    expect(schema).toContain('"field_names"');
    expect(schema).toContain("Synchronous TypeScript only");
    expect(schema).toContain("target_records");
    expect(schema).toContain("maxItems");
    expect(schema).toContain("chembl.files.v1");
    expect(schema).toContain("pubchem.files.v1");
    expect(schema).toContain("pubmed.files.v1");
    expect(schema).toContain("One PMCID per binding");
    expect(schema).toContain("^PMC[1-9][0-9]*$");
    expect(schema).toContain("geo.files.v1");
  });

  test("returns computable family and projection binding digests", async () => {
    const raw = await submission();
    const family = raw.family_spec as FamilySpec;
    raw.family_spec = { ...family, canonical_digest: "0".repeat(64) };
    await expect(parseDynamicFamilyBuildSubmission(raw)).rejects.toThrow(/canonical_digest must equal [0-9a-f]{64}/);
  });

  test("exposes one callback-backed Agent tool without weakening parsing", async () => {
    let received: unknown;
    const tool = createDynamicFamilyBuildTool({
      requirePreflight: false,
      submit: async (value) => {
        received = value;
        return { ok: true, build_id: value.build_proposal.build_id };
      },
    });
    const result = await tool.execute(await submission());
    expect(tool.name).toBe("submit_dynamic_family_build");
    expect(result.isError).not.toBe(true);
    expect(received).toMatchObject({ execution_backend: "in_process_unisolated" });

    const invalid = await submission();
    invalid.execution_backend = "sandbox";
    const rejected = await tool.execute(invalid);
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toContain("dynamic_build_rejected");
  });

  test("executes registered bytes through the total unisolated Core composition", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dynamic-family-submit-"));
    try {
      await mkdir(path.join(root, "source_assets"), { recursive: true });
      await writeFile(path.join(root, "source_assets", "source.csv"), "record_id,value\nr1,1\n", "utf8");
      const registry = new SourceAssetRegistry("task_dynamic", root);
      const receipt = await registry.register({ sourceId: "source_dynamic", relativePath: "source_assets/source.csv" });
      const raw = await submission();
      const reviewFamily = raw.family_spec as FamilySpec;
      reviewFamily.table_definitions[0]!.field_names.push("review_status");
      reviewFamily.canonical_digest = await computeFamilySpecDigest(reviewFamily);
      const reviewMetadata = raw.transform_metadata as { bound_family_spec_digest: string };
      reviewMetadata.bound_family_spec_digest = reviewFamily.canonical_digest;
      const reviewProposal = raw.build_proposal as {
        family_spec_ref: { digest: string };
        transform_refs: Array<{ digest: string }>;
      };
      reviewProposal.family_spec_ref.digest = reviewFamily.canonical_digest;
      raw.registered_sources = { source_binding: receipt.asset_ref.asset_id };
      raw.transform_source = `export const transform = { run({ inputs }) { const [input] = inputs; return { outputs: [{ handle: "out_0", table_id: "records", schema_ref: "schema_records", locator_ref: input.receipt_id, content: "record_id,value,review_status\\nr1,1,human_review_pending\\n", row_count: 1 }] }; } };`;
      let parsed = await parseDynamicFamilyBuildSubmission(raw);
      const mismatchedRole = structuredClone(raw);
      const mismatchedMetadata = mismatchedRole.transform_metadata as {
        declared_input_roles: Array<{ role: string }>;
      };
      mismatchedMetadata.declared_input_roles[0]!.role = "wrong_role";
      await expect(submitDynamicFamilyBuild({
        taskId: "task_dynamic", runId: "run_dynamic",
        submission: await parseDynamicFamilyBuildSubmission(mismatchedRole),
        sourceAssetRegistry: registry, taskRoot: root, runtimeLimits: DEFAULT_RUNTIME_LIMITS,
      })).rejects.toThrow(/binding 'source_binding'.*expected 'source'.*received 'wrong_role'/);
      await expect(submitDynamicFamilyBuild({
        taskId: "task_dynamic", runId: "run_dynamic", submission: parsed,
        sourceAssetRegistry: registry, taskRoot: root, runtimeLimits: DEFAULT_RUNTIME_LIMITS,
      })).rejects.toThrow(/Core acquisition provenance/);
      await registry.registerCoreAcquisitionProvenance(receipt, {
        provider_id: "fixture.files.v1",
        implementation_digest: A,
        request_identity_digest: B,
      });
      let expectedDigest = "";
      await expect(submitDynamicFamilyBuild({
        taskId: "task_dynamic", runId: "run_dynamic", submission: parsed,
        sourceAssetRegistry: registry, taskRoot: root, runtimeLimits: DEFAULT_RUNTIME_LIMITS,
      })).rejects.toThrow(/Host-compiled descriptor ([0-9a-f]{64})/);
      try {
        await submitDynamicFamilyBuild({
          taskId: "task_dynamic", runId: "run_dynamic", submission: parsed,
          sourceAssetRegistry: registry, taskRoot: root, runtimeLimits: DEFAULT_RUNTIME_LIMITS,
        });
      } catch (error) {
        expectedDigest = /([0-9a-f]{64})/.exec((error as Error).message)?.[1] ?? "";
      }
      const proposal = raw.build_proposal as { transform_refs: Array<{ digest: string }> };
      proposal.transform_refs[0]!.digest = expectedDigest;
      parsed = await parseDynamicFamilyBuildSubmission(raw);
      const result = await submitDynamicFamilyBuild({
        taskId: "task_dynamic", runId: "run_dynamic", submission: parsed,
        sourceAssetRegistry: registry, taskRoot: root, runtimeLimits: DEFAULT_RUNTIME_LIMITS,
      });
      expect(result.receipt.sandbox_backend).toBe("in_process_unisolated");
      expect(result.operationResult.output_summary).toMatchObject({ tables: { records: { row_count: 1 } } });
      expect(result.materialization.candidate.tables[0]?.definition.table_id).toBe("records");
      const publishInput = {
        taskId: "task_dynamic", taskRoot: root,
        workspaceRoot: path.join(root, "agent-workspace"),
        buildId: parsed.build_proposal.build_id,
        execution: result,
        validationProfileRef: parsed.family_spec.validation_policy_ref,
        signal: new AbortController().signal,
      };
      await expect(publishDynamicFamily(publishInput)).rejects.toThrow(/durable HIL gate/);
      for (const action of ["reject", "approve"] as const) {
        await expect(publishDynamicFamily({
          ...publishInput,
          hilGate: {
            requestHIL: async (input) => ({
              schema_version: "1.0",
              review_id: `review_${action}`,
              request_id: `hil_${action}`,
              decision: { action },
              reviewer: "user",
              reviewed_at: "2026-08-23T00:00:00.000Z",
              evidence_digest: computeHILEvidenceDigest(input),
              reason: null,
            }),
          },
        })).rejects.toThrow(new RegExp(`not accepted: ${action}`));
      }
      await expect(publishDynamicFamily({
        ...publishInput,
        hilGate: {
          requestHIL: async () => ({
            schema_version: "1.0",
            review_id: "review_mismatch",
            request_id: "hil_mismatch",
            decision: { action: "accept" },
            reviewer: "user",
            reviewed_at: "2026-08-23T00:00:00.000Z",
            evidence_digest: "f".repeat(64),
            reason: null,
          }),
        },
      })).rejects.toThrow(/evidence digest does not match/);
      await expect(access(path.join(root, "datasets_build", parsed.build_proposal.build_id, "publish")))
        .rejects.toThrow();

      let reviewRequest: { review_type: string; evidence: unknown } | null = null;
      const published = await publishDynamicFamily({
        ...publishInput,
        hilGate: {
          requestHIL: async (input) => {
            reviewRequest = input;
            return {
              schema_version: "1.0",
              review_id: "review_dynamic",
              request_id: "hil_dynamic",
              decision: { action: "accept" },
              reviewer: "user",
              reviewed_at: "2026-08-23T00:00:00.000Z",
              evidence_digest: computeHILEvidenceDigest(input),
              reason: "Reviewed the candidate",
            };
          },
        },
      });
      expect(published.validation.status).toBe("passed");
      expect(published.assessment.product_status).toBe("publishable");
      expect(reviewRequest).toMatchObject({ review_type: "publication_acceptance" });
      expect(published.assessment.human_review_evidence).toMatchObject([{ decision: "accept" }]);
      expect(published.publication.publication.manifest_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(published.manifest.artifacts.map((artifact) => artifact.role)).toContain("provenance");
      const provenance = JSON.parse(await readFile(
        path.join(root, "datasets_build", parsed.build_proposal.build_id, "provenance.json"),
        "utf8",
      )) as { hil_acceptance?: { decision?: string; evidence_digest?: string } };
      expect(provenance.hil_acceptance).toMatchObject({ decision: "accept" });
      expect(provenance.hil_acceptance?.evidence_digest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects sandbox claims, direct paths, examples, and unknown fields", async () => {
    const sandbox = await submission();
    sandbox.execution_backend = "container";
    await expect(parseDynamicFamilyBuildSubmission(sandbox)).rejects.toThrow(/explicit/);
    const directPath = await submission();
    directPath.registered_sources = { source_binding: "workspace/data.csv" };
    await expect(parseDynamicFamilyBuildSubmission(directPath)).rejects.toThrow(/asset_<sha256>/);
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

/**
 * Full Core composition for one tiny records build, returning a publish-ready
 * execution plus the task/build identity. The digest handshake is resolved by
 * re-submitting with the expected transform descriptor digest.
 */
async function executedSubmission(
  root: string,
  content = "record_id,value\nr1,1\n",
): Promise<{ publishInput: PublishDynamicFamilyInput; buildId: string }> {
  await mkdir(path.join(root, "source_assets"), { recursive: true });
  await writeFile(path.join(root, "source_assets", "source.csv"), "record_id,value\nr1,1\n", "utf8");
  const registry = new SourceAssetRegistry("task_dynamic", root);
  const receipt = await registry.register({
    sourceId: "source_dynamic",
    relativePath: "source_assets/source.csv",
  });
  const raw = await submission();
  raw.registered_sources = { source_binding: receipt.asset_ref.asset_id };
  raw.transform_source = `export const transform = { run({ inputs }) { const [input] = inputs; return { outputs: [{ handle: "out_0", table_id: "records", schema_ref: "schema_records", locator_ref: input.receipt_id, content: ${JSON.stringify(content)}, row_count: 1 }] }; } };`;
  let parsed = await parseDynamicFamilyBuildSubmission(raw);
  await registry.registerCoreAcquisitionProvenance(receipt, {
    provider_id: "fixture.files.v1",
    implementation_digest: A,
    request_identity_digest: B,
  });
  try {
    await submitDynamicFamilyBuild({
      taskId: "task_dynamic", runId: "run_dynamic", submission: parsed,
      sourceAssetRegistry: registry, taskRoot: root, runtimeLimits: DEFAULT_RUNTIME_LIMITS,
    });
  } catch (error) {
    const expectedDigest = /([0-9a-f]{64})/.exec((error as Error).message)?.[1] ?? "";
    if (expectedDigest.length === 0) throw error;
    const proposal = raw.build_proposal as { transform_refs: Array<{ digest: string }> };
    proposal.transform_refs[0]!.digest = expectedDigest;
    parsed = await parseDynamicFamilyBuildSubmission(raw);
  }
  const result = await submitDynamicFamilyBuild({
    taskId: "task_dynamic", runId: "run_dynamic", submission: parsed,
    sourceAssetRegistry: registry, taskRoot: root, runtimeLimits: DEFAULT_RUNTIME_LIMITS,
  });
  const buildId = parsed.build_proposal.build_id;
  return {
    buildId,
    publishInput: {
      taskId: "task_dynamic",
      taskRoot: root,
      workspaceRoot: path.join(root, "agent-workspace"),
      buildId,
      execution: result,
      validationProfileRef: parsed.family_spec.validation_policy_ref,
      signal: new AbortController().signal,
    },
  };
}

async function resourceReport(root: string, buildId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(
    path.join(root, "datasets_build", buildId, "resource_report.json"),
    "utf8",
  )) as Record<string, unknown>;
}

describe("production B3 resource/disk lane", () => {
  test("routes production publication B3 through the measured memory lane and records the report", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dynamic-family-b3-memory-"));
    try {
      const { publishInput, buildId } = await executedSubmission(root);
      const published = await publishDynamicFamily(publishInput);

      expect(published.validation.status).toBe("passed");
      const report = await resourceReport(root, buildId);
      expect(report.schemaVersion).toBe("b3-multitable-resource-preflight.v2");
      expect(report.measurementSource).toBe("core_receipted_table_scan.v1");
      expect(report.validatorMode).toBe("memory");
      expect(report.failureReason).toBeNull();
      expect((report.measuredInputs as unknown[])).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("selects the explicit disk lane above threshold and cleans the task-owned indexes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dynamic-family-b3-disk-"));
    try {
      const { publishInput, buildId } = await executedSubmission(root);
      const published = await publishDynamicFamily({
        ...publishInput,
        b3Validation: {
          policy: {
            ...PRODUCTION_B3_RESOURCE_POLICY,
            policyId: "b3-production-e2e-disk-test",
            memoryThresholdBytes: 0,
          },
          configuredHeapBytes: PRODUCTION_B3_CONFIGURED_HEAP_BYTES,
          configuredTempBytes: PRODUCTION_B3_CONFIGURED_TEMP_BYTES,
        },
      });

      expect(published.validation.status).toBe("passed");
      const report = await resourceReport(root, buildId);
      expect(report.validatorMode).toBe("disk");
      expect(report.failureReason).toBeNull();
      await expect(access(path.join(root, "builds", buildId, "b3-index"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed when the measured resource decision rejects above the temp quota", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "dynamic-family-b3-reject-"));
    try {
      const { publishInput, buildId } = await executedSubmission(root);
      await expect(publishDynamicFamily({
        ...publishInput,
        b3Validation: {
          policy: {
            ...PRODUCTION_B3_RESOURCE_POLICY,
            policyId: "b3-production-e2e-reject-test",
            memoryThresholdBytes: 0,
            tempQuotaBytes: 1,
          },
          configuredHeapBytes: PRODUCTION_B3_CONFIGURED_HEAP_BYTES,
          configuredTempBytes: PRODUCTION_B3_CONFIGURED_TEMP_BYTES,
        },
      })).rejects.toThrow(/not publishable/);

      const report = await resourceReport(root, buildId);
      expect(report.validatorMode).toBe("reject");
      expect(report.failureReason).toBe("temp_quota_exceeded");
      await expect(access(path.join(root, "builds", buildId, "b3-index"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("cleans task-owned B3 indexes when disk validation throws, is cancelled, or hits quota", async () => {
    const cases = [
      {
        name: "validation throws",
        run: async (publishInput: PublishDynamicFamilyInput) => {
          const validationError = new Error("synthetic B3 validation failure");
          vi.spyOn(TupleIndex.prototype, "primaryKeyCheck").mockImplementation(() => {
            throw validationError;
          });
          await expect(publishDynamicFamily({
            ...publishInput,
            b3Validation: {
              policy: { ...PRODUCTION_B3_RESOURCE_POLICY, memoryThresholdBytes: 0 },
              configuredHeapBytes: PRODUCTION_B3_CONFIGURED_HEAP_BYTES,
              configuredTempBytes: PRODUCTION_B3_CONFIGURED_TEMP_BYTES,
            },
          })).rejects.toBe(validationError);
        },
      },
      {
        name: "cancellation occurs",
        run: async (publishInput: PublishDynamicFamilyInput) => {
          const controller = new AbortController();
          controller.abort();
          await expect(publishDynamicFamily({
            ...publishInput,
            signal: controller.signal,
            b3Validation: {
              policy: { ...PRODUCTION_B3_RESOURCE_POLICY, memoryThresholdBytes: 0 },
              configuredHeapBytes: PRODUCTION_B3_CONFIGURED_HEAP_BYTES,
              configuredTempBytes: PRODUCTION_B3_CONFIGURED_TEMP_BYTES,
            },
          })).rejects.toBeInstanceOf(OperationAbortedError);
        },
      },
      {
        name: "quota fails",
        run: async (publishInput: PublishDynamicFamilyInput) => {
          const originalCreate = TupleIndex.create.bind(TupleIndex);
          vi.spyOn(TupleIndex, "create").mockImplementation(async (options) =>
            originalCreate({ ...options, quotaBytes: 32 * 1024 }));
          await expect(publishDynamicFamily({
            ...publishInput,
            b3Validation: {
              policy: { ...PRODUCTION_B3_RESOURCE_POLICY, memoryThresholdBytes: 0 },
              configuredHeapBytes: PRODUCTION_B3_CONFIGURED_HEAP_BYTES,
              configuredTempBytes: PRODUCTION_B3_CONFIGURED_TEMP_BYTES,
            },
          })).rejects.toBeInstanceOf(DiskIndexResourceLimitError);
        },
      },
    ] as const;

    for (const testCase of cases) {
      const root = await mkdtemp(path.join(os.tmpdir(), `dynamic-family-b3-cleanup-${testCase.name.replaceAll(" ", "-")}-`));
      try {
        const { publishInput, buildId } = await executedSubmission(root, testCase.name === "quota fails"
          ? `record_id,value\n${"x".repeat(40_000)},1\n`
          : undefined);
        await testCase.run(publishInput);
        await expect(access(path.join(root, "builds", buildId, "b3-index"))).rejects.toThrow();
      } finally {
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
