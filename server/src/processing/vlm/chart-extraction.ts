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
import type { DatasetHILGate } from "../../dataset/review/hil-policy.js";
import type { JsonValue } from "@biomed/contracts";
import { evaluateConfidence } from "../../dataset/confidence/evaluator.js";
import {
  CONFIDENCE_ARTIFACT_FILE,
  writeConfidenceArtifact,
} from "../../dataset/confidence/artifact.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const PDF_EXTENSION = ".pdf";

export type VlmQueryStatus = "success" | "not_found" | "failed" | "skipped" | "page_fallback";

export interface VlmToolHooks {
  onQueryStarted?: (query: string, source: string) => void;
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
  hilGate?: DatasetHILGate | null;
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

function correctionObject(value: JsonValue, path: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ChartExtractionError(`${path} must be an object`);
  }
  return value;
}

/**
 * Evidence-bound review for VLM-derived estimates. Every model-extracted
 * point enters as ``pending`` regardless of its confidence level — a
 * medium-confidence estimate is still a visual-model estimate — so ALL
 * pending points of one source are batched into ONE ``data_review`` request:
 * accept sets review provenance, correct preserves the original values,
 * reject removes the point, and skip leaves no publishable estimate.
 */
export async function reviewLowConfidencePoints(options: {
  chartRows: ChartRow[];
  pointRows: ChartPointRow[];
  sourceLabel: string;
  hilGate?: DatasetHILGate | null;
  signal?: AbortSignal;
}): Promise<void> {
  const pending = options.pointRows.filter((point) => point.human_review_state === "pending");
  if (pending.length === 0) return;
  if (options.hilGate === undefined || options.hilGate === null) {
    throw new ChartExtractionError(
      `${pending.length} pending VLM estimate(s) require durable human review`,
    );
  }
  const review = await options.hilGate.requestHIL({
    requirement_id: null,
    kind: "data_review",
    review_type: "vlm_extraction",
    blocking: true,
    subject: { record_ids: pending.map((point) => point.point_id) },
    review_items: pending.map((point) => ({
      item_id: point.point_id,
      summary: `${point.series_label || "point"}: (${point.x_value}, ${point.y_value})`,
      subject: { record_ids: [point.point_id] },
      evidence: {
        chart_id: point.chart_id,
        x_value: point.x_value,
        y_value: point.y_value,
        series_label: point.series_label,
        confidence_level: point.confidence_level,
        confidence_reason: point.confidence_reason,
      },
      proposed_value: { x: point.x_value, y: point.y_value },
      confidence_level: point.confidence_level === "not_applicable" ? null : point.confidence_level,
    })),
    summary: `${pending.length} pending VLM estimate(s) require review`,
    evidence: {
      source_label: options.sourceLabel,
      points: pending.map((point) => ({
        point_id: point.point_id,
        chart_id: point.chart_id,
        x_value: point.x_value,
        y_value: point.y_value,
        confidence_level: point.confidence_level,
        confidence_reason: point.confidence_reason,
      })),
    },
    policy_ref: "dataset.vlm_extraction.v1",
    idempotency_key: `vlm:${options.sourceLabel}:${pending.map((point) => point.point_id).join(",")}`,
  }, options.signal);

  if (review.decision.action === "approve") {
    throw new ChartExtractionError("approve is not valid for VLM data review");
  }
  if (review.decision.action === "reject" || review.decision.action === "skip") {
    const removed = new Set(pending.map((point) => point.point_id));
    const retained = options.pointRows.filter((point) => !removed.has(point.point_id));
    options.pointRows.splice(0, options.pointRows.length, ...retained);
  } else if (review.decision.action === "accept") {
    for (const point of pending) {
      point.human_review_state = "accepted";
      point.review_id = review.review_id;
    }
  } else {
    const root = correctionObject(review.decision.correction, "VLM correction");
    const corrections = correctionObject(root["points"] ?? null, "VLM correction.points");
    for (const point of pending) {
      const item = correctionObject(
        corrections[point.point_id] ?? null,
        `VLM correction.points.${point.point_id}`,
      );
      const x = item["x_value"];
      const y = item["y_value"];
      if (x !== undefined && typeof x !== "string" && typeof x !== "number") {
        throw new ChartExtractionError(`invalid x_value correction for ${point.point_id}`);
      }
      if (y !== undefined && typeof y !== "string" && typeof y !== "number") {
        throw new ChartExtractionError(`invalid y_value correction for ${point.point_id}`);
      }
      point.original_x_value = point.x_value;
      point.original_y_value = point.y_value;
      if (x !== undefined) point.x_value = String(x);
      if (y !== undefined) point.y_value = String(y);
      point.human_review_state = "corrected";
      point.review_id = review.review_id;
    }
  }
  for (const chart of options.chartRows) {
    chart.data_point_count = options.pointRows.filter(
      (point) => point.chart_id === chart.chart_id,
    ).length;
  }
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

async function writeChartConfidenceArtifact(
  outputDir: string,
  chartRows: readonly ChartRow[],
  pointRows: readonly ChartPointRow[],
): Promise<string> {
  const charts = new Map(chartRows.map((chart) => [chart.chart_id, chart]));
  const deterministicBatches = chartRows
    .filter((chart) => chart.extraction_tier === "L2_tables")
    .map((chart) => ({
      schema_version: "1.0" as const,
      batch_id: chart.chart_id,
      record_count: pointRows.filter((point) => point.chart_id === chart.chart_id).length,
      level: "medium" as const,
      channel: "deterministic_pdf_table",
      components: {
        schema_version: "1.0" as const,
        source_reliability: "medium" as const,
        extraction_reliability: "high" as const,
        mapping_reliability: "not_applicable" as const,
        cross_source_consistency: "not_checked" as const,
        human_review_state: "not_required" as const,
      },
      reasons: ["deterministic PDF table extraction from a literature source"],
    }));
  const recordOverrides = pointRows.flatMap((point) => {
    const chart = charts.get(point.chart_id);
    if (chart?.extraction_tier !== "L1_vlm" || point.confidence_level === "not_applicable") {
      return [];
    }
    return [evaluateConfidence({
      confidence_id: `confidence_${point.point_id}`,
      batch_id: point.chart_id,
      record_id: point.point_id,
      channel: "vlm",
      components: {
        source_reliability: "medium",
        extraction_reliability: point.confidence_level,
        mapping_reliability: "not_applicable",
        cross_source_consistency: "not_checked",
        human_review_state: point.human_review_state,
      },
      reasons: [point.confidence_reason],
    })];
  });
  return writeConfidenceArtifact(outputDir, {
    schema_version: "1.0",
    batch_defaults: deterministicBatches,
    record_overrides: recordOverrides,
  });
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
  modelName: string,
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
        modelName,
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
          confidence_level: "high",
          confidence_reason: "deterministic PDF table extraction",
          human_review_state: "not_required",
          review_id: "",
          original_x_value: "",
          original_y_value: "",
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
    confidence_level: "not_applicable",
    confidence_reason: "caption text only; no numeric chart value extracted",
    human_review_state: "not_required",
    review_id: "",
    original_x_value: "",
    original_y_value: "",
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
  modelName: string,
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
    modelName,
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
  hilGate?: DatasetHILGate | null;
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
      hooks.onQueryStarted?.(resolved, "extract_chart_data_vlm");

      const chartRows: ChartRow[] = [];
      const pointRows: ChartPointRow[] = [];
      const metas: VlmChartMeta[] = [];

      try {
        if (IMAGE_EXTENSIONS.has(extension)) {
          const result = await extractFromImage(resolved, sourceLabel, 1, vlm, prompt, taskRoot, config.model, signal);
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
          const l1 = await extractFromPdfL1(resolved, context, sourceLabel, vlm, prompt, taskRoot, hooks, config.model, signal);
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
        await reviewLowConfidencePoints({
          chartRows,
          pointRows,
          sourceLabel,
          hilGate: options.hilGate,
          signal,
        });
        await writeChartCsvs(
          chartData,
          chartRows,
          pointRows,
          async (mergedCharts, mergedPoints) => {
            await writeChartConfidenceArtifact(chartData, mergedCharts, mergedPoints);
          },
        );
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
          toTaskRelative(path.join(chartData, CONFIDENCE_ARTIFACT_FILE), taskRoot),
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
