/**
 * Analysis tools: run_differential_expression, generate_heatmap,
 * basic_statistics, generate_correlation_matrix (P5-09).
 *
 * TypeScript port of backend/app/skills/builtin/analysis/stats.py with
 * scipy/pandas numeric parity (see server/src/analysis/). Two deliberate
 * deviations, both frozen by P5-D5:
 *
 *   1. Output paths — the Python tool wrote directly to task/artifacts/;
 *      the TS tool writes ONLY under
 *      ``<taskRoot>/staging/analysis/<runId or "default">/`` and returns
 *      taskRoot-relative paths (application artifact promotion owns the
 *      artifacts namespace). Never writes to artifacts/.
 *   2. CSV paths — resolved with the task-local policy
 *      (``resolveTaskLocalFile``: relative to taskRoot or absolute inside
 *      taskRoot only, escapes rejected before any I/O) instead of the
 *      Python tool's unrestricted ``Path(...).resolve()``.
 *
 * Error JSON shapes (status/key names/zeroed fields) mirror the Python
 * tools exactly, including ``source_file`` echoing the raw argument on
 * failure.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BioMedAgentTool } from "../contracts.js";
import {
  bhAdjust,
  correlationMatrix,
  describeColumn,
  leavesOrder,
  linkageAverage,
  parseCsv,
  pyFloatStr,
  pyRound,
  renderCorrelation,
  renderHeatmap,
  renderVolcano,
  safeFloat,
  welchTTest,
  type ColumnStats,
  type CorrelationMethod,
  type VolcanoPoint,
} from "../../analysis/index.js";
import { resolveTaskLocalFile, toTaskRelative } from "../../processing/paths.js";
import { noopHooks, type ToolHooks, type ToolServiceDeps } from "./tool-hooks.js";

export const RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME = "run_differential_expression";
export const GENERATE_HEATMAP_TOOL_NAME = "generate_heatmap";
export const BASIC_STATISTICS_TOOL_NAME = "basic_statistics";
export const GENERATE_CORRELATION_MATRIX_TOOL_NAME = "generate_correlation_matrix";

export interface AnalysisToolDeps extends ToolServiceDeps {
  /** Staging namespace: outputs go to <taskRoot>/staging/analysis/<runId>. */
  runId?: string;
}

// ---------------------------------------------------------------------------
// Shared helpers (Python tool parity)
// ---------------------------------------------------------------------------

/** Python list repr used in the tool error messages: ['a', 'b']. */
function pyListRepr(items: readonly string[]): string {
  return `[${items.map((item) => `'${item}'`).join(", ")}]`;
}

/**
 * Python iteration semantics for the group-column arguments: a list is used
 * as-is, a string is iterated character-by-character, anything else raises
 * TypeError (which the Python tool catches into the error JSON).
 */
function toPythonIterable(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return Array.from(value);
  throw new TypeError(`'${typeof value}' object is not iterable`);
}

/** pandas NA-value test (case-sensitive exact match, pandas defaults). */
const NA_VALUES: ReadonlySet<string> = new Set([
  "", "#N/A", "#N/A N/A", "#NA", "-1.#IND", "-1.#QNAN", "-NaN", "-nan",
  "1.#IND", "1.#QNAN", "<NA>", "N/A", "NA", "NULL", "NaN", "None", "n/a",
  "nan", "null",
]);

/** Population standard deviation ddof=0 (the np.std guard in the tool). */
function populationStd(values: readonly number[], sampleMean: number): number {
  let sum = 0;
  for (const value of values) {
    const d = value - sampleMean;
    sum += d * d;
  }
  return Math.sqrt(sum / values.length);
}

function geneAutodetect(headers: readonly string[], numericColumns: readonly boolean[], geneCol: string): string {
  if (geneCol !== "" && headers.includes(geneCol)) return geneCol;
  const candidates = ["gene_symbol", "Gene", "Symbol", "gene", "ID"];
  for (const candidate of candidates) {
    if (headers.includes(candidate)) return candidate;
  }
  // First non-numeric (object dtype) column.
  for (let c = 0; c < headers.length; c += 1) {
    if (!numericColumns[c]) return headers[c];
  }
  throw new Error(
    "Cannot identify gene identifier column. Please specify with gene_col= parameter.",
  );
}

