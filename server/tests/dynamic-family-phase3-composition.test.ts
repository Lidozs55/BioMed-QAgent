import { createServer, type Server } from "node:http";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  computeFamilySpecDigest,
  DEFAULT_RUNTIME_LIMITS,
  type DynamicFamilyPreflightReceipt,
  type FamilySpec,
  type Projection,
} from "@biomed/contracts";
import { afterEach, describe, expect, test } from "vitest";

import { canonicalDigest } from "../src/dataset/adapters/identity.js";
import { submitDynamicFamilyPublication } from "../src/dataset/dynamic-family/submission.js";
import { publishDynamicFamily } from "../src/dataset/dynamic-family/publication.js";
import type { BioMedAgentAdapter, BioMedAgentSession, BioMedSessionConfig } from "../src/agent/contracts.js";
import {
  createPhase3Runtime,
  type Phase3AcquisitionRuntime,
  type Phase3DynamicFamilySeams,
} from "../src/runtime/phase3-composition.js";
import type { CoreAcquisitionResult } from "../src/dataset/acquisition/runtime.js";

const roots: string[] = [];
const servers: Server[] = [];
const DIGEST = "b".repeat(64);
const IMPLEMENTATION_DIGEST = "c".repeat(64);
const REQUEST_DIGEST = "d".repeat(64);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function rawSubmission(): Promise<Record<string, unknown>> {
  const projection: Projection = {
    projection_id: "projection_phase3",
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
  const unsignedFamily: FamilySpec = {
    family_spec_id: "family_phase3",
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
    integration_policy_ref: "policy_integration",
    validation_policy_ref: "policy_validation",
    assessment_policy_ref: "policy_assessment",
    resource_class_request: "small",
    scope: "task",
    author: "agent",
    evidence_refs: [],
  };
  const family = { ...unsignedFamily, canonical_digest: await computeFamilySpecDigest(unsignedFamily) };
  return {
    schema_version: "1.0",
    execution_backend: "in_process_unisolated",
    family_spec: family,
    projection_id: projection.projection_id,
    transform_source: "export const transform = { run({ inputs }) { const [input] = inputs; return { outputs: [{ handle: 'out_0', table_id: 'records', schema_ref: 'schema_records', locator_ref: input.receipt_id, content: 'record_id,value\\nr1,1\\n', row_count: 1 }] }; } };",
    transform_metadata: {
      transform_id: "transform_phase3", version: "1.0.0", entrypoint: "transform.run",
      declared_input_roles: [{ role: "source", media_type: "text/csv", constraint_ref: null }],
      declared_output_tables: [{ table_id: "records", schema_ref: "schema_records" }],
      bound_family_spec_digest: family.canonical_digest,
      bound_projection_digest: canonicalDigest(projection),
      determinism_profile: "deterministic", resource_class: "small", origin: "agent", scope: "task", review_refs: [],
    },
    registered_sources: {},
    acquisition_requests: {
      binding_1: {
        provider_id: "geo.files.v1",
        parameters: { source: "geo", accession: "GSE_PHASE3", entities: {} },
      },
    },
    execution_proposal: {
      schema_version: "2.0", spec_kind: "proposal", requirement_id: "build_phase3",
      family_spec_ref: { scope: "task", id: family.family_spec_id, version: family.semantic_version, digest: family.canonical_digest },
      projection_ref: projection.projection_id,
      transform_refs: [{ scope: "task", id: "transform_phase3", version: "1.0.0", digest: DIGEST }],
      policy_refs: [], output_format: "long_table", idempotency_identity: "phase3_identity",
      source_bindings: [{ binding_id: "binding_1", source: "geo", input_requirement_ref: "source", parameters: {} }],
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("dynamic family phase3 composition fencing", () => {
  test("serializes duplicate submit and fences transform/publication after superseding prepare", async () => {
    const tasksRoot = await mkdtemp(path.join(os.tmpdir(), "phase3-dynamic-composition-"));
    roots.push(tasksRoot);
    const workspacesRoot = await mkdtemp(path.join(os.tmpdir(), "phase3-dynamic-workspaces-"));
    roots.push(workspacesRoot);
    const transformEntered = deferred();
    const promotionFenceEntered = deferred();
    const releasePromotionFence = deferred();
    let inPromotionFence = false;
    let acquisitionCalls = 0;
    let transformCalls = 0;
    let publicationCalls = 0;
    const actualSubmit = submitDynamicFamilyPublication;
    const actualPublish = publishDynamicFamily;

    const acquisitionRuntimeFactory: NonNullable<Phase3DynamicFamilySeams["createAcquisitionRuntime"]> = ({
      taskRoot,
      sourceAssetRegistry,
    }): Phase3AcquisitionRuntime => ({
      plan: async () => ({
        requestIdentityDigest: REQUEST_DIGEST,
        providerId: "geo.files.v1",
        implementationDigest: IMPLEMENTATION_DIGEST,
        recipe: null,
      }),
      acquire: async (request): Promise<CoreAcquisitionResult> => {
        acquisitionCalls += 1;
        const sourceDir = path.join(taskRoot, "source_assets");
        await mkdir(sourceDir, { recursive: true });
        await writeFile(path.join(sourceDir, "geo.csv"), "record_id,value\nr1,1\n", "utf8");
        const receipt = await sourceAssetRegistry.register({
          sourceId: `geo_${acquisitionCalls}`,
          relativePath: "source_assets/geo.csv",
        });
        await sourceAssetRegistry.registerCoreAcquisitionProvenance(receipt, {
          provider_id: request.provider_id!,
          implementation_digest: IMPLEMENTATION_DIGEST,
          request_identity_digest: REQUEST_DIGEST,
        });
        return {
          requestIdentityDigest: REQUEST_DIGEST,
          attempts: [],
          sourceAsset: receipt.asset_ref,
          extractionAssets: [],
        };
      },
    });

    const adapter: BioMedAgentAdapter = {
      async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
        const tools = config.tools ?? [];
        const prepareTool = tools.find((tool) => tool.name === "prepare_dynamic_family_publication");
        const submitTool = tools.find((tool) => tool.name === "submit_dynamic_family_publication");
        if (prepareTool === undefined || submitTool === undefined) throw new Error("dynamic tools were not injected");
        return {
          piSessionId: `pi_${config.taskId}`,
          taskId: config.taskId,
          runId: config.runId,
          run: async function* run(): AsyncIterable<import("../src/agent/contracts.js").BioMedAgentEvent> {
            const raw = await rawSubmission();
            const prepared = await prepareTool.execute(raw);
            if (prepared.isError === true) throw new Error(`prepare failed: ${prepared.content}`);
            const receipt = (JSON.parse(prepared.content) as { preflight_receipt: DynamicFamilyPreflightReceipt }).preflight_receipt;
            const submitPayload = structuredClone(raw);
            (submitPayload.execution_proposal as { transform_refs: Array<{ digest: string }> }).transform_refs[0]!.digest =
              receipt.host_descriptor_digest;
            submitPayload.preflight_receipt = receipt;
            const duplicateSubmits = [
              submitTool.execute(submitPayload),
              submitTool.execute(structuredClone(submitPayload)),
            ];
            await transformEntered.promise;
            await promotionFenceEntered.promise;
            const supersedingPrepare = await prepareTool.execute(raw);
            expect(supersedingPrepare.isError).not.toBe(true);
            releasePromotionFence.resolve();
            const results = await Promise.all(duplicateSubmits);
            expect(results.every((result) => result.isError === true)).toBe(true);
            expect(acquisitionCalls).toBe(1);
            expect(transformCalls).toBe(1);
            expect(publicationCalls).toBe(1);
            yield { type: "turn_completed" };
          },
          cancel: async () => undefined,
          dispose: async () => undefined,
        };
      },
    };
    const runtime = await createPhase3Runtime({
      tasksRoot,
      workspacesRoot,
      repositoryRoot: path.resolve("."),
      agentExecPolicy: null,
      adapter,
      database: null,
      browserPool: null,
      resolveRuntimeLimits: () => ({ ...DEFAULT_RUNTIME_LIMITS, build_timeout_seconds: 30 }),
      dynamicFamilySeams: {
        createAcquisitionRuntime: acquisitionRuntimeFactory,
        assertExecutionLockOwned: async (assertOwned) => {
          if (inPromotionFence) {
            inPromotionFence = false;
            promotionFenceEntered.resolve();
            await releasePromotionFence.promise;
          }
          return assertOwned();
        },
        submitDynamicFamilyPublication: async (input) => {
          const result = await actualSubmit(input);
          transformCalls += 1;
          transformEntered.resolve();
          return result;
        },
        publishDynamicFamily: async (input) => {
          publicationCalls += 1;
          return actualPublish({
            ...input,
            signal: input.signal ?? new AbortController().signal,
          });
        },
        beforeDynamicFamilyFinalFence: async () => {
          inPromotionFence = true;
        },
      },
    });
    const server = createServer((request, response) => { void runtime.handle(request, response); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("phase3 test server has no address");
    const created = await fetch(`http://127.0.0.1:${address.port}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "phase3_dynamic_composition",
        input: "exercise the dynamic family composition",
        databases: [],
        mode: "agent",
      }),
    });
    expect(created.status).toBe(202);
    const accepted = await created.json() as { task_id: string; run_id: string };
    await expect.poll(async () => {
      const snapshot = await runtime.repository.getSnapshot(accepted.task_id);
      return snapshot?.runs.find((run) => run.run_id === accepted.run_id)?.status;
    }, { timeout: 30_000 }).toBe("completed");
    const publishRoot = path.join(tasksRoot, accepted.task_id, "dataset_runs", accepted.run_id, "build_phase3", "publish");
    await expect(readdir(publishRoot)).resolves.toEqual([]);
    const events = await runtime.repository.listEvents(accepted.task_id, 0);
    expect(events.some((event) => event.payload.type === "publication_created")).toBe(false);
    await runtime.close();
  });

  test("publishes a valid prepared receipt through the complete phase3 composition", async () => {
    const tasksRoot = await mkdtemp(path.join(os.tmpdir(), "phase3-dynamic-success-"));
    roots.push(tasksRoot);
    const workspacesRoot = await mkdtemp(path.join(os.tmpdir(), "phase3-dynamic-success-workspaces-"));
    roots.push(workspacesRoot);
    let acquisitionCalls = 0;
    let transformCalls = 0;
    let publicationCalls = 0;
    const actualSubmit = submitDynamicFamilyPublication;
    const actualPublish = publishDynamicFamily;
    const acquisitionRuntimeFactory: NonNullable<Phase3DynamicFamilySeams["createAcquisitionRuntime"]> = ({
      taskRoot,
      sourceAssetRegistry,
    }): Phase3AcquisitionRuntime => ({
      plan: async () => ({
        requestIdentityDigest: REQUEST_DIGEST,
        providerId: "geo.files.v1",
        implementationDigest: IMPLEMENTATION_DIGEST,
        recipe: null,
      }),
      acquire: async (request): Promise<CoreAcquisitionResult> => {
        acquisitionCalls += 1;
        const sourceDir = path.join(taskRoot, "source_assets");
        await mkdir(sourceDir, { recursive: true });
        await writeFile(path.join(sourceDir, "geo.csv"), "record_id,value\nr1,1\n", "utf8");
        const receipt = await sourceAssetRegistry.register({
          sourceId: `geo_success_${acquisitionCalls}`,
          relativePath: "source_assets/geo.csv",
        });
        await sourceAssetRegistry.registerCoreAcquisitionProvenance(receipt, {
          provider_id: request.provider_id!,
          implementation_digest: IMPLEMENTATION_DIGEST,
          request_identity_digest: REQUEST_DIGEST,
        });
        return {
          requestIdentityDigest: REQUEST_DIGEST,
          attempts: [],
          sourceAsset: receipt.asset_ref,
          extractionAssets: [],
        };
      },
    });
    const adapter: BioMedAgentAdapter = {
      async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
        const tools = config.tools ?? [];
        const prepareTool = tools.find((tool) => tool.name === "prepare_dynamic_family_publication");
        const submitTool = tools.find((tool) => tool.name === "submit_dynamic_family_publication");
        if (prepareTool === undefined || submitTool === undefined) throw new Error("dynamic tools were not injected");
        return {
          piSessionId: `pi_success_${config.taskId}`,
          taskId: config.taskId,
          runId: config.runId,
          run: async function* run(): AsyncIterable<import("../src/agent/contracts.js").BioMedAgentEvent> {
            const raw = await rawSubmission();
            const prepared = await prepareTool.execute(raw);
            if (prepared.isError === true) throw new Error(`prepare failed: ${prepared.content}`);
            const receipt = (JSON.parse(prepared.content) as { preflight_receipt: DynamicFamilyPreflightReceipt }).preflight_receipt;
            const submitPayload = structuredClone(raw);
            (submitPayload.execution_proposal as { transform_refs: Array<{ digest: string }> }).transform_refs[0]!.digest =
              receipt.host_descriptor_digest;
            submitPayload.preflight_receipt = receipt;
            const submitted = await submitTool.execute(submitPayload);
            expect(submitted.isError).not.toBe(true);
            yield { type: "turn_completed" };
          },
          cancel: async () => undefined,
          dispose: async () => undefined,
        };
      },
    };
    const runtime = await createPhase3Runtime({
      tasksRoot,
      workspacesRoot,
      repositoryRoot: path.resolve("."),
      agentExecPolicy: null,
      adapter,
      database: null,
      browserPool: null,
      resolveRuntimeLimits: () => ({ ...DEFAULT_RUNTIME_LIMITS, build_timeout_seconds: 30 }),
      dynamicFamilySeams: {
        createAcquisitionRuntime: acquisitionRuntimeFactory,
        submitDynamicFamilyPublication: async (input) => {
          transformCalls += 1;
          return actualSubmit(input);
        },
        publishDynamicFamily: async (input) => {
          publicationCalls += 1;
          return actualPublish({ ...input, signal: input.signal ?? new AbortController().signal });
        },
      },
    });
    const server = createServer((request, response) => { void runtime.handle(request, response); });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("phase3 success test server has no address");
    const created = await fetch(`http://127.0.0.1:${address.port}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "phase3_dynamic_success",
        input: "publish the prepared dynamic family",
        databases: [],
        mode: "agent",
      }),
    });
    expect(created.status).toBe(202);
    const accepted = await created.json() as { task_id: string; run_id: string };
    await expect.poll(async () => {
      const snapshot = await runtime.repository.getSnapshot(accepted.task_id);
      return snapshot?.runs.find((run) => run.run_id === accepted.run_id)?.status;
    }, { timeout: 30_000 }).toBe("completed");
    expect(acquisitionCalls).toBe(1);
    expect(transformCalls).toBe(1);
    expect(publicationCalls).toBe(1);
    await access(path.join(tasksRoot, accepted.task_id, "dataset_runs", accepted.run_id, "build_phase3", "publish"));
    const events = await runtime.repository.listEvents(accepted.task_id, 0);
    expect(events.some((event) => event.payload.type === "publication_created")).toBe(true);
    expect(events.some((event) => event.payload.type === "artifact_produced")).toBe(true);
    await runtime.close();
  });
});
