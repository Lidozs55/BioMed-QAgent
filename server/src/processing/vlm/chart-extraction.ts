/**
 * Chart extraction orchestration (P5-08B, Python
 * ``extract_chart_data_vlm.py`` parity): three-tier degradation
 *
 * ```text
 * L1  Qwen-VL on the image / each embedded PDF page image
 * L2  PDF table extraction (pdfjs)          — PDF sources only
 * L3  caption text from the PDF text layer  — PDF sources only
 * ```
 *
 * All tiers failed → ``ChartExtractionError`` (never an empty success).
 * Outputs: ``parsed/chart_data/chart_data.csv`` + ``chart_data_points.csv``;
 * images are preserved content-addressed under ``source_assets/figures/``;
 * progress hook ``kind="chart_data_extracted"`` at stage ``processing``.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";

import { PublicHttpClient } from "../../external/network/http-client.js";
import { resolveTaskLocalFile, toTaskRelative } from "../paths.js";
import { extractTablesRaw, type RawTable } from "../pdf/tables.js";
import { extractTextForMetadata } from "../pdf/metadata.js";
import {
  ChartExtractionError,
  normalizeChartJson,
  parseVlmJson,
  VLM_PROMPT,
  type ChartPointRow,
  type ChartRow,
} from "./chart-json.js";
import { writeChartCsvs } from "./chart-csv.js";
import { createVlmClient, DEFAULT_DASHSCOPE_BASE_URL, VL_MODEL_NAME, type VlmClient, type VlmConfig } from "./vlm-client.js";
import { extractPdfImages, MAX_PDF_IMAGES_PER_FILE } from "./pdf-images.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const PDF_EXTENSION = ".pdf";

export type VlmQueryStatus = "success" | "not_found" | "failed" | "skipped" | "page_fallback";

export interface VlmToolHooks {
  onQuery?: (query: string, source: string, status: VlmQueryStatus, recordsCount?: number) => void;
  onProgress?: (stage: string, kind: string, payload: Record<string, unknown>) => void;
  onWarning?: (severity: string, message: string, source: string) => void;
}

export interface VlmToolsConfig {
  /** VLM credentials/model; missing fields fall back to env / defaults. */
  vlmConfig?: Partial<VlmConfig>;
  /** Injectable HTTP client (fixture tests use a local-executor instance). */
  httpClient?: PublicHttpClient;
  /** Task-absolute work root. */
  taskRoot: string;
  hooks?: VlmToolHooks;
}

export interface VlmChartMeta {
  source_asset_id: string;
  sha256: string;
  tier: string;
  was_copied?: boolean;
  captions?: string[];
}

export interface VlmChartSummary {
  chart_id: string;
  chart_type: string;
  data_point_count: number;
  source_asset_id: string;
}

export interface VlmResultOk {
  status: "ok";
  source_file: string;
  source_path: string;
  outputs: string[];
  charts: VlmChartSummary[];
  total_charts: number;
  total_data_points: number;
  metas: VlmChartMeta[];
  degradation?: string[];
}

export interface VlmResultError {
  status: "error";
  error: string;
  source_file: string;
}

export type VlmResult = VlmResultOk | VlmResultError;

export interface VlmTools {
  config: VlmConfig;
  extractChartDataVlm(sourcePath: string, hint?: string, signal?: AbortSignal): Promise<VlmResult>;
}

/** Resolve VLM config: injected values > env fallbacks > defaults. */
export function resolveVlmConfig(partial: Partial<VlmConfig> = {}, env: NodeJS.ProcessEnv = process.env): VlmConfig {
  return {
    apiKey: partial.apiKey ?? env.DASHSCOPE_API_KEY ?? "",
    baseUrl: partial.baseUrl ?? env.DASHSCOPE_BASE_URL ?? DEFAULT_DASHSCOPE_BASE_URL,
    model: partial.model ?? VL_MODEL_NAME,
  };
}

/** Streaming sha256 of a file (64 lowercase hex chars). */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest("hex");
}

/** ``source_assets/figures/`` inside the task root (created on demand). */
async function figuresDir(taskRoot: string): Promise<string> {
  const dir = path.join(taskRoot, "source_assets", "figures");
  await mkdir(dir, { recursive: true });
  return dir;
}

