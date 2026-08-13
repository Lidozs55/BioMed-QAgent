/**
 * P5-09 analysis tests: golden numeric parity (scipy/pandas) + tool
 * behavior + deterministic PNG rendering for the four analysis tools.
 *
 * Golden fixtures live in tests/phase5/fixtures/analysis/ and are produced
 * by generate-goldens.py (real Python tools + scipy/pandas, see the script
 * header for how to regenerate). Numeric assertions report the max absolute
 * difference per function in the failure message.
 */

import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PNG } from "pngjs";
import { afterAll, describe, expect, it } from "vitest";

import {
  BASIC_STATISTICS_TOOL_NAME,
  GENERATE_CORRELATION_MATRIX_TOOL_NAME,
  GENERATE_HEATMAP_TOOL_NAME,
  RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME,
  createAnalysisTools,
} from "../../src/agent/tools/analysis.js";
import {
  bhAdjust,
  betainc,
  colormapBytes,
  correlationMatrix,
  drawText,
  encodePng,
  createCanvas,
  correlationLayout,
  heatmapLayout,
  lgamma,
  leavesOrder,
  linkageAverage,
  parseCsv,
  pyRound,
  renderCorrelation,
  studentTTwoSidedSurvival,
  volcanoLayout,
  welchTTest,
  type VolcanoPoint,
} from "../../src/analysis/index.js";
import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "analysis",
);

const TMP_ROOTS: string[] = [];

async function makeTaskRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biomed-analysis-"));
  TMP_ROOTS.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(
    TMP_ROOTS.map((root) => rm(root, { recursive: true, force: true }).catch(() => undefined)),
  );
});

async function golden<T = unknown>(name: string): Promise<T> {
  return JSON.parse(await readFile(path.join(FIXTURES, name), "utf8")) as T;
}

/** Extract the path tail from a tool error message and canonicalize it. */
async function realpathOf(message: string): Promise<string> {
  const match = /^(file is empty|CSV has no rows): (.+)$/.exec(message);
  if (!match) return message;
  return realpath(match[2]);
}

async function installFixture(taskRoot: string, name = "de_input.csv"): Promise<string> {
  const content = await readFile(path.join(FIXTURES, name));
  const dest = path.join(taskRoot, name);
  await writeFile(dest, content);
  return dest;
}

function readPng(buffer: Buffer): PNG {
  expect(buffer.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  return PNG.sync.read(buffer);
}

function pixel(png: PNG, x: number, y: number): [number, number, number] {
  const offset = (y * png.width + x) * 4;
  return [png.data[offset], png.data[offset + 1], png.data[offset + 2]];
}

/** Assert |actual - expected| <= tolerance, reporting the max abs diff. */
function assertClose(
  actual: number,
  expected: number,
  tolerance: number,
  label: string,
): void {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(`${label}: |${actual} - ${expected}| = ${diff} > ${tolerance}`);
  }
}

function reportMaxAbsDiff(label: string, diffs: readonly number[]): void {
  const max = diffs.length > 0 ? Math.max(...diffs) : 0;
  console.log(`[parity] ${label}: max abs diff = ${max} (n=${diffs.length})`);
}

// ---------------------------------------------------------------------------
// Special functions (ibeta / lgamma)
// ---------------------------------------------------------------------------

