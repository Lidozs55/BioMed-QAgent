/**
 * M2 (I-07) TS Core E2E: the four golden outcome classes run through the
 * opt-in DATASET_CORE=ts path — SUCCESS, PARTIAL_SUCCESS, NO_DATA,
 * FAILED/SPEC_REJECTED — plus the build lock and the core event sink.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { parseDatasetBuildSpec, parseSourceAsset, type SourceAsset } from "../../src/dataset/contracts/index.js";
import { TypeScriptDatasetCore } from "../../src/dataset/service/ts-core.js";
import { TsDatasetCoreAdapter } from "../../src/dataset/service/dataset-core.js";
import { acquireBuildLock } from "../../src/dataset/service/build-lock.js";
import type { CoreOperationEvent } from "../../src/dataset/runtime/executor.js";
import type { EventPayload } from "@biomed/contracts";

const FIXTURES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "backend", "tests", "fixtures",
);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function spec(overrides: Record<string, unknown> = {}): ReturnType<typeof parseDatasetBuildSpec> {
  return parseDatasetBuildSpec({
    schema_version: "1.0",
    build_id: "build_e2e",
    objective: "compare TP53 expression",
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
    ...overrides,
  });
}

async function assetFor(taskRoot: string, fixture: string, bindingId: string): Promise<SourceAsset> {
  const fixturePath = path.join(FIXTURES_ROOT, fixture);
  const bytes = await readFile(fixturePath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const destination = path.join(taskRoot, "source_assets", `asset_${sha256}`, path.basename(fixture));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  return parseSourceAsset({
    schema_version: "1.0",
    asset_id: `asset_${sha256}`,
    kind: "source",
    relative_path: `source_assets/asset_${sha256}/${path.basename(fixture)}`,
    sha256,
    size_bytes: bytes.length,
    media_type: "text/tab-separated-values",
    generated_by_step_id: null,
    source_id: `src_${bindingId}`,
    successful_attempt_id: "attempt_1",
    derived_from_asset_id: null,
    data_level: "repository_processed",
  });
}

async function newCore(): Promise<{ taskRoot: string; taskId: string; core: TypeScriptDatasetCore; events: Array<{ event: CoreOperationEvent; buildId: string }> }> {
  const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-core-"));
  roots.push(taskRoot);
  const events: Array<{ event: CoreOperationEvent; buildId: string }> = [];
  const core = new TypeScriptDatasetCore({
    taskId: "task_e2e",
    taskRoot,
    eventSink: async (event, buildId) => {
      events.push({ event, buildId });
    },
  });
  return { taskRoot, taskId: "task_e2e", core, events };
}

describe("TS Core E2E golden outcomes (I-07)", () => {
  it("SUCCESS: gdc expression fixture completes, validates, and publishes immutably", async () => {
    const { taskRoot, core, events } = await newCore();
    const asset = await assetFor(taskRoot, "gdc/gdc_expression.tsv", "binding_gdc");
    const record = await core.executeDatasetBuild(spec(), {
      runId: "run_e2e",
      sourceAssets: { binding_gdc: asset },
    });
    expect(record.status).toBe("completed");
    expect(record.rejected_sources).toEqual([]);
    expect(record.publication_id).not.toBeNull();
    expect(record.manifest?.row_count).toBeGreaterThan(0);
    expect(record.validation?.status).toBe("passed");
    // Immutable publication on disk with the frozen layout
    // (version dir = <build_id>_<digest16>; publication id = pub_ + version).
    const versionDir = path.join(
      taskRoot, "datasets_build", "build_e2e", "publish",
      (record.publication_id ?? "").replace(/^pub_/, ""),
    );
    const manifestStat = await stat(path.join(versionDir, "dataset_manifest.json"));
    expect(manifestStat.isFile()).toBe(true);
    // Event sink saw the full lifecycle.
    const kinds = events.map(({ event }) => event.type);
    expect(kinds).toContain("build_started");
    expect(kinds).toContain("operation_started");
    expect(kinds).toContain("operation_completed");
    expect(kinds).toContain("build_completed");
    // getBuild round-trips the manifest.
    const loaded = await core.getBuild("build_e2e");
    expect(loaded?.manifest?.manifest_id).toBe(record.manifest?.manifest_id);
    expect(await core.listBuildArtifacts("build_e2e")).toHaveLength(record.manifest?.artifacts.length ?? 0);
  });

  it("PARTIAL_SUCCESS: one valid + one rejected binding publishes with partial status", async () => {
    const { taskRoot, core } = await newCore();
    const good = await assetFor(taskRoot, "gdc/gdc_expression.tsv", "binding_gdc");
    const bad = await assetFor(taskRoot, "gdc/gdc_clinical.tsv", "binding_xena");
    const record = await core.executeDatasetBuild(spec({
      source_bindings: [
        {
          schema_version: "1.0",
          binding_id: "binding_gdc",
          source: "gdc",
          acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "gdc.files.v1" },
          adapter_id: "gdc.expression.v1",
        },
        {
          schema_version: "1.0",
          binding_id: "binding_xena",
          source: "xena",
          acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "xena.files.v1" },
          adapter_id: "xena.matrix.v1",
        },
      ],
    }), {
      runId: "run_e2e",
      sourceAssets: { binding_gdc: good, binding_xena: bad },
    });
    expect(record.status).toBe("completed");
    expect(record.rejected_sources).toContain("binding_xena");
    expect(record.publication_id).not.toBeNull();
    const adapter = new TsDatasetCoreAdapter(core);
    const envelope = await adapter.execute({
      taskId: "task_e2e",
      runId: "run_e2e",
      piSessionId: "pi_1",
      toolCallId: "t1",
      spec: spec({ build_id: "build_e2e_partial_b" }),
      sourceFiles: { binding_gdc: good.relative_path },
      mappingFiles: {},
    });
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      const data = envelope.data as { build_result?: { status: string } };
      expect(data.build_result?.status).toBe("succeeded");
    }
  });

  it("NO_DATA: every binding rejected surfaces a no_data build result", async () => {
    const { taskRoot, core } = await newCore();
    const bad = await assetFor(taskRoot, "gdc/gdc_clinical.tsv", "binding_gdc");
    const record = await core.executeDatasetBuild(spec(), {
      runId: "run_e2e",
      sourceAssets: { binding_gdc: bad },
    });
    expect(record.status).toBe("failed");
    expect(record.rejected_sources).toEqual(["binding_gdc"]);
    const adapter = new TsDatasetCoreAdapter(core);
    const envelope = await adapter.execute({
      taskId: "task_e2e",
      runId: "run_e2e",
      piSessionId: "pi_1",
      toolCallId: "t1",
      spec: spec(),
      sourceFiles: { binding_gdc: bad.relative_path },
      mappingFiles: {},
    });
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("core_execution_error");
      expect(envelope.error.details.build_result?.status).toBe("no_data");
    }
  });

  it("SPEC_REJECTED: invalid spec fails validation without executing", async () => {
    const { core, events } = await newCore();
    const adapter = new TsDatasetCoreAdapter(core);
    const invalid = spec({ schema_ref: "unknown.schema.v9" });
    const envelope = await adapter.validate({
      taskId: "task_e2e",
      runId: "run_e2e",
      piSessionId: "pi_1",
      toolCallId: "t1",
      spec: invalid,
    });
    expect(envelope.ok).toBe(true);
    if (envelope.ok) {
      const data = envelope.data as { valid: boolean; reason_codes: string[] };
      expect(data.valid).toBe(false);
      expect(data.reason_codes).toContain("unknown_schema");
    }
    const executeEnvelope = await adapter.execute({
      taskId: "task_e2e",
      runId: "run_e2e",
      piSessionId: "pi_1",
      toolCallId: "t1",
      spec: invalid,
      sourceFiles: {},
      mappingFiles: {},
    });
    expect(executeEnvelope.ok).toBe(false);
    if (!executeEnvelope.ok) expect(executeEnvelope.error.code).toBe("invalid_input");
    expect(events).toHaveLength(0); // nothing executed
  });
});

describe("build lock (I-04)", () => {
  it("refuses a second concurrent publisher for the same task+build", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-lock-"));
    roots.push(taskRoot);
    const lockRoot = path.join(taskRoot, "state", "build-locks");
    const lease = await acquireBuildLock({ lockRoot }, "task_1", "build_1", "run_a");
    await expect(
      acquireBuildLock({ lockRoot }, "task_1", "build_1", "run_b"),
    ).rejects.toThrow(/locked by another publisher/);
    await lease.release();
    // Releasable after release.
    const next = await acquireBuildLock({ lockRoot }, "task_1", "build_1", "run_c");
    await next.release();
  });

  it("reclaims a stale lock whose owner pid is dead", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-lock-"));
    roots.push(taskRoot);
    const lockRoot = path.join(taskRoot, "state", "build-locks");
    // Dead owner: a pid that cannot exist.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const lockDir = path.join(lockRoot, "task_1", "build_1.lock");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      path.join(lockDir, "owner.json"),
      JSON.stringify({ owner: "dead", pid: 99999999, acquired_at: new Date().toISOString() }),
    );
    const lease = await acquireBuildLock({ lockRoot }, "task_1", "build_1", "run_a");
    await lease.release();
  });
});

describe("executor operation timeout (I-03)", () => {
  it("records a typed timeout failure when an operation exceeds its budget", async () => {
    const { DatasetBuildExecutor } = await import("../../src/dataset/runtime/executor.js");
    const { buildOperationPlan } = await import("../../src/dataset/runtime/index.js");
    const { makeOperationOutput } = await import("../../src/dataset/runtime/index.js");
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-timeout-"));
    roots.push(taskRoot);
    const executor = new DatasetBuildExecutor({
      taskId: "task_t",
      buildId: "build_t",
      stateDir: path.join(taskRoot, "state"),
      taskRoot,
      plan: buildOperationPlan(spec({ build_id: "build_t" })),
      runOperation: async (op) => {
        if (op.kind === "acquire") {
          return makeOperationOutput({ binding_id: op.category, source_id: "s", asset_id: "a" });
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
        return makeOperationOutput({});
      },
      operationTimeoutMs: 20,
    });
    const outcome = await executor.run();
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("timeout");
    expect(outcome.error?.message).toContain("timed out after 20ms");
  });
});

describe("core event → payload mapping (I-05)", () => {
  it("maps build lifecycle and operation events onto stable payloads", async () => {
    const { coreEventToPayload } = await import("../../src/dataset/service/events.js");
    const payloads: EventPayload[] = [
      coreEventToPayload({ type: "build_started" }, "build_1"),
      coreEventToPayload({ type: "operation_started", operationId: "parse:b1", label: "解析", category: "b1", attempt: 1 }, "build_1"),
      coreEventToPayload({ type: "operation_completed", operationId: "parse:b1", label: null, category: "b1", status: "succeeded", outputDigest: "d1", reusedOperationAttemptId: null }, "build_1"),
      coreEventToPayload({ type: "operation_failed", operationId: "parse:b2", label: null, category: "b2", status: "failed", error: { code: "parse_error", message: "x" } }, "build_1"),
      coreEventToPayload({ type: "build_completed" }, "build_1"),
    ];
    expect(payloads.map((payload) => payload.type)).toEqual([
      "operation_started",
      "operation_started",
      "operation_completed",
      "operation_failed",
      "operation_completed",
    ]);
    expect(payloads[0]).toEqual({ type: "operation_started", operation_id: "build:build_1", label: "构建", category: "build" });
  });
});