async function chartDataDir(taskRoot: string): Promise<string> {
  const dir = path.join(taskRoot, "parsed", "chart_data");
  await mkdir(dir, { recursive: true });
  return dir;
}

export interface EnsureFigureResult {
  figuresPath: string;
  sha: string;
  wasCopied: boolean;
}

/**
 * Ensure an image is under ``source_assets/figures/`` (Python
 * ``_ensure_image_in_figures``): content-addressed ``fig_<sha12><ext>``,
 * no re-copy when already inside figures/ or when the same sha exists.
 */
export async function ensureImageInFigures(sourcePath: string, taskRoot: string): Promise<EnsureFigureResult> {
  const sha = await sha256File(sourcePath);
  const extension = path.extname(sourcePath).toLowerCase();
  const destName = `fig_${sha.slice(0, 12)}${extension}`;
  const figuresRoot = path.resolve(await figuresDir(taskRoot));
  const sourceResolved = path.resolve(sourcePath);
  if (path.dirname(sourceResolved) === figuresRoot) {
    return { figuresPath: sourceResolved, sha, wasCopied: false };
  }
  const destPath = path.join(figuresRoot, destName);
  let wasCopied = false;
  try {
    await stat(destPath);
  } catch {
    await copyFile(sourceResolved, destPath);
    wasCopied = true;
  }
  return { figuresPath: destPath, sha, wasCopied };
}

const CAPTION_RE = /(Fig(?:ure)?|Table)\s*\d+[:.]\s*([^\n]{1,500})/gi;

/** L3: extract figure/table captions from a PDF's text layer. */
async function extractCaptionsPdf(pdfPath: string): Promise<string[]> {
  let text: string;
  try {
    text = (await extractTextForMetadata(pdfPath)).text;
  } catch {
    return [];
  }
  const captions: string[] = [];
  for (const match of text.matchAll(CAPTION_RE)) {
    captions.push(match[0].trim());
  }
  return captions;
}

interface PdfSourceContext {
  pdfSha: string;
  sourceAssetId: string;
  downloadTmp: string;
}

/**
 * L1 for PDFs: extract embedded images into ``download_tmp`` and run VLM on
 * each; failures are per-image warnings (Python parity). Returns rows/meta.
 */
async function extractFromPdfL1(
  pdfPath: string,
  context: PdfSourceContext,
  sourceLabel: string,
  vlm: VlmClient,
  prompt: string,
  taskRoot: string,
  hooks: VlmToolHooks,
  signal?: AbortSignal,
): Promise<{ chartRows: ChartRow[]; pointRows: ChartPointRow[]; metas: VlmChartMeta[]; l1Failed: boolean }> {
  const chartRows: ChartRow[] = [];
  const pointRows: ChartPointRow[] = [];
  const metas: VlmChartMeta[] = [];
  let l1Failed = false;

  let images: Awaited<ReturnType<typeof extractPdfImages>>;
  try {
    images = await extractPdfImages(pdfPath, context.downloadTmp);
  } catch (error) {
    console.warn(`L1 PDF image extraction failed for ${pdfPath}: ${error instanceof Error ? error.message : String(error)}`);
    images = { images: [], skippedExtra: 0 };
    l1Failed = true;
  }

  for (const image of images.images) {
    try {
      const ensured = await ensureImageInFigures(image.path, taskRoot);
      const pageImageId = `asset_${ensured.sha}`;
      const rawResponse = await vlm.call(ensured.figuresPath, prompt, signal);
      const chartJson = parseVlmJson(rawResponse, `${sourceLabel} (page image ${image.pageIndex})`);
      const { chartRow, pointRows: points } = normalizeChartJson(
        chartJson,
        pageImageId,
        image.pageIndex,
        `${sourceLabel} (page image ${image.pageIndex})`,
        VL_MODEL_NAME,
        { pageNumber: String(image.pageIndex), bbox: image.bbox, extractionTier: "L1_vlm" },
      );
      // Override source_asset_id to the PDF-level id (Python parity).
      chartRow.source_asset_id = context.sourceAssetId;
      chartRows.push(chartRow);
      pointRows.push(...points);
      metas.push({
        source_asset_id: context.sourceAssetId,
        sha256: ensured.sha,
        tier: "L1_vlm",
        was_copied: ensured.wasCopied,
      });
    } catch (error) {
      console.warn(`L1 VLM failed for ${pdfPath} image ${image.pageIndex}: ${error instanceof Error ? error.message : String(error)}`);
      hooks.onWarning?.(
        "warning",
        `L1 VLM failed for ${path.basename(pdfPath)} image ${image.pageIndex}: ${error instanceof Error ? error.message : String(error)}`,
        "extract_chart_data_vlm",
      );
    }
  }
  return { chartRows, pointRows, metas, l1Failed };
}

