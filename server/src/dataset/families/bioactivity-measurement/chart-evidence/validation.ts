import type { ImageBBoxSourceLocator } from "@biomed/contracts";

import type {
  MultiTableValidationRequest,
  MultiTableValidationResult,
} from "../../../contracts/index.js";
import { parseSourceLocator } from "../../../contracts/index.js";
import { validateMultiTableCandidate } from "../../../validation/multitable.js";
import {
  bioactivityRelations,
  bioactivityTableEntries,
  bioactivityValidationPolicy,
} from "../schemas.js";
import {
  chartEvidenceRelations,
  chartEvidenceTables,
} from "./schemas.js";
import type {
  ChartEvidenceRows,
  ChartPointInput,
  ChartReviewStatus,
  ChartSeriesInput,
  ChartTransformProvenance,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CONTENT_ASSET_ID = /^asset_[0-9a-f]{64}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T/;
const REVIEW_STATUSES = ["not_required", "pending", "accepted", "corrected", "rejected"] as const;
const REVIEWED = new Set<ChartReviewStatus>(["accepted", "corrected"]);
/**
 * Evidence stages for the rows. ``carrier`` rows are fresh VLM candidate
 * evidence registered before any human review; ``publication`` rows are the
 * review-closed rows admitted into a PublicationCandidate.
 */
export type ChartEvidenceStage = "carrier" | "publication";
const AXIS_STATUSES = ["clear", "unclear", "human_validated"] as const;
const LEGEND_STATUSES = ["clear", "unclear", "human_validated"] as const;
const CONFIDENCE_LEVELS = ["high", "medium", "low"] as const;
const RELIABILITY_LEVELS = ["high", "medium", "low"] as const;
const VALUE_PRECISIONS = ["exact", "estimated"] as const;
const TRANSFORM_OPERATIONS = [
  "vlm_extract",
  "coordinate_transform",
  "unit_transform",
  "human_correction",
] as const;

export interface ChartEvidencePublicationCheck {
  check_id: string;
  passed: boolean;
  detail: string;
}

export interface ChartEvidencePublicationResult {
  publishable: boolean;
  checks: ChartEvidencePublicationCheck[];
}

function fail(message: string): never {
  throw new TypeError(`chart evidence rejected: ${message}`);
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} is required`);
  return value;
}

function safeId(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!SAFE_ID.test(parsed) || parsed.includes("..")) fail(`${name} is not a safe identifier`);
  return parsed;
}

function finiteToken(value: unknown, name: string): string {
  const parsed = text(value, name);
  if (!Number.isFinite(Number(parsed))) fail(`${name} must be a finite numeric token`);
  return parsed;
}

function controlled<T extends string>(
  value: unknown,
  values: readonly T[],
  name: string,
): T {
  const parsed = text(value, name);
  if (!values.includes(parsed as T)) fail(`${name} has unsupported value '${parsed}'`);
  return parsed as T;
}

function imageLocator(value: unknown, name: string, assetId?: string): ImageBBoxSourceLocator {
  let parsed: ReturnType<typeof parseSourceLocator>;
  try {
    parsed = parseSourceLocator(value);
  } catch (error) {
    fail(`${name} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!("locator_version" in parsed) || parsed.locator_version !== "2.0" || parsed.locator_type !== "image_bbox") {
    fail(`${name} must be a SourceLocator 2.0 image_bbox`);
  }
  if (!CONTENT_ASSET_ID.test(parsed.asset_id)) fail(`${name}.asset_id must be content addressed`);
  if (assetId !== undefined && parsed.asset_id !== assetId) fail(`${name}.asset_id does not match source_asset_id`);
  if (parsed.bbox.some((coordinate) => !Number.isFinite(coordinate) || coordinate < 0)) {
    fail(`${name}.bbox must contain finite non-negative coordinates`);
  }
  if (parsed.bbox[2] <= parsed.bbox[0] || parsed.bbox[3] <= parsed.bbox[1]) {
    fail(`${name}.bbox must have positive width and height`);
  }
  return parsed;
}

/**
 * Source carriers may be PDFs or XML full text, so the sources table accepts
 * any SourceLocator 2.0 that resolves to its content-addressed asset. Visual
 * rows (series/points) keep the strict image_bbox rule via ``imageLocator``.
 */
