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
  /**
   * Terminal transform input asset ids (publication input receipts). When
   * supplied, VLM manifest matching is restricted to exactly these selected
   * assets, so a candidate+reviewed closure is resolved by the ACTUAL selected
   * reviewed carrier instead of being inferred from point review state.
   */
  selectedInputAssetIds?: readonly string[];
  signal?: AbortSignal;
}): Promise<void> {
  if (input.profileRef !== LITERATURE_EXPERIMENT_CHART_PROFILE_REF) return;
  const derived = input.sourceInputProvenance.filter(
    (item): item is CoreDerivedAssetProvenance => "operation_kind" in item,
  );
  // Manifests are parsed ONLY from vlm_extraction facts. The review_evidence
  // HIL record kind carries no manifest and never participates in matching.
  const vlmInputsAll = derived.filter((item) => item.operation_kind === "vlm_extraction");
  const reviewEvidenceInputs = derived.filter((item) => item.operation_kind === "review_evidence");
  const archiveInputs = derived.filter((item) => item.operation_kind === "archive_member_extraction");
  const parserInputs = derived.filter((item) => item.operation_kind === "registered_parser");
  const selectedIds = input.selectedInputAssetIds === undefined
    ? null
    : new Set(input.selectedInputAssetIds);
  const vlmInputs = selectedIds === null
    ? vlmInputsAll
    : vlmInputsAll.filter((item) => selectedIds.has(item.asset_id));
  if (vlmInputs.length === 0) {
    if (selectedIds !== null && vlmInputsAll.length > 0) {
      semanticFailure("literature_experiment_chart selected terminal inputs carry no Core-owned VLM evidence asset");
    }
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
      // The candidate carrier this fact was derived from, when declared.
      parentCandidateAssetId: typeof evidence.candidate_carrier_asset_id === "string"
        ? evidence.candidate_carrier_asset_id
        : null,
      charts: jsonArray(manifest.charts, "VLM manifest.charts"),
      points: jsonArray(manifest.points, "VLM manifest.points"),
    };
  });
  type VlmFact = typeof vlmFacts[number];
  const assertReviewedTerminalClosure = (terminal: VlmFact): {
    reviewEvidence: Record<string, JsonValue>;
  } => {
    const candidateCarrierAssetId = terminal.evidence.candidate_carrier_asset_id;
    const reviewEvidenceAssetId = terminal.evidence.review_evidence_asset_id;
    const reviewId = terminal.evidence.review_id;
    const reviewRequestId = terminal.evidence.review_request_id;
    const reviewAction = terminal.evidence.review_action;
    const reviewEvidenceDigest = terminal.evidence.review_evidence_digest;
    if (
      typeof candidateCarrierAssetId !== "string" || candidateCarrierAssetId === ""
      || typeof reviewEvidenceAssetId !== "string" || reviewEvidenceAssetId === ""
      || typeof reviewId !== "string" || reviewId === ""
      || typeof reviewRequestId !== "string" || reviewRequestId === ""
      || (reviewAction !== "accept" && reviewAction !== "correct")
      || typeof reviewEvidenceDigest !== "string" || !/^[0-9a-f]{64}$/u.test(reviewEvidenceDigest)
    ) {
      semanticFailure(
        "selected terminal VLM evidence must be a reviewed carrier with candidate and review_evidence references",
      );
    }
    if (
      terminal.parentCandidateAssetId !== candidateCarrierAssetId
      || !terminal.parents.has(candidateCarrierAssetId)
      || !terminal.parents.has(reviewEvidenceAssetId)
    ) {
      semanticFailure(
        "reviewed VLM evidence must directly parent its candidate carrier and review_evidence HIL record",
      );
    }
    const candidateCarrierFacts = vlmInputsAll.filter((item) =>
      item.asset_id === candidateCarrierAssetId);
    if (candidateCarrierFacts.length !== 1) {
      semanticFailure(
        "reviewed VLM evidence must reference exactly one candidate carrier provenance fact with operation kind vlm_extraction",
      );
    }
    const reviewEvidenceFacts = reviewEvidenceInputs.filter((item) =>
      item.asset_id === reviewEvidenceAssetId);
    if (reviewEvidenceFacts.length !== 1) {
      semanticFailure(
        "reviewed VLM evidence must reference exactly one review_evidence provenance fact",
      );
    }
    if (!reviewEvidenceFacts[0]!.parent_asset_ids.includes(candidateCarrierAssetId)) {
      semanticFailure(
        "review_evidence HIL record must directly parent its candidate carrier",
      );
    }
    const reviewEvidence = evidenceRecord(reviewEvidenceFacts[0]!);
    if (
      reviewEvidence.candidate_carrier_asset_id !== candidateCarrierAssetId
      || reviewEvidence.review_id !== reviewId
      || reviewEvidence.request_id !== reviewRequestId
      || reviewEvidence.review_evidence_digest !== reviewEvidenceDigest
    ) {
      semanticFailure(
        "review_evidence HIL record does not consistently bind the reviewed VLM carrier",
      );
    }
    return { reviewEvidence };
  };
  // Production supplies selected transform input receipts. Every selected VLM
  // input must be the reviewed terminal carrier before any table row can
  // bypass the graph check, including an otherwise valid empty chart_points
  // table.
  if (selectedIds !== null) {
    for (const terminal of vlmFacts) assertReviewedTerminalClosure(terminal);
  }
  const seriesFacts = new Map<string, {
    sourceAssetId: string;
    figureId: string;
    modelName: string;
    modelVersion: string;
    promptDigest: string;
  }>();
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
    // Exact, parent-free matching: a staged series row must equal a chart
    // entry inside ONE vlm_extraction fact's manifest across the full staged
    // row state, including the row-level model_version and prompt_digest of
    // the page response this series actually came from. Top-level
    // evidence.model_version / evidence.prompt_digest are deterministic
    // carrier summaries and may span multiple pages, so they never participate
    // in matching. A reviewed closure legitimately contains candidate and
    // reviewed facts with IDENTICAL chart identity (the reviewed carrier
    // re-projects the same charts); identical duplicates are deduplicated and
    // resolved deterministically. Only DISTINCT matching chart identities or
    // distinct matching facts fail closed.
    const chartMatches = (chart: Record<string, JsonValue>): boolean =>
      chart.chart_id === row.chart_series_id
      && chart.source_asset_id === row.source_asset_id
      && chart.model_name === row.model_name
      && chart.model_version === row.model_version
      && chart.prompt_digest === row.prompt_digest
      && chart.x_label === row.x_axis_name
      && chart.x_unit === row.x_axis_unit
      && chart.y_label === row.y_axis_name
      && chart.y_unit === row.y_axis_unit
      && chart.x_scale === row.x_scale
      && chart.y_scale === row.y_scale
      && chart.legend === row.legend_text;
    const matchingFacts = vlmFacts.filter((item) => item.charts.some(chartMatches));
    const candidates = matchingFacts.flatMap((item) => item.charts.filter(chartMatches));
    const distinctCharts = new Set(candidates.map((chart) => JSON.stringify(chart)));
    // A reviewed closure legitimately contains candidate and reviewed facts
    // carrying IDENTICAL chart entries (the reviewed carrier re-projects the
    // same charts; P0 finding). Identical duplicates are deduplicated
    // deterministically: the fact that carries its review_evidence HIL record
    // is preferred when exactly one such fact exists. Only DISTINCT matching
    // chart identities or an ambiguous fact set fail closed.
    const reviewedMatchingFacts = matchingFacts.filter((item) =>
      typeof item.evidence.review_evidence_asset_id === "string"
      && item.evidence.review_evidence_asset_id !== "");
    const matching = distinctCharts.size === 1
      ? (matchingFacts.length === 1
        ? matchingFacts[0]
        : reviewedMatchingFacts.length === 1 ? reviewedMatchingFacts[0] : undefined)
      : undefined;
    const chart = distinctCharts.size === 1 ? candidates[0] : undefined;
    if (
      matching === undefined
      || chart === undefined
      || distinctCharts.size !== 1
      || typeof chart.model_version !== "string"
      || typeof chart.prompt_digest !== "string"
      || typeof chart.figure_id !== "string"
      || locator.asset_id !== row.source_asset_id
      || locator.figure_id !== row.figure_id
      || chart.figure_id !== row.figure_id
      || chart.page_number !== (locator.page_number === null ? "" : String(locator.page_number))
      || chart.bbox !== locator.bbox.join(",")
    ) {
      semanticFailure("chart_series rows do not match Core VLM evidence bytes and provenance");
    }
    const transformProvenance = jsonRecord(
      row.transform_provenance ?? "",
      "chart_series.transform_provenance",
    );
    const vlmExtractStep = (Array.isArray(transformProvenance.steps)
      ? transformProvenance.steps
      : []).find((step) => step !== null && typeof step === "object"
      && !Array.isArray(step)
      && (step as Record<string, JsonValue>).operation === "vlm_extract");
    const stepRecord = vlmExtractStep === undefined
      ? null
      : vlmExtractStep as Record<string, JsonValue>;
    const stepParameters = stepRecord === null
      ? null
      : stepRecord.parameters === null || typeof stepRecord.parameters !== "object"
        || Array.isArray(stepRecord.parameters)
        ? null
        : stepRecord.parameters as Record<string, JsonValue>;
    if (
      transformProvenance.model_name !== row.model_name
      || transformProvenance.model_name !== chart.model_name
      || transformProvenance.model_version !== row.model_version
      || transformProvenance.model_version !== chart.model_version
      || stepParameters === null
      || stepParameters.prompt_digest !== row.prompt_digest
      || stepParameters.prompt_digest !== chart.prompt_digest
    ) {
      semanticFailure(
        "chart_series.transform_provenance does not match row and Core VLM manifest",
      );
    }
    seriesFacts.set(row.chart_series_id ?? "", {
      sourceAssetId: row.source_asset_id ?? "",
      figureId: row.figure_id ?? "",
      modelName: row.model_name ?? "",
      modelVersion: row.model_version ?? "",
      promptDigest: row.prompt_digest ?? "",
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
    // Exact, parent-free point matching inside ONE vlm_extraction fact. The
    // staged point row is first compared against the COMPLETE manifest point
    // state (coordinates, type, confidence, review state/provenance, original
    // values, locator identity, model/prompt identity); only facts whose
    // manifest carries an EXACT state match survive. This prevents a pending
    // candidate fact from shadowing the reviewed accepted/corrected fact.
    // Identical duplicate exact matches (reviewed closure re-projection) are
    // deduplicated deterministically; zero matches or multiple DISTINCT exact
    // states / fact identities fail closed.
    const series = seriesFacts.get(row.chart_series_id ?? "");
    const pointStateMatches = (point: Record<string, JsonValue>): boolean =>
      point.point_id === row.point_id
      && point.chart_id === row.chart_series_id
      && String(point.x_value ?? "") === row.x_value
      && String(point.y_value ?? "") === row.y_value
      && point.point_type === row.point_type
      && point.confidence_level === row.extraction_confidence
      && point.confidence_reason === row.confidence_reason
      && point.human_review_state === row.review_status
      && String(point.review_id ?? "") === String(row.review_id ?? "")
      && String(point.original_x_value ?? "") === String(row.original_x_value ?? "")
      && String(point.original_y_value ?? "") === String(row.original_y_value ?? "");
    const exactFacts = vlmFacts.filter((item) => item.points.some(pointStateMatches));
    const exactCandidates = exactFacts.flatMap((item) =>
      item.points.filter(pointStateMatches));
    const distinctExactStates = new Set(exactCandidates.map((point) => JSON.stringify(point)));
    // Same reviewed-closure dedupe as the series loop: identical point state
    // across candidate and reviewed facts is resolved to the fact carrying
    // its review_evidence HIL record; ambiguity fails closed.
    const reviewedExactFacts = exactFacts.filter((item) =>
      typeof item.evidence.review_evidence_asset_id === "string"
      && item.evidence.review_evidence_asset_id !== "");
    const matching = distinctExactStates.size === 1
      ? (exactFacts.length === 1
        ? exactFacts[0]
        : reviewedExactFacts.length === 1 ? reviewedExactFacts[0] : undefined)
      : undefined;
    const point = distinctExactStates.size === 1 ? exactCandidates[0] : undefined;
    const seriesChart = matching?.charts.find((item) =>
      item.chart_id === row.chart_series_id
      && item.source_asset_id === (series?.sourceAssetId ?? "")
      && item.model_name === (series?.modelName ?? "")
      && item.model_version === (series?.modelVersion ?? "")
      && item.prompt_digest === (series?.promptDigest ?? ""));
    if (
      matching === undefined
      || point === undefined
      || distinctExactStates.size !== 1
      || seriesChart === undefined
      || series === undefined
      || locator.asset_id !== series.sourceAssetId
      || locator.figure_id !== series.figureId
      || (String(seriesChart.extraction_tier ?? "").startsWith("L1") && row.estimated_or_exact !== "estimated")
      // Point locator identity is exact-checked against the manifest point's
      // own projected locator fields, never against the chart bbox.
      || String(point.page_number ?? "") !== (locator.page_number === null ? "" : String(locator.page_number))
      || point.figure_id !== locator.figure_id
      || point.bbox !== locator.bbox.join(",")
      // Point-level model/prompt identity: the manifest point must carry the
      // identity of the page response it actually came from.
      || typeof point.model_version !== "string"
      || point.model_version === ""
      || !/^[0-9a-f]{64}$/u.test(String(point.prompt_digest ?? ""))
    ) {
      semanticFailure("chart_points rows do not match Core VLM evidence bytes");
    }
    const transformProvenance = jsonRecord(
      row.transform_provenance ?? "",
      "chart_points.transform_provenance",
    );
    // Point provenance identity (P0 hardening): the manifest point's row-level
    // page response identity must agree with the point's OWN transform
    // provenance (model_version + the vlm_extract step's prompt_digest) and,
    // because the producer admits a point only from its owning series' page,
    // with the series row identity as well. Any disagreement fails closed.
    if (transformProvenance.model_version !== point.model_version) {
      semanticFailure(
        "chart point manifest model_version does not match its transform provenance",
      );
    }
    const vlmExtractStep = (Array.isArray(transformProvenance.steps)
      ? transformProvenance.steps
      : []).find((step) => step !== null && typeof step === "object"
      && !Array.isArray(step)
      && (step as Record<string, JsonValue>).operation === "vlm_extract");
    const stepRecord = vlmExtractStep === undefined ? null
      : vlmExtractStep as Record<string, JsonValue>;
    const stepParameters = stepRecord === null
      ? null
      : stepRecord.parameters === null || typeof stepRecord.parameters !== "object"
        || Array.isArray(stepRecord.parameters)
        ? null
        : stepRecord.parameters as Record<string, JsonValue>;
    if (stepParameters === null || stepParameters.prompt_digest !== point.prompt_digest) {
      semanticFailure(
        "chart point manifest prompt_digest does not match its vlm_extract transform step",
      );
    }
    if (
      transformProvenance.model_version !== series.modelVersion
      || stepParameters.prompt_digest !== series.promptDigest
    ) {
      semanticFailure(
        "chart point page identity does not match its owning series page response",
      );
    }
    // Bind the reviewed point to its HIL review provenance and the exact
    // review_evidence HIL record: the selected reviewed VLM evidence must
    // reference exactly one review_evidence fact whose candidate carrier,
    // review id, request id, and HIL evidence digest all match.
    const reviewedState = row.review_status === "accepted" || row.review_status === "corrected";
    if (reviewedState) {
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
      const { reviewEvidence } = assertReviewedTerminalClosure(matching);
      const expectedAction = row.review_status === "accepted" ? "accept" : "correct";
      if (
        matching.evidence.review_action !== expectedAction
        || reviewEvidence.review_id !== row.review_id
        || reviewEvidence.review_id !== matching.evidence.review_id
        || reviewEvidence.request_id !== matching.evidence.review_request_id
        || reviewEvidence.review_evidence_digest !== reviewRecord.evidence_digest
        || reviewEvidence.review_evidence_digest !== matching.evidence.review_evidence_digest
      ) {
        semanticFailure(
          "review_evidence HIL record does not bind the reviewed VLM evidence and its point review provenance",
        );
      }
    }
    semanticParse(() => assertChartPointReviewClosure({
      pointId: row.point_id ?? "",
      estimatedOrExact: row.estimated_or_exact ?? "",
      extractionConfidence: row.extraction_confidence ?? "",
      reviewStatus: row.review_status ?? "",
      reviewId: row.review_id === "" ? null : row.review_id ?? null,
      transformProvenance,
    }));
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