/** L2: PDF tables as chart_type="table" rows (Python ``_try_pdfplumber_tables``). */
async function tryPdfTables(
  pdfPath: string,
  sourceAssetId: string,
  sourceLabel: string,
): Promise<{ chartRows: ChartRow[]; pointRows: ChartPointRow[] } | null> {
  let extraction: { tables: RawTable[] };
  try {
    extraction = await extractTablesRaw(pdfPath);
  } catch {
    return null;
  }
  if (extraction.tables.length === 0) return null;

  const chartRows: ChartRow[] = [];
  const pointRows: ChartPointRow[] = [];
  for (const [tableIndex, table] of extraction.tables.entries()) {
    const page = table.page ?? 1;
    if (table.rows.length < 1) continue;
    const header = table.header;
    const dataRows = table.rows;
    const chartId = `chart_${sourceAssetId.slice(0, 20)}_tbl_p${page}_${tableIndex + 1}`;
    chartRows.push({
      chart_id: chartId,
      source_asset_id: sourceAssetId,
      chart_type: "table",
      title: `PDF table p${page} #${tableIndex + 1}`,
      x_label: "column",
      x_unit: "",
      x_scale: "linear",
      y_label: "value",
      y_unit: "",
      y_scale: "linear",
      data_point_count: dataRows.reduce((sum, row) => sum + row.length, 0),
      legend: header.join("|"),
      extracted_at: new Date().toISOString(),
      model_name: "pdfjs-dist",
      source_label: sourceLabel,
      page_number: String(page),
      bbox: "",
      extraction_tier: "L2_tables",
    });
    dataRows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        pointRows.push({
          point_id: `${chartId}_r${rowIndex + 1}_c${columnIndex + 1}`,
          chart_id: chartId,
          x_value: String(columnIndex + 1),
          y_value: cell || "",
          series_label: `row_${rowIndex + 1}`,
          confidence: "",
        });
      });
    });
  }
  return chartRows.length > 0 ? { chartRows, pointRows } : null;
}

/** L3: captions as a single ``chart_unextracted`` pseudo-chart. */
function captionRows(
  pdfSha: string,
  sourceAssetId: string,
  sourceLabel: string,
  pdfName: string,
  captions: string[],
): { chartRows: ChartRow[]; pointRows: ChartPointRow[]; metas: VlmChartMeta[] } {
  const chartId = `chart_${pdfSha.slice(0, 20)}_captions`;
  const chartRow: ChartRow = {
    chart_id: chartId,
    source_asset_id: sourceAssetId,
    chart_type: "caption_only",
    title: `Captions extracted from ${pdfName}`,
    x_label: "",
    x_unit: "",
    x_scale: "linear",
    y_label: "",
    y_unit: "",
    y_scale: "linear",
    data_point_count: captions.length,
    legend: "",
    extracted_at: new Date().toISOString(),
    model_name: "pdfjs-dist_captions",
    source_label: sourceLabel,
    page_number: "",
    bbox: "",
    extraction_tier: "L3_captions",
  };
  const pointRows: ChartPointRow[] = captions.map((caption, index) => ({
    point_id: `${chartId}_c${index + 1}`,
    chart_id: chartId,
    x_value: String(index + 1),
    y_value: caption,
    series_label: "caption",
    confidence: "",
  }));
  return {
    chartRows: [chartRow],
    pointRows,
    metas: [{ source_asset_id: sourceAssetId, sha256: pdfSha, tier: "L3_captions", captions }],
  };
}

