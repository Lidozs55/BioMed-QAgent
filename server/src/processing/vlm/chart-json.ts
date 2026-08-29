/**
 * VLM chart JSON parsing + normalization (Python
 * ``extract_chart_data_vlm.py`` parity: strict JSON with markdown-fence and
 * trailing-prose tolerance, required top-level keys, chart/point row
 * normalization into the stable chart_data CSV columns).
 */

/** Raised when the full L1→L2→L3 chain fails (Python ``ChartExtractionError``). */
export class ChartExtractionError extends Error {
  static readonly code = "chart_extraction_failed";

  constructor(message: string) {
    super(message);
    this.name = "ChartExtractionError";
  }
}

/** Strict JSON prompt (Python ``_VLM_PROMPT`` verbatim). */
export const VLM_PROMPT = `You are a biomedical chart data extraction assistant. Analyze the image and
extract structured chart data. Return ONLY a JSON object (no markdown fences,
no prose) with this exact schema:

{
  "chart_type": "bar" | "line" | "scatter" | "box" | "violin" | "heatmap" | "pie" | "histogram" | "other",
  "title": "<chart title or empty string>",
  "axes": {
    "x": {"label": "<label>", "unit": "<unit or empty>", "scale": "linear" | "log" | "other"},
    "y": {"label": "<label>", "unit": "<unit or empty>", "scale": "linear" | "log" | "other"}
  },
  "data_points": [
    {"x": "<x value as string>", "y": "<y value as string>", "series_label": "<series name>", "confidence_level": "high" | "medium" | "low", "confidence_reason": "<brief evidence-based reason>"}
  ],
  "legend": ["<series 1 name>", "<series 2 name>"]
}

Rules:
- If the image is not a chart (e.g., a photo, a diagram, pure text), return
  {"chart_type": "other", "title": "", "axes": {"x": {"label":"","unit":"","scale":"linear"}, "y": {"label":"","unit":"","scale":"linear"}}, "data_points": [], "legend": []}
- Numeric x/y values must be stringified (e.g., "1.5", "100", "NA").
- "confidence_level" is categorical evidence quality, never a probability.
- Every point needs a concrete "confidence_reason" describing legibility,
  labels, overlap, interpolation, or another visible limitation.
- For box/violin plots, each data_point.y may be a comma-separated list
  representing the quartiles/whiskers.
- Extract at most 100 data_points; for dense scatter plots, sample
  representative points.
- Do NOT wrap the JSON in markdown fences.`;

/** Strip markdown fences if the model ignored instructions. */
const MD_FENCE_RE = /^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/;

export interface VlmChartJson {
  chart_type?: unknown;
  title?: unknown;
  axes?: unknown;
  data_points?: unknown;
  legend?: unknown;
}