describe("ibeta / lgamma special functions", () => {
  it("I_x(1,1) = x and I_x(0.5,0.5) = (2/pi) asin(sqrt(x))", () => {
    for (const x of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      assertClose(betainc(1, 1, x), x, 1e-12, `I_x(1,1) at ${x}`);
      assertClose(
        betainc(0.5, 0.5, x),
        (2 / Math.PI) * Math.asin(Math.sqrt(x)),
        1e-12,
        `I_x(0.5,0.5) at ${x}`,
      );
    }
    expect(betainc(2, 3, 0)).toBe(0);
    expect(betainc(2, 3, 1)).toBe(1);
    expect(Number.isNaN(betainc(2, 3, -0.1))).toBe(true);
  });

  it("lgamma matches exact integer factorials", () => {
    assertClose(lgamma(5), Math.log(24), 1e-12, "lgamma(5)");
    assertClose(lgamma(1), 0, 1e-12, "lgamma(1)");
    assertClose(lgamma(0.5), 0.5 * Math.log(Math.PI), 1e-12, "lgamma(0.5)");
  });

  it("Student-t survival sanity: df=1, t=1 -> p=0.5", () => {
    assertClose(studentTTwoSidedSurvival(1, 1), 0.5, 1e-12, "stdtr(1,1)");
    expect(studentTTwoSidedSurvival(0, 3)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Welch t-test — golden parity against scipy ttest_ind(equal_var=False)
// ---------------------------------------------------------------------------

describe("welch t-test golden parity (scipy.stats.ttest_ind)", () => {
  interface WelchGoldenGene {
    gene: string;
    a: number[];
    b: number[];
    t: number | null;
    p: number;
  }

  it("t and p match scipy within 1e-10 for every fixture row", async () => {
    const goldenData = await golden<{ genes: WelchGoldenGene[] }>("welch.golden.json");
    const tDiffs: number[] = [];
    const pDiffs: number[] = [];
    for (const entry of goldenData.genes) {
      const { t, p } = welchTTest(entry.a, entry.b);
      if (entry.t === null) {
        expect(Number.isNaN(t), `${entry.gene}: degenerate row must yield NaN t`).toBe(true);
      } else {
        expect(Number.isFinite(t), `${entry.gene}: t must be finite`).toBe(true);
        tDiffs.push(Math.abs(t - entry.t));
      }
      pDiffs.push(Math.abs(p - entry.p));
      assertClose(p, entry.p, 1e-10, `welch p for ${entry.gene}`);
    }
    reportMaxAbsDiff("welch t (vs scipy)", tDiffs);
    reportMaxAbsDiff("welch p (vs scipy)", pDiffs);
    expect(tDiffs.every((d) => d <= 1e-10)).toBe(true);
    expect(pDiffs.every((d) => d <= 1e-10)).toBe(true);
  });

  it("degenerate inputs mirror the Python tool guard (p=1.0, t=NaN)", () => {
    expect(welchTTest([1], [1, 2, 3]).p).toBe(1.0); // group size < 2
    expect(welchTTest([1, 1, 1], [2, 3, 4]).p).toBe(1.0); // zero variance
    expect(welchTTest([1, 1], [2, 2]).p).toBe(1.0); // both zero variance
    expect(welchTTest([], []).p).toBe(1.0); // empty
  });
});

// ---------------------------------------------------------------------------
// Benjamini-Hochberg
// ---------------------------------------------------------------------------

describe("bhAdjust (Python _bh_adjust_pvalues parity)", () => {
  it("matches the textbook hand computation", () => {
    const actual = bhAdjust([0.01, 0.02, 0.03, 0.05, 0.2]);
    const expected = [0.05, 0.05, 0.05, 0.0625, 0.2];
    actual.forEach((value, i) => assertClose(value, expected[i], 1e-12, `bh[${i}]`));
  });

  it("preserves input order", () => {
    const actual = bhAdjust([0.2, 0.01, 0.05, 0.03, 0.02]);
    const expected = [0.2, 0.05, 0.0625, 0.05, 0.05];
    actual.forEach((value, i) => assertClose(value, expected[i], 1e-12, `bh[${i}]`));
  });

  it("degenerate inputs are NaN-safe", () => {
    expect(bhAdjust([])).toEqual([]);
    expect(bhAdjust([0.01])).toEqual([0.01]);
    expect(bhAdjust([0.01, 0.04])).toEqual([0.02, 0.04]);
    expect(bhAdjust([0.05, 0.05, 0.05, 0.05, 0.05])).toEqual([0.05, 0.05, 0.05, 0.05, 0.05]);
    expect(bhAdjust([Number.NaN, 0.01])).toEqual([1.0, 0.02]);
    expect(bhAdjust([Number.POSITIVE_INFINITY])).toEqual([1.0]);
    expect(bhAdjust([0.01, 0.9])).toEqual([0.02, 0.9]);
  });

  it("matches the Python BH output on the full-set fixture", async () => {
    const fullset = await golden<{ pvalues_all: number[]; padj_all: number[] }>("de_fullset.golden.json");
    const actual = bhAdjust(fullset.pvalues_all);
    const diffs = actual.map((v, i) => Math.abs(v - fullset.padj_all[i]));
    reportMaxAbsDiff("bh (vs Python _bh_adjust_pvalues)", diffs);
    expect(diffs.every((d) => d <= 1e-12)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Correlation — golden parity against pandas DataFrame.corr
// ---------------------------------------------------------------------------

describe("correlationMatrix golden parity (pandas DataFrame.corr)", () => {
  interface CorrelationGolden {
    columns: string[];
    values: (number | null)[][];
  }

  it.each(["pearson", "spearman", "kendall"] as const)(
    "%s matches pandas .corr within 1e-9",
    async (method) => {
      const data = await golden<CorrelationGolden>(`correlation_${method}.golden.json`);
      const table = parseCsv(await readFile(path.join(FIXTURES, "de_input.csv"), "utf8"));
      const columns = data.columns.map((col) => {
        const idx = table.headers.indexOf(col);
        expect(idx).toBeGreaterThanOrEqual(0);
        return table.values.map((row) => row[idx]);
      });
      const actual = correlationMatrix(columns, method);
      const diffs: number[] = [];
      for (let i = 0; i < data.values.length; i += 1) {
        for (let j = 0; j < data.values[i].length; j += 1) {
          const expected = data.values[i][j];
          if (expected === null) {
            expect(Number.isNaN(actual[i][j]), `${method}[${i}][${j}] must be NaN`).toBe(true);
          } else {
            diffs.push(Math.abs(actual[i][j] - expected));
          }
        }
      }
      reportMaxAbsDiff(`correlation ${method} (vs pandas)`, diffs);
      expect(diffs.every((d) => d <= 1e-9)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Clustering — golden order parity against scipy linkage('average')
// ---------------------------------------------------------------------------

describe("clustering golden parity (scipy linkage average + leaves_list)", () => {
  interface HeatmapGolden {
    display_genes: string[];
    columns_used: string[];
    row_order: number[] | null;
    col_order: number[] | null;
    matrix: number[][];
  }

  it("UPGMA + leaf order matches scipy/seaborn on the z-score matrix", async () => {
    const data = await golden<HeatmapGolden>("heatmap_zscore.golden.json");
    const rowOrder = leavesOrder(linkageAverage(data.matrix), data.matrix.length);
    expect(rowOrder).toEqual(data.row_order);
    const transposed = data.matrix[0].map((_, c) => data.matrix.map((row) => row[c]));
    const colOrder = leavesOrder(linkageAverage(transposed), transposed.length);
    expect(colOrder).toEqual(data.col_order);
  });
});

// ---------------------------------------------------------------------------
// Tools — differential expression
// ---------------------------------------------------------------------------

interface DegEntry {
  gene: string;
  log2FC: number;
  pvalue: number;
  padj: number;
  neg_log10_pval: number;
  significant: boolean;
}

interface DeGolden {
  gene_column: string;
  row_count: number;
  group_a_count: number;
  group_b_count: number;
  significant_up: number;
  significant_down: number;
  pval_threshold: number;
  log2fc_threshold: number;
  degs: DegEntry[];
}

interface DeResult {
  status: string;
  source_file: string;
  gene_column: string;
  row_count: number;
  group_a_count: number;
  group_b_count: number;
  significant_up: number;
  significant_down: number;
  pval_threshold: number;
  log2fc_threshold: number;
  degs: DegEntry[];
  volcano_plot: string;
  outputs: string[];
  error?: string;
}

function assertDegsParity(actual: DegEntry[], expected: DegEntry[]): void {
  expect(actual).toHaveLength(expected.length);
  const fcDiffs: number[] = [];
  const pDiffs: number[] = [];
  const padjDiffs: number[] = [];
  const nlpDiffs: number[] = [];
  for (let i = 0; i < expected.length; i += 1) {
    expect(actual[i].gene).toBe(expected[i].gene);
    expect(actual[i].significant).toBe(expected[i].significant);
    fcDiffs.push(Math.abs(actual[i].log2FC - expected[i].log2FC));
    pDiffs.push(Math.abs(actual[i].pvalue - expected[i].pvalue));
    padjDiffs.push(Math.abs(actual[i].padj - expected[i].padj));
    nlpDiffs.push(Math.abs(actual[i].neg_log10_pval - expected[i].neg_log10_pval));
  }
  reportMaxAbsDiff("de log2FC (vs Python)", fcDiffs);
  reportMaxAbsDiff("de pvalue (vs Python)", pDiffs);
  reportMaxAbsDiff("de padj (vs Python)", padjDiffs);
  reportMaxAbsDiff("de neg_log10_pval (vs Python)", nlpDiffs);
  expect(fcDiffs.every((d) => d <= 5e-5)).toBe(true);
  expect(pDiffs.every((d) => d <= 5e-7)).toBe(true);
  expect(padjDiffs.every((d) => d <= 5e-7)).toBe(true);
  expect(nlpDiffs.every((d) => d <= 5e-5)).toBe(true);
}

async function runTool(
  taskRoot: string,
  runId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tools = createAnalysisTools({ taskRoot, runId });
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  const result = await tool.execute(args);
  return JSON.parse(result.content) as Record<string, unknown>;
}

async function listFilesRecursive(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await listFilesRecursive(full)));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe("run_differential_expression tool", () => {
  it("matches the Python golden for default thresholds", async () => {
    const taskRoot = await makeTaskRoot();
    await installFixture(taskRoot);
    const runId = "run-de-1";
    const result = (await runTool(taskRoot, runId, RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME, {
      csv_path: "de_input.csv",
      group_a_cols: ["A_1", "A_2", "A_3", "A_4"],
      group_b_cols: ["B_1", "B_2", "B_3"],
      gene_col: "gene",
      pval_threshold: 0.05,
      log2fc_threshold: 1.0,
      top_n: 100,
    })) as unknown as DeResult;

    const expected = await golden<DeGolden>("differential_expression.golden.json");
    expect(result.status).toBe("ok");
    // realpath: the tool reports the canonical path (Windows casing differs
    // from os.tmpdir()'s spelling).
    expect(await realpath(result.source_file)).toBe(await realpath(path.join(taskRoot, "de_input.csv")));
    expect(result.gene_column).toBe(expected.gene_column);
    expect(result.row_count).toBe(expected.row_count);
    expect(result.group_a_count).toBe(expected.group_a_count);
    expect(result.group_b_count).toBe(expected.group_b_count);
    expect(result.significant_up).toBe(expected.significant_up);
    expect(result.significant_down).toBe(expected.significant_down);
    expect(result.pval_threshold).toBe(expected.pval_threshold);
    expect(result.log2fc_threshold).toBe(expected.log2fc_threshold);
    assertDegsParity(result.degs, expected.degs);

    // P5-D5: taskRoot-relative outputs confined to staging/analysis/<runId>.
    expect(result.volcano_plot).toBe(`staging/analysis/${runId}/volcano_plot.png`);
    expect(result.outputs).toEqual([
      `staging/analysis/${runId}/volcano_plot.png`,
      `staging/analysis/${runId}/differential_expression.json`,
    ]);
    for (const output of result.outputs) {
      expect(path.isAbsolute(output)).toBe(false);
      expect((await readFile(path.join(taskRoot, output))).length).toBeGreaterThan(0);
    }
    await expect(readdir(path.join(taskRoot, "artifacts"))).rejects.toThrow();

    // Volcano PNG pixel checks at computed data coordinates.
    const png = readPng(await readFile(path.join(taskRoot, result.volcano_plot)));
    const deInputText = await readFile(path.join(FIXTURES, "de_input.csv"), "utf8");
    const buildPoints = (): VolcanoPoint[] => {
      const table = parseCsv(deInputText);
      const geneIdx = table.headers.indexOf("gene");
      const aIdx = ["A_1", "A_2", "A_3", "A_4"].map((c) => table.headers.indexOf(c));
      const bIdx = ["B_1", "B_2", "B_3"].map((c) => table.headers.indexOf(c));
      return table.rows.map((row, r) => {
        const a = aIdx.map((c) => table.values[r][c]).filter((v) => Number.isFinite(v));
        const b = bIdx.map((c) => table.values[r][c]).filter((v) => Number.isFinite(v));
        const meanA = a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
        const meanB = b.length ? b.reduce((s, v) => s + v, 0) / b.length : 0;
        const fc = Math.log2(Math.max(meanB + 1, 1e-9)) - Math.log2(Math.max(meanA + 1, 1e-9));
        const p = a.length >= 2 && b.length >= 2
          ? welchTTest(a, b).p
          : 1.0;
        return {
          x: fc,
          y: -Math.log10(Math.max(p, 1e-300)),
          gene: row[geneIdx],
          category: (p <= 0.05 && fc >= 1.0 ? "up" : p <= 0.05 && fc <= -1.0 ? "down" : "ns") as VolcanoPoint["category"],
        };
      });
    };
    const points = buildPoints();
    const layout = volcanoLayout(points);
    const firstTp53 = points.find((point) => point.gene === "TP53" && point.category === "up");
    const g03 = points.find((point) => point.gene === "G03");
    const g05 = points.find((point) => point.gene === "G05");
    expect(firstTp53?.category).toBe("up");
    expect(g03?.category).toBe("down");
    expect(g05?.category).toBe("ns");
    if (!firstTp53 || !g03 || !g05) {
      throw new Error("fixture points missing");
    }
    const { px: upX, py: upY } = layout.toPixel(firstTp53.x, firstTp53.y);
    expect(pixel(png, upX, upY)).toEqual([255, 0, 0]);
    const { px: downX, py: downY } = layout.toPixel(g03.x, g03.y);
    expect(pixel(png, downX, downY)).toEqual([0, 0, 255]);
    const { px: nsX, py: nsY } = layout.toPixel(g05.x, g05.y);
    expect(pixel(png, nsX, nsY)).toEqual([128, 128, 128]);
    // Threshold lines: sample positions away from any data point.
    const hlineY = layout.toPixel(0, -Math.log10(0.05)).py;
    const busy = new Set<string>();
    for (const point of points) {
      const { px, py } = layout.toPixel(point.x, point.y);
      for (let dx = -5; dx <= 5; dx += 1) {
        for (let dy = -5; dy <= 5; dy += 1) {
          busy.add(`${px + dx},${py + dy}`);
        }
      }
    }
    let sampled = 0;
    for (let px = layout.left + 2; px < layout.left + layout.plotWidth - 2; px += 7) {
      if (!busy.has(`${px},${hlineY}`)) {
        expect(pixel(png, px, hlineY)).toEqual([128, 128, 128]);
        sampled += 1;
        if (sampled >= 3) break;
      }
    }
    expect(sampled).toBe(3);
    const vlineX = layout.toPixel(1.0, 0).px;
    const vlineNx = layout.toPixel(-1.0, 0).px;
    for (const [vx] of [[vlineX], [vlineNx]] as const) {
      let vSampled = 0;
      for (let py = layout.top + 2; py < layout.top + layout.plotHeight - 2; py += 9) {
        if (!busy.has(`${vx},${py}`)) {
          expect(pixel(png, vx, py)).toEqual([128, 128, 128]);
          vSampled += 1;
          if (vSampled >= 3) break;
        }
      }
      expect(vSampled).toBe(3);
    }
    // Label text drawn for top_n genes: non-background pixels near TP53 point.
    let textPixels = 0;
    for (let dx = -8; dx <= 40; dx += 1) {
      for (let dy = -14; dy <= 14; dy += 1) {
        const [r, g, b] = pixel(png, upX + dx, upY + dy);
        if (r < 200 || g < 200 || b < 200) textPixels += 1;
      }
    }
    expect(textPixels).toBeGreaterThan(10);
  });

  it("matches the strict-threshold golden (0.01 / 0.5)", async () => {
    const taskRoot = await makeTaskRoot();
    await installFixture(taskRoot);
    const result = (await runTool(taskRoot, "run-strict", RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME, {
      csv_path: "de_input.csv",
      group_a_cols: ["A_1", "A_2", "A_3", "A_4"],
      group_b_cols: ["B_1", "B_2", "B_3"],
      gene_col: "gene",
      pval_threshold: 0.01,
      log2fc_threshold: 0.5,
      top_n: 100,
    })) as unknown as DeResult;
    const expected = await golden<DeGolden>("differential_expression_strict.golden.json");
    expect(result.significant_up).toBe(expected.significant_up);
    expect(result.significant_down).toBe(expected.significant_down);
    expect(result.pval_threshold).toBe(0.01);
    expect(result.log2fc_threshold).toBe(0.5);
    assertDegsParity(result.degs, expected.degs);
  });

  it("single-sample groups fall back to p=1.0 (Python guard)", async () => {
    const taskRoot = await makeTaskRoot();
    const content = await readFile(path.join(FIXTURES, "de_input.csv"), "utf8");
    const small = path.join(taskRoot, "single.csv");
    const lines = content.split("\n");
    await writeFile(small, `${lines[0]}\n${lines[1]}\n${lines[2]}\n${lines[3]}\n`);
    const result = (await runTool(taskRoot, "run-single", RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME, {
      csv_path: "single.csv",
      group_a_cols: ["A_1"],
      group_b_cols: ["B_1"],
      gene_col: "gene",
      top_n: 100,
    })) as unknown as DeResult;
    expect(result.status).toBe("ok");
    for (const deg of result.degs) {
      expect(deg.pvalue).toBe(1.0);
      expect(deg.padj).toBe(1.0);
    }
  });

  it("zero-variance and sparse rows carry p=1.0 in the golden result", async () => {
    const expected = await golden<DeGolden>("differential_expression.golden.json");
    for (const gene of ["SPARSE", "FLAT"]) {
      const deg = expected.degs.find((d) => d.gene === gene);
      expect(deg?.pvalue).toBe(1.0);
      expect(deg?.padj).toBe(1.0);
      expect(deg?.significant).toBe(false);
    }
    expect(expected.degs.find((d) => d.gene === "FLAT")?.log2FC).toBe(-1.0);
  });

  it("BH correction runs over the FULL p-value set before top_n truncation", async () => {
    const taskRoot = await makeTaskRoot();
    await installFixture(taskRoot, "de_fullset.csv");
    const result = (await runTool(taskRoot, "run-fullset", RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME, {
      csv_path: "de_fullset.csv",
      group_a_cols: ["a1", "a2"],
      group_b_cols: ["b1", "b2"],
      gene_col: "gene",
      top_n: 3,
    })) as unknown as DeResult;
    const fullset = await golden<{
      row_count: number;
      degs: DegEntry[];
      pvalues_all: number[];
      padj_all: number[];
    }>("de_fullset.golden.json");
    expect(result.row_count).toBe(fullset.row_count);
    expect(result.degs).toHaveLength(3);
    for (let i = 0; i < result.degs.length; i += 1) {
      assertClose(result.degs[i].pvalue, fullset.degs[i].pvalue, 5e-7, `fullset pvalue[${i}]`);
      assertClose(result.degs[i].padj, fullset.degs[i].padj, 5e-7, `fullset padj[${i}]`);
      expect(result.degs[i].gene).toBe(fullset.degs[i].gene);
    }
    // The top-3 padj must equal the FULL-set BH (not a 3-gene re-run).
    const oracle = new Map(fullset.degs.map((d) => [d.gene, d.padj]));
    for (const deg of result.degs) {
      expect(deg.padj).toBe(oracle.get(deg.gene));
    }
  });

  it("identical p-values yield padj == pvalue", async () => {
    const taskRoot = await makeTaskRoot();
    await writeFile(
      path.join(taskRoot, "identical.csv"),
      "gene,a1,a2,b1,b2\n" +
        "G1,1.0,3.0,2.0,4.0\n" +
        "G2,2.0,4.0,1.0,3.0\n" +
        "G3,1.0,3.0,2.0,4.0\n",
    );
    const result = (await runTool(taskRoot, "run-identical", RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME, {
      csv_path: "identical.csv",
      group_a_cols: ["a1", "a2"],
      group_b_cols: ["b1", "b2"],
      gene_col: "gene",
    })) as unknown as DeResult;
    expect(result.status).toBe("ok");
    expect(result.degs).toHaveLength(3);
    expect(new Set(result.degs.map((d) => d.pvalue)).size).toBe(1);
    for (const deg of result.degs) {
      expect(deg.padj).toBe(deg.pvalue);
    }
  });

  it("gene column autodetection mirrors the Python heuristic", async () => {
    const taskRoot = await makeTaskRoot();
    await writeFile(
      path.join(taskRoot, "autodetect.csv"),
      "foo,val1,val2\nA,1.0,2.0\nB,2.0,3.0\nC,3.0,4.0\n",
    );
    const result = (await runTool(taskRoot, "run-auto", RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME, {
      csv_path: "autodetect.csv",
      group_a_cols: ["val1"],
      group_b_cols: ["val2"],
      top_n: 100,
    })) as unknown as DeResult;
    expect(result.gene_column).toBe("foo"); // first non-numeric column fallback

    await writeFile(
      path.join(taskRoot, "autodetect2.csv"),
      "sample_a,sample_b,ID\n1.0,2.0,X1\n2.0,3.0,X2\n",
    );
    const result2 = (await runTool(taskRoot, "run-auto2", RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME, {
      csv_path: "autodetect2.csv",
      group_a_cols: ["sample_a"],
      group_b_cols: ["sample_b"],
      top_n: 100,
    })) as unknown as DeResult;
    expect(result2.gene_column).toBe("ID"); // named candidate

    await writeFile(
      path.join(taskRoot, "autodetect3.csv"),
      "n1,n2,n3\n1.0,2.0,3.0\n2.0,3.0,4.0\n",
    );
    const result3 = (await runTool(taskRoot, "run-auto3", RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME, {
      csv_path: "autodetect3.csv",
      group_a_cols: ["n1"],
      group_b_cols: ["n2"],
      top_n: 100,
    })) as unknown as DeResult;
    expect(result3.status).toBe("error");
    expect(result3.error).toContain("Cannot identify gene identifier column");
  });

  it("error shape mirrors Python on missing group columns and empty groups", async () => {
    const taskRoot = await makeTaskRoot();
    await installFixture(taskRoot);
    const missing = (await runTool(taskRoot, "run-err1", RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME, {
      csv_path: "de_input.csv",
      group_a_cols: ["A_1", "nope"],
      group_b_cols: ["B_1"],
    })) as unknown as DeResult;
    expect(missing.status).toBe("error");
    expect(missing.error).toBe("group A columns not found: ['nope']");
    expect(missing.row_count).toBe(0);
    expect(missing.degs).toEqual([]);
    expect(missing.volcano_plot).toBe("");
    expect(missing.outputs).toEqual([]);
    expect(missing.source_file).toBe("de_input.csv");

    const empty = (await runTool(taskRoot, "run-err2", RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME, {
      csv_path: "de_input.csv",
      group_a_cols: [],
      group_b_cols: ["B_1"],
    })) as unknown as DeResult;
    expect(empty.status).toBe("error");
    expect(empty.error).toContain("both groups must have at least one column");
  });

  it("unreadable CSVs produce the Python error shape", async () => {
    const taskRoot = await makeTaskRoot();
    const notFound = (await runTool(taskRoot, "run-err3", RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME, {
      csv_path: "missing.csv",
      group_a_cols: ["a"],
      group_b_cols: ["b"],
    })) as unknown as DeResult;
    expect(notFound.status).toBe("error");
    expect(notFound.error).toBe(`file not found: missing.csv`);
    expect(notFound.source_file).toBe("missing.csv");

    // The other three tools share the reader but each has its own zeroed
    // error shape (Python parity).
    const basic = (await runTool(taskRoot, "run-err3b", BASIC_STATISTICS_TOOL_NAME, {
      csv_path: "missing.csv",
    })) as unknown as {
      status: string;
      source_file: string;
      total_rows: number;
      columns_analyzed: string[];
      stats_report: string;
      summary: Record<string, never>;
      outputs: string[];
      error: string;
    };
    expect(basic).toEqual({
      status: "error",
      source_file: "missing.csv",
      total_rows: 0,
      columns_analyzed: [],
      stats_report: "",
      summary: {},
      outputs: [],
      error: "file not found: missing.csv",
    });
    const heatmap = (await runTool(taskRoot, "run-err3c", GENERATE_HEATMAP_TOOL_NAME, {
      csv_path: "missing.csv",
    })) as unknown as {
      status: string;
      rows_displayed: number;
      columns_used: string[];
      zscore: boolean;
      heatmap_png: string;
      outputs: string[];
      error: string;
    };
    expect(heatmap.status).toBe("error");
    expect(heatmap.rows_displayed).toBe(0);
    expect(heatmap.columns_used).toEqual([]);
    expect(heatmap.zscore).toBe(true);
    expect(heatmap.heatmap_png).toBe("");
    expect(heatmap.outputs).toEqual([]);
    expect(heatmap.error).toBe("file not found: missing.csv");
    const correlation = (await runTool(taskRoot, "run-err3d", GENERATE_CORRELATION_MATRIX_TOOL_NAME, {
      csv_path: "missing.csv",
    })) as unknown as {
      status: string;
      method: string;
      columns_used: string[];
      correlation_png: string;
      outputs: string[];
      error: string;
    };
    expect(correlation.status).toBe("error");
    expect(correlation.method).toBe("pearson");
    expect(correlation.columns_used).toEqual([]);
    expect(correlation.correlation_png).toBe("");
    expect(correlation.outputs).toEqual([]);
    expect(correlation.error).toBe("file not found: missing.csv");

    await writeFile(path.join(taskRoot, "empty.csv"), "");
    const emptyFile = (await runTool(taskRoot, "run-err4", RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME, {
      csv_path: "empty.csv",
      group_a_cols: ["a"],
      group_b_cols: ["b"],
    })) as unknown as DeResult;
    expect(emptyFile.status).toBe("error");
    expect(await realpathOf(emptyFile.error ?? "")).toBe(await realpath(path.join(taskRoot, "empty.csv")));
    expect(emptyFile.error).toContain("file is empty: ");

    await writeFile(path.join(taskRoot, "header_only.csv"), "gene,a1,b1\n");
    const headerOnly = (await runTool(taskRoot, "run-err5", RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME, {
      csv_path: "header_only.csv",
      group_a_cols: ["a1"],
      group_b_cols: ["b1"],
    })) as unknown as DeResult;
    expect(headerOnly.status).toBe("error");
    expect(await realpathOf(headerOnly.error ?? "")).toBe(await realpath(path.join(taskRoot, "header_only.csv")));
    expect(headerOnly.error).toContain("CSV has no rows: ");
  });

  it("rejects task-root escapes (relative and absolute)", async () => {
    const taskRoot = await makeTaskRoot();
    await installFixture(taskRoot);
    const outside = path.join(path.dirname(taskRoot), "outside.csv");
    await writeFile(outside, "gene,a,b\nG1,1,2\n");
    for (const csvPath of ["../outside.csv", outside]) {
      const result = (await runTool(taskRoot, "run-esc", RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME, {
        csv_path: csvPath,
        group_a_cols: ["a"],
        group_b_cols: ["b"],
      })) as unknown as DeResult;
      expect(result.status).toBe("error");
      expect(result.error).toBe("source path must remain inside the task work directory");
    }
    await rm(outside, { force: true });
  });

  it("never writes under artifacts/ — everything lands in staging/analysis/<runId>", async () => {
    const taskRoot = await makeTaskRoot();
    await installFixture(taskRoot);
    const runId = "run-confinement";
    await runTool(taskRoot, runId, RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME, {
      csv_path: "de_input.csv",
      group_a_cols: ["A_1", "A_2", "A_3", "A_4"],
      group_b_cols: ["B_1", "B_2", "B_3"],
      top_n: 100,
    });
    await runTool(taskRoot, runId, BASIC_STATISTICS_TOOL_NAME, { csv_path: "de_input.csv" });
    await runTool(taskRoot, runId, GENERATE_CORRELATION_MATRIX_TOOL_NAME, { csv_path: "de_input.csv" });
    await runTool(taskRoot, runId, GENERATE_HEATMAP_TOOL_NAME, { csv_path: "de_input.csv" });
    const all = await listFilesRecursive(taskRoot);
    const stagingPrefix = path.join(taskRoot, "staging", "analysis", runId);
    expect(all.filter((f) => f.includes(`${path.sep}artifacts${path.sep}`))).toEqual([]);
    expect(all.every((f) => f.startsWith(stagingPrefix) || f.startsWith(path.join(taskRoot, "de_input.csv")))).toBe(true);
    // 2 (DE) + 2 (basic stats) + 2 (correlation) + 1 (heatmap) = 7 files.
    expect(all.filter((f) => f.startsWith(stagingPrefix))).toHaveLength(7);
  });

  it("defaults to staging/analysis/default when runId is absent", async () => {
    const taskRoot = await makeTaskRoot();
    await installFixture(taskRoot);
    const tools = createAnalysisTools({ taskRoot });
    const tool = tools.find((t) => t.name === BASIC_STATISTICS_TOOL_NAME);
    expect(tool).toBeDefined();
    const result = JSON.parse((await tool?.execute({ csv_path: "de_input.csv" }))?.content ?? "{}") as {
      stats_report: string;
      outputs: string[];
    };
    expect(result.stats_report).toBe("staging/analysis/default/stats_report.csv");
    expect(result.outputs).toEqual([
      "staging/analysis/default/stats_report.csv",
      "staging/analysis/default/basic_statistics.json",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tools — basic_statistics
// ---------------------------------------------------------------------------

interface BasicStatsGolden {
  total_rows: number;
  columns_analyzed: string[];
  summary: Record<string, {
    column: string;
    count: number;
    mean: number | null;
    std: number | null;
    min: number | null;
    q25: number | null;
    median: number | null;
    q75: number | null;
    max: number | null;
    missing: number;
    missing_pct: number;
  }>;
}

describe("basic_statistics tool", () => {
  it("matches the pandas describe() golden", async () => {
    const taskRoot = await makeTaskRoot();
    await installFixture(taskRoot);
    const result = (await runTool(taskRoot, "run-basic", BASIC_STATISTICS_TOOL_NAME, {
      csv_path: "de_input.csv",
    })) as unknown as {
      status: string;
      total_rows: number;
      columns_analyzed: string[];
      stats_report: string;
      summary: BasicStatsGolden["summary"];
      outputs: string[];
    };
    const expected = await golden<BasicStatsGolden>("basic_statistics.golden.json");
    expect(result.status).toBe("ok");
    expect(result.total_rows).toBe(expected.total_rows);
    expect(result.columns_analyzed).toEqual(expected.columns_analyzed);
    const diffs: number[] = [];
    for (const col of expected.columns_analyzed) {
      const actual = result.summary[col];
      const want = expected.summary[col];
      expect(actual.column).toBe(col);
      expect(actual.count).toBe(want.count);
      expect(actual.missing).toBe(want.missing);
      for (const key of ["mean", "std", "min", "q25", "median", "q75", "max"] as const) {
        if (want[key] === null) {
          expect(actual[key]).toBeNull();
        } else {
          diffs.push(Math.abs((actual[key] as number) - (want[key] as number)));
        }
      }
      diffs.push(Math.abs(actual.missing_pct - want.missing_pct));
    }
    reportMaxAbsDiff("basic_statistics (vs pandas describe)", diffs);
    expect(diffs.every((d) => d <= 1e-4)).toBe(true);
    // Stats report CSV written with the pandas column layout.
    const report = await readFile(path.join(taskRoot, result.stats_report), "utf8");
    expect(report.split("\n")[0]).toBe(
      "column,count,mean,std,min,q25,median,q75,max,missing,missing_pct",
    );
    expect(report.split("\n").filter(Boolean)).toHaveLength(expected.columns_analyzed.length + 1);
  });

  it("zero-variance column statistics are NaN-free (std=0)", async () => {
    const taskRoot = await makeTaskRoot();
    await writeFile(
      path.join(taskRoot, "zv.csv"),
      "gene,z,other\nG1,2.5,1.0\nG2,2.5,2.0\nG3,2.5,3.0\n",
    );
    const result = (await runTool(taskRoot, "run-zv", BASIC_STATISTICS_TOOL_NAME, {
      csv_path: "zv.csv",
    })) as unknown as { summary: Record<string, { std: number; min: number; max: number }> };
    expect(result.summary.z.std).toBe(0);
    expect(result.summary.z.min).toBe(2.5);
    expect(result.summary.z.max).toBe(2.5);
  });

  it("unknown columns produce the Python error", async () => {
    const taskRoot = await makeTaskRoot();
    await installFixture(taskRoot);
    const result = (await runTool(taskRoot, "run-basic-err", BASIC_STATISTICS_TOOL_NAME, {
      csv_path: "de_input.csv",
      columns: ["A_1", "nope"],
    })) as unknown as { status: string; error: string; columns_analyzed: string[] };
    expect(result.status).toBe("error");
    expect(result.error).toBe("columns not found in CSV: ['nope']");
    expect(result.columns_analyzed).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tools — correlation matrix
// ---------------------------------------------------------------------------

describe("generate_correlation_matrix tool", () => {
  interface CorrelationResult {
    status: string;
    source_file: string;
    method: string;
    columns_used: string[];
    correlation_png: string;
    outputs: string[];
    error?: string;
  }

  interface CorrelationGolden {
    columns: string[];
    values: (number | null)[][];
  }

  it.each(["pearson", "spearman", "kendall"] as const)(
    "%s tool output + PNG + CSV match the golden",
    async (method) => {
      const taskRoot = await makeTaskRoot();
      await installFixture(taskRoot);
      const runId = `run-corr-${method}`;
      const result = (await runTool(taskRoot, runId, GENERATE_CORRELATION_MATRIX_TOOL_NAME, {
        csv_path: "de_input.csv",
        method,
      })) as unknown as CorrelationResult;
      const expected = await golden<CorrelationGolden>(`correlation_${method}.golden.json`);
      expect(result.status).toBe("ok");
      expect(result.method).toBe(method);
      expect(result.columns_used).toEqual(expected.columns);
      expect(result.correlation_png).toBe(`staging/analysis/${runId}/correlation.png`);
      expect(result.outputs).toEqual([
        `staging/analysis/${runId}/correlation.png`,
        `staging/analysis/${runId}/correlation.csv`,
      ]);

      // CSV matrix parity.
      const csv = await readFile(path.join(taskRoot, `staging/analysis/${runId}/correlation.csv`), "utf8");
      const lines = csv.trim().split("\n");
      expect(lines[0]).toBe(expected.columns.join(","));
      for (let i = 0; i < expected.values.length; i += 1) {
        const cells = lines[i + 1].split(",");
        for (let j = 0; j < expected.values[i].length; j += 1) {
          const want = expected.values[i][j];
          if (want === null) {
            expect(cells[j]).toBe("");
          } else {
            assertClose(Number(cells[j]), want, 1e-9, `${method} csv[${i}][${j}]`);
          }
        }
      }

      // PNG pixel checks: coolwarm with vmin=-1/vmax=1, upper triangle masked.
      const png = readPng(await readFile(path.join(taskRoot, result.correlation_png)));
      const count = expected.columns.length;
      const layout = correlationLayout(count, expected.columns);
      const { px: d0x, py: d0y } = layout.cellCenter(0, 0);
      // Sample away from the cell center: the ".2f" annotation text is black
      // at the center; (+20, +20) stays inside the 52px cell, outside text.
      expect(pixel(png, d0x + 20, d0y + 20)).toEqual(
        colormapBytes("coolwarm", 1).slice(0, 3) as [number, number, number],
      );
      const { px: m0x, py: m0y } = layout.cellCenter(0, 2);
      expect(pixel(png, m0x + 20, m0y + 20)).toEqual([255, 255, 255]); // masked (j > i)
      const { px: m0x2, py: m0y2 } = layout.cellCenter(0, 1);
      expect(pixel(png, m0x2 + 20, m0y2 + 20)).toEqual([255, 255, 255]); // masked (j > i)
      const r01 = expected.values[0][1];
      void r01;
      const r10 = expected.values[1][0];
      if (r10 !== null) {
        const { px: c1x, py: c1y } = layout.cellCenter(1, 0);
        expect(pixel(png, c1x + 20, c1y + 20)).toEqual(
          colormapBytes("coolwarm", (r10 + 1) / 2).slice(0, 3) as [number, number, number],
        );
      }
    },
  );

  it("invalid method mirrors the pandas ValueError", async () => {
    const taskRoot = await makeTaskRoot();
    await installFixture(taskRoot);
    const result = (await runTool(taskRoot, "run-corr-bad", GENERATE_CORRELATION_MATRIX_TOOL_NAME, {
      csv_path: "de_input.csv",
      method: "bogus",
    })) as unknown as CorrelationResult;
    expect(result.status).toBe("error");
    expect(result.error).toBe(
      "method must be either 'pearson', 'spearman', 'kendall', or a callable, 'bogus' was supplied",
    );
  });

  it("fewer than 2 numeric columns fails with the Python message", async () => {
    const taskRoot = await makeTaskRoot();
    await writeFile(path.join(taskRoot, "one.csv"), "gene,v1\nG1,1.0\nG2,2.0\n");
    const result = (await runTool(taskRoot, "run-corr-one", GENERATE_CORRELATION_MATRIX_TOOL_NAME, {
      csv_path: "one.csv",
    })) as unknown as CorrelationResult;
    expect(result.status).toBe("error");
    expect(result.error).toBe("Need at least 2 numeric columns for correlation; found 1");
  });
});

// ---------------------------------------------------------------------------
// Tools — heatmap
// ---------------------------------------------------------------------------

interface HeatmapResult {
  status: string;
  source_file: string;
  gene_column: string;
  rows_displayed: number;
  total_rows_in_csv: number;
  columns_used: string[];
  zscore: boolean;
  heatmap_png: string;
  outputs: string[];
  error?: string;
}

interface HeatmapGolden {
  rows_displayed: number;
  total_rows_in_csv: number;
  columns_used: string[];
  zscore: boolean;
  display_genes: string[];
  row_order: number[] | null;
  col_order: number[] | null;
  matrix: number[][];
}

function assertHeatmapParity(result: HeatmapResult, goldenData: HeatmapGolden): void {
  expect(result.status).toBe("ok");
  expect(result.rows_displayed).toBe(goldenData.rows_displayed);
  expect(result.total_rows_in_csv).toBe(goldenData.total_rows_in_csv);
  expect(result.columns_used).toEqual(goldenData.columns_used);
  expect(result.zscore).toBe(goldenData.zscore);
}

describe("generate_heatmap tool", () => {
  it("z-score matrix, top-variable selection and clustering order match the golden", async () => {
    const taskRoot = await makeTaskRoot();
    await installFixture(taskRoot);
    const goldenData = await golden<HeatmapGolden>("heatmap_zscore.golden.json");
    const result = (await runTool(taskRoot, "run-heat", GENERATE_HEATMAP_TOOL_NAME, {
      csv_path: "de_input.csv",
      zscore: true,
    })) as unknown as HeatmapResult;
    assertHeatmapParity(result, goldenData);
    expect(result.heatmap_png).toBe("staging/analysis/run-heat/heatmap.png");

    // PNG: heatmap cells colored by the golden z matrix in clustered order.
    const png = readPng(await readFile(path.join(taskRoot, result.heatmap_png)));
    const rowOrder = goldenData.row_order ?? goldenData.matrix.map((_, i) => i);
    const colOrder = goldenData.col_order ?? goldenData.columns_used.map((_, i) => i);
    const rowLabels = rowOrder.map((r) => goldenData.display_genes[r]);
    const colLabels = colOrder.map((c) => goldenData.columns_used[c]);
    const layout = heatmapLayout(rowLabels.length, colLabels.length, rowLabels, colLabels);
    let vmin = Infinity;
    let vmax = -Infinity;
    for (const row of goldenData.matrix) {
      for (const value of row) {
        if (value < vmin) vmin = value;
        if (value > vmax) vmax = value;
      }
    }
    const expectedColor = (r: number, c: number): [number, number, number] => {
      const value = goldenData.matrix[rowOrder[r]][colOrder[c]];
      const t = (value - vmin) / (vmax - vmin);
      return colormapBytes("RdBu_r", t).slice(0, 3) as [number, number, number];
    };
    for (const [r, c] of [[0, 0], [0, colOrder.length - 1], [rowOrder.length - 1, 0], [5, 3]]) {
      const { px, py } = layout.cellCenter(r, c);
      expect(pixel(png, px, py), `cell(${r},${c})`).toEqual(expectedColor(r, c));
    }
  });

  it("max_genes=8 reproduces the top-variable golden", async () => {
    const taskRoot = await makeTaskRoot();
    await installFixture(taskRoot);
    const goldenData = await golden<HeatmapGolden>("heatmap_zscore_top8.golden.json");
    const result = (await runTool(taskRoot, "run-heat8", GENERATE_HEATMAP_TOOL_NAME, {
      csv_path: "de_input.csv",
      max_genes: 8,
      zscore: true,
    })) as unknown as HeatmapResult;
    assertHeatmapParity(result, goldenData);
  });

  it("zscore=false matches the golden on NaN-free columns", async () => {
    const taskRoot = await makeTaskRoot();
    await installFixture(taskRoot);
    const goldenData = await golden<HeatmapGolden>("heatmap_nozscore.golden.json");
    const result = (await runTool(taskRoot, "run-heat-raw", GENERATE_HEATMAP_TOOL_NAME, {
      csv_path: "de_input.csv",
      columns: ["B_1", "S_1", "Z_1"],
      zscore: false,
    })) as unknown as HeatmapResult;
    assertHeatmapParity(result, goldenData);
  });

  it("zscore=false with missing values and clustering mirrors the scipy failure", async () => {
    const taskRoot = await makeTaskRoot();
    await installFixture(taskRoot);
    const result = (await runTool(taskRoot, "run-heat-nan", GENERATE_HEATMAP_TOOL_NAME, {
      csv_path: "de_input.csv",
      zscore: false,
    })) as unknown as HeatmapResult;
    expect(result.status).toBe("error");
    expect(result.error).toBe("The condensed distance matrix must contain only finite values.");
  });

  it("too few numeric columns produces the Python error", async () => {
    const taskRoot = await makeTaskRoot();
    await writeFile(path.join(taskRoot, "one.csv"), "gene,v1\nG1,1.0\nG2,2.0\n");
    const result = (await runTool(taskRoot, "run-heat-one", GENERATE_HEATMAP_TOOL_NAME, {
      csv_path: "one.csv",
    })) as unknown as HeatmapResult;
    expect(result.status).toBe("error");
    expect(result.error).toBe("Need at least 2 numeric columns; found 1");
  });
});

// ---------------------------------------------------------------------------
// Tool registration + schemas + rendering primitives
// ---------------------------------------------------------------------------

describe("analysis tool registration and rendering primitives", () => {
  it("registers all four names in SKILL_TOOL_MAP under the analysis skill", () => {
    for (const name of [
      RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME,
      GENERATE_HEATMAP_TOOL_NAME,
      BASIC_STATISTICS_TOOL_NAME,
      GENERATE_CORRELATION_MATRIX_TOOL_NAME,
    ]) {
      expect(SKILL_TOOL_NAMES.has(name), name).toBe(true);
      expect(toolOwner(name)).toBe("analysis");
    }
  });

  it("exposes stable parameter schemas with Python-required args", async () => {
    const taskRoot = await makeTaskRoot();
    const tools = createAnalysisTools({ taskRoot, runId: "schema" });
    const byName = new Map(tools.map((t) => [t.name, t.parameters as {
      required: string[];
      properties: Record<string, unknown>;
    }]));
    expect(byName.get(RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME)?.required).toEqual([
      "csv_path", "group_a_cols", "group_b_cols",
    ]);
    expect(byName.get(GENERATE_HEATMAP_TOOL_NAME)?.required).toEqual(["csv_path"]);
    expect(byName.get(BASIC_STATISTICS_TOOL_NAME)?.required).toEqual(["csv_path"]);
    expect(byName.get(GENERATE_CORRELATION_MATRIX_TOOL_NAME)?.required).toEqual(["csv_path"]);
    expect(byName.get(GENERATE_CORRELATION_MATRIX_TOOL_NAME)?.properties.method).toMatchObject({
      enum: ["pearson", "spearman", "kendall"],
    });
    expect(tools).toHaveLength(4);
  });

  it("renders text glyphs deterministically (font sanity)", () => {
    const canvasA = createCanvas(16, 10);
    drawText(canvasA, 0, 0, "A", [0, 0, 0], 1);
    const canvasB = createCanvas(16, 10);
    drawText(canvasB, 0, 0, "B", [0, 0, 0], 1);
    expect(canvasA.data.equals(canvasB.data)).toBe(false);
    const nonWhiteA = [...canvasA.data].filter((_, i) => i % 4 === 0 && canvasA.data[i] < 255).length;
    expect(nonWhiteA).toBeGreaterThan(0);
    const png = readPng(encodePng(canvasA));
    expect(png.width).toBe(16);
    expect(png.height).toBe(10);
  });

  it("renderCorrelation annotates finite cells with black text pixels", () => {
    const values = [
      [1, 0.5],
      [0.5, 1],
    ];
    const pngBuffer = renderCorrelation({ values, labels: ["a", "b"], method: "pearson", cmap: "coolwarm" });
    const png = readPng(pngBuffer);
    const layout = correlationLayout(2, ["a", "b"]);
    const { px, py } = layout.cellCenter(0, 0);
    let textPixels = 0;
    for (let dx = -20; dx <= 20; dx += 1) {
      for (let dy = -6; dy <= 6; dy += 1) {
        const [r, g, b] = pixel(png, px + dx, py + dy);
        if (r < 100 && g < 100 && b < 100) textPixels += 1;
      }
    }
    expect(textPixels).toBeGreaterThan(5);
  });

  it("pyRound matches Python round() half-even semantics", () => {
    expect(pyRound(2.675, 2)).toBe(2.67); // binary double 2.67499...
    expect(pyRound(1.005, 2)).toBe(1.0); // binary double 1.00499...
    expect(pyRound(0.125, 2)).toBe(0.12); // exact tie -> even
    expect(pyRound(0.135, 2)).toBe(0.14); // exact tie -> even (3 odd -> up)
    expect(pyRound(-0.125, 2)).toBe(-0.12);
    expect(pyRound(1.2345, 3)).toBe(1.234);
  });
});
