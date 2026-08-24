import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ProviderRevisionEvidenceV1,
  SourceAssetRegistrationReceipt,
} from "@biomed/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseDatasetBuildSpec } from "../src/dataset/contracts/index.js";
import {
  TsDatasetCoreAdapter,
  type ExecuteDatasetBuildInput,
} from "../src/dataset/service/dataset-core.js";
import {
  requireAuthoritativeProviderRevisionEvidence,
  TypeScriptDatasetCore,
  type BuildRecord,
  type ExecuteContext,
  type ValidateContext,
} from "../src/dataset/service/ts-core.js";
import { createDefaultSchemaRegistry } from "../src/dataset/schema/index.js";
import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";

const TASK_ID = "task_provider_revision_plumbing";
const roots: string[] = [];

const completedRecord = (buildId: string): BuildRecord => ({
  build_id: buildId,
  status: "completed",
  error: null,
  publication_id: null,
  publication: null,
  manifest: null,
  validation: null,
  completed_operations: [],
  rejected_sources: [],
});

function spec(buildId: string): ReturnType<typeof parseDatasetBuildSpec> {
  return parseDatasetBuildSpec({
    schema_version: "1.0",
    build_id: buildId,
    objective: "Provider revision evidence transport audit",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: "gene_expression.long.v1",
    source_bindings: [{
      schema_version: "1.0",
      binding_id: "binding_gdc",
      source: "gdc",
      acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "gdc.files.v1" },
      adapter_id: "gdc.expression.v1",
    }],
    validation_profile_ref: "gene_expression.release.v1",
  });
}

function evidence(receipt: SourceAssetRegistrationReceipt): ProviderRevisionEvidenceV1 {
  return {
    schema_version: "1.0",
    canonical_accession: "GDC:TEST",
    provider_snapshot_identity: "gdc-fixture-snapshot:v1",
    provider_revision_token: null,
    source_asset_registration_receipt: receipt,
  };
}

async function fixture(): Promise<{
  taskRoot: string;
  core: TypeScriptDatasetCore;
  adapter: TsDatasetCoreAdapter;
  registry: SourceAssetRegistry;
}> {
  const taskRoot = await mkdtemp(path.join(os.tmpdir(), "provider-revision-plumbing-"));
  roots.push(taskRoot);
  await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
  const core = new TypeScriptDatasetCore({ taskId: TASK_ID, taskRoot });
  return {
    taskRoot,
    core,
    adapter: new TsDatasetCoreAdapter(core),
    registry: new SourceAssetRegistry(TASK_ID, taskRoot),
  };
}

async function install(
  taskRoot: string,
  registry: SourceAssetRegistry,
  name: string,
  bytes: string,
  role: "source" | "mapping" | "metadata",
  sourceId = "binding_gdc",
): Promise<SourceAssetRegistrationReceipt> {
  const relativePath = `source_assets/${name}`;
  await writeFile(path.join(taskRoot, ...relativePath.split("/")), bytes);
  return registry.register({ sourceId, relativePath, role });
}

function executeInput(
  buildId: string,
  sourceFile: string,
  overrides: Partial<ExecuteDatasetBuildInput> = {},
): ExecuteDatasetBuildInput {
  return {
    taskId: TASK_ID,
    runId: `run_${buildId}`,
    piSessionId: "pi_provider_revision",
    toolCallId: "call_provider_revision",
    spec: spec(buildId),
    sourceFiles: { binding_gdc: sourceFile },
    mappingFiles: {},
    ...overrides,
  };
}