/** Parse a VLM response into a chart JSON dict (Python ``_parse_vlm_json``). */
export function parseVlmJson(raw: string, sourceLabel: string): Record<string, unknown> {
  let text = raw.trim();
  const fenceMatch = MD_FENCE_RE.exec(text);
  if (fenceMatch !== null) {
    text = fenceMatch[1].trim();
  }

  // Trailing prose: trim at the closing brace matching the first opening one.
  if (text.startsWith("{")) {
    let depth = 0;
    let endIndex = -1;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          endIndex = i + 1;
          break;
        }
      }
    }
    if (endIndex > 0) text = text.slice(0, endIndex);
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new ChartExtractionError(
      `qwen-vl-max returned non-JSON for ${sourceLabel}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new ChartExtractionError(
      `qwen-vl-max returned non-object JSON for ${sourceLabel}: ${Array.isArray(data) ? "Array" : typeof data}`,
    );
  }
  const record = data as Record<string, unknown>;
  const required = ["chart_type", "axes", "data_points"] as const;
  const missing = required.filter((key) => !(key in record));
  if (missing.length > 0) {
    throw new ChartExtractionError(
      `qwen-vl-max JSON missing required keys ${JSON.stringify(missing)} for ${sourceLabel}`,
    );
  }
  return record;
}

export const CHART_DATA_COLUMNS = [
  "chart_id",
  "source_asset_id",
  "chart_type",
  "title",
  "x_label",
  "x_unit",
  "x_scale",
  "y_label",
  "y_unit",
  "y_scale",
  "data_point_count",
  "legend",
  "extracted_at",
  "model_name",
  "source_label",
  "page_number",
  "bbox",
  "extraction_tier",
] as const;

export const CHART_DATA_POINTS_COLUMNS = [
  "point_id",
  "chart_id",
  "x_value",
  "y_value",
  "series_label",
  "confidence_level",
  "confidence_reason",
  "human_review_state",
  "review_id",
  "review_evidence_digest",
  "review_reviewer",
  "reviewed_at",
  "review_reason",
  "original_x_value",
  "original_y_value",
] as const;

export interface ChartRow {
  chart_id: string;
  source_asset_id: string;
  chart_type: string;
  title: string;
  x_label: string;
  x_unit: string;
  x_scale: string;
  y_label: string;
  y_unit: string;
  y_scale: string;
  data_point_count: number;
  legend: string;
  extracted_at: string;
  model_name: string;
  source_label: string;
  page_number: string;
  bbox: string;
  extraction_tier: string;
}

export interface ChartPointRow {
  point_id: string;
  chart_id: string;
  x_value: string;
  y_value: string;
  series_label: string;
  confidence_level: "high" | "medium" | "low" | "not_applicable";
  confidence_reason: string;
  human_review_state: "not_required" | "pending" | "accepted" | "corrected" | "rejected";
  review_id: string;
  review_evidence_digest: string;
  review_reviewer: string;
  reviewed_at: string;
  review_reason: string;
  original_x_value: string;
  original_y_value: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** Python ``str(data.get(key, default))``: default only when the key is absent. */
function fieldOrDefault(record: Record<string, unknown>, key: string, fallback: string): string {
  return key in record ? stringField(record[key]) : fallback;
}

export interface NormalizeChartOptions {
  pageNumber?: string;
  bbox?: string;
  extractionTier?: string;
}

/** Normalize VLM JSON into (chart_row, data_point_rows) (Python parity). */
export function normalizeChartJson(
  data: Record<string, unknown>,
  sourceAssetId: string,
  chartIdx: number,
  sourceLabel: string,
  modelName: string,
  options: NormalizeChartOptions = {},
): { chartRow: ChartRow; pointRows: ChartPointRow[] } {
  const chartId = `chart_${sourceAssetId.slice(0, 20)}_${chartIdx}`;
  const axes = asRecord(data.axes);
  const xAxis = asRecord(axes.x);
  const yAxis = asRecord(axes.y);
  const dataPoints = Array.isArray(data.data_points) ? data.data_points : [];
  const legend = Array.isArray(data.legend) ? data.legend : [];

  const chartRow: ChartRow = {
    chart_id: chartId,
    source_asset_id: sourceAssetId,
    chart_type: fieldOrDefault(data, "chart_type", "other"),
    title: stringField(data.title),
    x_label: stringField(xAxis.label),
    x_unit: stringField(xAxis.unit),
    x_scale: fieldOrDefault(xAxis, "scale", "linear"),
    y_label: stringField(yAxis.label),
    y_unit: stringField(yAxis.unit),
    y_scale: fieldOrDefault(yAxis, "scale", "linear"),
    data_point_count: dataPoints.length,
    legend: legend.map((entry) => stringField(entry)).join("|"),
    extracted_at: new Date().toISOString(),
    model_name: modelName,
    source_label: sourceLabel,
    page_number: options.pageNumber ?? "",
    bbox: options.bbox ?? "",
    extraction_tier: options.extractionTier ?? "L1_vlm",
  };

  const pointRows: ChartPointRow[] = [];
  const modelExtracted = chartRow.extraction_tier === "" || chartRow.extraction_tier.startsWith("L1");
  dataPoints.forEach((point, index) => {
    if (typeof point !== "object" || point === null || Array.isArray(point)) return;
    const record = point as Record<string, unknown>;
    if (record.confidence !== undefined) {
      throw new ChartExtractionError(
        `numeric confidence is not allowed for ${sourceLabel}; use confidence_level`,
      );
    }
    const confidenceLevel = record.confidence_level;
    if (
      confidenceLevel !== "high" &&
      confidenceLevel !== "medium" &&
      confidenceLevel !== "low"
    ) {
      throw new ChartExtractionError(
        `invalid confidence_level for ${sourceLabel} point ${index + 1}`,
      );
    }
    const confidenceReason = stringField(record.confidence_reason).trim();
    if (confidenceReason === "") {
      throw new ChartExtractionError(
        `missing confidence_reason for ${sourceLabel} point ${index + 1}`,
      );
    }
    pointRows.push({
      point_id: `${chartId}_p${index + 1}`,
      chart_id: chartId,
      x_value: stringField(record.x),
      y_value: stringField(record.y),
      series_label: stringField(record.series_label),
      confidence_level: modelExtracted && confidenceLevel === "high" ? "medium" : confidenceLevel,
      confidence_reason: confidenceReason,
      human_review_state: modelExtracted ? "pending" : "not_required",
      review_id: "",
      review_evidence_digest: "",
      review_reviewer: "",
      reviewed_at: "",
      review_reason: "",
      original_x_value: "",
      original_y_value: "",
    });
  });

  return { chartRow, pointRows };
}

export const CHART_CSV_LOCK_NAME = ".chart-csv.lock";
