import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { integrate } from "../../../src/dataset/integrator/integrator.js";
import { buildGeneExpressionSchema } from "../../../src/dataset/schema/index.js";
import type { CanonicalizationResult } from "../../../src/dataset/canonicalizer/index.js";

const HEADER =
  "record_id,dataset_id,source_id,asset_id,gene_id_raw,gene_id,gene_id_namespace,gene_id_version,sample_id,source_sample_alias,measurement_type,value_semantics,value_scale,is_normalized,is_integer_expected,expression_value,expression_unit,source_logical_file,source_line_number,source_column_index,source_column_name,source_raw_value";

function canonicalRow(geneId: string, sampleId: string, value: string, assetId: string): string {
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

async function makeCanonicalResults(root: string, count: number): Promise<CanonicalizationResult[]> {
  const output = join(root, "canonical");
  await mkdir(output, { recursive: true });
  const make = async (bindingId: string, genePrefix: string): Promise<CanonicalizationResult> => {
    const canonicalPath = join(output, `${bindingId}.csv`);
    const chunks: string[] = [HEADER];
    for (let index = 0; index < count; index += 1) {
      chunks.push(canonicalRow(`${genePrefix}_${index}`, `sample_${index}`, "1", `asset_${bindingId}_${index}`));
    }
    await writeFile(canonicalPath, `${chunks.join("\n")}\n`, "utf8");
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
      canonicalPath,
      rowCount: count,
      rejectedCount: 0,
      namespaces: ["hgnc_symbol"],
      auditPaths: [],
    };
  };
  return [await make("binding_g", "gene_g"), await make("binding_h", "gene_h")];
}

function forceGc(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (gc) gc();
}

const [workRoot, countText] = process.argv.slice(2);
if (workRoot === undefined || countText === undefined) throw new Error("work root and row count are required");
const count = Number.parseInt(countText, 10);
if (!Number.isSafeInteger(count) || count < 1) throw new Error("row count must be a positive integer");

const results = await makeCanonicalResults(workRoot, count);
await integrate({
  results,
  mergeStrategy: "append_by_canonical_row",
  schema: buildGeneExpressionSchema(),
  buildId: `build_${count}`,
  outputDir: join(workRoot, "warmup"),
  signal: null,
});
forceGc();
const before = process.memoryUsage().heapUsed;
let peak = before;
const timer = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().heapUsed);
}, 10);
try {
  await integrate({
    results,
    mergeStrategy: "append_by_canonical_row",
    schema: buildGeneExpressionSchema(),
    buildId: `build_measure_${count}`,
    outputDir: join(workRoot, "measure"),
    signal: null,
  });
  peak = Math.max(peak, process.memoryUsage().heapUsed);
} finally {
  clearInterval(timer);
}
process.stdout.write(`${JSON.stringify({ peak_delta: peak - before })}\n`);
