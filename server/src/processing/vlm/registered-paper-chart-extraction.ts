/**
 * Governed registered paper chart evidence extraction (Gold6 vision repair,
 * task 5). Consumes ONLY task-owned SourceAsset registrations (paper full-text
 * XML, paper PDF, supplementary carriers), extracts candidate paper /
 * experiment / activity / series / point evidence with the configured visual
 * model, and registers content-addressed JSON carriers under the task
 * ``source_assets`` root as committed Core-derived assets.
 *
 * Trust boundary: the Dataset Core remains the only component that parses,
 * validates, assembles, assesses, and publishes. VLM output here is candidate
 * evidence — every chart point is ``estimated`` and ``pending`` review, and a
 * series whose axis/legend semantics are unclear degrades to an explicit
 * unclear no-points series instead of publishing exact points. Raw provider
 * credentials never enter the carrier, the summary, or log output.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  HILSubject,
  JsonValue,
  OperationResultManifest,
  SourceAssetRegistrationReceipt,
  SourceLocatorV2,
} from "@biomed/contracts";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import type { CoreResolvedRegisteredAsset } from "../../dataset/adapters/registered/types.js";
import { canonicalDigest } from "../../dataset/adapters/identity.js";
import type { DatasetHILGate } from "../../dataset/review/hil-policy.js";
import {
  assertChartEvidenceCarrierRows,
  assertChartEvidenceRows,
  type ChartConfidenceLevel,
  type ChartEvidenceRows,
  type ChartPaperInput,
  type ChartPointInput,
  type ChartReliabilityLevel,
  type ChartReviewProvenance,
  type ChartSeriesInput,
  type ChartSourceInput,
  type ChartTransformProvenance,
  type ChartTransformStep,
} from "../../dataset/families/bioactivity-measurement/chart-evidence/index.js";
import {
  assertPaperEvidenceRows,
  derivePaperCanonicalIdentities,
  PAPER_ID_ABSENT,
  type ActivityValueRecordInput,
  type ExperimentRecordInput,
  type PaperEvidenceRows,
  type PaperRecordInput,
  type SupplementaryAssetRecordInput,
} from "../../dataset/families/bioactivity-measurement/paper-evidence/index.js";
import { parseMeasurementRelation } from "../../dataset/schema/common/index.js";
import { MAX_XML_CARRIER_BYTES } from "../../dataset/runtime/provider-limits.js";
import { PublicHttpClient } from "../../external/network/http-client.js";
import type { SourceAssetRegistry } from "../../runtime/source-assets/registry.js";
import { parseVlmJsonObject, ChartExtractionError } from "./chart-json.js";
import type { PdfPageRaster } from "./pdf-images.js";
import { renderPdfPagesFromBytes } from "./pdf-pages.js";
import { createVlmClient, type VlmClient, type VlmConfig } from "./vlm-client.js";

export const REGISTERED_PAPER_CHART_EXTRACTION_IMPLEMENTATION =
  "registered-paper-chart-extraction";
export const REGISTERED_PAPER_CHART_EXTRACTION_VERSION = "1.1.0";
export const REGISTERED_PAPER_CHART_PROMPT_VERSION = "registered_paper_chart.v2";
export const REGISTERED_PAPER_CHART_CARRIER_KIND = "registered_paper_chart_evidence";

const ASSET_ID = /^asset_[0-9a-f]{64}$/;
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const XML_MEDIA_TYPES = new Set(["application/xml", "text/xml"]);
const PDF_MEDIA_TYPES = new Set(["application/pdf"]);
const PAPER_ID_NAMESPACES = new Set(["pubmed", "pmc", "doi"]);
const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
const CLARITY_STATUSES = ["clear", "unclear"] as const;
const MAX_WARNINGS = 20;
const MAX_REVIEW_IDS = 100;
/** Higher governed resolution for small biomedical chart labels and ticks. */
export const REGISTERED_PAPER_RENDER_DPI = 216;

export const REGISTERED_PAPER_CHART_PROMPT = `You are a governed biomedical paper chart evidence extractor. Analyze the
figure content of this paper page image and return ONLY a JSON object (no
markdown fences, no prose) with this exact schema:

{
  "experiments": [
    {"experiment_id": "<stable id>", "protein": "<protein or gene>", "variant": "<variant or empty>", "construct": "<construct or empty>", "ligand": "<ligand or empty>", "assay_type": "<assay type>", "cell_line_or_system": "<system or empty>", "temperature": "<value or empty>", "buffer": "<buffer or empty>", "incubation_time": "<value or empty>", "figure_id": "<Figure_2A or empty>", "table_id": "<Table_1 or empty>", "locator_evidence": "<verbatim caption or sentence locating the experiment>"}
  ],
  "activities": [
    {"activity_key": "<short stable key>", "experiment_id": "<experiment id>", "compound": "<name as reported>", "protein_variant": "<protein or variant>", "activity_type": "IC50" | "Ki" | "EC50" | "...", "activity_value": "<numeric token>", "activity_unit": "nM" | "uM" | "mM" | "pM" | "M", "relation": "=" | "<" | ">" | "<=" | ">=" | "~", "replicate_count": <integer or null>, "error_value": <number or null>, "error_type": "<type or empty>", "original_text": "<verbatim sentence or cell text>", "table_or_figure": "<Figure_2A / Table_1 / none>", "row_label": "<row label or none>", "column_label": "<column label or none>", "confidence_level": "high" | "medium" | "low"}
  ],
  "series": [
    {"series_key": "<short stable key>", "figure_id": "<Figure_2A or empty when unclear>", "series_label": "<legend label>", "x_axis_name": "<axis label>", "x_axis_unit": "<unit or empty>", "y_axis_name": "<axis label>", "y_axis_unit": "<unit or empty>", "x_scale": "linear" | "log", "y_scale": "linear" | "log", "legend_text": "<verbatim legend text or empty>", "axis_validation_status": "clear" | "unclear", "legend_validation_status": "clear" | "unclear", "bbox": [<x0>, <y0>, <x1>, <y1>], "extraction_confidence": "high" | "medium" | "low", "confidence_reason": "<concrete evidence-based reason>"}
  ],
  "points": [
    {"series_key": "<series key>", "activity_key": "<activity key this point represents>", "x_value": "<numeric token>", "y_value": "<numeric token>", "point_type": "point" | "line_vertex" | "bar" | "error_bound", "bbox": [<x0>, <y0>, <x1>, <y1>], "extraction_confidence": "high" | "medium" | "low", "confidence_reason": "<concrete evidence-based reason>"}
  ]
}

Rules:
- Paper metadata is supplied separately from byte-verified JATS XML. Do not infer or repeat it.
- bbox arrays are pixel coordinates in THIS page image, ordered x0 < x1, y0 < y1.
- Omit a section as an empty array when nothing of that kind is on the page.
- Never guess figure identity, axis units, or legend semantics: use "unclear"
  status and empty fields instead; unclear series carry no points.
- activity_value must be a finite number token with a concentration unit.
- confidence_level is categorical evidence quality, never a probability.
- Do NOT wrap the JSON in markdown fences.`;

export interface RegisteredPaperChartExtractionRequest {
  paper_xml_asset_id: string;
  paper_pdf_asset_id: string;
  supplementary_asset_ids?: readonly string[];
  paper_id: string;
  paper_id_namespace: string;
}

export interface RegisteredPaperChartExtractionDeps {
  taskRoot: string;
  sourceAssetRegistry: SourceAssetRegistry;
  /** Live visual-model resolver; consulted immediately before the first call. */
  resolveVlmConfig: () => Promise<VlmConfig>;
  httpClient?: PublicHttpClient;
  /** Test seam: build the VLM client from the resolved config. */
  vlmClientFactory?: (config: VlmConfig) => VlmClient;
  /** Test seam: render complete page rasters from the registered PDF. */
  extractPageImages?: (
    pdfBytes: Buffer,
    sourceLabel: string,
    destDir: string,
    options: { hint: string; signal?: AbortSignal },
  ) => Promise<{ images: PdfPageRaster[]; skippedPages: number }>;
  /**
   * Durable review gate. When present, ALL pending VLM point estimates of
   * the registered carrier are batched into ONE evidence-bound
   * ``data_review`` request; a reject/skip resolution fails the extraction
   * outcome (the estimates are not publishable). Absent (legacy), the
   * carrier keeps its pending review ids only.
   */
  hilGate?: DatasetHILGate | null;
  now?: () => Date;
}

export interface RegisteredPaperChartCarrierSummary {
  asset_id: string;
  receipt_id: string;
  sha256: string;
  size_bytes: number;
  media_type: string;
  relative_path: string;
  role: string;
  registered_at: string;
}

export interface RegisteredPaperChartEvidenceResult {
  status: "ok";
  carrier: RegisteredPaperChartCarrierSummary;
  model: { provider: string; model: string; model_version: string };
  rows: {
    paper_records: number;
    experiment_records: number;
    activity_value_records: number;
    supplementary_asset_records: number;
    chart_series: number;
    chart_points: number;
    papers: number;
    sources: number;
  };
  /** Durable review references; empty until evidence-bound human review. */
  pending_review: {
    series_count: number;
    point_count: number;
    review_ids: string[];
    /** Present only when a durable review gate resolved the carrier batch. */
    review?: RegisteredPaperChartCarrierReview;
  };
  warnings: string[];
  /**
   * Present only after the evidence-bound review resolved with accept or
   * correct: the review-closed publication carrier (second content-addressed
   * registration) whose rows pass the publication-stage review gate and which
   * carries committed Core-derived provenance for dynamic-route binding. The
   * candidate carrier keeps its pending rows and is never bound for publication.
   */
  reviewed_carrier?: RegisteredPaperChartCarrierSummary;
}