function numericColumnSelection(
  headers: readonly string[],
  numericColumns: readonly boolean[],
  columns: readonly string[] | null,
  geneCol: string | null,
): string[] {
  if (columns === null) {
    return headers.filter((_, c) => numericColumns[c] && headers[c] !== geneCol);
  }
  const missing = columns.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    throw new Error(`columns not found in CSV: ${pyListRepr(missing)}`);
  }
  return [...columns];
}

function numericColumnSelectionAll(
  headers: readonly string[],
  numericColumns: readonly boolean[],
  columns: readonly string[] | null,
): string[] {
  if (columns === null) {
    return headers.filter((_, c) => numericColumns[c]);
  }
  const missing = columns.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    throw new Error(`columns not found in CSV: ${pyListRepr(missing)}`);
  }
  return columns.filter((c) => numericColumns[headers.indexOf(c)]);
}

/** CSV read + minimum viability validation (Python _validate_csv parity). */
function validateCsv(text: string, sourceLabel: string, byteLength: number) {
  if (byteLength === 0) {
    throw new Error(`file is empty: ${sourceLabel}`);
  }
  const table = parseCsv(text);
  if (table.rows.length === 0) {
    throw new Error(`CSV has no rows: ${sourceLabel}`);
  }
  if (table.headers.length === 0) {
    throw new Error(`CSV has no columns: ${sourceLabel}`);
  }
  return table;
}

function jsonContent(value: unknown): { content: string } {
  return { content: JSON.stringify(value, null, 2) };
}

interface FileWrites {
  paths: string[];
  /** Absolute paths written. */
  absolute: string[];
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAnalysisTools(deps: AnalysisToolDeps): BioMedAgentTool[] {
  const hooks = noopHooks(deps.hooks);
  const { taskRoot } = deps;
  const runKey = deps.runId ?? "default";
  const stagingDir = () => path.join(taskRoot, "staging", "analysis", runKey);
  const relative = (absolute: string): string => toTaskRelative(absolute, taskRoot);

  async function writeStaging(files: Readonly<Record<string, string | Buffer>>): Promise<FileWrites> {
    const dir = stagingDir();
    await mkdir(dir, { recursive: true });
    const paths: string[] = [];
    const absolute: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const dest = path.join(dir, name);
      await writeFile(dest, content);
      paths.push(relative(dest));
      absolute.push(dest);
    }
    return { paths, absolute };
  }

  /** Read + validate the task-local CSV (P5-D5 confinement policy). */
  async function readCsv(csvPath: string): Promise<{
    table: ReturnType<typeof parseCsv>;
    absolute: string;
    rawText: string;
  }> {
    const absolute = await resolveTaskLocalFile(csvPath, taskRoot);
    const buffer = await readFile(absolute);
    const rawText = buffer.toString("utf8");
    return {
      table: validateCsv(rawText, absolute, buffer.length),
      absolute,
      rawText,
    };
  }

  // -------------------------------------------------------------------------
  // run_differential_expression
  // -------------------------------------------------------------------------

