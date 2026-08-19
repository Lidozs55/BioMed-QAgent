/**
 * A8 benchmark driver (TASK-047): run the largest feasible real bulk GEO
 * matrix (GSE325735, 58,676 genes x 807 samples) end-to-end through the
 * TypeScript Dataset Core under the frozen default RuntimeLimits with the
 * Node default heap (no --max-old-space-size override).
 *
 * Execution (bounded report only; not auto-run by vitest because of the
 * `.run.ts` suffix):
 *   pnpm --filter @biomed/contracts build
 *   pnpm --filter @biomed/server exec tsx tests/bench-a8.run.ts            # full fresh run
 *   pnpm --filter @biomed/server exec tsx tests/bench-a8.run.ts --verify <runDir>   # verify an existing run without re-running
 */

import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { copyFile, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDatasetBuildSpec } from "../src/dataset/contracts/index.js";
import { TypeScriptDatasetCore } from "../src/dataset/service/ts-core.js";
import { TsDatasetCoreAdapter } from "../src/dataset/service/dataset-core.js";
import type { CoreOperationEvent } from "../src/dataset/runtime/executor.js";
import type { DatasetBridgeResponse } from "@biomed/contracts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(HERE, "..");
const REPO_ROOT = path.resolve(SERVER_ROOT, "..");

const SOURCE_GZ = path.join(
  REPO_ROOT,
  "data",
  "bench",
  "gse325735",
  "GSE325735_clean_ensg.tsv.gz",
);
const SOURCE_BASENAME = "GSE325735_clean_ensg.tsv.gz";
const BINDING = "binding_geo";
const SCHEMA_REF = "gene_expression.long.v1";
const PROFILE_REF = "gene_expression.release.v1";
const TASK_ID = "task_047_a8";
const BUILD_ID = "build_gse325735";

interface DirStat {
  bytes: number;
  files: number;
}

async function dirStat(dir: string): Promise<DirStat> {
  let bytes = 0;
  let files = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await dirStat(full);
      bytes += sub.bytes;
      files += sub.files;
    } else {
      bytes += (await stat(full)).size;
      files += 1;
    }
  }
  return { bytes, files };
}

async function gzipContentBytes(gzPath: string): Promise<number> {
  const gunzip = createGunzip();
  const source = createReadStream(gzPath).pipe(gunzip);
  let bytes = 0;
  for await (const chunk of source) bytes += chunk.length;
  return bytes;
}

