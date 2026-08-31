import type { CoreDerivedAssetProvenance, JsonValue } from "@biomed/contracts";

import type { CoreAcquisitionProvenance } from "../../../runtime/source-assets/registry.js";
import { delimitedRowsFromFileAsync } from "../../adapters/text.js";
import { parseSourceLocator } from "../../contracts/index.js";
import { assertChartPointReviewClosure } from "../bioactivity-measurement/chart-evidence/validation.js";
import { LITERATURE_EXPERIMENT_CHART_PROFILE_REF } from "./profile.js";

/**
 * An intentional literature-profile decision. Only this error may be converted
 * into the dynamic publication fallback allowlist; file I/O, abort and parser
 * resource failures retain their original types.
 */
export class LiteratureExperimentChartSemanticError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LiteratureExperimentChartSemanticError";
  }
}

function semanticFailure(message: string): never {
  throw new LiteratureExperimentChartSemanticError(message);
}

function semanticParse<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof LiteratureExperimentChartSemanticError) throw error;
    if (error instanceof TypeError) {
      throw new LiteratureExperimentChartSemanticError(error.message, { cause: error });
    }
    throw error;
  }
}

async function csvRecords(
  file: string,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, string>>[]> {
  let header: string[] | null = null;
  const rows: Record<string, string>[] = [];
  for await (const row of delimitedRowsFromFileAsync(file, ",", signal, {
    maxRowChars: 1024 * 1024,
    maxFieldChars: 512 * 1024,
    maxRowFields: 128,
  })) {
    if (header === null) {
      header = row.values;
      if (header.length === 0 || new Set(header).size !== header.length) {
        semanticFailure(`semantic profile table '${file}' has an invalid header`);
      }
      continue;
    }
    if (row.values.length !== header.length) {
      semanticFailure(`semantic profile table '${file}' row ${row.line} has the wrong width`);
    }
    rows.push(Object.fromEntries(header.map((name, index) => [name, row.values[index] ?? ""])));
  }
  if (header === null) semanticFailure(`semantic profile table '${file}' is empty`);
  return rows;
}
function jsonRecord(value: string, label: string): Record<string, JsonValue> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    semanticFailure(`${label} must be JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    semanticFailure(`${label} must be a JSON object`);
  }
  return parsed as Record<string, JsonValue>;
}

function jsonArray(value: JsonValue | undefined, label: string): Readonly<Record<string, JsonValue>>[] {
  if (!Array.isArray(value)) semanticFailure(`${label} must be an array`);
  return value.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      semanticFailure(`${label}[${index}] must be an object`);
    }
    return item;
  });
}

function evidenceRecord(provenance: CoreDerivedAssetProvenance): Record<string, JsonValue> {
  if (provenance.evidence === null || typeof provenance.evidence !== "object" || Array.isArray(provenance.evidence)) {
    semanticFailure("Core derived input evidence must be an object");
  }
  return provenance.evidence;
}

export async function validateLiteratureExperimentChartProfile(input: {
  profileRef: string;
  stagedTablePaths: ReadonlyMap<string, string>;
  sourceInputProvenance: readonly (
    CoreDerivedAssetProvenance | CoreAcquisitionProvenance
  )[];
  signal?: AbortSignal;
}): Promise<void> {
  if (input.profileRef !== LITERATURE_EXPERIMENT_CHART_PROFILE_REF) return;
  const derived = input.sourceInputProvenance.filter(
    (item): item is CoreDerivedAssetProvenance => "operation_kind" in item,
  );
  const vlmInputs = derived.filter((item) => item.operation_kind === "vlm_extraction");
  const archiveInputs = derived.filter((item) => item.operation_kind === "archive_member_extraction");
  const parserInputs = derived.filter((item) => item.operation_kind === "registered_parser");
  if (vlmInputs.length === 0) {
    semanticFailure("literature_experiment_chart requires a Core-owned VLM evidence asset");
  }
  if (archiveInputs.length === 0) {
    semanticFailure("literature_experiment_chart requires a Core-owned supplementary member asset");
  }
  const chartSeriesPath = input.stagedTablePaths.get("chart_series");
  const chartPointsPath = input.stagedTablePaths.get("chart_points");
  const supplementaryPath = input.stagedTablePaths.get("supplementary_asset_records");
  if (chartSeriesPath === undefined || chartPointsPath === undefined || supplementaryPath === undefined) {
    semanticFailure("literature_experiment_chart semantic tables are incomplete");
  }
  const vlmFacts = vlmInputs.map((item) => {
    const evidence = evidenceRecord(item);
    const manifest = evidence.manifest;
    if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
      semanticFailure("Core VLM provenance requires an embedded evidence manifest");
    }
    return {
      assetId: item.asset_id,
      parents: new Set(item.parent_asset_ids),
      evidence,
      charts: jsonArray(manifest.charts, "VLM manifest.charts"),
      points: jsonArray(manifest.points, "VLM manifest.points"),
    };
  });
  const seriesFacts = new Map<string, { sourceAssetId: string; figureId: string }>();
  for (const row of await csvRecords(chartSeriesPath, input.signal)) {
    const locator = semanticParse(() => parseSourceLocator(
      jsonRecord(row.source_locator ?? "", "chart_series.source_locator"),
    ));
    if (!("locator_version" in locator) || locator.locator_type !== "image_bbox") {
      semanticFailure("chart_series.source_locator must be an image_bbox locator");
    }
    if (!/^[0-9a-f]{64}$/u.test(row.prompt_digest ?? "")) {
      semanticFailure("chart_series.prompt_digest must be SHA-256");
    }
    const matching = vlmFacts.find((item) =>
      item.assetId === row.source_asset_id || item.parents.has(row.source_asset_id ?? ""));
    const chart = matching?.charts.find((item) => item.chart_id === row.chart_series_id);
    if (
      matching === undefined
      || chart === undefined
      || chart.source_asset_id !== row.source_asset_id
      || locator.asset_id !== row.source_asset_id
      || locator.figure_id !== row.figure_id
      || chart.model_name !== row.model_name
      || chart.x_label !== row.x_axis_name
      || chart.x_unit !== row.x_axis_unit
      || chart.y_label !== row.y_axis_name
      || chart.y_unit !== row.y_axis_unit
      || chart.x_scale !== row.x_scale
      || chart.y_scale !== row.y_scale
      || chart.legend !== row.legend_text
      || chart.page_number !== (locator.page_number === null ? "" : String(locator.page_number))
      || chart.bbox !== locator.bbox.join(",")
      || matching.evidence.model_name !== row.model_name
      || matching.evidence.model_version !== row.model_version
      || matching.evidence.prompt_digest !== row.prompt_digest
    ) {
      semanticFailure("chart_series rows do not match Core VLM evidence bytes and provenance");
    }
    jsonRecord(row.transform_provenance ?? "", "chart_series.transform_provenance");
    seriesFacts.set(row.chart_series_id ?? "", {
      sourceAssetId: row.source_asset_id ?? "",
      figureId: row.figure_id ?? "",
    });
  }
  for (const row of await csvRecords(chartPointsPath, input.signal)) {
    const locator = semanticParse(() => parseSourceLocator(jsonRecord(
      row.pixel_or_coordinate_locator ?? "",
      "chart_points.pixel_or_coordinate_locator",
    )));
    if (!("locator_version" in locator) || locator.locator_type !== "image_bbox") {
      semanticFailure("chart_points locator must be an image_bbox locator");
    }
    const matching = vlmFacts.find((item) =>
      item.points.some((point) => point.point_id === row.point_id));
    const series = seriesFacts.get(row.chart_series_id ?? "");
    const point = matching?.points.find((item) => item.point_id === row.point_id);
    const chart = matching?.charts.find((item) => item.chart_id === row.chart_series_id);
    if (
      point === undefined
      || chart === undefined
      || series === undefined
      || locator.asset_id !== series.sourceAssetId
      || locator.figure_id !== series.figureId
      || chart.page_number !== (locator.page_number === null ? "" : String(locator.page_number))
      || chart.bbox !== locator.bbox.join(",")
      || (String(chart.extraction_tier ?? "").startsWith("L1") && row.estimated_or_exact !== "estimated")
      || point.chart_id !== row.chart_series_id
      || String(point.x_value ?? "") !== row.x_value
      || String(point.y_value ?? "") !== row.y_value
      || point.confidence_level !== row.extraction_confidence
      || point.confidence_reason !== row.confidence_reason
      || point.human_review_state !== row.review_status
      || String(point.review_id ?? "") !== String(row.review_id ?? "")
      || String(point.original_x_value ?? "") !== String(row.original_x_value ?? "")
      || String(point.original_y_value ?? "") !== String(row.original_y_value ?? "")
    ) {
      semanticFailure("chart_points rows do not match Core VLM evidence bytes");
    }
    const transformProvenance = jsonRecord(
      row.transform_provenance ?? "",
      "chart_points.transform_provenance",
    );
    semanticParse(() => assertChartPointReviewClosure({
      pointId: row.point_id ?? "",
      estimatedOrExact: row.estimated_or_exact ?? "",
      extractionConfidence: row.extraction_confidence ?? "",
      reviewStatus: row.review_status ?? "",
      reviewId: row.review_id === "" ? null : row.review_id ?? null,
      transformProvenance,
    }));
    if (row.review_status === "accepted" || row.review_status === "corrected") {
      const review = transformProvenance.review;
      if (review === null || typeof review !== "object" || Array.isArray(review)) {
        semanticFailure("reviewed chart point requires review provenance");
      }
      const reviewRecord = review as Record<string, JsonValue>;
      if (
        reviewRecord.evidence_digest !== point.review_evidence_digest
        || reviewRecord.reviewer !== point.review_reviewer
        || reviewRecord.reviewed_at !== point.reviewed_at
        || String(reviewRecord.reason ?? "") !== String(point.review_reason ?? "")
      ) {
        semanticFailure("chart point review provenance does not match the vlm_extraction HIL record");
      }
    }
  }
  const archiveFacts = new Map(archiveInputs.map((item) => [item.asset_id, evidenceRecord(item)]));
  for (const row of await csvRecords(supplementaryPath, input.signal)) {
    const evidence = archiveFacts.get(row.source_asset_id ?? "");
    const locator = semanticParse(() => parseSourceLocator(jsonRecord(
      row.source_locator ?? "",
      "supplementary_asset_records.source_locator",
    )));
    if (
      evidence === undefined
      || evidence.parent_archive_asset_id !== row.parent_archive_asset_id
      || evidence.parent_archive_sha256 !== row.parent_archive_sha256
      || evidence.member_path !== row.member_path
      || evidence.member_sha256 !== row.member_sha256
      || evidence.media_type !== row.media_type
      || String(evidence.size_bytes ?? "") !== row.size_bytes
      || locator.asset_id !== row.source_asset_id
      || locator.logical_file !== evidence.registered_relative_path
      || locator.raw_value !== row.member_sha256
    ) {
      semanticFailure("supplementary asset record does not match Core archive-member provenance");
    }
    const parserProvenance = parserInputs.find((item) =>
      item.parent_asset_ids.includes(row.source_asset_id ?? "")
      && item.operation_result_id === row.operation_result_id);
    const vlmProvenance = vlmInputs.find((item) =>
      item.parent_asset_ids.includes(row.source_asset_id ?? "")
      && item.operation_result_id === row.operation_result_id);
    const memberMediaType = String(evidence.media_type ?? "");
    const requiresRegisteredParser = new Set([
      "text/csv",
      "text/tab-separated-values",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]).has(memberMediaType);
    if (requiresRegisteredParser) {
      const parserEvidence = parserProvenance === undefined ? null : evidenceRecord(parserProvenance);
      if (parserEvidence?.parser_id !== row.parser_id) {
        semanticFailure("supplementary tabular member lacks matching registered parser provenance");
      }
    } else if (memberMediaType === "application/pdf") {
      const parserEvidence = parserProvenance === undefined ? null : evidenceRecord(parserProvenance);
      if (parserEvidence?.parser_id !== row.parser_id && vlmProvenance?.implementation_id !== row.parser_id) {
        semanticFailure("supplementary PDF lacks matching registered parser or VLM provenance");
      }
    }
  }
}
