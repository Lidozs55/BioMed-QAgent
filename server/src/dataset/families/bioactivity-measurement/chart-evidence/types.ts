import type { SourceLocatorV2 } from "@biomed/contracts";

export const CHART_SERIES_TABLE_ID = "chart_series";
export const CHART_POINTS_TABLE_ID = "chart_points";
export const CHART_PAPERS_TABLE_ID = "papers";
export const CHART_SOURCES_TABLE_ID = "sources";

export type ChartAxisStatus = "clear" | "unclear" | "human_validated";
export type ChartLegendStatus = "clear" | "unclear" | "human_validated";
export type ChartValuePrecision = "exact" | "estimated";
export type ChartConfidenceLevel = "high" | "medium" | "low";
export type ChartReliabilityLevel = "high" | "medium" | "low";
export type ChartReviewStatus =
  | "not_required"
  | "pending"
  | "accepted"
  | "corrected"
  | "rejected";

export interface ChartTransformStep {
  step_id: string;
  operation: "vlm_extract" | "coordinate_transform" | "unit_transform" | "human_correction";
  implementation: string;
  implementation_version: string;
  parameters: Readonly<Record<string, unknown>>;
  input_digest: string;
  output_digest: string;
}

export interface ChartReviewProvenance {
  review_id: string;
  status: "accepted" | "corrected" | "rejected";
  reviewer: "user";
  reviewed_at: string;
  evidence_digest: string;
  reason: string;
}

export interface ChartTransformProvenance {
  schema_version: "1.0";
  model_name: string;
  model_version: string;
  source_reliability_at_extraction: ChartReliabilityLevel;
  extraction_reliability_at_extraction: ChartReliabilityLevel;
  steps: readonly ChartTransformStep[];
  review: ChartReviewProvenance | null;
}

export interface ChartSeriesInput {
  chart_series_id: string;
  paper_id: string;
  paper_id_namespace: string;
  figure_id: string;
  series_label: string;
  x_axis_name: string;
  x_axis_unit: string;
  y_axis_name: string;
  y_axis_unit: string;
  x_scale: string;
  y_scale: string;
  legend_text: string;
  axis_validation_status: ChartAxisStatus;
  legend_validation_status: ChartLegendStatus;
  human_review_status: ChartReviewStatus;
  source_id: string;
  source_asset_id: string;
  source_locator: SourceLocatorV2;
  model_name: string;
  model_version: string;
  prompt_digest: string;
  extraction_method: "vlm";
  extraction_confidence: ChartConfidenceLevel;
  source_reliability: ChartReliabilityLevel;
  extraction_reliability: ChartReliabilityLevel;
  transform_provenance: ChartTransformProvenance;
}

export interface ChartPointInput {
  point_id: string;
  chart_series_id: string;
  activity_id: string;
  x_value: string;
  y_value: string;
  point_type: string;
  estimated_or_exact: ChartValuePrecision;
  pixel_or_coordinate_locator: SourceLocatorV2;
  extraction_confidence: ChartConfidenceLevel;
  confidence_reason: string;
  review_status: ChartReviewStatus;
  review_id: string | null;
  source_reliability: ChartReliabilityLevel;
  extraction_reliability: ChartReliabilityLevel;
  original_x_value: string | null;
  original_y_value: string | null;
  transform_provenance: ChartTransformProvenance;
}

export interface ChartPaperInput {
  paper_id: string;
  paper_id_namespace: string;
  title: string;
  journal: string | null;
  publication_date: string | null;
  authors: readonly string[] | null;
  source_url: string | null;
  source_id: string;
}

export interface ChartSourceInput {
  source_id: string;
  source_database: string;
  source_asset_id: string;
  source_locator: SourceLocatorV2;
  retrieved_at: string;
  carrier_type: string;
}

export interface ChartEvidenceRows {
  chart_series: readonly ChartSeriesInput[];
  chart_points: readonly ChartPointInput[];
  papers: readonly ChartPaperInput[];
  sources: readonly ChartSourceInput[];
}