function sourceCarrierLocator(value: unknown, name: string, assetId?: string): void {
  let parsed: ReturnType<typeof parseSourceLocator>;
  try {
    parsed = parseSourceLocator(value);
  } catch (error) {
    fail(`${name} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!("locator_version" in parsed) || parsed.locator_version !== "2.0") {
    fail(`${name} must be a SourceLocator 2.0`);
  }
  if (!CONTENT_ASSET_ID.test(parsed.asset_id)) fail(`${name}.asset_id must be content addressed`);
  if (assetId !== undefined && parsed.asset_id !== assetId) fail(`${name}.asset_id does not match source_asset_id`);
}

function assertProvenance(
  provenance: ChartTransformProvenance,
  owner: ChartSeriesInput | ChartPointInput,
  name: string,
  stage: ChartEvidenceStage,
): void {
  if (provenance.schema_version !== "1.0") fail(`${name}.schema_version must be 1.0`);
  text(provenance.model_name, `${name}.model_name`);
  text(provenance.model_version, `${name}.model_version`);
  controlled(
    provenance.source_reliability_at_extraction,
    RELIABILITY_LEVELS,
    `${name}.source_reliability_at_extraction`,
  );
  controlled(
    provenance.extraction_reliability_at_extraction,
    RELIABILITY_LEVELS,
    `${name}.extraction_reliability_at_extraction`,
  );
  if ("model_name" in owner && provenance.model_name !== owner.model_name) {
    fail(`${name}.model_name does not match the series model`);
  }
  if ("model_version" in owner && provenance.model_version !== owner.model_version) {
    fail(`${name}.model_version does not match the series model`);
  }
  if (provenance.steps.length === 0 || provenance.steps[0]?.operation !== "vlm_extract") {
    fail(`${name} must begin with a vlm_extract step`);
  }
  const stepIds = new Set<string>();
  for (const step of provenance.steps) {
    safeId(step.step_id, `${name}.step_id`);
    if (stepIds.has(step.step_id)) fail(`${name} contains duplicate step_id ${step.step_id}`);
    stepIds.add(step.step_id);
    controlled(step.operation, TRANSFORM_OPERATIONS, `${name}.operation`);
    text(step.implementation, `${name}.implementation`);
    text(step.implementation_version, `${name}.implementation_version`);
    if (!SHA256.test(step.input_digest) || !SHA256.test(step.output_digest)) {
      fail(`${name} transform digests must be lowercase SHA-256`);
    }
    if (typeof step.parameters !== "object" || step.parameters === null || Array.isArray(step.parameters)) {
      fail(`${name}.parameters must be an object`);
    }
  }
  if (owner.source_reliability !== provenance.source_reliability_at_extraction) {
    fail(`${name} human review must not upgrade source reliability`);
  }
  const reviewStatus = controlled(
    "review_status" in owner ? owner.review_status : owner.human_review_status,
    REVIEW_STATUSES,
    `${name}.review_status`,
  );
  if (stage === "carrier" && REVIEWED.has(reviewStatus)) {
    fail(`${name} carrier-stage rows must remain pending evidence-bound review`);
  }
  if (REVIEWED.has(reviewStatus) &&
      owner.extraction_reliability !== provenance.extraction_reliability_at_extraction) {
    fail(`${name} human review must not upgrade extraction reliability`);
  }
  if (REVIEWED.has(reviewStatus)) {
    const review = provenance.review;
    if (review === null || review.status !== reviewStatus || review.reviewer !== "user") {
      fail(`${name} reviewed row requires matching user review provenance`);
    }
    safeId(review.review_id, `${name}.review_id`);
    if (!("review_id" in owner) || owner.review_id !== review.review_id) {
      if ("review_id" in owner) fail(`${name}.review_id does not match review provenance`);
    }
    if (!ISO_DATETIME.test(review.reviewed_at) || Number.isNaN(Date.parse(review.reviewed_at))) {
      fail(`${name}.reviewed_at must be ISO 8601`);
    }
    if (!SHA256.test(review.evidence_digest)) fail(`${name}.evidence_digest must be lowercase SHA-256`);
    text(review.reason, `${name}.review reason`);
  } else if (provenance.review !== null) {
    fail(`${name} unreviewed row must not carry resolved review provenance`);
  }
}

function assertSeries(series: ChartSeriesInput, stage: ChartEvidenceStage): void {
  safeId(series.chart_series_id, "chart_series_id");
  safeId(series.paper_id, "paper_id");
  text(series.paper_id_namespace, "paper_id_namespace");
  text(series.figure_id, "figure_id");
  text(series.series_label, "series_label");
  text(series.x_axis_name, "x_axis_name");
  text(series.x_axis_unit, "x_axis_unit");
  text(series.y_axis_name, "y_axis_name");
  text(series.y_axis_unit, "y_axis_unit");
  text(series.x_scale, "x_scale");
  text(series.y_scale, "y_scale");
  text(series.legend_text, "legend_text");
  controlled(series.axis_validation_status, AXIS_STATUSES, "axis_validation_status");
  controlled(series.legend_validation_status, LEGEND_STATUSES, "legend_validation_status");
  controlled(series.human_review_status, REVIEW_STATUSES, "human_review_status");
  controlled(series.extraction_confidence, CONFIDENCE_LEVELS, "extraction_confidence");
  controlled(series.source_reliability, RELIABILITY_LEVELS, "source_reliability");
  controlled(series.extraction_reliability, RELIABILITY_LEVELS, "extraction_reliability");
  safeId(series.source_id, "source_id");
  if (!CONTENT_ASSET_ID.test(series.source_asset_id)) fail("source_asset_id must be content addressed");
  imageLocator(series.source_locator, "source_locator", series.source_asset_id);
  text(series.model_name, "model_name");
  text(series.model_version, "model_version");
  if (series.extraction_method !== "vlm") fail("extraction_method must be vlm");
  if (series.human_review_status === "rejected") fail(`series ${series.chart_series_id} was rejected`);
  assertProvenance(series.transform_provenance, series, `series ${series.chart_series_id} provenance`, stage);
}

export function assertChartPointReviewClosure(input: {
  pointId: string;
  estimatedOrExact: string;
  extractionConfidence: string;
  reviewStatus: string;
  reviewId: string | null;
  transformProvenance: unknown;
}): void {
  const reviewed = input.reviewStatus === "accepted" || input.reviewStatus === "corrected";
  if (input.estimatedOrExact === "estimated" && !reviewed) {
    fail(`estimated point ${input.pointId} requires accepted or corrected review`);
  }
  if (input.extractionConfidence === "low" && !reviewed) {
    fail(`low-confidence primary point ${input.pointId} requires review`);
  }
  if (reviewed && (input.reviewId === null || input.reviewId.trim() === "")) {
    fail(`point ${input.pointId} reviewed state requires review_id`);
  }
  if (reviewed) {
    if (input.transformProvenance === null || typeof input.transformProvenance !== "object" || Array.isArray(input.transformProvenance)) {
      fail(`point ${input.pointId} reviewed state requires transform provenance`);
    }
    const review = (input.transformProvenance as { review?: unknown }).review;
    if (review === null || typeof review !== "object" || Array.isArray(review)) {
      fail(`point ${input.pointId} reviewed state requires review provenance`);
    }
    const record = review as { review_id?: unknown; status?: unknown; evidence_digest?: unknown };
    if (
      record.review_id !== input.reviewId
      || record.status !== input.reviewStatus
      || typeof record.evidence_digest !== "string"
      || !SHA256.test(record.evidence_digest)
    ) {
      fail(`point ${input.pointId} review provenance does not match its reviewed state`);
    }
  }
}

function assertPoint(point: ChartPointInput, series: ChartSeriesInput, stage: ChartEvidenceStage): void {
  safeId(point.point_id, "point_id");
  safeId(point.chart_series_id, "chart_series_id");
  safeId(point.activity_id, "activity_id");
  finiteToken(point.x_value, "x_value");
  finiteToken(point.y_value, "y_value");
  text(point.point_type, "point_type");
  controlled(point.estimated_or_exact, VALUE_PRECISIONS, "estimated_or_exact");
  controlled(point.extraction_confidence, CONFIDENCE_LEVELS, "extraction_confidence");
  controlled(point.review_status, REVIEW_STATUSES, "review_status");
  controlled(point.source_reliability, RELIABILITY_LEVELS, "source_reliability");
  controlled(point.extraction_reliability, RELIABILITY_LEVELS, "extraction_reliability");
  text(point.confidence_reason, "confidence_reason");
  const locator = imageLocator(point.pixel_or_coordinate_locator, "pixel_or_coordinate_locator", series.source_asset_id);
  const seriesLocator = imageLocator(series.source_locator, "series source_locator", series.source_asset_id);
  if (point.transform_provenance.model_name !== series.model_name ||
      point.transform_provenance.model_version !== series.model_version) {
    fail(`point ${point.point_id} model identity does not match its chart series`);
  }
  if (locator.figure_id !== seriesLocator.figure_id || locator.page_number !== seriesLocator.page_number) {
    fail(`point ${point.point_id} locator does not match its chart figure`);
  }
  if (point.review_status === "rejected") fail(`point ${point.point_id} was rejected`);
  if (stage === "carrier" && point.estimated_or_exact !== "estimated") {
    fail(`carrier-stage point ${point.point_id} must be estimated, never exact`);
  }
  if (stage === "publication" && point.estimated_or_exact === "estimated" && !REVIEWED.has(point.review_status)) {
    fail(`estimated point ${point.point_id} requires accepted or corrected review`);
  }
  if (stage === "publication" && point.extraction_confidence === "low" && !REVIEWED.has(point.review_status)) {
    fail(`low-confidence primary point ${point.point_id} requires review`);
  }
  if (stage === "publication") {
    assertChartPointReviewClosure({
      pointId: point.point_id,
      estimatedOrExact: point.estimated_or_exact,
      extractionConfidence: point.extraction_confidence,
      reviewStatus: point.review_status,
      reviewId: point.review_id,
      transformProvenance: point.transform_provenance,
    });
  }
  if (point.estimated_or_exact === "exact" &&
      (series.axis_validation_status === "unclear" || series.legend_validation_status === "unclear")) {
    fail(`exact point ${point.point_id} cannot use unclear axis or legend semantics`);
  }
  if (point.review_status === "corrected") {
    if (point.original_x_value === null || point.original_y_value === null ||
        !point.transform_provenance.steps.some((step) => step.operation === "human_correction")) {
      fail(`corrected point ${point.point_id} requires original values and a human_correction transform`);
    }
  }
  if (point.review_status === "accepted" &&
      (point.original_x_value !== null || point.original_y_value !== null)) {
    fail(`accepted point ${point.point_id} must not claim corrected original values`);
  }
  assertProvenance(point.transform_provenance, point, `point ${point.point_id} provenance`, stage);
}

export function assertChartEvidenceRows(
  rows: ChartEvidenceRows,
  activityIds: ReadonlySet<string>,
): void {
  assertChartEvidenceRowsForStage(rows, activityIds, "publication");
}

/**
 * Carrier-stage gate for freshly extracted VLM evidence: everything except
 * the review closure is enforced, and rows must be pending + estimated so a
 * registered carrier can never masquerade as review-closed publication rows.
 */
export function assertChartEvidenceCarrierRows(
  rows: ChartEvidenceRows,
  activityIds: ReadonlySet<string>,
): void {
  assertChartEvidenceRowsForStage(rows, activityIds, "carrier");
}

export function evaluateChartEvidenceCarrierRows(
  rows: ChartEvidenceRows,
  activityIds: ReadonlySet<string>,
): ChartEvidencePublicationResult {
  try {
    assertChartEvidenceCarrierRows(rows, activityIds);
    return {
      publishable: true,
      checks: [{
        check_id: "chart_evidence_carrier_gate",
        passed: true,
        detail: "chart evidence carrier is provenance-closed and pending review",
      }],
    };
  } catch (error) {
    return {
      publishable: false,
      checks: [{
        check_id: "chart_evidence_carrier_gate",
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

function assertChartEvidenceRowsForStage(
  rows: ChartEvidenceRows,
  activityIds: ReadonlySet<string>,
  stage: ChartEvidenceStage,
): void {
  if (rows.chart_series.length === 0) fail("chart_series must not be empty");
  if (rows.papers.length === 0) fail("papers must not be empty");
  if (rows.sources.length === 0) fail("sources must not be empty");

  const sources = new Map<string, ChartEvidenceRows["sources"][number]>();
  for (const source of rows.sources) {
    safeId(source.source_id, "source source_id");
    if (sources.has(source.source_id)) fail(`duplicate source_id ${source.source_id}`);
    if (!CONTENT_ASSET_ID.test(source.source_asset_id)) fail("source source_asset_id must be content addressed");
    sourceCarrierLocator(source.source_locator, "source source_locator", source.source_asset_id);
    if (!ISO_DATETIME.test(source.retrieved_at) || Number.isNaN(Date.parse(source.retrieved_at))) {
      fail("source retrieved_at must be ISO 8601");
    }
    text(source.source_database, "source_database");
    text(source.carrier_type, "carrier_type");
    sources.set(source.source_id, source);
  }

  const papers = new Set<string>();
  for (const paper of rows.papers) {
    const key = `${safeId(paper.paper_id, "paper_id")}\u001f${text(paper.paper_id_namespace, "paper_id_namespace")}`;
    if (papers.has(key)) fail(`duplicate paper identity ${paper.paper_id}`);
    if (!sources.has(safeId(paper.source_id, "paper source_id"))) fail(`paper ${paper.paper_id} references missing source`);
    text(paper.title, "paper title");
    papers.add(key);
  }

  const seriesById = new Map<string, ChartSeriesInput>();
  for (const series of rows.chart_series) {
    assertSeries(series, stage);
    if (seriesById.has(series.chart_series_id)) fail(`duplicate chart_series_id ${series.chart_series_id}`);
    if (!papers.has(`${series.paper_id}\u001f${series.paper_id_namespace}`)) {
      fail(`series ${series.chart_series_id} references missing paper`);
    }
    const source = sources.get(series.source_id);
    if (source === undefined || source.source_asset_id !== series.source_asset_id) {
      fail(`series ${series.chart_series_id} source asset closure is invalid`);
    }
    seriesById.set(series.chart_series_id, series);
  }

  const pointIds = new Set<string>();
  const pointsPerSeries = new Map<string, number>();
  for (const point of rows.chart_points) {
    const series = seriesById.get(point.chart_series_id);
    if (series === undefined) fail(`point ${point.point_id} references missing chart series`);
    assertPoint(point, series, stage);
    if (pointIds.has(point.point_id)) fail(`duplicate point_id ${point.point_id}`);
    if (!activityIds.has(point.activity_id)) fail(`point ${point.point_id} references missing primary activity`);
    pointIds.add(point.point_id);
    pointsPerSeries.set(point.chart_series_id, (pointsPerSeries.get(point.chart_series_id) ?? 0) + 1);
  }
  for (const series of rows.chart_series) {
    if ((pointsPerSeries.get(series.chart_series_id) ?? 0) === 0 &&
        series.axis_validation_status !== "unclear" &&
        series.legend_validation_status !== "unclear") {
      fail(`series ${series.chart_series_id} may omit chart_points only when axis or legend is unclear`);
    }
  }
}

export function evaluateChartEvidencePublication(
  rows: ChartEvidenceRows,
  activityIds: ReadonlySet<string>,
): ChartEvidencePublicationResult {
  try {
    assertChartEvidenceRows(rows, activityIds);
    return {
      publishable: true,
      checks: [{ check_id: "chart_evidence_gate", passed: true, detail: "chart evidence is review- and provenance-closed" }],
    };
  } catch (error) {
    return {
      publishable: false,
      checks: [{
        check_id: "chart_evidence_gate",
        passed: false,
        detail: error instanceof Error ? error.message : String(error),
      }],
    };
  }
}

export function chartEvidenceValidationPolicy() {
  const base = bioactivityValidationPolicy();
  return {
    ...base,
    token_preservation_rules: [
      ...base.token_preservation_rules,
      {
        table_id: "chart_series",
        source_field: "x_axis_unit",
        output_field: "x_axis_unit",
        token_kind: "unit" as const,
      },
      {
        table_id: "chart_series",
        source_field: "y_axis_unit",
        output_field: "y_axis_unit",
        token_kind: "unit" as const,
      },
    ],
  };
}

export async function validateChartEvidenceCandidate(
  request: MultiTableValidationRequest,
  rows: ChartEvidenceRows,
  activityIds: ReadonlySet<string>,
  signal?: AbortSignal | null,
): Promise<MultiTableValidationResult> {
  const expectedTables = [
    ...bioactivityTableEntries().map((entry) => ({ schema: entry.schema, definition: entry.definition })),
    ...chartEvidenceTables,
  ];
  const expectedRelations = [...bioactivityRelations, ...chartEvidenceRelations];
  const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
  if (request.tables.length !== expectedTables.length || request.relations.length !== expectedRelations.length) {
    fail("candidate must contain the complete bioactivity and chart evidence table/relation contract");
  }
  for (const expected of expectedTables) {
    const actual = request.tables.find((table) => table.definition.table_id === expected.definition.table_id);
    if (actual === undefined || !same(actual.definition, expected.definition) || !same(actual.schema, expected.schema)) {
      fail(`table ${expected.definition.table_id} does not match the chart evidence contract`);
    }
  }
  for (const expected of expectedRelations) {
    if (!request.relations.some((actual) => same(actual, expected))) {
      fail(`relation ${expected.relation_id} does not match the chart evidence contract`);
    }
  }
  if (!same(request.policy, chartEvidenceValidationPolicy())) {
    fail("bioactivity token preservation policy is required");
  }
  const result = await validateMultiTableCandidate(request, signal);
  if (!result.passed) return result;
  const chartGate = evaluateChartEvidencePublication(rows, activityIds);
  return {
    passed: chartGate.publishable,
    checks: [
      ...result.checks,
      ...chartGate.checks.map((item) => ({
        check_id: item.check_id,
        scope: "chart_evidence",
        passed: item.passed,
        detail: item.detail,
      })),
    ],
  };
}