  const runDifferentialExpressionTool: BioMedAgentTool = {
    name: RUN_DIFFERENTIAL_EXPRESSION_TOOL_NAME,
    label: "Differential expression analysis",
    description:
      "Run differential expression analysis between two sample groups of a " +
      "gene expression CSV (rows=genes, columns=samples). Computes log2 " +
      "fold-change and p-values via a two-sided Welch t-test, applies " +
      "Benjamini-Hochberg FDR correction over ALL tested genes, and renders " +
      "a volcano plot PNG. Outputs are written under staging/analysis/.",
    parameters: {
      type: "object",
      properties: {
        csv_path: { type: "string", description: "Path to the CSV file under the task work directory." },
        group_a_cols: { type: "array", items: { type: "string" }, description: "Column names of group A (e.g. control)." },
        group_b_cols: { type: "array", items: { type: "string" }, description: "Column names of group B (e.g. treatment)." },
        gene_col: { type: "string", description: "Gene identifier column; auto-detected when empty." },
        pval_threshold: { type: "number", description: "P-value cutoff for significance (default 0.05)." },
        log2fc_threshold: { type: "number", description: "Absolute log2 fold-change cutoff (default 1.0)." },
        top_n: { type: "integer", description: "Number of top DEGs to return (default 100)." },
      },
      required: ["csv_path", "group_a_cols", "group_b_cols"],
      additionalProperties: false,
    },
    execute: async (argumentsValue) => {
      const record = argumentsValue as Record<string, unknown>;
      const csvPath = typeof record.csv_path === "string" ? record.csv_path : null;
      const errorResult = (error: string) =>
        jsonContent({
          status: "error",
          source_file: csvPath,
          row_count: 0,
          group_a_count: 0,
          group_b_count: 0,
          significant_up: 0,
          significant_down: 0,
          degs: [],
          volcano_plot: "",
          outputs: [],
          error,
        });
      try {
        if (csvPath === null) {
          throw new TypeError("csv_path must be a string");
        }
        const groupACols = toPythonIterable(record.group_a_cols);
        const groupBCols = toPythonIterable(record.group_b_cols);
        const geneCol = typeof record.gene_col === "string" ? record.gene_col : "";
        const pvalThreshold = typeof record.pval_threshold === "number" ? record.pval_threshold : Number(record.pval_threshold ?? 0.05);
        const log2fcThreshold = typeof record.log2fc_threshold === "number" ? record.log2fc_threshold : Number(record.log2fc_threshold ?? 1.0);
        const topN = typeof record.top_n === "number" ? Math.trunc(record.top_n) : Math.trunc(Number(record.top_n ?? 100));

        const { table, absolute } = await readCsv(csvPath);
        const resolvedGene = geneAutodetect(table.headers, table.numericColumns, geneCol);

        const missingA = groupACols.filter((c) => !table.headers.includes(c));
        const missingB = groupBCols.filter((c) => !table.headers.includes(c));
        if (missingA.length > 0) {
          throw new Error(`group A columns not found: ${pyListRepr(missingA)}`);
        }
        if (missingB.length > 0) {
          throw new Error(`group B columns not found: ${pyListRepr(missingB)}`);
        }
        if (groupACols.length < 1 || groupBCols.length < 1) {
          throw new Error("both groups must have at least one column");
        }

        const aIdx = groupACols.map((c) => table.headers.indexOf(c));
        const bIdx = groupBCols.map((c) => table.headers.indexOf(c));
        const geneIdx = table.headers.indexOf(resolvedGene);

        const genes: string[] = [];
        const log2fcList: number[] = [];
        const pvalList: number[] = [];
        for (let row = 0; row < table.rows.length; row += 1) {
          const aValues = aIdx
            .map((c) => table.values[row][c])
            .filter((v) => Number.isFinite(v));
          const bValues = bIdx
            .map((c) => table.values[row][c])
            .filter((v) => Number.isFinite(v));
          const meanA = aValues.length > 0 ? aValues.reduce((s, v) => s + v, 0) / aValues.length : 0;
          const meanB = bValues.length > 0 ? bValues.reduce((s, v) => s + v, 0) / bValues.length : 0;
          const pseudo = 1.0;
          const log2fc =
            Math.log2(Math.max(meanB + pseudo, 1e-9)) -
            Math.log2(Math.max(meanA + pseudo, 1e-9));
          log2fcList.push(log2fc);
          if (
            aValues.length >= 2 && bValues.length >= 2 &&
            populationStd(aValues, meanA) > 0 && populationStd(bValues, meanB) > 0
          ) {
            pvalList.push(welchTTest(aValues, bValues).p);
          } else {
            pvalList.push(1.0);
          }
          genes.push(String(table.rows[row][geneIdx]));
        }

        const sigUp = log2fcList.filter(
          (fc, i) => pvalList[i] <= pvalThreshold && fc >= log2fcThreshold,
        ).length;
        const sigDown = log2fcList.filter(
          (fc, i) => pvalList[i] <= pvalThreshold && fc <= -log2fcThreshold,
        ).length;

        // BH over the FULL p-value set before any top-N truncation.
        const padjList = bhAdjust(pvalList);

        const degRecords = genes.map((gene, i) => ({
          gene,
          index: i,
          log2FC: pyRound(log2fcList[i], 4),
          pvalue: pyRound(pvalList[i], 6),
          padj: pyRound(padjList[i], 6),
          neg_log10_pval: pyRound(-Math.log10(Math.max(pvalList[i], 1e-300)), 4),
          significant: pvalList[i] <= pvalThreshold && Math.abs(log2fcList[i]) >= log2fcThreshold,
        }));
        const topRecords = [...degRecords]
          .sort((a, b) => a.pvalue - b.pvalue)
          .slice(0, topN);
        const degs = topRecords.map((deg) => ({
          gene: deg.gene,
          log2FC: deg.log2FC,
          pvalue: deg.pvalue,
          padj: deg.padj,
          neg_log10_pval: deg.neg_log10_pval,
          significant: deg.significant,
        }));

        // Volcano plot (top_n gene labels).
        const points: VolcanoPoint[] = genes.map((gene, i) => ({
          x: log2fcList[i],
          y: -Math.log10(Math.max(pvalList[i], 1e-300)),
          gene,
          category:
            pvalList[i] <= pvalThreshold && log2fcList[i] >= log2fcThreshold
              ? "up"
              : pvalList[i] <= pvalThreshold && log2fcList[i] <= -log2fcThreshold
                ? "down"
                : "ns",
        }));
        const degLabels = topRecords.map((deg) => ({
          x: log2fcList[deg.index],
          y: -Math.log10(Math.max(pvalList[deg.index], 1e-300)),
          text: deg.gene,
        }));
        const volcanoPng = renderVolcano({
          points,
          pvalThreshold,
          log2fcThreshold,
          significantUp: sigUp,
          significantDown: sigDown,
          labels: degLabels,
        });

        const result = {
          status: "ok",
          source_file: absolute,
          gene_column: resolvedGene,
          row_count: table.rows.length,
          group_a_count: groupACols.length,
          group_b_count: groupBCols.length,
          significant_up: sigUp,
          significant_down: sigDown,
          pval_threshold: pvalThreshold,
          log2fc_threshold: log2fcThreshold,
          degs,
          volcano_plot: "",
          outputs: [] as string[],
        };
        const writes = await writeStaging({
          "volcano_plot.png": volcanoPng,
          "differential_expression.json": Buffer.from(JSON.stringify(result, null, 2), "utf8"),
        });
        result.volcano_plot = writes.paths[0];
        result.outputs = writes.paths;
        hooks.onQuery?.(csvPath, "analysis", "success", degs.length);
        return jsonContent(result);
      } catch (error) {
        hooks.onQuery?.(csvPath ?? String(record.csv_path ?? ""), "analysis", "failed", 0);
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };

  // -------------------------------------------------------------------------
  // generate_heatmap
  // -------------------------------------------------------------------------

  const generateHeatmapTool: BioMedAgentTool = {
    name: GENERATE_HEATMAP_TOOL_NAME,
    label: "Clustered heatmap",
    description:
      "Generate a clustered heatmap from a tabular gene expression CSV. " +
      "Selects numeric columns (all when columns is empty), optionally applies " +
      "z-score normalization per row, clusters rows/columns (UPGMA average " +
      "linkage, Euclidean distance) and renders a PNG. Outputs are written " +
      "under staging/analysis/.",
    parameters: {
      type: "object",
      properties: {
        csv_path: { type: "string", description: "Path to the CSV file under the task work directory." },
        columns: { type: "array", items: { type: "string" }, description: "Sample columns to include (empty = all numeric)." },
        gene_col: { type: "string", description: "Gene identifier column; auto-detected when empty." },
        max_genes: { type: "integer", description: "Cap on displayed rows, top-variable selection (default 50)." },
        zscore: { type: "boolean", description: "Z-score normalization per row (default true)." },
        cluster_rows: { type: "boolean", description: "Cluster rows (default true)." },
        cluster_cols: { type: "boolean", description: "Cluster columns (default true)." },
        cmap: { type: "string", description: "Colormap name (default 'RdBu_r')." },
      },
      required: ["csv_path"],
      additionalProperties: false,
    },
    execute: async (argumentsValue) => {
      const record = argumentsValue as Record<string, unknown>;
      const csvPath = typeof record.csv_path === "string" ? record.csv_path : null;
      const zscore = record.zscore !== false;
      const errorResult = (error: string) =>
        jsonContent({
          status: "error",
          source_file: csvPath,
          rows_displayed: 0,
          columns_used: [],
          zscore,
          heatmap_png: "",
          outputs: [],
          error,
        });
      try {
        if (csvPath === null) {
          throw new TypeError("csv_path must be a string");
        }
        const columns = record.columns === undefined || record.columns === null
          ? null
          : toPythonIterable(record.columns);
        const geneCol = typeof record.gene_col === "string" ? record.gene_col : "";
        const maxGenes = typeof record.max_genes === "number" ? Math.trunc(record.max_genes) : Math.trunc(Number(record.max_genes ?? 50));
        const clusterRows = record.cluster_rows !== false;
        const clusterCols = record.cluster_cols !== false;
        const cmap = typeof record.cmap === "string" ? record.cmap : "RdBu_r";

        const { table, absolute } = await readCsv(csvPath);
        const resolvedGene = geneAutodetect(table.headers, table.numericColumns, geneCol);
        const numericCols = numericColumnSelection(table.headers, table.numericColumns, columns, resolvedGene);
        if (numericCols.length < 2) {
          throw new Error(`Need at least 2 numeric columns; found ${numericCols.length}`);
        }

        // Subset rows: drop rows where ALL selected values are NaN.
        const colIdx = numericCols.map((c) => table.headers.indexOf(c));
        const geneIdx = table.headers.indexOf(resolvedGene);
        let keptRows: number[] = table.rows
          .map((_, row) => row)
          .filter((row) => colIdx.some((c) => Number.isFinite(table.values[row][c])));
        if (keptRows.length > maxGenes) {
          // Top-variable selection by row std (np.nanstd ddof=0).
          const stds = keptRows.map((row) => {
            const finite = colIdx
              .map((c) => table.values[row][c])
              .filter((v) => Number.isFinite(v));
            if (finite.length === 0) return 0;
            const mean = finite.reduce((s, v) => s + v, 0) / finite.length;
            return populationStd(finite, mean);
          });
          keptRows = keptRows
            .map((row, i) => ({ row, std: stds[i] }))
            .sort((a, b) => b.std - a.std)
            .slice(0, maxGenes)
            .map((entry) => entry.row);
        }

        // Build the matrix.
        let matrix = keptRows.map((row) => colIdx.map((c) => table.values[row][c]));
        const displayGenes = keptRows.map((row) => String(table.rows[row][geneIdx]));
        if (zscore) {
          matrix = matrix.map((values) => {
            const finite = values.filter((v) => Number.isFinite(v));
            if (finite.length === 0) return values.map(() => 0);
            const mean = finite.reduce((s, v) => s + v, 0) / finite.length;
            const std = populationStd(finite, mean);
            return values.map((v) => {
              if (!Number.isFinite(v)) return 0; // np.nan_to_num(nan=0)
              if (std === 0) return 0; // std==0 -> NaN -> 0 (nan_to_num)
              return (v - mean) / std;
            });
          });
        } else if (rowCluster || colCluster) {
          // scipy linkage rejects non-finite condensed distances; the Python
          // tool raises the same way through seaborn when NaN survives and
          // either rows or columns are clustered.
          for (const row of matrix) {
            for (const value of row) {
              if (!Number.isFinite(value)) {
                throw new Error("The condensed distance matrix must contain only finite values.");
              }
            }
          }
        }

        const rowCluster = clusterRows && matrix.length > 1;
        const colCluster = clusterCols && numericCols.length > 1;
        let rowOrder = matrix.map((_, i) => i);
        let colOrder = numericCols.map((_, i) => i);
        if (rowCluster) {
          rowOrder = leavesOrder(linkageAverage(matrix), matrix.length);
        }
        if (colCluster) {
          const transposed = numericCols.map((_, c) => matrix.map((row) => row[c]));
          colOrder = leavesOrder(linkageAverage(transposed), transposed.length);
        }

        const orderedMatrix = rowOrder.map((r) => matrix[r].map((_, c) => matrix[r][colOrder[c]]));
        const rowLabels = rowOrder.map((r) => displayGenes[r]);
        const colLabels = colOrder.map((c) => numericCols[c]);

        let cmapName: "RdBu_r" | "coolwarm" = "RdBu_r";
        if (cmap === "coolwarm") cmapName = "coolwarm";
        const heatmapPng = renderHeatmap({
          matrix: orderedMatrix,
          rowLabels,
          colLabels,
          cmap: cmapName,
          zscore,
        });

        const result = {
          status: "ok",
          source_file: absolute,
          gene_column: resolvedGene,
          rows_displayed: matrix.length,
          total_rows_in_csv: table.rows.length,
          columns_used: numericCols,
          zscore,
          heatmap_png: "",
          outputs: [] as string[],
        };
        const writes = await writeStaging({ "heatmap.png": heatmapPng });
        result.heatmap_png = writes.paths[0];
        result.outputs = writes.paths;
        hooks.onQuery?.(csvPath, "analysis", "success", matrix.length);
        return jsonContent(result);
      } catch (error) {
        hooks.onQuery?.(csvPath ?? String(record.csv_path ?? ""), "analysis", "failed", 0);
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };

  // -------------------------------------------------------------------------
  // basic_statistics
  // -------------------------------------------------------------------------

  const basicStatisticsTool: BioMedAgentTool = {
    name: BASIC_STATISTICS_TOOL_NAME,
    label: "Basic descriptive statistics",
    description:
      "Compute descriptive statistics (count, mean, std, min, quartiles, " +
      "max, missing counts) for numeric CSV columns, mirroring pandas " +
      "describe(), and write a stats report CSV under staging/analysis/.",
    parameters: {
      type: "object",
      properties: {
        csv_path: { type: "string", description: "Path to the CSV file under the task work directory." },
        columns: { type: "array", items: { type: "string" }, description: "Columns to analyze (empty = all numeric)." },
      },
      required: ["csv_path"],
      additionalProperties: false,
    },
    execute: async (argumentsValue) => {
      const record = argumentsValue as Record<string, unknown>;
      const csvPath = typeof record.csv_path === "string" ? record.csv_path : null;
      const errorResult = (error: string) =>
        jsonContent({
          status: "error",
          source_file: csvPath,
          total_rows: 0,
          columns_analyzed: [],
          stats_report: "",
          summary: {},
          outputs: [],
          error,
        });
      try {
        if (csvPath === null) {
          throw new TypeError("csv_path must be a string");
        }
        const columns = record.columns === undefined || record.columns === null
          ? null
          : toPythonIterable(record.columns);
        const { table, absolute } = await readCsv(csvPath);
        const numCols = numericColumnSelectionAll(table.headers, table.numericColumns, columns);
        if (numCols.length === 0) {
          throw new Error("no numeric columns found to analyze");
        }

        const summary: Record<string, ColumnStats> = {};
        const statsRows: ColumnStats[] = [];
        for (const col of numCols) {
          const colIndex = table.headers.indexOf(col);
          const values = table.values.map((row) => row[colIndex]);
          const stats = describeColumn(col, values, table.rows.length);
          statsRows.push(stats);
          summary[col] = stats;
        }

        const reportHeader = "column,count,mean,std,min,q25,median,q75,max,missing,missing_pct";
        const reportRows = statsRows.map((stats) =>
          [
            stats.column,
            stats.count,
            pyFloatStr(stats.mean),
            pyFloatStr(stats.std),
            pyFloatStr(stats.min),
            pyFloatStr(stats.q25),
            pyFloatStr(stats.median),
            pyFloatStr(stats.q75),
            pyFloatStr(stats.max),
            stats.missing,
            pyFloatStr(stats.missing_pct),
          ].join(","),
        );
        const reportCsv = `${reportHeader}\n${reportRows.join("\n")}\n`;

        const result = {
          status: "ok",
          source_file: absolute,
          total_rows: table.rows.length,
          columns_analyzed: numCols,
          stats_report: "",
          summary,
          outputs: [] as string[],
        };
        const writes = await writeStaging({
          "stats_report.csv": Buffer.from(reportCsv, "utf8"),
          "basic_statistics.json": Buffer.from(JSON.stringify(result, null, 2), "utf8"),
        });
        result.stats_report = writes.paths[0];
        result.outputs = writes.paths;
        hooks.onQuery?.(csvPath, "analysis", "success", numCols.length);
        return jsonContent(result);
      } catch (error) {
        hooks.onQuery?.(csvPath ?? String(record.csv_path ?? ""), "analysis", "failed", 0);
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };

  // -------------------------------------------------------------------------
  // generate_correlation_matrix
  // -------------------------------------------------------------------------

  const generateCorrelationMatrixTool: BioMedAgentTool = {
    name: GENERATE_CORRELATION_MATRIX_TOOL_NAME,
    label: "Correlation matrix",
    description:
      "Compute a pairwise correlation matrix (pearson, spearman or kendall, " +
      "pandas DataFrame.corr parity) for numeric CSV columns and render a " +
      "heatmap PNG with annotated values under staging/analysis/.",
    parameters: {
      type: "object",
      properties: {
        csv_path: { type: "string", description: "Path to the CSV file under the task work directory." },
        columns: { type: "array", items: { type: "string" }, description: "Columns to include (empty = all numeric)." },
        method: { type: "string", enum: ["pearson", "spearman", "kendall"], description: "Correlation method (default 'pearson')." },
        cmap: { type: "string", description: "Colormap name (default 'coolwarm')." },
      },
      required: ["csv_path"],
      additionalProperties: false,
    },
    execute: async (argumentsValue) => {
      const record = argumentsValue as Record<string, unknown>;
      const csvPath = typeof record.csv_path === "string" ? record.csv_path : null;
      const method = typeof record.method === "string" ? record.method : "pearson";
      const errorResult = (error: string) =>
        jsonContent({
          status: "error",
          source_file: csvPath,
          method,
          columns_used: [],
          correlation_png: "",
          outputs: [],
          error,
        });
      try {
        if (csvPath === null) {
          throw new TypeError("csv_path must be a string");
        }
        const columns = record.columns === undefined || record.columns === null
          ? null
          : toPythonIterable(record.columns);
        const cmap = typeof record.cmap === "string" ? record.cmap : "coolwarm";
        if (method !== "pearson" && method !== "spearman" && method !== "kendall") {
          throw new Error(
            `method must be either 'pearson', 'spearman', 'kendall', or a callable, '${method}' was supplied`,
          );
        }
        const { table, absolute } = await readCsv(csvPath);
        const numCols = numericColumnSelectionAll(table.headers, table.numericColumns, columns);
        if (numCols.length < 2) {
          throw new Error(
            `Need at least 2 numeric columns for correlation; found ${numCols.length}`,
          );
        }

        const colData = numCols.map((col) =>
          table.values.map((row) => row[table.headers.indexOf(col)]),
        );
        const corr = correlationMatrix(colData, method as CorrelationMethod);

        // correlation.csv: matrix with header (TS addition; Python only plotted).
        const csvLines = [
          numCols.join(","),
          ...corr.map((row) => row.map((v) => pyFloatStr(Number.isFinite(v) ? v : null)).join(",")),
        ];
        const corrCsv = `${csvLines.join("\n")}\n`;

        const corrPng = renderCorrelation({
          values: corr,
          labels: numCols,
          method,
          cmap: cmap === "RdBu_r" ? "RdBu_r" : "coolwarm",
        });

        const result = {
          status: "ok",
          source_file: absolute,
          method,
          columns_used: numCols,
          correlation_png: "",
          outputs: [] as string[],
        };
        const writes = await writeStaging({
          "correlation.png": corrPng,
          "correlation.csv": Buffer.from(corrCsv, "utf8"),
        });
        result.correlation_png = writes.paths[0];
        result.outputs = writes.paths;
        hooks.onQuery?.(csvPath, "analysis", "success", numCols.length);
        return jsonContent(result);
      } catch (error) {
        hooks.onQuery?.(csvPath ?? String(record.csv_path ?? ""), "analysis", "failed", 0);
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };

  return [
    runDifferentialExpressionTool,
    generateHeatmapTool,
    basicStatisticsTool,
    generateCorrelationMatrixTool,
  ];
}

