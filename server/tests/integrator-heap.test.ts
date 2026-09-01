import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { integrate } from "../src/dataset/integrator/integrator.js";
import { OperationAbortedError } from "../src/dataset/cooperative.js";
import { buildGeneExpressionSchema } from "../src/dataset/schema/index.js";
import type { CanonicalizationResult } from "../src/dataset/canonicalizer/index.js";

const HEADER =
  "record_id,dataset_id,source_id,asset_id,gene_id_raw,gene_id,gene_id_namespace,gene_id_version,sample_id,source_sample_alias,measurement_type,value_semantics,value_scale,is_normalized,is_integer_expected,expression_value,expression_unit,source_logical_file,source_line_number,source_column_index,source_column_name,source_raw_value";

function canonicalRow(
  geneId: string,
  sampleId: string,
  value: string,
  assetId: string,
): string {
  return [
    `record_${geneId}_${sampleId}`,
    "dataset_demo",
    "source_demo",
    assetId,
    geneId,
    geneId,
    "hgnc_symbol",
    "",
    sampleId,
    sampleId,
    "expression",
    "raw",
    "linear",
    "false",
    "false",
    value,
    "tpm",
    "demo.txt",
    "1",
    "0",
    "expression_value",
    value,
  ].join(",");
}

function makeCanonicalResults(
  root: string,
  count: number,
): CanonicalizationResult[] {
  const out = join(root, "canonical");
  mkdirSync(out, { recursive: true });
  const make = (bindingId: string, genePrefix: string): CanonicalizationResult => {
    const path = join(out, `${bindingId}.csv`);
    const lines: string[] = [HEADER];
    for (let index = 0; index < count; index += 1) {
      lines.push(
        canonicalRow(`${genePrefix}_${index}`, `sample_${index}`, "1", `asset_${bindingId}_${index}`),
      );
    }
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    return {
      batch: {
        batch_id: `batch_${bindingId}`,
        binding_id: bindingId,
        dataset_family: "gene_expression",
        row_granularity: "gene_sample_measurement",
        schema_ref: "gene_expression.long.v1",
        file_asset: null,
        row_count: count,
        column_count: 22,
        parser_id: "demo.expression.v1",
        parser_version: "1.0",
        statistics: {},
        warnings: [],
        declared_mappings: [],
      },
      canonicalPath: path,
      rowCount: count,
      rejectedCount: 0,
      namespaces: ["hgnc_symbol"],
      auditPaths: [],
    };
  };
  // Identity does not overlap between the two sources (gene_g vs gene_h), so
  // every row is a distinct canonical identity and the `seen` map under test
  // accumulates all of them (O(n) in-memory growth).
  return [make("binding_g", "gene_g"), make("binding_h", "gene_h")];
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VITE_NODE_ENTRY = createRequire(import.meta.url).resolve("vite-node/vite-node.mjs");
const HEAP_CHILD = path.join(REPO_ROOT, "server", "tests", "phase5", "fixtures", "integrator-heap-child.mts");

function runHeapChild(workRoot: string, rowCount: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--expose-gc", VITE_NODE_ENTRY, HEAP_CHILD, workRoot, String(rowCount)],
      { stdio: "pipe" },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`integrator heap child failed (${code}): ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const result: unknown = JSON.parse(stdout);
        if (result === null || typeof result !== "object" || typeof (result as { peak_delta?: unknown }).peak_delta !== "number") {
          throw new Error("missing numeric peak_delta");
        }
        resolve((result as { peak_delta: number }).peak_delta);
      } catch (error) {
        reject(new Error(`invalid integrator heap child output: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
  });
}

async function integrateResults(
  results: CanonicalizationResult[],
  outputDir: string,
  signal?: AbortSignal | null,
  tempStore?: { quotaBytes: number },
): Promise<void> {
  await integrate({
    results,
    mergeStrategy: "append_by_canonical_row",
    schema: buildGeneExpressionSchema(),
    requirementId: `build_${join(outputDir, "out")}`,
    outputDir: join(outputDir, "out"),
    signal: signal ?? null,
    tempStore,
  });
}

async function runIntegrate(
  count: number,
  outputDir: string,
  signal?: AbortSignal | null,
  tempStore?: { quotaBytes: number },
): Promise<void> {
  await integrateResults(makeCanonicalResults(outputDir, count), outputDir, signal, tempStore);
}

const roots: string[] = [];

function tempRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

describe("integrator heap (WP-A6)", () => {
  test("high-cardinality multi-source: peak heap delta grows sub-linearly with 4x rows", async () => {
    const base = 6_000;
    const smallRoot = tempRoot("integrator-heap-small-");
    const small = await runHeapChild(smallRoot, base);
    const largeRoot = tempRoot("integrator-heap-large-");
    const large = await runHeapChild(largeRoot, base * 4);
    // Linear growth would scale ~4x; a disk-backed seen-set must stay far
    // below 2.5x. Loose threshold calibrated to the in-memory Map.
    expect(large).toBeLessThan(small * 2.5);
  }, 120_000);

  test("temp disk quota overflow fails closed and cleans temp files", async () => {
    const root = tempRoot("integrator-quota-");
    await expect(
      runIntegrate(50_000, root, null, { quotaBytes: 256 }),
    ).rejects.toMatchObject({ name: "IntegratorResourceLimitError" });
    const leftovers = findLeftovers(root);
    expect(leftovers.filter((f) => f.includes("integrate-temp"))).toEqual([]);
  });

  test("cancel aborts mid-stream and cleans temp db and partial merged outputs", async () => {
    const controller = new AbortController();
    const root = tempRoot("integrator-cancel-");
    const promise = runIntegrate(400_000, root, controller.signal);
    const timer = setTimeout(() => controller.abort(), 30);
    try {
      await expect(promise).rejects.toThrow(OperationAbortedError);
    } finally {
      clearTimeout(timer);
    }
    const leftovers = findLeftovers(root);
    expect(leftovers.filter((f) => f.includes("integrate-temp"))).toEqual([]);
    expect(leftovers.filter((f) => f.endsWith(".csv"))).toEqual([]);
  });
});

function findLeftovers(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: { name: string; isDirectory: () => boolean }[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        found.push(full);
      }
    }
  };
  walk(join(root, "out"));
  return found;
}