/** Durable resolution of the one batched carrier review (T6). */
export interface RegisteredPaperChartCarrierReview {
  request_id: string;
  review_id: string;
  action: "accept" | "correct";
  reviewer: string;
  reviewed_at: string;
  evidence_digest: string;
  reason: string | null;
  /** Structured corrections; only for ``correct`` resolutions. */
  correction: JsonValue | null;
}

export interface ParsedPaperMetaCandidate {
  title: string;
  journal: string | null;
  publication_date: string | null;
  authors: readonly string[] | null;
  source_url: string | null;
  open_access_status: string | null;
}

export interface ParsedExperimentCandidate {
  experiment_id: string;
  protein: string;
  variant: string | null;
  construct: string | null;
  ligand: string | null;
  assay_type: string;
  cell_line_or_system: string | null;
  temperature: string | null;
  buffer: string | null;
  incubation_time: string | null;
  figure_id: string | null;
  table_id: string | null;
  locator_evidence: string | null;
}

export interface ParsedActivityCandidate {
  activity_key: string;
  experiment_id: string;
  compound: string;
  protein_variant: string;
  activity_type: string;
  activity_value: string;
  activity_unit: string;
  relation: string;
  replicate_count: number | null;
  error_value: number | null;
  error_type: string | null;
  original_text: string;
  table_or_figure: string;
  row_label: string;
  column_label: string;
  confidence_level: ChartConfidenceLevel;
}

export interface ParsedSeriesCandidate {
  series_key: string;
  figure_id: string | null;
  series_label: string;
  x_axis_name: string;
  x_axis_unit: string | null;
  y_axis_name: string;
  y_axis_unit: string | null;
  x_scale: string;
  y_scale: string;
  legend_text: string | null;
  axis_validation_status: "clear" | "unclear" | null;
  legend_validation_status: "clear" | "unclear" | null;
  bbox: [number, number, number, number] | null;
  extraction_confidence: ChartConfidenceLevel | null;
  confidence_reason: string | null;
}

export interface ParsedPointCandidate {
  series_key: string;
  activity_key: string;
  x_value: string;
  y_value: string;
  point_type: string;
  bbox: [number, number, number, number] | null;
  extraction_confidence: ChartConfidenceLevel | null;
  confidence_reason: string | null;
}

export interface RegisteredPaperChartResponse {
  paper: ParsedPaperMetaCandidate | null;
  experiments: ParsedExperimentCandidate[];
  activities: ParsedActivityCandidate[];
  series: ParsedSeriesCandidate[];
  points: ParsedPointCandidate[];
}

function fail(message: string): never {
  throw new ChartExtractionError(`registered paper chart evidence rejected: ${message}`);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} is required`);
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function optionalInt(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function optionalFloat(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function optionalAuthors(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const authors = value.every((item) => typeof item === "string" && item.trim() !== "")
    ? (value as string[])
    : null;
  return authors !== null && authors.length > 0 ? authors : null;
}

function controlled<T extends string>(value: unknown, values: readonly T[], name: string): T {
  const parsed = requiredText(value, name);
  if (!values.includes(parsed as T)) fail(`${name} has unsupported value '${parsed}'`);
  return parsed as T;
}

function optionalConfidence(value: unknown): ChartConfidenceLevel | null {
  return typeof value === "string" && (CONFIDENCE_LEVELS as readonly string[]).includes(value)
    ? (value as ChartConfidenceLevel)
    : null;
}

function optionalClarity(value: unknown): "clear" | "unclear" | null {
  return typeof value === "string" && (CLARITY_STATUSES as readonly string[]).includes(value)
    ? (value as "clear" | "unclear")
    : null;
}

function optionalBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  if (value.some((item) => typeof item !== "number" || !Number.isFinite(item) || item < 0)) {
    return null;
  }
  const [x0, y0, x1, y1] = value as [number, number, number, number];
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

/** Parse a raw VLM page response into validated structured candidates. */
export function parseRegisteredPaperChartResponse(
  raw: string,
  sourceLabel: string,
): RegisteredPaperChartResponse {
  const record = parseVlmJsonObject(raw, sourceLabel, []);

  // Paper metadata is authoritative only when parsed from the registered
  // JATS carrier. A legacy/model response may still echo it; keep a complete
  // title-bearing object only for mismatch diagnostics and ignore partial
  // metadata instead of rejecting otherwise usable visual evidence.
  const paperRecord = asRecord(record.paper);
  const modelPaperTitle = paperRecord === null ? null : optionalText(paperRecord.title);
  const paper = paperRecord === null || modelPaperTitle === null ? null : {
    title: modelPaperTitle,
    journal: optionalText(paperRecord.journal),
    publication_date: optionalText(paperRecord.publication_date),
    authors: optionalAuthors(paperRecord.authors),
    source_url: optionalText(paperRecord.source_url),
    open_access_status: optionalText(paperRecord.open_access_status),
  };

  const experimentList = Array.isArray(record.experiments) ? record.experiments : [];
  const experiments = experimentList.map((entry, index) => {
    const item = asRecord(entry);
    if (item === null) fail(`${sourceLabel} experiment ${index + 1} must be an object`);
    return {
      experiment_id: requiredText(item.experiment_id, `${sourceLabel} experiment experiment_id`),
      protein: requiredText(item.protein, `${sourceLabel} experiment protein`),
      variant: optionalText(item.variant),
      construct: optionalText(item.construct),
      ligand: optionalText(item.ligand),
      assay_type: requiredText(item.assay_type, `${sourceLabel} experiment assay_type`),
      cell_line_or_system: optionalText(item.cell_line_or_system),
      temperature: optionalText(item.temperature),
      buffer: optionalText(item.buffer),
      incubation_time: optionalText(item.incubation_time),
      figure_id: optionalText(item.figure_id),
      table_id: optionalText(item.table_id),
      locator_evidence: optionalText(item.locator_evidence),
    };
  });

  const activityList = Array.isArray(record.activities) ? record.activities : [];
  const activities = activityList.map((entry, index) => {
    const item = asRecord(entry);
    if (item === null) fail(`${sourceLabel} activity ${index + 1} must be an object`);
    const activityValue = requiredText(item.activity_value, `${sourceLabel} activity activity_value`);
    if (!Number.isFinite(Number(activityValue))) {
      fail(`${sourceLabel} activity activity_value must be a finite numeric token`);
    }
    const relation = requiredText(item.relation, `${sourceLabel} activity relation`);
    try {
      parseMeasurementRelation(relation);
    } catch (error) {
      fail(`${sourceLabel} activity relation: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      activity_key: optionalText(item.activity_key) ?? `act_${index + 1}`,
      experiment_id: requiredText(item.experiment_id, `${sourceLabel} activity experiment_id`),
      compound: requiredText(item.compound, `${sourceLabel} activity compound`),
      protein_variant: requiredText(item.protein_variant, `${sourceLabel} activity protein_variant`),
      activity_type: requiredText(item.activity_type, `${sourceLabel} activity activity_type`),
      activity_value: activityValue,
      activity_unit: requiredText(item.activity_unit, `${sourceLabel} activity activity_unit`),
      relation,
      replicate_count: optionalInt(item.replicate_count),
      error_value: optionalFloat(item.error_value),
      error_type: optionalText(item.error_type),
      original_text: requiredText(item.original_text, `${sourceLabel} activity original_text`),
      table_or_figure: optionalText(item.table_or_figure) ?? PAPER_ID_ABSENT,
      row_label: optionalText(item.row_label) ?? PAPER_ID_ABSENT,
      column_label: optionalText(item.column_label) ?? PAPER_ID_ABSENT,
      confidence_level: controlled(
        item.confidence_level,
        CONFIDENCE_LEVELS,
        `${sourceLabel} activity confidence_level`,
      ),
    };
  });

  const seriesList = Array.isArray(record.series) ? record.series : [];
  const series = seriesList.map((entry, index) => {
    const item = asRecord(entry);
    if (item === null) fail(`${sourceLabel} series ${index + 1} must be an object`);
    const seriesKey = requiredText(item.series_key, `${sourceLabel} series series_key`);
    return {
      series_key: seriesKey,
      figure_id: optionalText(item.figure_id),
      series_label: optionalText(item.series_label) ?? seriesKey,
      x_axis_name: optionalText(item.x_axis_name) ?? PAPER_ID_ABSENT,
      x_axis_unit: optionalText(item.x_axis_unit),
      y_axis_name: optionalText(item.y_axis_name) ?? PAPER_ID_ABSENT,
      y_axis_unit: optionalText(item.y_axis_unit),
      x_scale: optionalText(item.x_scale) ?? "linear",
      y_scale: optionalText(item.y_scale) ?? "linear",
      legend_text: optionalText(item.legend_text),
      axis_validation_status: optionalClarity(item.axis_validation_status),
      legend_validation_status: optionalClarity(item.legend_validation_status),
      bbox: optionalBbox(item.bbox),
      extraction_confidence: optionalConfidence(item.extraction_confidence),
      confidence_reason: optionalText(item.confidence_reason),
    };
  });

  const pointList = Array.isArray(record.points) ? record.points : [];
  const points = pointList.map((entry, index) => {
    const item = asRecord(entry);
    if (item === null) fail(`${sourceLabel} point ${index + 1} must be an object`);
    return {
      series_key: requiredText(item.series_key, `${sourceLabel} point series_key`),
      activity_key: optionalText(item.activity_key) ?? "",
      x_value: requiredText(item.x_value, `${sourceLabel} point x_value`),
      y_value: requiredText(item.y_value, `${sourceLabel} point y_value`),
      point_type: optionalText(item.point_type) ?? "point",
      bbox: optionalBbox(item.bbox),
      extraction_confidence: optionalConfidence(item.extraction_confidence),
      confidence_reason: optionalText(item.confidence_reason),
    };
  });

  return { paper, experiments, activities, series, points };
}

