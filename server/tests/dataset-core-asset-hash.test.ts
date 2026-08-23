/**
 * TASK-047-A1 — Core 前置资产流式 hash (fix/dataset-asset-stream-hash).
 *
 * Acceptance:
 * - invalid spec → zero file reads (spec validation precedes any stat/hash);
 * - GB-scale sources hash with bounded heap (limited-heap child process);
 * - abort interrupts the hash and never enters Core (no build dir, no
 *   resolved-asset record);
 * - hash/size/asset id stay byte-parity with the legacy readFile+sha256Bytes
 *   implementation;
 * - a file mutated between stat and hash completion is rejected fail-closed
 *   (TOCTOU guard), and bytes/hash wall time are recorded without content.
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { parseDatasetBuildSpec } from "../src/dataset/contracts/index.js";
import { TypeScriptDatasetCore } from "../src/dataset/service/ts-core.js";
import {
  resolveReferencedAsset,
  TsDatasetCoreAdapter,
  type AssetResolutionRecord,
} from "../src/dataset/service/dataset-core.js";

const FIXTURES_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..", "..", "tests", "fixtures",
);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ZERO_256MIB_SHA256 =
  "a6d72ac7690f53be6ae46ba88506bd97302a093f7108472bd9efc3cefda06484";
const LARGE_MIB = 256;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function spec(buildId: string): ReturnType<typeof parseDatasetBuildSpec> {
  return parseDatasetBuildSpec({
    schema_version: "1.0",
    build_id: buildId,
    objective: "A1 asset stream hash parity",
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

async function newCore(): Promise<{ taskRoot: string; core: TypeScriptDatasetCore }> {
  const taskRoot = await mkdtemp(path.join(os.tmpdir(), "a1-core-"));
  roots.push(taskRoot);
  const core = new TypeScriptDatasetCore({ taskId: "task_a1", taskRoot });
  return { taskRoot, core };
}

function zeroFile(target: string, miB: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(target);
    stream.on("error", reject);
    stream.on("close", () => resolve());
    const chunk = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < miB; index += 1) {
      stream.write(chunk);
    }
    stream.end();
  });
}

function runHashChild(
  workRoot: string,
  sizeMiB: number,
  heapMb: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const script = path.join(REPO_ROOT, "server", "tests", "phase5", "fixtures", "stream-hash-child.mts");
  const pnpmDir = path.join(REPO_ROOT, "node_modules", ".pnpm");
  const viteNodeVersions = readdirSync(pnpmDir)
    .filter((name) => name.startsWith("vite-node@"))
    .sort();
  if (viteNodeVersions.length === 0) {
    throw new Error("vite-node not found in node_modules/.pnpm");
  }
  const viteNodeEntry = path.join(
    pnpmDir,
    viteNodeVersions[viteNodeVersions.length - 1]!,
    "node_modules",
    "vite-node",
    "vite-node.mjs",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", `--max-old-space-size=${heapMb}`, viteNodeEntry, script, workRoot, String(sizeMiB)],
      { stdio: "pipe" },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("TASK-047-A1 streaming asset hash", () => {
  it("parity: streamed hash/size/asset id match the legacy buffered implementation", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "a1-parity-"));
    roots.push(taskRoot);
    await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
    await writeFile(
      path.join(taskRoot, "source_assets", "x.tsv"),
      "gene_id\tS1\nENSG1\t1.5\n",
    );
    const bytes = await readFile(path.join(taskRoot, "source_assets", "x.tsv"));
    const expected = createHash("sha256").update(bytes).digest("hex");

    const resolved = await resolveReferencedAsset(taskRoot, "source_assets/x.tsv");
    expect(resolved).not.toBeNull();
    if (resolved !== null) {
      expect(resolved.asset.sha256).toBe(expected);
      expect(resolved.asset.size_bytes).toBe(bytes.length);
      expect(resolved.asset.asset_id).toBe(`asset_${expected}`);
      expect(resolved.asset.relative_path).toBe("source_assets/x.tsv");
      expect(resolved.asset.media_type).toBe("text/tab-separated-values");
      expect(resolved.bytes).toBe(bytes.length);
      expect(resolved.hashMs).toBeGreaterThanOrEqual(0);
    }
    // Out-of-root references stay rejected.
    expect(await resolveReferencedAsset(taskRoot, "../outside.tsv")).toBeNull();
    // Missing files stay dropped (rejected binding at Core level).
    expect(await resolveReferencedAsset(taskRoot, "source_assets/missing.tsv")).toBeNull();
  });

  it("invalid spec: zero file reads — spec validation precedes hashing", async () => {
    const { taskRoot, core } = await newCore();
    await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
    await zeroFile(path.join(taskRoot, "source_assets", "big.bin"), LARGE_MIB);
    const records: AssetResolutionRecord[] = [];
    const adapter = new TsDatasetCoreAdapter(core, {
      onAssetResolved: (record) => records.push(record),
    });
    const envelope = await adapter.execute({
      taskId: "task_a1",
      runId: "run_invalid",
      piSessionId: "pi_1",
      toolCallId: "t1",
      spec: { ...spec("build_invalid"), schema_ref: "unknown.schema.v9" },
      sourceFiles: { binding_gdc: "source_assets/big.bin" },
      mappingFiles: {},
    });
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("invalid_input");
    expect(records).toHaveLength(0);
  });

  it("resolves a registered asset ID only from its task-owned unique file", async () => {
    const { taskRoot, core } = await newCore();
    const content = "gene_id\tS1\tS2\nTP53\t1.5\t2\nBRCA1\t3\t4.25\n";
    const sha256 = createHash("sha256").update(content).digest("hex");
    const assetId = `asset_${sha256}`;
    await mkdir(path.join(taskRoot, "source_assets", assetId), { recursive: true });
    await writeFile(path.join(taskRoot, "source_assets", assetId, "file.tsv"), content);
    const adapter = new TsDatasetCoreAdapter(core);
    const envelope = await adapter.execute({
      taskId: "task_a1",
      runId: "run_registered",
      piSessionId: "pi_1",
      toolCallId: "t1",
      spec: spec("build_registered"),
      sourceFiles: { binding_gdc: assetId },
      mappingFiles: {},
    });
    expect(envelope.ok).toBe(true);
    if (envelope.ok && "registeredSourceAssetIds" in envelope.data) {
      expect(envelope.data.registeredSourceAssetIds).toEqual([assetId]);
    }
  });

  it.each([
    ["missing directory", async (taskRoot: string, assetId: string): Promise<void> => {
      void taskRoot;
      void assetId;
    }, /directory is missing/],
    ["multiple files", async (taskRoot: string, assetId: string) => {
      await mkdir(path.join(taskRoot, "source_assets", assetId), { recursive: true });
      await writeFile(path.join(taskRoot, "source_assets", assetId, "a.tsv"), "x");
      await writeFile(path.join(taskRoot, "source_assets", assetId, "b.tsv"), "x");
    }, /exactly one file/],
  ] as const)("rejects %s for a registered asset ID", async (_label, prepare, expected) => {
    const { taskRoot, core } = await newCore();
    const assetId = `asset_${"a".repeat(64)}`;
    await prepare(taskRoot, assetId);
    const envelope = await new TsDatasetCoreAdapter(core).execute({
      taskId: "task_a1",
      runId: "run_registered_reject",
      piSessionId: "pi_1",
      toolCallId: "t1",
      spec: spec("build_registered_reject"),
      sourceFiles: { binding_gdc: assetId },
      mappingFiles: {},
    });
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.message).toMatch(expected);
  });

  it("rejects a registered asset ID when its directory content hash differs", async () => {
    const { taskRoot, core } = await newCore();
    const assetId = `asset_${"a".repeat(64)}`;
    await mkdir(path.join(taskRoot, "source_assets", assetId), { recursive: true });
    await writeFile(path.join(taskRoot, "source_assets", assetId, "file.tsv"), "different");
    const envelope = await new TsDatasetCoreAdapter(core).execute({
      taskId: "task_a1",
      runId: "run_registered_drift",
      piSessionId: "pi_1",
      toolCallId: "t1",
      spec: spec("build_registered_drift"),
      sourceFiles: { binding_gdc: assetId },
      mappingFiles: {},
    });
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.message).toMatch(/does not match|hash drift/);
  });

  it("rejects a registered asset request that names another task", async () => {
    const { taskRoot, core } = await newCore();
    const assetId = `asset_${"a".repeat(64)}`;
    await mkdir(path.join(taskRoot, "source_assets", assetId), { recursive: true });
    await writeFile(path.join(taskRoot, "source_assets", assetId, "file.tsv"), "gene_id\tS1\tS2\nTP53\t1.5\t2\nBRCA1\t3\t4.25\n");
    const envelope = await new TsDatasetCoreAdapter(core).execute({
      taskId: "task_other",
      runId: "run_registered_cross_task",
      piSessionId: "pi_1",
      toolCallId: "t1",
      spec: spec("build_registered_cross_task"),
      sourceFiles: { binding_gdc: assetId },
      mappingFiles: {},
    });
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.message).toContain("task identity");
  });

  it("rejects an unregistered mapping-role asset ID", async () => {
    const { core } = await newCore();
    const assetId = `asset_${"a".repeat(64)}`;
    const envelope = await new TsDatasetCoreAdapter(core).execute({
      taskId: "task_a1",
      runId: "run_registered_mapping",
      piSessionId: "pi_1",
      toolCallId: "t1",
      spec: spec("build_registered_mapping"),
      sourceFiles: { binding_gdc: "source_assets/missing.tsv" },
      mappingFiles: { binding_gdc: assetId },
    });
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.message).toContain("registered asset");
  });

  it("resolves through the adapter and records bytes/hash time without content", async () => {
    const { taskRoot, core } = await newCore();
    const fixtureBytes = await readFile(path.join(FIXTURES_ROOT, "gdc", "gdc_expression.tsv"));
    await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
    await writeFile(path.join(taskRoot, "source_assets", "gdc_expression.tsv"), fixtureBytes);
    const expected = createHash("sha256").update(fixtureBytes).digest("hex");
    const records: AssetResolutionRecord[] = [];
    const adapter = new TsDatasetCoreAdapter(core, {
      onAssetResolved: (record) => records.push(record),
    });
    const envelope = await adapter.execute({
      taskId: "task_a1",
      runId: "run_parity",
      piSessionId: "pi_1",
      toolCallId: "t1",
      spec: spec("build_parity"),
      sourceFiles: { binding_gdc: "source_assets/gdc_expression.tsv" },
      mappingFiles: {},
    });
    expect(envelope.ok).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      bindingId: "binding_gdc",
      role: "source",
      relativePath: "source_assets/gdc_expression.tsv",
      sizeBytes: fixtureBytes.length,
      sha256: expected,
      assetId: `asset_${expected}`,
    });
    expect(records[0]!.hashMs).toBeGreaterThanOrEqual(0);
  });

  it("a pre-aborted signal hashes zero bytes and never enters Core", async () => {
    const { taskRoot, core } = await newCore();
    await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
    await zeroFile(path.join(taskRoot, "source_assets", "big.bin"), LARGE_MIB);
    const records: AssetResolutionRecord[] = [];
    const adapter = new TsDatasetCoreAdapter(core, {
      onAssetResolved: (record) => records.push(record),
    });
    const controller = new AbortController();
    controller.abort();
    const envelope = await adapter.execute({
      taskId: "task_a1",
      runId: "run_preabort",
      piSessionId: "pi_1",
      toolCallId: "t1",
      spec: spec("build_preabort"),
      sourceFiles: { binding_gdc: "source_assets/big.bin" },
      mappingFiles: {},
      signal: controller.signal,
    });
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("cancelled");
    expect(records).toHaveLength(0);
    // Core was never entered: no build output directory was created.
    await expect(stat(path.join(taskRoot, "datasets_build", "build_preabort"))).rejects.toThrow();
  });

  it("abort interrupts a mid-hash asset and does not enter Core", async () => {
    const { taskRoot, core } = await newCore();
    await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
    await zeroFile(path.join(taskRoot, "source_assets", "big.bin"), LARGE_MIB);
    const records: AssetResolutionRecord[] = [];
    const adapter = new TsDatasetCoreAdapter(core, {
      onAssetResolved: (record) => records.push(record),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20);
    const envelope = await adapter.execute({
      taskId: "task_a1",
      runId: "run_abort",
      piSessionId: "pi_1",
      toolCallId: "t1",
      spec: spec("build_abort"),
      sourceFiles: { binding_gdc: "source_assets/big.bin" },
      mappingFiles: {},
      signal: controller.signal,
    });
    clearTimeout(timer);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) expect(envelope.error.code).toBe("cancelled");
    // The hash never completed (256 MiB cannot finish in 20 ms) — no
    // resolved-asset record was produced and Core was not entered.
    expect(records).toHaveLength(0);
    await expect(stat(path.join(taskRoot, "datasets_build", "build_abort"))).rejects.toThrow();
  });

  it("rejects an asset that changes while hashing (TOCTOU fail-closed)", async () => {
    const { taskRoot, core } = await newCore();
    await mkdir(path.join(taskRoot, "source_assets"), { recursive: true });
    await zeroFile(path.join(taskRoot, "source_assets", "big.bin"), LARGE_MIB);
    const records: AssetResolutionRecord[] = [];
    const adapter = new TsDatasetCoreAdapter(core, {
      onAssetResolved: (record) => records.push(record),
    });
    // Append while the stream hash is still scanning the 256 MiB file.
    const timer = setTimeout(() => {
      void writeFile(
        path.join(taskRoot, "source_assets", "big.bin"),
        Buffer.alloc(1024 * 1024),
        { flag: "a" },
      );
    }, 10);
    const envelope = await adapter.execute({
      taskId: "task_a1",
      runId: "run_toctou",
      piSessionId: "pi_1",
      toolCallId: "t1",
      spec: spec("build_toctou"),
      sourceFiles: { binding_gdc: "source_assets/big.bin" },
      mappingFiles: {},
    });
    clearTimeout(timer);
    expect(envelope.ok).toBe(false);
    if (!envelope.ok) {
      expect(envelope.error.code).toBe("core_execution_error");
      expect(envelope.error.message).toContain("changed while hashing");
    }
    expect(records).toHaveLength(0);
    await expect(stat(path.join(taskRoot, "datasets_build", "build_toctou"))).rejects.toThrow();
  });

  it("hashes a 256 MiB asset in a 64 MB-heap child without OOM", async () => {
    const workRoot = await mkdtemp(path.join(os.tmpdir(), "a1-heap-"));
    roots.push(workRoot);
    const { code, stdout, stderr } = await runHashChild(workRoot, LARGE_MIB, 64);
    expect(stderr, `child stderr: ${stderr.slice(0, 400)}`).toBe("");
    expect(code).toBe(0);
    const [tag, sha, bytes, hashMs] = stdout.trim().split(/\s+/);
    expect(tag).toBe("resolved");
    expect(sha).toBe(ZERO_256MIB_SHA256);
    expect(bytes).toBe(String(LARGE_MIB * 1024 * 1024));
    expect(Number(hashMs)).toBeGreaterThanOrEqual(0);
  });
});