function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function sha256Decompressed(gzPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const gunzip = createGunzip();
    const stream = createReadStream(gzPath).pipe(gunzip);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

interface BuildOutcome {
  bridge: DatasetBridgeResponse;
  operationWall: Record<string, number>;
  sourceAsset: { sizeBytes: number; hashMs: number; sha256: string } | null;
  peak: { rss: number; heapUsed: number; heapTotal: number } | null;
}

async function runBuild(taskRoot: string): Promise<BuildOutcome> {
  const opStarted = new Map<string, number>();
  const operationWall: Record<string, number> = {};

  const core = new TypeScriptDatasetCore({
    taskId: TASK_ID,
    taskRoot,
    eventSink: (event: CoreOperationEvent) => {
      if (event.type === "operation_started") {
        opStarted.set(event.operationId, Date.now());
      } else if (event.type === "operation_completed") {
        const started = opStarted.get(event.operationId);
        if (started !== undefined) {
          operationWall[event.operationId] = Date.now() - started;
        }
      }
    },
  });

  let sourceAsset: BuildOutcome["sourceAsset"] = null;
  const adapter = new TsDatasetCoreAdapter(core, {
    onAssetResolved: (record) => {
      if (record.role === "source" && record.bindingId === BINDING) {
        sourceAsset = {
          sizeBytes: record.sizeBytes,
          hashMs: record.hashMs,
          sha256: record.sha256,
        };
      }
    },
  });

  const spec = parseDatasetBuildSpec({
    schema_version: "1.0",
    build_id: BUILD_ID,
    objective: "A8 bulk GEO gene-level expression dataset (GSE325735 counts)",
    dataset_family: "gene_expression",
    row_granularity: "gene_sample_measurement",
    schema_ref: SCHEMA_REF,
    source_bindings: [{
      schema_version: "1.0",
      binding_id: BINDING,
      source: "geo",
      acquisition: { schema_version: "1.0", mode: "builtin", provider_id: "geo.files.v1" },
      adapter_id: "geo.expression.v1",
      parameters: {
        schema_version: "1.0",
        format: "supplementary_matrix",
        value_semantics: "raw_count",
        value_scale: "linear",
        expression_unit: "estimated_count",
        is_normalized: false,
        platform_ids: [],
        delimiter: "\t",
      },
    }],
    validation_profile_ref: PROFILE_REF,
  });

  const baseline = process.memoryUsage();
  const peak: NonNullable<BuildOutcome["peak"]> = {
    rss: baseline.rss,
    heapUsed: baseline.heapUsed,
    heapTotal: baseline.heapTotal,
  };
  const sampleTimer = setInterval(() => {
    const usage = process.memoryUsage();
    if (usage.rss > peak.rss) peak.rss = usage.rss;
    if (usage.heapUsed > peak.heapUsed) peak.heapUsed = usage.heapUsed;
    if (usage.heapTotal > peak.heapTotal) peak.heapTotal = usage.heapTotal;
  }, 250);

  try {
    const bridge = await adapter.execute({
      taskId: TASK_ID,
      runId: "run_a8_gse325735",
      piSessionId: "pi_a8",
      toolCallId: "tool_a8_benchmark",
      spec,
      sourceFiles: { [BINDING]: `source/${SOURCE_BASENAME}` },
      mappingFiles: {},
    });
    return { bridge, operationWall, sourceAsset, peak };
  } finally {
    clearInterval(sampleTimer);
  }
}

async function resolveVersionDir(taskRoot: string): Promise<string> {
  const publishRoot = path.join(taskRoot, "datasets_build", BUILD_ID, "publish");
  const entries = await readdir(publishRoot, { withFileTypes: true });
  const dirs = entries.filter((entry) => entry.isDirectory());
  if (dirs.length !== 1) {
    throw new Error(`expected exactly one publish version dir, found ${dirs.length}`);
  }
  return path.join(publishRoot, dirs[0]!.name);
}

async function loadOperationWall(taskRoot: string): Promise<Record<string, number>> {
  const logPath = path.join(
    taskRoot,
    "datasets_build",
    BUILD_ID,
    "state",
    "operation_attempts.jsonl",
  );
  const wall: Record<string, number> = {};
  for (const raw of readFileSync(logPath, "utf8").split("\n")) {
    const attempt = raw.trim();
    if (!attempt) continue;
    const record = JSON.parse(attempt) as {
      operation_id?: string;
      started_at?: string;
      finished_at?: string;
      status?: string;
    };
    if (record.status === "succeeded" && record.started_at && record.finished_at) {
      wall[record.operation_id as string] =
        Date.parse(record.finished_at) - Date.parse(record.started_at);
    }
  }
  return wall;
}

interface ManifestLike {
  manifest_id: string;
  task_id: string;
  build_id: string;
  dataset_family: string;
  row_granularity: string;
  schema_ref: string;
  primary_key: string[];
  row_count: number;
  sha256: string;
  artifacts: Array<{
    artifact_id: string;
    role: string;
    relative_path: string;
    media_type: string;
    size_bytes: number;
    sha256: string;
  }>;
  source_summary: Record<string, unknown>;
  validation_summary: Record<string, unknown>;
  confidence_summary: Record<string, unknown>;
  provenance_summary: Record<string, unknown>;
}

interface ReportEnv {
  runDir: string;
  taskRoot: string;
  versionDir: string;
  manifest: ManifestLike;
  operationWall: Record<string, number>;
  sourceAsset: BuildOutcome["sourceAsset"];
  peak: BuildOutcome["peak"];
  metricSource: "live" | "verify";
}

async function produceReport(env: ReportEnv): Promise<Record<string, unknown>> {
  const { runDir, taskRoot, versionDir, manifest, operationWall, sourceAsset, peak, metricSource } =
    env;

  const evalManifest = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "docs", "evaluation", "gold-v1", "manifest.json"), "utf8"),
  ) as { manifest_id: string; prompt_encoding?: string };
  const runtimeDefaults = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, "docs", "evaluation", "gold-v1", "runtime-defaults.json"),
      "utf8",
    ),
  ) as { profile_id: string; limits: unknown; node_heap_override: unknown };

  const stagedGz = path.join(taskRoot, "source", SOURCE_BASENAME);
  const sourceCompressed = statSync(stagedGz).size;
  const sourceUncompressed = await gzipContentBytes(stagedGz);
  const gzSha = await sha256File(stagedGz);
  const uncompressedSha = await sha256Decompressed(stagedGz);

  const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT })
    .toString("utf8").trim();

  const publishedStat = await dirStat(versionDir);
  const workspaceStat = await dirStat(path.join(taskRoot, "datasets_build", BUILD_ID));

  const artifacts: Array<{
    role: string;
    artifact_id: string;
    relative_path: string;
    media_type: string;
    size_bytes: number;
    sha256: string;
    disk_sha256: string;
    match: boolean;
  }> = [];
  for (const artifact of manifest.artifacts) {
    const diskPath = path.join(versionDir, artifact.relative_path);
    const diskSha = await sha256File(diskPath);
    artifacts.push({
      role: artifact.role,
      artifact_id: artifact.artifact_id,
      relative_path: artifact.relative_path,
      media_type: artifact.media_type,
      size_bytes: artifact.size_bytes,
      sha256: artifact.sha256,
      disk_sha256: diskSha,
      match: diskSha === artifact.sha256,
    });
  }
  const allHashesMatch = artifacts.every((artifact) => artifact.match);

  const confidencePath = path.join(versionDir, "confidence_records.json");
  const confidencePresent = existsSync(confidencePath);

  const validationSummary = manifest.validation_summary as {
    status?: string;
    checked_count?: number;
    failed_count?: number;
    report_path?: string;
    profile_ref?: string;
  };
  const provenanceSummary = manifest.provenance_summary as {
    conflict_count?: number;
    coverage?: { coverage_ratio?: number; traced_rows?: number; untraced_rows?: number };
    dedup_count?: number;
    field_mapping_count?: number;
    normalization_log_entries?: number;
    rejected_count?: number;
    source_count?: number;
  };
  const confidenceSummary = manifest.confidence_summary as {
    pending_human_review_count?: number;
    record_count?: number;
  };

  const result = {
    eval_manifest: evalManifest.manifest_id,
    prompt_encoding: evalManifest.prompt_encoding ?? null,
    runtime_profile: runtimeDefaults.profile_id,
    frozen_limits: runtimeDefaults.limits,
    node_heap_override: runtimeDefaults.node_heap_override,
    commit,
    node_version: process.version,
    sample_period_ms: 250,
    metric_source: metricSource,

    accession: "GSE325735",
    build_id: BUILD_ID,
    task_id: TASK_ID,
    schema_ref: SCHEMA_REF,
    profile_ref: PROFILE_REF,
    manifest_id: manifest.manifest_id,
    manifest_sha256: manifest.sha256,
    family: manifest.dataset_family,
    row_granularity: manifest.row_granularity,
    primary_key: manifest.primary_key,

    source: {
      source_gz_sha256: gzSha,
      source_compressed_bytes: sourceCompressed,
      source_uncompressed_bytes: sourceUncompressed,
      uncompressed_sha256: uncompressedSha,
      rows_kept: 58676,
      samples: 807,
      acquisition_asset_sha256: sourceAsset?.sha256 ?? null,
      acquisition_asset_hash_ms: sourceAsset?.hashMs ?? null,
    },

    runtime: {
      peak_rss_bytes: peak?.rss ?? null,
      peak_heap_used_bytes: peak?.heapUsed ?? null,
      peak_heap_total_bytes: peak?.heapTotal ?? null,
      heap_override: runtimeDefaults.node_heap_override,
      operation_wall_time_ms: operationWall,
    },

    storage: {
      workspace_bytes: workspaceStat.bytes,
      workspace_files: workspaceStat.files,
      published_bytes: publishedStat.bytes,
      published_files: publishedStat.files,
    },

    rows: {
      manifest_row_count: manifest.row_count,
    },

    validation: {
      status: validationSummary.status ?? "unknown",
      checked_count: validationSummary.checked_count ?? 0,
      failed_count: validationSummary.failed_count ?? 0,
      report_path: validationSummary.report_path ?? null,
      profile_ref: validationSummary.profile_ref ?? null,
    },

    provenance: {
      sources: Object.keys(manifest.source_summary),
      source_count: provenanceSummary.source_count ?? 0,
      traced_rows: provenanceSummary.coverage?.traced_rows ?? 0,
      untraced_rows: provenanceSummary.coverage?.untraced_rows ?? 0,
      coverage_ratio: provenanceSummary.coverage?.coverage_ratio ?? 0,
      conflict_count: provenanceSummary.conflict_count ?? 0,
      dedup_count: provenanceSummary.dedup_count ?? 0,
      field_mapping_count: provenanceSummary.field_mapping_count ?? 0,
      normalization_log_entries: provenanceSummary.normalization_log_entries ?? 0,
      rejected_count: provenanceSummary.rejected_count ?? 0,
      confidence_records_present: confidencePresent,
      confidence_pending_human_review:
        confidenceSummary.pending_human_review_count ?? "n/a",
      confidence_record_count: confidenceSummary.record_count ?? "n/a",
    },

    artifacts,
    artifacts_hash_parity: allHashesMatch,
  };

  console.log(JSON.stringify(result, null, 2));
  await writeFile(path.join(runDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  return result;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "--verify") {
    const runDir = process.argv[3];
    if (!runDir) {
      throw new Error("--verify requires a run directory");
    }
    const taskRoot = path.join(runDir, "task");
    const versionDir = await resolveVersionDir(taskRoot);
    const manifest = JSON.parse(
      readFileSync(path.join(versionDir, "dataset_manifest.json"), "utf8"),
    ) as ManifestLike;
    const operationWall = await loadOperationWall(taskRoot);
    await produceReport({
      runDir,
      taskRoot,
      versionDir,
      manifest,
      operationWall,
      sourceAsset: null,
      peak: null,
      metricSource: "verify",
    });
    console.error(`\n[bench-a8] verified run: ${runDir}`);
    return;
  }

  const runDir = await mkdtemp(path.join(REPO_ROOT, "data", "bench", "a8-run-"));
  const taskRoot = path.join(runDir, "task");
  const sourceDir = path.join(taskRoot, "source");
  mkdirSync(sourceDir, { recursive: true });
  await copyFile(SOURCE_GZ, path.join(sourceDir, SOURCE_BASENAME));

  const outcome = await runBuild(taskRoot);

  if (!outcome.bridge.ok) {
    throw new Error(
      `build not ok: ${outcome.bridge.error?.code} ${outcome.bridge.error?.message ?? ""}`,
    );
  }

  const versionDir = await resolveVersionDir(taskRoot);
  const manifest = JSON.parse(
    readFileSync(path.join(versionDir, "dataset_manifest.json"), "utf8"),
  ) as ManifestLike;

  await produceReport({
    runDir,
    taskRoot,
    versionDir,
    manifest,
    operationWall: outcome.operationWall,
    sourceAsset: outcome.sourceAsset,
    peak: outcome.peak,
    metricSource: "live",
  });

  console.error(`\n[bench-a8] taskRoot=${taskRoot}`);
  console.error(`[bench-a8] result.json written under ${runDir}`);
}

main().catch((error) => {
  console.error("[bench-a8] FAILED");
  console.error(error);
  process.exitCode = 1;
});