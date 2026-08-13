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
    {"x": "<x value as string>", "y": "<y value as string>", "series_label": "<series name>", "confidence": <0.0-1.0>}
  ],
  "legend": ["<series 1 name>", "<series 2 name>"]
}

Rules:
- If the image is not a chart (e.g., a photo, a diagram, pure text), return
  {"chart_type": "other", "title": "", "axes": {"x": {"label":"","unit":"","scale":"linear"}, "y": {"label":"","unit":"","scale":"linear"}}, "data_points": [], "legend": []}
- Numeric x/y values must be stringified (e.g., "1.5", "100", "NA").
- "confidence" is your 0.0-1.0 self-assessment of how accurately you read
  that data point off the figure (1.0 = fully certain, 0.0 = guessing).
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
  "confidence",
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
  confidence: string;
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
  dataPoints.forEach((point, index) => {
    if (typeof point !== "object" || point === null || Array.isArray(point)) return;
    const record = point as Record<string, unknown>;
    const confidence = record.confidence;
    pointRows.push({
      point_id: `${chartId}_p${index + 1}`,
      chart_id: chartId,
      x_value: stringField(record.x),
      y_value: stringField(record.y),
      series_label: stringField(record.series_label),
      confidence: confidence === undefined || confidence === null ? "" : String(confidence),
    });
  });

  return { chartRow, pointRows };
}

export const CHART_CSV_LOCK_NAME = ".chart-csv.lock";