/** L1 for plain image sources (Python ``_extract_from_image``). */
async function extractFromImage(
  imagePath: string,
  sourceLabel: string,
  chartIdxOffset: number,
  vlm: VlmClient,
  prompt: string,
  taskRoot: string,
  signal?: AbortSignal,
): Promise<{ chartRows: ChartRow[]; pointRows: ChartPointRow[]; meta: VlmChartMeta }> {
  const ensured = await ensureImageInFigures(imagePath, taskRoot);
  const sourceAssetId = `asset_${ensured.sha}`;
  const rawResponse = await vlm.call(ensured.figuresPath, prompt, signal);
  const chartJson = parseVlmJson(rawResponse, sourceLabel);
  const { chartRow, pointRows } = normalizeChartJson(
    chartJson,
    sourceAssetId,
    chartIdxOffset,
    sourceLabel,
    VL_MODEL_NAME,
  );
  return {
    chartRows: [chartRow],
    pointRows,
    meta: {
      source_asset_id: sourceAssetId,
      sha256: ensured.sha,
      tier: "L1_vlm",
      was_copied: ensured.wasCopied,
    },
  };
}

/**
 * Build the chart-extraction tools factory. All config is injected — the
 * tool layer stays free of env reads and of Pi imports.
 */
export function createVlmTools(options: {
  taskRoot: string;
  hooks?: VlmToolHooks;
  vlmConfig?: Partial<VlmConfig>;
  httpClient?: PublicHttpClient;
}): VlmTools {
  const { taskRoot } = options;
  const hooks = options.hooks ?? {};
  const config = resolveVlmConfig(options.vlmConfig);
  // A default client performs public-URL policy + DNS pinning; tests inject
  // a PublicHttpClient bound to a fixture server.
  const client = options.httpClient ?? new PublicHttpClient();
  const vlm = createVlmClient(config, client);

  return {
    config,
    extractChartDataVlm: async (sourcePath, hint = "", signal) => {
      let resolved: string;
      try {
        resolved = await resolveTaskLocalFile(sourcePath, taskRoot);
      } catch (error) {
        const isMissing = error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT";
        return {
          status: "error",
          error: isMissing
            ? `source file not found: ${sourcePath}`
            : error instanceof Error
              ? error.message
              : String(error),
          source_file: path.basename(sourcePath),
        };
      }

      const extension = path.extname(resolved).toLowerCase();
      const sourceLabel = path.basename(resolved);
      const prompt = hint.trim() !== "" ? `${VLM_PROMPT}\n\nAdditional hint: ${hint.trim()}` : VLM_PROMPT;

      const chartRows: ChartRow[] = [];
      const pointRows: ChartPointRow[] = [];
      const metas: VlmChartMeta[] = [];

      try {
        if (IMAGE_EXTENSIONS.has(extension)) {
          const result = await extractFromImage(resolved, sourceLabel, 1, vlm, prompt, taskRoot, signal);
          chartRows.push(...result.chartRows);
          pointRows.push(...result.pointRows);
          metas.push(result.meta);
        } else if (extension === PDF_EXTENSION) {
          const pdfSha = await sha256File(resolved);
          const context: PdfSourceContext = {
            pdfSha,
            sourceAssetId: `asset_${pdfSha}`,
            downloadTmp: path.join(taskRoot, "download_tmp"),
          };
          const l1 = await extractFromPdfL1(resolved, context, sourceLabel, vlm, prompt, taskRoot, hooks, signal);
          chartRows.push(...l1.chartRows);
          pointRows.push(...l1.pointRows);
          metas.push(...l1.metas);

          if (chartRows.length === 0) {
            const l2 = await tryPdfTables(resolved, context.sourceAssetId, sourceLabel);
            if (l2 !== null) {
              hooks.onWarning?.(
                "info",
                `L1 VLM produced no charts for ${sourceLabel}; L2 pdfjs recovered ${l2.chartRows.length} table(s)`,
                "extract_chart_data_vlm",
              );
              chartRows.push(...l2.chartRows);
              pointRows.push(...l2.pointRows);
              metas.push({ source_asset_id: context.sourceAssetId, sha256: pdfSha, tier: "L2_pdfjs_tables" });
            } else {
              const captions = await extractCaptionsPdf(resolved);
              if (captions.length > 0) {
                hooks.onWarning?.(
                  "warning",
                  `L1+L2 failed for ${sourceLabel}; L3 recovered ${captions.length} caption(s): ${captions.slice(0, 3).join(" | ")}`,
                  "extract_chart_data_vlm",
                );
                const l3 = captionRows(pdfSha, context.sourceAssetId, sourceLabel, sourceLabel, captions);
                chartRows.push(...l3.chartRows);
                pointRows.push(...l3.pointRows);
                metas.push(...l3.metas);
              } else if (l1.l1Failed) {
                throw new ChartExtractionError(
                  `All chart extraction tiers failed for ${resolved} ` +
                    "(L1 image extraction error, L2 no tables, L3 no captions)",
                );
              } else {
                throw new ChartExtractionError(
                  `All chart extraction tiers failed for ${resolved} ` +
                    "(L1 no images extracted or all VLM calls failed, L2 no tables, L3 no captions)",
                );
              }
            }
          }
        } else {
          return {
            status: "error",
            error: `unsupported file type: ${extension} (supported: ${[...IMAGE_EXTENSIONS, PDF_EXTENSION].sort()})`,
            source_file: sourceLabel,
          };
        }
      } catch (error) {
        if (error instanceof ChartExtractionError) {
          hooks.onQuery?.(resolved, "extract_chart_data_vlm", "failed", 0);
          hooks.onWarning?.("error", `chart extraction failed for ${sourceLabel}: ${error.message}`, "extract_chart_data_vlm");
          return { status: "error", error: error.message, source_file: sourceLabel };
        }
        console.error(`unexpected error extracting chart data from ${resolved}`, error);
        hooks.onQuery?.(resolved, "extract_chart_data_vlm", "failed", 0);
        return {
          status: "error",
          error: `unexpected error: ${error instanceof Error ? error.message : String(error)}`,
          source_file: sourceLabel,
        };
      }

      // Persist CSV artifacts (integrity + admission gates inside).
      const chartData = await chartDataDir(taskRoot);
      try {
        await writeChartCsvs(chartData, chartRows, pointRows);
      } catch (error) {
        if (error instanceof Error && error.name === "ValueError") {
          hooks.onQuery?.(resolved, "extract_chart_data_vlm", "failed", 0);
          hooks.onWarning?.("error", `chart_data integrity check failed for ${sourceLabel}: ${error.message}`, "extract_chart_data_vlm");
          return { status: "error", error: error.message, source_file: sourceLabel };
        }
        throw error;
      }

      hooks.onQuery?.(resolved, "extract_chart_data_vlm", "success", chartRows.length);
      const tiersUsed = metas.map((meta) => meta.tier);
      hooks.onProgress?.("processing", "chart_data_extracted", {
        source: "extract_chart_data_vlm",
        source_file: sourceLabel,
        charts: chartRows.length,
        data_points: pointRows.length,
        tiers_used: tiersUsed,
      });

      const charts: VlmChartSummary[] = chartRows.map((row) => ({
        chart_id: row.chart_id,
        chart_type: row.chart_type,
        data_point_count: row.data_point_count,
        source_asset_id: row.source_asset_id,
      }));

      const result: VlmResultOk = {
        status: "ok",
        source_file: sourceLabel,
        source_path: resolved,
        outputs: [
          toTaskRelative(path.join(chartData, "chart_data.csv"), taskRoot),
          toTaskRelative(path.join(chartData, "chart_data_points.csv"), taskRoot),
        ],
        charts,
        total_charts: chartRows.length,
        total_data_points: pointRows.length,
        metas: metas.map((meta) => ({
          source_asset_id: meta.source_asset_id,
          sha256: meta.sha256,
          tier: meta.tier,
          was_copied: meta.was_copied ?? false,
        })),
      };
      if (tiersUsed.some((tier) => tier !== "L1_vlm")) {
        result.degradation = tiersUsed;
      }
      return result;
    },
  };
}

export { MAX_PDF_IMAGES_PER_FILE };