interface PageExtraction {
  pageNumber: number;
  parsed: RegisteredPaperChartResponse;
  inputDigest: string;
  outputDigest: string;
  providerModel: string | null;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function registerDerivedJsonAsset(options: {
  taskRoot: string;
  sourceAssetRegistry: SourceAssetRegistry;
  sourceId: string;
  relativePath: string;
  role: "source" | "carrier";
  bytes: Buffer;
  parentAssetIds: readonly string[];
  requirementId: string;
  stage: "candidate" | "review_evidence" | "reviewed";
  parametersDigest: string;
  evidence: JsonValue;
}): Promise<SourceAssetRegistrationReceipt> {
  const parentClosures = await Promise.all(options.parentAssetIds.map((assetId) =>
    options.sourceAssetRegistry.resolveFormalProvenanceClosure(assetId)));
  const upstreamResultIds = [...new Set(parentClosures.flatMap((closure) =>
    closure.flatMap((item) => "operation_result_id" in item ? [item.operation_result_id] : [])))];
  const outputDigest = sha256(options.bytes);
  const implementationDigest = sha256(Buffer.from(
    `${REGISTERED_PAPER_CHART_EXTRACTION_IMPLEMENTATION}@${REGISTERED_PAPER_CHART_EXTRACTION_VERSION}`,
    "utf8",
  ));
  const operationResultId = `result_chart_${sha256(Buffer.from(JSON.stringify({
    requirement_id: options.requirementId,
    parent_asset_ids: options.parentAssetIds,
    parameter_digest: options.parametersDigest,
    output_digest: outputDigest,
  }), "utf8")).slice(0, 32)}`;
  const finalPath = path.join(options.taskRoot, ...options.relativePath.split("/"));
  await mkdir(path.dirname(finalPath), { recursive: true });
  const tempPath = `${finalPath}.${process.pid}.tmp`;
  await writeFile(tempPath, options.bytes);
  await rename(tempPath, finalPath);
  const registered = await options.sourceAssetRegistry.registerDerived({
    sourceId: options.sourceId,
    relativePath: options.relativePath,
    role: options.role,
    mediaType: "application/json",
    parentAssetIds: options.parentAssetIds,
    operationKind: "vlm_extraction",
    operationResultId,
    implementationId: REGISTERED_PAPER_CHART_EXTRACTION_IMPLEMENTATION,
    implementationVersion: REGISTERED_PAPER_CHART_EXTRACTION_VERSION,
    parametersDigest: options.parametersDigest,
    evidence: options.evidence,
  });
  if (
    registered.receipt.sha256 !== outputDigest
    || registered.receipt.size_bytes !== options.bytes.length
  ) {
    throw new ChartExtractionError(
      `derived ${options.stage} carrier registration did not bind the written bytes`,
    );
  }
  const operationResult: OperationResultManifest = {
    schema_version: "1.0",
    result_manifest_id: operationResultId,
    task_id: registered.receipt.task_id,
    run_id: "core",
    requirement_id: options.requirementId,
    operation_id: operationResultId,
    operation_kind: "derive",
    operation_attempt_id: `attempt_${operationResultId}`,
    attempt: 1,
    status: "succeeded",
    input_digest: sha256(Buffer.from(options.parentAssetIds.join("\u0000"), "utf8")),
    parameter_digest: options.parametersDigest,
    implementation_digest: implementationDigest,
    output_digest: outputDigest,
    output_kind: "derived_evidence",
    output_summary: {
      stage: options.stage,
      asset_id: registered.receipt.asset_ref.asset_id,
      sha256: outputDigest,
    },
    output_files: [{
      relative_path: registered.receipt.relative_path,
      size_bytes: registered.receipt.size_bytes,
      sha256: registered.receipt.sha256,
    }],
    dependency_closure: {
      input_asset_ids: [...options.parentAssetIds],
      upstream_result_manifest_ids: upstreamResultIds,
      parameter_digest: options.parametersDigest,
      implementation_digest: implementationDigest,
    },
    commit: {
      state: "committed",
      commit_id: `commit_${operationResultId}`,
      committed_at: registered.provenance.created_at,
    },
  };
  await options.sourceAssetRegistry.recordDerivedOperationResult(operationResult);
  return registered.receipt;
}

function requireAssetId(value: unknown, field: string): string {
  if (typeof value === "string" && ASSET_ID.test(value)) return value;
  throw new ChartExtractionError(
    `${field} must be a registered asset id (asset_<sha256>), not a path or free text`,
  );
}

function requirePaperNamespace(value: unknown): string {
  const namespace = requiredText(value, "paper_id_namespace");
  if (!PAPER_ID_NAMESPACES.has(namespace)) {
    fail(`paper_id_namespace '${namespace}' is unsupported (expected one of ${[...PAPER_ID_NAMESPACES].join(", ")})`);
  }
  return namespace;
}

function rejectBrowserMedia(mediaType: string, assetId: string): void {
  if (mediaType.startsWith("image/")) {
    throw new ChartExtractionError(
      `asset ${assetId} is a browser screenshot registration (media_type ${mediaType}); ` +
        "browser-only captures are not formal paper evidence inputs",
    );
  }
}

async function readVerifiedAsset(
  registry: SourceAssetRegistry,
  assetId: string,
): Promise<{ receipt: SourceAssetRegistrationReceipt; bytes: Buffer }> {
  let resolved: CoreResolvedRegisteredAsset;
  try {
    resolved = await registry.resolveAny(assetId);
  } catch (error) {
    throw new ChartExtractionError(
      `asset ${assetId} is not registered in this task: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of resolved.content) chunks.push(chunk as Buffer);
  const bytes = Buffer.concat(chunks);
  if (sha256(bytes) !== resolved.registration_receipt.sha256) {
    throw new ChartExtractionError(`asset ${assetId} bytes do not match its registered digest`);
  }
  return { receipt: resolved.registration_receipt, bytes };
}

function assertPaperMediaType(receipt: SourceAssetRegistrationReceipt, allowed: Set<string>, kind: string): void {
  rejectBrowserMedia(receipt.media_type, receipt.asset_ref.asset_id);
  if (!allowed.has(receipt.media_type.toLowerCase())) {
    throw new ChartExtractionError(
      `${kind} asset ${receipt.asset_ref.asset_id} has unsupported media type ${receipt.media_type} ` +
        `(expected ${[...allowed].sort().join(" or ")})`,
    );
  }
}

function assertSupplementaryMediaType(receipt: SourceAssetRegistrationReceipt): void {
  rejectBrowserMedia(receipt.media_type, receipt.asset_ref.asset_id);
}

function defaultExtractPageImages(
  pdfBytes: Buffer,
  sourceLabel: string,
  destDir: string,
  options: { hint: string; signal?: AbortSignal },
): Promise<{ images: PdfPageRaster[]; skippedPages: number }> {
  return renderPdfPagesFromBytes(pdfBytes, sourceLabel, destDir, {
    ...options,
    dpi: REGISTERED_PAPER_RENDER_DPI,
  }).then((rendering) => ({
    images: rendering.pages,
    skippedPages: rendering.skippedPages,
  }));
}

type XmlRecord = Record<string, unknown>;

function xmlAttributes(node: unknown): XmlRecord {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return {};
  const attributes = (node as XmlRecord)[":@"];
  return typeof attributes === "object" && attributes !== null && !Array.isArray(attributes)
    ? (attributes as XmlRecord)
    : {};
}

function xmlChildren(node: unknown, name: string): unknown[] {
  const values: unknown[] = [];
  const entries = Array.isArray(node) ? node : [node];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const value = (entry as XmlRecord)[name];
    if (value === undefined) continue;
    values.push(...(Array.isArray(value) ? value : [value]));
  }
  return values;
}

function xmlDescendants(node: unknown, name: string): unknown[] {
  const values: unknown[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === ":@" || key.startsWith("@_")) continue;
      if (key === name) {
        values.push({
          "#children": Array.isArray(child) ? child : [child],
          ":@": xmlAttributes(value),
        });
      }
      visit(child);
    }
  };
  visit(node);
  return values;
}

function xmlText(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(xmlText).join(" ").replace(/\s+/g, " ").trim();
  if (typeof node !== "object" || node === null) return "";
  return Object.entries(node)
    .filter(([key]) => key !== ":@" && !key.startsWith("@_"))
    .map(([, value]) => xmlText(value))
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([([])\s+/g, "$1")
    .replace(/\s+([)\]])/g, "$1")
    .trim();
}

function firstXmlText(node: unknown, name: string): string | null {
  const value = xmlText(xmlDescendants(node, name)[0]);
  return value === "" ? null : value;
}

function parseJatsDate(article: unknown): string | null {
  const dates = xmlDescendants(article, "pub-date");
  const preferred = dates.find((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const type = xmlAttributes(value)["@_pub-type"];
    return type === "epub" || type === "ppub";
  }) ?? dates[0];
  if (preferred === undefined) return null;
  const year = firstXmlText(preferred, "year");
  const month = firstXmlText(preferred, "month");
  const day = firstXmlText(preferred, "day");
  if (year === null || !/^\d{4}$/.test(year)) return null;
  if (month === null || day === null || !/^\d{1,2}$/.test(month) || !/^\d{1,2}$/.test(day)) {
    return null;
  }
  const normalized = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const parsed = new Date(`${normalized}T00:00:00Z`);
  return Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== normalized
    ? null
    : normalized;
}

function parseJatsAuthor(contributor: unknown): string | null {
  const given = firstXmlText(contributor, "given-names");
  const surname = firstXmlText(contributor, "surname");
  const name = [given, surname].filter((value): value is string => value !== null).join(" ").trim();
  if (name !== "") return name;
  return firstXmlText(contributor, "collab");
}

/** Authoritative paper metadata from the byte-verified registered JATS XML. */
export function parseRegisteredJatsPaperMeta(
  bytes: Buffer,
  expectedIdentity?: { paperId: string; paperNamespace: string },
): ParsedPaperMetaCandidate {
  if (bytes.length > MAX_XML_CARRIER_BYTES) {
    throw new ChartExtractionError(
      `registered paper XML exceeded ${MAX_XML_CARRIER_BYTES} byte parse limit (${bytes.length} bytes)`,
    );
  }
  const xml = bytes.toString("utf8");
  if (XMLValidator.validate(xml) !== true) {
    throw new ChartExtractionError("registered paper XML is malformed");
  }
  const root = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    trimValues: false,
    processEntities: true,
    preserveOrder: true,
  }).parse(xml) as unknown;
  const article = xmlChildren(root, "article")[0];
  if (article === undefined) {
    throw new ChartExtractionError("registered paper XML has no JATS article element");
  }
  const title = firstXmlText(article, "article-title");
  if (title === null) {
    throw new ChartExtractionError("registered paper XML has no JATS article title");
  }
  if (expectedIdentity !== undefined) {
    const expectedType = expectedIdentity.paperNamespace === "pubmed"
      ? "pmid"
      : expectedIdentity.paperNamespace === "pmc"
        ? "pmc"
        : "doi";
    const matchingIds = xmlDescendants(article, "article-id")
      .filter((value) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
        const type = xmlAttributes(value)["@_pub-id-type"];
        return type === expectedType || (expectedType === "pmc" && type === "pmcid");
      })
      .map(xmlText);
    if (matchingIds.length === 0) {
      throw new ChartExtractionError(
        `registered paper XML has no ${expectedIdentity.paperNamespace} identity for requested paper_id`,
      );
    }
    const normalizeIdentity = (value: string): string => {
      const trimmed = value.trim();
      if (expectedType === "pmc") {
        return trimmed.toUpperCase().startsWith("PMC")
          ? trimmed.toUpperCase()
          : `PMC${trimmed}`;
      }
      return expectedType === "doi" ? trimmed.toLowerCase() : trimmed;
    };
    const expected = normalizeIdentity(expectedIdentity.paperId);
    if (!matchingIds.map(normalizeIdentity).includes(expected)) {
      throw new ChartExtractionError(
        `registered paper XML ${expectedIdentity.paperNamespace} identity does not match requested paper_id`,
      );
    }
  }
  const authors = xmlDescendants(article, "contrib")
    .filter((contributor) => {
      if (typeof contributor !== "object" || contributor === null || Array.isArray(contributor)) {
        return false;
      }
      const type = xmlAttributes(contributor)["@_contrib-type"];
      return type === undefined || type === "author";
    })
    .map(parseJatsAuthor)
    .filter((author): author is string => author !== null);
  return {
    title,
    journal: firstXmlText(article, "journal-title"),
    publication_date: parseJatsDate(article),
    authors: authors.length === 0 ? null : authors,
    source_url: null,
    open_access_status: null,
  };
}

function safeToken(value: string, fallbackPrefix: string): string {
  const sanitized = value.replaceAll(/[^A-Za-z0-9_.:-]/g, "_").replaceAll(/\.{2,}/g, ".");
  if (SAFE_TOKEN.test(sanitized)) return sanitized;
  return `${fallbackPrefix}${sanitized.replace(/^[^A-Za-z0-9]+/, "")}`;
}

function pdfRegionLocator(options: {
  assetId: string;
  logicalFile: string;
  rawValue: string;
  pageNumber: number;
  tableId: string | null;
  figureId: string | null;
  rowLabel: string | null;
  columnLabel: string | null;
}): SourceLocatorV2 {
  return {
    locator_version: "2.0",
    locator_type: "pdf_region",
    asset_id: options.assetId,
    logical_file: options.logicalFile,
    raw_value: options.rawValue,
    page_number: options.pageNumber,
    table_id: options.tableId,
    figure_id: options.figureId,
    row_label: options.rowLabel,
    column_label: options.columnLabel,
  };
}

function imageBboxLocator(options: {
  assetId: string;
  logicalFile: string;
  rawValue: string;
  pageNumber: number;
  figureId: string;
  bbox: [number, number, number, number];
}): SourceLocatorV2 {
  return {
    locator_version: "2.0",
    locator_type: "image_bbox",
    asset_id: options.assetId,
    logical_file: options.logicalFile,
    raw_value: options.rawValue,
    page_number: options.pageNumber,
    figure_id: options.figureId,
    bbox: options.bbox,
  };
}

function carrierProvenance(options: {
  modelName: string;
  modelVersion: string;
  sourceReliability: ChartReliabilityLevel;
  extractionReliability: ChartReliabilityLevel;
  step: ChartTransformStep;
}): ChartTransformProvenance {
  return {
    schema_version: "1.0",
    model_name: options.modelName,
    model_version: options.modelVersion,
    source_reliability_at_extraction: options.sourceReliability,
    extraction_reliability_at_extraction: options.extractionReliability,
    steps: [options.step],
    review: null,
  };
}

function transformStep(options: {
  stepId: string;
  pageNumber: number;
  inputDigest: string;
  outputDigest: string;
}): ChartTransformStep {
  return {
    step_id: options.stepId,
    operation: "vlm_extract",
    implementation: REGISTERED_PAPER_CHART_EXTRACTION_IMPLEMENTATION,
    implementation_version: REGISTERED_PAPER_CHART_EXTRACTION_VERSION,
    parameters: {
      prompt_version: REGISTERED_PAPER_CHART_PROMPT_VERSION,
      page_number: options.pageNumber,
    },
    input_digest: options.inputDigest,
    output_digest: options.outputDigest,
  };
}

/** Extraction reliability from an unreviewed visual model never exceeds medium. */
function extractionReliability(confidence: ChartConfidenceLevel): ChartReliabilityLevel {
  return confidence === "low" ? "low" : "medium";
}

/**
 * Run the governed extraction and register the evidence carrier atomically.
 * All registered-asset, media-type, and identity gates run BEFORE any model
 * call; VLM-derived rows are validated against the formal table contracts;
 * the serialized carrier is content-addressed and registered as a task-owned
 * ``carrier`` SourceAsset.
 */
export async function extractRegisteredPaperChartEvidence(
  request: RegisteredPaperChartExtractionRequest,
  deps: RegisteredPaperChartExtractionDeps,
  signal?: AbortSignal,
): Promise<RegisteredPaperChartEvidenceResult> {
  const retrievedAt = (deps.now ?? (() => new Date()))().toISOString();

  // -- 1. Input identity gates (before any I/O or model call).
  const xmlAssetId = requireAssetId(request.paper_xml_asset_id, "paper_xml_asset_id");
  const pdfAssetId = requireAssetId(request.paper_pdf_asset_id, "paper_pdf_asset_id");
  const supplementIdsRaw = request.supplementary_asset_ids ?? [];
  const supplementIds = supplementIdsRaw.map((id) => requireAssetId(id, "supplementary_asset_ids"));
  if (new Set(supplementIds).size !== supplementIds.length) {
    fail("supplementary_asset_ids must not contain duplicates");
  }
  const paperId = requiredText(request.paper_id, "paper_id");
  const paperNamespace = requirePaperNamespace(request.paper_id_namespace);

  // -- 2. Registration, byte-digest, and media-type gates.
  const xml = await readVerifiedAsset(deps.sourceAssetRegistry, xmlAssetId);
  assertPaperMediaType(xml.receipt, XML_MEDIA_TYPES, "paper XML");
  const pdf = await readVerifiedAsset(deps.sourceAssetRegistry, pdfAssetId);
  assertPaperMediaType(pdf.receipt, PDF_MEDIA_TYPES, "paper PDF");
  const supplements = [];
  for (const id of supplementIds) {
    const asset = await readVerifiedAsset(deps.sourceAssetRegistry, id);
    assertSupplementaryMediaType(asset.receipt);
    supplements.push(asset);
  }
  const formalParentAssetIds = [xmlAssetId, pdfAssetId, ...supplementIds];
  for (const assetId of formalParentAssetIds) {
    try {
      await deps.sourceAssetRegistry.resolveFormalProvenanceClosure(assetId);
    } catch (error) {
      throw new ChartExtractionError(
        `source asset ${assetId} lacks formal Core provenance: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const registeredIds = new Set(formalParentAssetIds);

  // -- 3. Authoritative metadata + complete page raster extraction. The
  // registered JATS XML, not a visual-model repetition, owns paper metadata.
  const paperMeta = parseRegisteredJatsPaperMeta(xml.bytes, {
    paperId,
    paperNamespace,
  });
  const destDir = path.join(deps.taskRoot, "download_tmp", "paper_chart_evidence");
  const renderHint = paperMeta.title;
  const pageImages = await (deps.extractPageImages ?? defaultExtractPageImages)(
    pdf.bytes,
    pdf.receipt.relative_path,
    destDir,
    { hint: renderHint, signal },
  );
  if (pageImages.images.length === 0) {
    throw new ChartExtractionError(
      `no complete page images could be rendered from registered PDF asset ${pdfAssetId}`,
    );
  }

  // -- 4. Resolve the visual model live, then run one VLM call per page.
  const config = await deps.resolveVlmConfig();
  const client = deps.vlmClientFactory !== undefined
    ? deps.vlmClientFactory(config)
    : createVlmClient(config, deps.httpClient ?? new PublicHttpClient());
  let providerHost: string;
  try {
    providerHost = new URL(config.baseUrl).host;
  } catch {
    fail("resolved VLM base URL is invalid");
  }
  const pages: PageExtraction[] = [];
  for (const image of pageImages.images) {
    const imageBytes = await readFile(image.path);
    const { content, model } = await client.callWithMeta(
      image.path,
      REGISTERED_PAPER_CHART_PROMPT,
      signal,
    );
    pages.push({
      pageNumber: image.pageIndex,
      parsed: parseRegisteredPaperChartResponse(content, `page ${image.pageIndex}`),
      inputDigest: sha256(imageBytes),
      outputDigest: sha256(Buffer.from(content, "utf8")),
      providerModel: model,
    });
  }
  const modelVersion = pages.find((page) => page.providerModel !== null)?.providerModel ?? config.model;

  // -- 5. Merge page responses into merged candidates (with page context).
  const warnings: string[] = [];
  if (pageImages.skippedPages > 0) {
    warnings.push(
      `${pageImages.skippedPages} additional PDF page candidate(s) were not rendered because of the page cap`,
    );
  }
  for (const page of pages) {
    if (page.parsed.paper !== null && page.parsed.paper.title !== paperMeta.title) {
      warnings.push(
        `page ${page.pageNumber} model paper title differed from registered JATS metadata and was ignored`,
      );
    }
  }

  const experimentCandidates: Array<{ page: PageExtraction; candidate: ParsedExperimentCandidate }> = [];
  const experimentIds = new Set<string>();
  const activityCandidates: Array<{ page: PageExtraction; candidate: ParsedActivityCandidate }> = [];
  const activityKeys = new Set<string>();
  const seriesCandidates: Array<{ page: PageExtraction; candidate: ParsedSeriesCandidate }> = [];
  const seriesKeys = new Set<string>();
  const pointCandidates: Array<{ page: PageExtraction; candidate: ParsedPointCandidate }> = [];
  for (const page of pages) {
    for (const candidate of page.parsed.experiments) {
      if (experimentIds.has(candidate.experiment_id)) {
        fail(`duplicate experiment_id ${candidate.experiment_id}`);
      }
      experimentIds.add(candidate.experiment_id);
      experimentCandidates.push({ page, candidate });
    }
    for (const candidate of page.parsed.activities) {
      if (activityKeys.has(candidate.activity_key)) {
        fail(`duplicate activity_key ${candidate.activity_key}`);
      }
      activityKeys.add(candidate.activity_key);
      activityCandidates.push({ page, candidate });
    }
    for (const candidate of page.parsed.series) {
      if (seriesKeys.has(candidate.series_key)) {
        fail(`duplicate series_key ${candidate.series_key}`);
      }
      seriesKeys.add(candidate.series_key);
      seriesCandidates.push({ page, candidate });
    }
    pointCandidates.push(...page.parsed.points.map((candidate) => ({ page, candidate })));
  }
  if (experimentCandidates.length === 0) fail("experiment_records must not be empty: no experiment candidates");
  if (seriesCandidates.length === 0) fail("chart_series must not be empty: no series candidates");

  // -- 6. Build the formal rows.
  const pmid = paperNamespace === "pubmed" ? paperId : PAPER_ID_ABSENT;
  const pmcid = paperNamespace === "pmc" ? paperId : PAPER_ID_ABSENT;
  const doi = paperNamespace === "doi" ? paperId : PAPER_ID_ABSENT;
  const paperKey = `paper_${canonicalDigest([pmid, pmcid, doi]).slice(0, 32)}`;
  const xmlSourceId = `source_xml_${xml.receipt.sha256.slice(0, 16)}`;
  const pdfSourceId = `source_pdf_${pdf.receipt.sha256.slice(0, 16)}`;
  const pdfLogicalFile = pdf.receipt.relative_path;

  const paperRecords: PaperRecordInput[] = [{
    pmid,
    pmcid,
    doi,
    title: paperMeta.title,
    journal: paperMeta.journal,
    publication_date: paperMeta.publication_date,
    authors: paperMeta.authors,
    open_access_status: paperMeta.open_access_status,
    source_url: paperMeta.source_url,
    paper_key: paperKey,
    source_id: xmlSourceId,
  }];

  const experimentRecords: ExperimentRecordInput[] = experimentCandidates.map(({ page, candidate: experiment }) => ({
    experiment_id: experiment.experiment_id,
    paper_id: paperKey,
    protein: experiment.protein,
    variant: experiment.variant ?? PAPER_ID_ABSENT,
    construct: experiment.construct,
    ligand: experiment.ligand,
    assay_type: experiment.assay_type,
    cell_line_or_system: experiment.cell_line_or_system,
    temperature: experiment.temperature,
    buffer: experiment.buffer,
    incubation_time: experiment.incubation_time,
    source_locator: pdfRegionLocator({
      assetId: pdfAssetId,
      logicalFile: pdfLogicalFile,
      rawValue: experiment.locator_evidence ?? `${experiment.protein} ${experiment.assay_type}`,
      pageNumber: page.pageNumber,
      tableId: experiment.table_id,
      figureId: experiment.figure_id,
      rowLabel: null,
      columnLabel: null,
    }),
    extraction_method: "vlm",
  }));

  const activityRecords: ActivityValueRecordInput[] = activityCandidates.map(({ page, candidate: activity }) => {
    if (!experimentIds.has(activity.experiment_id)) {
      fail(`activity ${activity.activity_key} references unknown experiment_id ${activity.experiment_id}`);
    }
    return {
      experiment_id: activity.experiment_id,
      compound: activity.compound,
      protein_variant: activity.protein_variant,
      activity_type: activity.activity_type,
      activity_value: activity.activity_value,
      activity_unit: activity.activity_unit,
      relation: activity.relation,
      replicate_count: activity.replicate_count,
      error_value: activity.error_value,
      error_type: activity.error_type,
      original_text: activity.original_text,
      table_or_figure: activity.table_or_figure,
      page_number: page.pageNumber,
      row_label: activity.row_label,
      column_label: activity.column_label,
      confidence_level: activity.confidence_level,
      source_id: pdfSourceId,
      source_asset_id: pdfAssetId,
      source_locator: pdfRegionLocator({
        assetId: pdfAssetId,
        logicalFile: pdfLogicalFile,
        rawValue: activity.original_text,
        pageNumber: page.pageNumber,
        tableId: activity.table_or_figure.startsWith("Table") ? activity.table_or_figure : null,
        figureId: activity.table_or_figure.startsWith("Figure") ? activity.table_or_figure : null,
        rowLabel: activity.row_label === PAPER_ID_ABSENT ? null : activity.row_label,
        columnLabel: activity.column_label === PAPER_ID_ABSENT ? null : activity.column_label,
      }),
      retrieved_at: retrievedAt,
    };
  });

  const supplementaryRecords: SupplementaryAssetRecordInput[] = supplements.map((asset) => ({
    paper_id: paperKey,
    asset_name: safeToken(path.basename(asset.receipt.relative_path), "supplement_"),
    asset_type: asset.receipt.media_type.toLowerCase() === "text/csv"
      ? "csv_table"
      : asset.receipt.media_type.toLowerCase() === "application/pdf"
        ? "pdf_document"
        : asset.receipt.media_type.toLowerCase().includes("xml")
          ? "xml_document"
          : "binary_file",
    download_url: null,
    sha256: asset.receipt.sha256,
    file_size: asset.receipt.size_bytes,
    parse_status: "unparsed",
    table_count: null,
    source_locator: {
      locator_version: "2.0",
      locator_type: "json_pointer",
      asset_id: asset.receipt.asset_ref.asset_id,
      logical_file: asset.receipt.relative_path,
      raw_value: "registered supplementary carrier",
      json_pointer: "/",
    },
    source_asset_id: asset.receipt.asset_ref.asset_id,
  }));

  const paperRows: PaperEvidenceRows = {
    paper_records: paperRecords,
    experiment_records: experimentRecords,
    activity_value_records: activityRecords,
    supplementary_asset_records: supplementaryRecords,
  };
  // Canonical identities derived from the admitted paper evidence give chart
  // points real primary activity ids to reference.
  const derived = derivePaperCanonicalIdentities(paperRows);
  const activityIdByKey = new Map<string, string>();
  for (const [index, activity] of activityCandidates.entries()) {
    const derivedActivity = derived.activities[index];
    if (derivedActivity !== undefined) {
      activityIdByKey.set(activity.candidate.activity_key, derivedActivity.activity_id);
    }
  }

  const seriesRows: ChartSeriesInput[] = [];
  const pointRows: ChartPointInput[] = [];
  const pointIds: string[] = [];
  for (const { page, candidate } of seriesCandidates) {
    const step = transformStep({
      stepId: `vlm_extract_p${page.pageNumber}_${candidate.series_key}`,
      pageNumber: page.pageNumber,
      inputDigest: page.inputDigest,
      outputDigest: page.outputDigest,
    });

    const degradations: string[] = [];
    const figureId = candidate.figure_id;
    if (figureId === null) degradations.push("figure identity missing");
    if (candidate.bbox === null) degradations.push("figure locator missing");
    if (candidate.extraction_confidence === null) degradations.push("extraction confidence missing");
    if (candidate.confidence_reason === null) degradations.push("confidence reason missing");

    let axisStatus = candidate.axis_validation_status ?? "unclear";
    const xUnit = candidate.x_axis_unit;
    const yUnit = candidate.y_axis_unit;
    if (xUnit === null || yUnit === null) {
      axisStatus = "unclear";
      degradations.push("axis unit missing");
    }
    let legendStatus = candidate.legend_validation_status ?? "unclear";
    const legendText = candidate.legend_text;
    if (legendText === null) {
      legendStatus = "unclear";
      degradations.push("legend status missing");
    }

    const chartSeriesId = `series_${candidate.series_key}`;
    const confidence = candidate.extraction_confidence ?? "low";
    seriesRows.push({
      chart_series_id: chartSeriesId,
      paper_id: paperId,
      paper_id_namespace: paperNamespace,
      figure_id: figureId ?? "unknown",
      series_label: candidate.series_label,
      x_axis_name: candidate.x_axis_name,
      x_axis_unit: xUnit ?? PAPER_ID_ABSENT,
      y_axis_name: candidate.y_axis_name,
      y_axis_unit: yUnit ?? PAPER_ID_ABSENT,
      x_scale: candidate.x_scale,
      y_scale: candidate.y_scale,
      legend_text: legendText ?? PAPER_ID_ABSENT,
      axis_validation_status: axisStatus,
      legend_validation_status: legendStatus,
      human_review_status: "pending",
      source_id: pdfSourceId,
      source_asset_id: pdfAssetId,
      source_locator: imageBboxLocator({
        assetId: pdfAssetId,
        logicalFile: pdfLogicalFile,
        rawValue: degradations.length > 0
          ? `series degraded: ${degradations.join("; ")}`
          : `${candidate.series_label} in ${figureId}`,
        pageNumber: page.pageNumber,
        figureId: figureId ?? "unknown",
        bbox: candidate.bbox ?? [0, 0, 1, 1],
      }),
      model_name: config.model,
      model_version: modelVersion,
      extraction_method: "vlm",
      extraction_confidence: confidence,
      source_reliability: "medium",
      extraction_reliability: extractionReliability(confidence),
      transform_provenance: carrierProvenance({
        modelName: config.model,
        modelVersion,
        sourceReliability: "medium",
        extractionReliability: extractionReliability(confidence),
        step,
      }),
    });

    if (degradations.length > 0) {
      warnings.push(`series ${chartSeriesId} degraded to unclear no-points: ${degradations.join("; ")}`);
      continue;
    }
    if (axisStatus !== "clear" || legendStatus !== "clear") continue;

    const seriesPointCandidates = pointCandidates.filter(
      (entry) => entry.candidate.series_key === candidate.series_key,
    );
    let admitted = 0;
    for (const [pointIndex, pointEntry] of seriesPointCandidates.entries()) {
      const candidate_ = pointEntry.candidate;
      const drop = (reason: string): void => {
        warnings.push(`point dropped from ${chartSeriesId}: ${reason}`);
      };
      if (candidate_.bbox === null) {
        drop("point locator missing");
        continue;
      }
      if (candidate_.extraction_confidence === null || candidate_.confidence_reason === null) {
        drop("point confidence or confidence reason missing");
        continue;
      }
      if (!Number.isFinite(Number(candidate_.x_value)) || !Number.isFinite(Number(candidate_.y_value))) {
        drop("point coordinates are not finite numeric tokens");
        continue;
      }
      const activityId = activityIdByKey.get(candidate_.activity_key);
      if (activityId === undefined) {
        drop(`activity_key '${candidate_.activity_key}' does not match an extracted activity`);
        continue;
      }
      const pointId = `${chartSeriesId}_p${pointIndex + 1}`;
      pointIds.push(pointId);
      admitted += 1;
      pointRows.push({
        point_id: pointId,
        chart_series_id: chartSeriesId,
        activity_id: activityId,
        x_value: candidate_.x_value,
        y_value: candidate_.y_value,
        point_type: candidate_.point_type,
        estimated_or_exact: "estimated",
        pixel_or_coordinate_locator: imageBboxLocator({
          assetId: pdfAssetId,
          logicalFile: pdfLogicalFile,
          rawValue: `Estimated point (${candidate_.x_value}, ${candidate_.y_value})`,
          pageNumber: pointEntry.page.pageNumber,
          figureId: figureId ?? "unknown",
          bbox: candidate_.bbox,
        }),
        extraction_confidence: candidate_.extraction_confidence,
        confidence_reason: candidate_.confidence_reason,
        review_status: "pending",
        review_id: null,
        source_reliability: "medium",
        extraction_reliability: extractionReliability(candidate_.extraction_confidence),
        original_x_value: null,
        original_y_value: null,
        transform_provenance: carrierProvenance({
          modelName: config.model,
          modelVersion,
          sourceReliability: "medium",
          extractionReliability: extractionReliability(candidate_.extraction_confidence),
          step: transformStep({
            stepId: `vlm_extract_p${pointEntry.page.pageNumber}_${candidate.series_key}_pt${pointIndex + 1}`,
            pageNumber: pointEntry.page.pageNumber,
            inputDigest: pointEntry.page.inputDigest,
            outputDigest: pointEntry.page.outputDigest,
          }),
        }),
      });
    }
    // A clear series may only be registered with points; otherwise it becomes
    // an explicit unclear no-points series instead of an exact-looking stub.
    if (admitted === 0) {
      const series = seriesRows[seriesRows.length - 1];
      if (series !== undefined) {
        series.axis_validation_status = "unclear";
        series.legend_validation_status = "unclear";
      }
      warnings.push(`series ${chartSeriesId} admitted no points and was marked unclear`);
    }
  }

  const chartPapers: ChartPaperInput[] = [{
    paper_id: paperId,
    paper_id_namespace: paperNamespace,
    title: paperMeta.title,
    journal: paperMeta.journal,
    publication_date: paperMeta.publication_date,
    authors: paperMeta.authors,
    source_url: paperMeta.source_url,
    source_id: xmlSourceId,
  }];
  const chartSources: ChartSourceInput[] = [{
    source_id: xmlSourceId,
    source_database: "paper_full_text",
    source_asset_id: xmlAssetId,
    source_locator: {
      locator_version: "2.0",
      locator_type: "json_pointer",
      asset_id: xmlAssetId,
      logical_file: xml.receipt.relative_path,
      raw_value: "registered paper full-text XML carrier",
      json_pointer: "/",
    },
    retrieved_at: retrievedAt,
    carrier_type: "xml_full_text",
  }, {
    source_id: pdfSourceId,
    source_database: "paper_full_text",
    source_asset_id: pdfAssetId,
    source_locator: pdfRegionLocator({
      assetId: pdfAssetId,
      logicalFile: pdfLogicalFile,
      rawValue: "registered paper PDF carrier",
      pageNumber: 1,
      tableId: null,
      figureId: null,
      rowLabel: null,
      columnLabel: null,
    }),
    retrieved_at: retrievedAt,
    carrier_type: "pdf_document",
  }];
  const chartRows: ChartEvidenceRows = {
    chart_series: seriesRows,
    chart_points: pointRows,
    papers: chartPapers,
    sources: chartSources,
  };

  // -- 7. Hostile validation against the formal table contracts.
  try {
    assertPaperEvidenceRows(paperRows, registeredIds);
  } catch (error) {
    throw new ChartExtractionError(
      `paper evidence rows rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const derivedActivityIds = new Set(derived.activities.map((activity) => activity.activity_id));
  try {
    assertChartEvidenceCarrierRows(chartRows, derivedActivityIds);
  } catch (error) {
    throw new ChartExtractionError(
      `chart evidence rows rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // -- 8. Serialize with stable key order, write, and register atomically.
  const carrier = {
    schema_version: "1.0",
    carrier_kind: REGISTERED_PAPER_CHART_CARRIER_KIND,
    paper_id: paperId,
    paper_id_namespace: paperNamespace,
    extraction: {
      implementation: REGISTERED_PAPER_CHART_EXTRACTION_IMPLEMENTATION,
      implementation_version: REGISTERED_PAPER_CHART_EXTRACTION_VERSION,
      prompt_version: REGISTERED_PAPER_CHART_PROMPT_VERSION,
      model: { provider: providerHost, model: config.model, model_version: modelVersion },
      source_assets: {
        paper_xml_asset_id: xmlAssetId,
        paper_pdf_asset_id: pdfAssetId,
        supplementary_asset_ids: supplementIds,
      },
    },
    paper_records: paperRecords,
    experiment_records: experimentRecords,
    activity_value_records: activityRecords,
    supplementary_asset_records: supplementaryRecords,
    chart_series: seriesRows,
    chart_points: pointRows,
    papers: chartRows.papers,
    sources: chartRows.sources,
  };
  const bytes = Buffer.from(JSON.stringify(carrier), "utf8");
  const digest = sha256(bytes);
  const relativePath = `source_assets/paper_chart_evidence/evidence_${digest.slice(0, 12)}.json`;
  const candidateParametersDigest = canonicalDigest({
    stage: "candidate",
    parent_asset_ids: formalParentAssetIds,
    prompt_version: REGISTERED_PAPER_CHART_PROMPT_VERSION,
    model_name: config.model,
    model_version: modelVersion,
  });
  const receipt = await registerDerivedJsonAsset({
    taskRoot: deps.taskRoot,
    sourceAssetRegistry: deps.sourceAssetRegistry,
    sourceId: `paper_chart_evidence_${digest.slice(0, 12)}`,
    relativePath,
    role: "carrier",
    bytes,
    parentAssetIds: formalParentAssetIds,
    requirementId: "registered_paper_chart_candidate",
    stage: "candidate",
    parametersDigest: candidateParametersDigest,
    evidence: {
      carrier_kind: REGISTERED_PAPER_CHART_CARRIER_KIND,
      paper_id: paperId,
      paper_id_namespace: paperNamespace,
      source_asset_ids: formalParentAssetIds,
      prompt_version: REGISTERED_PAPER_CHART_PROMPT_VERSION,
      model_name: config.model,
      model_version: modelVersion,
      output_sha256: digest,
    },
  });

  // -- 9. ONE evidence-bound review batch for ALL pending carrier estimates.
  let carrierReview: RegisteredPaperChartCarrierReview | null = null;
  if (deps.hilGate != null && pointRows.length > 0) {
    const subject: HILSubject = {
      source_asset_ids: [receipt.asset_ref.asset_id],
      record_ids: pointIds.slice(0, MAX_REVIEW_IDS),
    };
    const reviewItems = pointRows.map((point) => ({
      item_id: point.point_id,
      summary: `${point.point_id}: (${point.x_value}, ${point.y_value}) ${point.extraction_confidence}`,
      subject: { record_ids: [point.point_id] },
      evidence: {
        carrier_asset_id: receipt.asset_ref.asset_id,
        chart_series_id: point.chart_series_id,
        x_value: point.x_value,
        y_value: point.y_value,
        extraction_confidence: point.extraction_confidence,
        confidence_reason: point.confidence_reason,
      },
      proposed_value: { x: point.x_value, y: point.y_value },
      confidence_level: point.extraction_confidence,
    }));
    const reviewRequest = {
      requirement_id: null,
      kind: "data_review" as const,
      review_type: "vlm_extraction" as const,
      blocking: true as const,
      subject,
      review_items: reviewItems,
      summary:
        `${pointRows.length} pending VLM estimate(s) registered in carrier ` +
        `${receipt.asset_ref.asset_id} require review`,
      evidence: JSON.parse(JSON.stringify({
        carrier: {
          asset_id: receipt.asset_ref.asset_id,
          sha256: receipt.sha256,
          relative_path: receipt.relative_path,
        },
        points: pointRows.map((point) => ({
          point_id: point.point_id,
          chart_series_id: point.chart_series_id,
          activity_id: point.activity_id,
          x_value: point.x_value,
          y_value: point.y_value,
          estimated_or_exact: point.estimated_or_exact,
          extraction_confidence: point.extraction_confidence,
        })),
      })) as JsonValue,
      policy_ref: "dataset.vlm_extraction.v1",
      idempotency_key: `registered_paper_chart:${receipt.asset_ref.asset_id}`,
    };
    const review = await deps.hilGate.requestHIL(reviewRequest, signal);
    if (review.decision.action === "approve") {
      fail("approve is not valid for VLM data review");
    }
    if (review.decision.action === "reject" || review.decision.action === "skip") {
      // The whole carrier batch was declined: its estimates are not
      // publishable, so the governed extraction outcome fails closed.
      fail(
        `carrier ${receipt.asset_ref.asset_id} was ` +
          `${review.decision.action === "skip" ? "skipped" : "rejected"} by human review; ` +
          "its pending VLM estimates are not publishable",
      );
    }
    carrierReview = {
      request_id: review.request_id,
      review_id: review.review_id,
      action: review.decision.action,
      reviewer: review.reviewer,
      reviewed_at: review.reviewed_at,
      evidence_digest: review.evidence_digest,
      reason: review.reason,
      correction: review.decision.action === "correct"
        ? review.decision.correction
        : null,
    };
  }

  // -- 10. Review-closed publication carrier (Gold6 T8). The candidate
  // carrier keeps its pending rows and is never bound for publication; the
  // deterministic review application derives a SECOND content-addressed
  // carrier whose rows pass the publication-stage review gate and whose
  // committed Core-derived provenance lets the dynamic route bind it as a
  // task-owned formal source.
  let reviewedCarrier: RegisteredPaperChartCarrierSummary | null = null;
  if (carrierReview !== null && pointRows.length > 0) {
    reviewedCarrier = await registerReviewedPublicationCarrier({
      taskRoot: deps.taskRoot,
      retrievedAt,
      candidateCarrier: {
        schema_version: "1.0",
        carrier_kind: REGISTERED_PAPER_CHART_CARRIER_KIND,
        paper_id: paperId,
        paper_id_namespace: paperNamespace,
        extraction: {
          implementation: REGISTERED_PAPER_CHART_EXTRACTION_IMPLEMENTATION,
          implementation_version: REGISTERED_PAPER_CHART_EXTRACTION_VERSION,
          prompt_version: REGISTERED_PAPER_CHART_PROMPT_VERSION,
          model: { provider: providerHost, model: config.model, model_version: modelVersion },
          source_assets: {
            paper_xml_asset_id: xmlAssetId,
            paper_pdf_asset_id: pdfAssetId,
            supplementary_asset_ids: supplementIds,
          },
        },
        paper_records: paperRecords,
        experiment_records: experimentRecords,
        activity_value_records: activityRecords,
        supplementary_asset_records: supplementaryRecords,
        chart_series: seriesRows,
        chart_points: pointRows,
        papers: chartRows.papers,
        sources: chartRows.sources,
      },
      candidateCarrierReceipt: receipt,
      seriesRows,
      pointRows,
      derivedActivityIds,
      review: {
        request_id: carrierReview.request_id,
        review_id: carrierReview.review_id,
        action: carrierReview.action,
        reviewer: carrierReview.reviewer,
        reviewed_at: carrierReview.reviewed_at,
        evidence_digest: carrierReview.evidence_digest,
        reason: carrierReview.reason,
        correction: carrierReview.correction,
      },
      sourceAssetRegistry: deps.sourceAssetRegistry,
    });
  }

  return {
    status: "ok",
    carrier: {
      asset_id: receipt.asset_ref.asset_id,
      receipt_id: receipt.receipt_id,
      sha256: receipt.sha256,
      size_bytes: receipt.size_bytes,
      media_type: receipt.media_type,
      relative_path: receipt.relative_path,
      role: receipt.asset_ref.role,
      registered_at: receipt.registered_at,
    },
    model: { provider: providerHost, model: config.model, model_version: modelVersion },
    rows: {
      paper_records: paperRecords.length,
      experiment_records: experimentRecords.length,
      activity_value_records: activityRecords.length,
      supplementary_asset_records: supplementaryRecords.length,
      chart_series: seriesRows.length,
      chart_points: pointRows.length,
      papers: chartRows.papers.length,
      sources: chartRows.sources.length,
    },
    pending_review: {
      series_count: seriesRows.length,
      point_count: pointRows.length,
      review_ids: pointIds.slice(0, MAX_REVIEW_IDS),
      ...(carrierReview === null ? {} : { review: carrierReview }),
    },
    warnings: warnings.slice(0, MAX_WARNINGS),
    ...(reviewedCarrier === null ? {} : { reviewed_carrier: reviewedCarrier }),
  };
}

/**
 * Deterministic evidence-bound review application (Gold6 T8): accept closes
 * every estimate with review provenance, correct preserves the original
 * values and appends a ``human_correction`` transform step, and the resulting
 * rows must pass the strict publication-stage chart gate before the reviewed
 * carrier is registered. The reviewed carrier is Core-derived from the
 * candidate and byte-bound review evidence so dynamic submission can resolve
 * it without disguising model output as provider acquisition.
 */
async function registerReviewedPublicationCarrier(options: {
  taskRoot: string;
  retrievedAt: string;
  candidateCarrier: Record<string, unknown>;
  candidateCarrierReceipt: SourceAssetRegistrationReceipt;
  seriesRows: ChartSeriesInput[];
  pointRows: ChartPointInput[];
  derivedActivityIds: ReadonlySet<string>;
  review: RegisteredPaperChartCarrierReview;
  sourceAssetRegistry: SourceAssetRegistry;
}): Promise<RegisteredPaperChartCarrierSummary> {
  const { review } = options;
  if (review.reviewer !== "user") {
    fail(
      `carrier review ${review.review_id} was resolved by '${review.reviewer}'; ` +
        "publication closure requires a human reviewer",
    );
  }
  const reviewProvenance: ChartReviewProvenance = {
    review_id: review.review_id,
    status: review.action === "accept" ? "accepted" : "corrected",
    reviewer: "user",
    reviewed_at: review.reviewed_at,
    evidence_digest: review.evidence_digest,
    reason: review.reason !== null && review.reason.trim() !== ""
      ? review.reason
      : `estimates ${review.action === "accept" ? "accepted" : "corrected"} by human review`,
  };
  interface CorrectionEntry {
    x_value?: string | number;
    y_value?: string | number;
  }
  let corrections: Record<string, CorrectionEntry> | null = null;
  if (review.action === "correct") {
    const root = review.correction !== null && typeof review.correction === "object" && !Array.isArray(review.correction)
      ? review.correction as Record<string, JsonValue>
      : null;
    const points = root === null || root.points === null || typeof root.points !== "object" || Array.isArray(root.points)
      ? null
      : root.points as Record<string, JsonValue>;
    if (points === null) {
      fail("correct review requires a structured correction.points object");
    }
    corrections = {};
    for (const [pointId, entry] of Object.entries(points)) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        fail(`correction for ${pointId} must be an object with optional x_value/y_value`);
      }
      const item = entry as Record<string, JsonValue>;
      for (const field of ["x_value", "y_value"] as const) {
        if (item[field] !== undefined && typeof item[field] !== "string" && typeof item[field] !== "number") {
          fail(`correction ${field} for ${pointId} must be a numeric token`);
        }
      }
      corrections[pointId] = {
        ...(item.x_value === undefined ? {} : { x_value: item.x_value as string | number }),
        ...(item.y_value === undefined ? {} : { y_value: item.y_value as string | number }),
      };
    }
  }

  const reviewedPoints: ChartPointInput[] = options.pointRows.map((point) => {
    const provenance: ChartTransformProvenance = {
      ...point.transform_provenance,
      review: reviewProvenance,
    };
    if (review.action === "accept") {
      return {
        ...point,
        review_status: "accepted" as const,
        review_id: review.review_id,
        transform_provenance: provenance,
      };
    }
    const entry = corrections![point.point_id];
    if (entry === undefined) {
      fail(`correct review is missing a correction entry for ${point.point_id}`);
    }
    const originalX = point.x_value;
    const originalY = point.y_value;
    const correctedX = entry.x_value === undefined ? originalX : String(entry.x_value);
    const correctedY = entry.y_value === undefined ? originalY : String(entry.y_value);
    if (!Number.isFinite(Number(correctedX)) || !Number.isFinite(Number(correctedY))) {
      fail(`correction for ${point.point_id} must keep finite numeric coordinates`);
    }
    const correctedFields = [
      ...(correctedX !== originalX ? ["x_value"] : []),
      ...(correctedY !== originalY ? ["y_value"] : []),
    ];
    const correctionStep: ChartTransformStep = {
      step_id: `human_correction_${point.point_id}`,
      operation: "human_correction",
      implementation: "durable-hil-review",
      implementation_version: "1.0.0",
      parameters: { fields: correctedFields },
      input_digest: sha256(Buffer.from(JSON.stringify({ x: originalX, y: originalY }), "utf8")),
      output_digest: sha256(Buffer.from(JSON.stringify({ x: correctedX, y: correctedY }), "utf8")),
    };
    return {
      ...point,
      x_value: correctedX,
      y_value: correctedY,
      original_x_value: originalX,
      original_y_value: originalY,
      review_status: "corrected" as const,
      review_id: review.review_id,
      transform_provenance: { ...provenance, steps: [...provenance.steps, correctionStep] },
    };
  });

  const reviewedRows: ChartEvidenceRows = {
    chart_series: options.seriesRows,
    chart_points: reviewedPoints,
    papers: (options.candidateCarrier.papers as ChartPaperInput[]),
    sources: (options.candidateCarrier.sources as ChartSourceInput[]),
  };
  try {
    assertChartEvidenceRows(reviewedRows, options.derivedActivityIds);
  } catch (error) {
    throw new ChartExtractionError(
      `reviewed publication rows rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const reviewEvidence = {
    schema_version: "1.0",
    evidence_kind: "registered_paper_chart_review",
    candidate_carrier: {
      asset_id: options.candidateCarrierReceipt.asset_ref.asset_id,
      sha256: options.candidateCarrierReceipt.sha256,
      relative_path: options.candidateCarrierReceipt.relative_path,
    },
    review,
  };
  const reviewEvidenceBytes = Buffer.from(JSON.stringify(reviewEvidence), "utf8");
  const reviewEvidenceDigest = sha256(reviewEvidenceBytes);
  const reviewEvidenceParametersDigest = canonicalDigest({
    stage: "review_evidence",
    candidate_carrier_asset_id: options.candidateCarrierReceipt.asset_ref.asset_id,
    request_id: review.request_id,
    review_id: review.review_id,
    evidence_digest: review.evidence_digest,
    action: review.action,
  });
  const reviewEvidenceReceipt = await registerDerivedJsonAsset({
    taskRoot: options.taskRoot,
    sourceAssetRegistry: options.sourceAssetRegistry,
    sourceId: `paper_chart_review_${reviewEvidenceDigest.slice(0, 12)}`,
    relativePath: `source_assets/paper_chart_evidence/review_${reviewEvidenceDigest.slice(0, 12)}.json`,
    role: "source",
    bytes: reviewEvidenceBytes,
    parentAssetIds: [options.candidateCarrierReceipt.asset_ref.asset_id],
    requirementId: "registered_paper_chart_review_evidence",
    stage: "review_evidence",
    parametersDigest: reviewEvidenceParametersDigest,
    evidence: {
      candidate_carrier_asset_id: options.candidateCarrierReceipt.asset_ref.asset_id,
      review_id: review.review_id,
      request_id: review.request_id,
      review_evidence_digest: review.evidence_digest,
      output_sha256: reviewEvidenceDigest,
    },
  });

  const reviewedCarrier = {
    ...options.candidateCarrier,
    chart_points: reviewedPoints,
  };
  const reviewedBytes = Buffer.from(JSON.stringify(reviewedCarrier), "utf8");
  const reviewedDigest = sha256(reviewedBytes);
  const reviewedRelativePath = `source_assets/paper_chart_evidence/reviewed_${reviewedDigest.slice(0, 12)}.json`;
  const reviewedParametersDigest = canonicalDigest({
    stage: "reviewed",
    candidate_carrier_asset_id: options.candidateCarrierReceipt.asset_ref.asset_id,
    review_evidence_asset_id: reviewEvidenceReceipt.asset_ref.asset_id,
    review_id: review.review_id,
    review_action: review.action,
  });
  const reviewedReceipt = await registerDerivedJsonAsset({
    taskRoot: options.taskRoot,
    sourceAssetRegistry: options.sourceAssetRegistry,
    sourceId: `paper_chart_evidence_reviewed_${reviewedDigest.slice(0, 12)}`,
    relativePath: reviewedRelativePath,
    role: "carrier",
    bytes: reviewedBytes,
    parentAssetIds: [
      options.candidateCarrierReceipt.asset_ref.asset_id,
      reviewEvidenceReceipt.asset_ref.asset_id,
    ],
    requirementId: "registered_paper_chart_reviewed",
    stage: "reviewed",
    parametersDigest: reviewedParametersDigest,
    evidence: {
      candidate_carrier_asset_id: options.candidateCarrierReceipt.asset_ref.asset_id,
      review_evidence_asset_id: reviewEvidenceReceipt.asset_ref.asset_id,
      review_id: review.review_id,
      review_action: review.action,
      output_sha256: reviewedDigest,
    },
  });
  return {
    asset_id: reviewedReceipt.asset_ref.asset_id,
    receipt_id: reviewedReceipt.receipt_id,
    sha256: reviewedReceipt.sha256,
    size_bytes: reviewedReceipt.size_bytes,
    media_type: reviewedReceipt.media_type,
    relative_path: reviewedReceipt.relative_path,
    role: reviewedReceipt.asset_ref.role,
    registered_at: options.retrievedAt,
  };
}