function expectRejectedMessage(
  envelope: Awaited<ReturnType<TsDatasetCoreAdapter["validate"]>>,
  message: RegExp,
): void {
  expect(envelope.ok).toBe(false);
  if (!envelope.ok) {
    expect(envelope.error.retryable).toBe(false);
    expect(envelope.error.message).toMatch(message);
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("ProviderRevisionEvidence Dataset Core plumbing", () => {
  it("rejects evidence owned by another task before V1 validation", async () => {
    const { adapter, registry, taskRoot } = await fixture();
    const receipt = await install(taskRoot, registry, "source.tsv", "gene_id\tS1\nTP53\t1\n", "source");
    const wrongTaskReceipt: SourceAssetRegistrationReceipt = {
      ...receipt,
      task_id: "task_other",
      asset_ref: { ...receipt.asset_ref, task_id: "task_other" },
    };

    const envelope = await adapter.validate({
      taskId: TASK_ID,
      runId: "run_task_mismatch",
      piSessionId: "pi_provider_revision",
      toolCallId: "call_provider_revision",
      spec: spec("build_task_mismatch"),
      providerRevisionEvidence: [evidence(wrongTaskReceipt)],
    });

    expectRejectedMessage(envelope, /different task/);
  });

  it("rejects receipt hash drift and exact receipt-field mismatches", async () => {
    const { adapter, registry, taskRoot } = await fixture();
    const receipt = await install(taskRoot, registry, "source.tsv", "AAAA", "source");
    await writeFile(path.join(taskRoot, "source_assets", "source.tsv"), "BBBB");

    const hashDrift = await adapter.validate({
      taskId: TASK_ID,
      runId: "run_hash_drift",
      piSessionId: "pi_provider_revision",
      toolCallId: "call_provider_revision",
      spec: spec("build_hash_drift"),
      providerRevisionEvidence: [evidence(receipt)],
    });
    expectRejectedMessage(hashDrift, /hash drift/);

    await writeFile(path.join(taskRoot, "source_assets", "source.tsv"), "AAAA");
    const mismatchedReceipt: SourceAssetRegistrationReceipt = {
      ...receipt,
      receipt_id: "receipt_not_the_registered_receipt",
    };
    const receiptMismatch = await adapter.validate({
      taskId: TASK_ID,
      runId: "run_receipt_mismatch",
      piSessionId: "pi_provider_revision",
      toolCallId: "call_provider_revision",
      spec: spec("build_receipt_mismatch"),
      providerRevisionEvidence: [evidence(mismatchedReceipt)],
    });
    expectRejectedMessage(receiptMismatch, /does not match the task-owned asset receipt/);
  });

  it("requires the exact asset and role receipt among the current build inputs", async () => {
    const { adapter, core, registry, taskRoot } = await fixture();
    const sourceReceipt = await install(
      taskRoot,
      registry,
      "source.tsv",
      "gene_id\tS1\nTP53\t1\n",
      "source",
    );
    const otherReceipt = await install(taskRoot, registry, "other.tsv", "other bytes", "source");
    const mappingRoleReceipt = await registry.register({
      sourceId: "binding_gdc",
      relativePath: sourceReceipt.relative_path,
      role: "mapping",
    });
    vi.spyOn(core, "executeDatasetBuild").mockResolvedValue(completedRecord("build_binding"));

    const wrongAsset = await adapter.execute(executeInput(
      "build_binding",
      sourceReceipt.relative_path,
      { providerRevisionEvidence: [evidence(otherReceipt)] },
    ));
    expectRejectedMessage(wrongAsset, /not bound to this build input receipt/);

    const wrongRole = await adapter.execute(executeInput(
      "build_binding",
      sourceReceipt.relative_path,
      { providerRevisionEvidence: [evidence(mappingRoleReceipt)] },
    ));
    expectRejectedMessage(wrongRole, /not bound to this build input receipt/);
  });

  it("passes exact source, mapping, and metadata receipts without rewriting their roles", async () => {
    const { adapter, core, registry, taskRoot } = await fixture();
    const sourceReceipt = await install(
      taskRoot,
      registry,
      "source.tsv",
      "gene_id\tS1\nTP53\t1\n",
      "source",
    );
    const mappingReceipt = await install(
      taskRoot,
      registry,
      "mapping.tsv",
      "probe_id\tgene_id\np1\tTP53\n",
      "mapping",
    );
    const metadataReceipt = await install(
      taskRoot,
      registry,
      "metadata.txt",
      "!Sample_geo_accession = GSM1\n",
      "metadata",
    );
    const contexts: ExecuteContext[] = [];
    vi.spyOn(core, "executeDatasetBuild").mockImplementation(async (buildSpec, received) => {
      contexts.push(received);
      return completedRecord(buildSpec.build_id);
    });
    const providerRevisionEvidence = [
      evidence(sourceReceipt),
      evidence(mappingReceipt),
      evidence(metadataReceipt),
    ] as const;

    const envelope = await adapter.execute(executeInput(
      "build_exact_binding",
      sourceReceipt.relative_path,
      {
        mappingFiles: { binding_gdc: mappingReceipt.relative_path },
        metadataFiles: { binding_gdc: metadataReceipt.relative_path },
        providerRevisionEvidence,
      },
    ));

    expect(envelope.ok).toBe(true);
    const context = contexts[0];
    if (context === undefined) throw new Error("execute context was not captured");
    expect(context.providerRevisionEvidence).toEqual(providerRevisionEvidence);
    expect(context.registrationReceipts).toEqual([
      sourceReceipt,
      mappingReceipt,
      metadataReceipt,
    ]);
    expect(context.sourceAssets?.binding_gdc?.successful_attempt_id).toBe(sourceReceipt.receipt_id);
    expect(context.mappingAssets?.binding_gdc?.successful_attempt_id).toBe(mappingReceipt.receipt_id);
    expect(context.metadataAssets?.binding_gdc?.successful_attempt_id).toBe(metadataReceipt.receipt_id);
    await expect(registry.resolveRole(sourceReceipt.asset_ref.asset_id, "source")).resolves.toMatchObject({
      registration_receipt: { asset_ref: { role: "source" } },
    });
    await expect(registry.resolveRole(mappingReceipt.asset_ref.asset_id, "mapping")).resolves.toMatchObject({
      registration_receipt: { asset_ref: { role: "mapping" } },
    });
    await expect(registry.resolveRole(metadataReceipt.asset_ref.asset_id, "metadata")).resolves.toMatchObject({
      registration_receipt: { asset_ref: { role: "metadata" } },
    });
  });

  it("keeps omitted-evidence V1 validate/execute compatible and synthesizes no identity", async () => {
    const { adapter, core, taskRoot } = await fixture();
    await writeFile(
      path.join(taskRoot, "source_assets", "source.tsv"),
      "gene_id\tS1\nTP53\t1\n",
    );
    const validateContexts: ValidateContext[] = [];
    const executeContexts: ExecuteContext[] = [];
    vi.spyOn(core, "validateDatasetBuildSpec").mockImplementation(async (_spec, context = {
      providerRevisionEvidence: null,
    }) => {
      validateContexts.push(context);
      return { valid: true, reason_codes: [], reasons: [] };
    });
    vi.spyOn(core, "executeDatasetBuild").mockImplementation(async (buildSpec, context) => {
      executeContexts.push(context);
      return completedRecord(buildSpec.build_id);
    });

    const validation = await adapter.validate({
      taskId: TASK_ID,
      runId: "run_v1_validate",
      piSessionId: "pi_provider_revision",
      toolCallId: "call_provider_revision",
      spec: spec("build_v1_validate"),
    });
    const execution = await adapter.execute(executeInput(
      "build_v1_execute",
      "source_assets/source.tsv",
    ));

    expect(validation.ok).toBe(true);
    expect(execution.ok).toBe(true);
    expect(validateContexts[0]?.providerRevisionEvidence).toBeNull();
    expect(executeContexts[0]?.providerRevisionEvidence).toBeNull();
    expect(() => requireAuthoritativeProviderRevisionEvidence({
      providerRevisionEvidence: null,
    })).toThrow(/requires provider revision evidence/);
    expect(createDefaultSchemaRegistry().contains("gene_expression.long.v2")).toBe(true);
    expect(createDefaultSchemaRegistry().contains("gene_expression.probe_long.v2")).toBe(true);
  });

  it("uses byte-derived asset IDs rather than build, user, or time values", async () => {
    const { registry, taskRoot } = await fixture();
    const bytes = "immutable provider bytes";
    const receipt = await install(taskRoot, registry, "source.tsv", bytes, "source");
    const expectedSha = createHash("sha256").update(bytes).digest("hex");

    expect(receipt.sha256).toBe(expectedSha);
    expect(receipt.asset_ref.asset_id).toBe(`asset_${expectedSha}`);
    expect(receipt.asset_ref.asset_id).not.toContain("build");
    expect(evidence(receipt).provider_revision_token).toBeNull();
  });
});
