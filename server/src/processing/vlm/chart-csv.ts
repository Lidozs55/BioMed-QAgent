/**
 * chart_data CSV persistence (Python ``_write_chart_csvs`` parity):
 * utf-8-sig BOM, merge-by-id accumulation across invocations, integrity
 * validation (every chart has source_asset_id, every point references an
 * existing chart) and the L1 admission gate (model-extracted points must
 * carry categorical confidence evidence + model_name). Violations abort the write so a broken
 * chart dataset is never persisted.
 *
 * Python guards with a cross-process ``TaskLock`` on ``.chart-csv.lock``;
 * the TS runtime is single-process per task, so an in-process mutex plus
 * write-to-temp + rename keeps the same atomicity semantics.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CHART_DATA_COLUMNS,
  CHART_DATA_POINTS_COLUMNS,
  type ChartPointRow,
  type ChartRow,
} from "./chart-json.js";

export const CHART_CSV_NAME = "chart_data.csv";
export const CHART_POINTS_CSV_NAME = "chart_data_points.csv";

type CsvRecord = Record<string, string>;

function escapeCell(value: unknown): string {
  const cell = String(value);
  if (/[",\r\n]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

function encodeCsv(columns: readonly string[], rows: readonly CsvRecord[]): string {
  const headerLine = columns.map(escapeCell).join(",");
  const dataLines = rows.map((row) => columns.map((column) => escapeCell(row[column] ?? "")).join(","));
  return "\ufeff" + [headerLine, ...dataLines].join("\r\n") + "\r\n";
}

function decodeCsv(content: string, columns: readonly string[], fileName: string): CsvRecord[] {
  const text = content.replace(/^\ufeff/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  if (lines.length === 0) return [];
  const header = lines[0].split(",");
  const expected = [...columns];
  if (header.length !== expected.length || header.some((name, index) => name !== expected[index])) {
    throw new ValueError(`existing chart CSV schema mismatch: ${fileName}`);
  }
  return lines.slice(1).map((line) => {
    const record: CsvRecord = {};
    const cells = splitCsvLine(line);
    expected.forEach((column, index) => {
      record[column] = cells[index] ?? "";
    });
    return record;
  });
}

/** Minimal CSV line splitter handling quoted cells (\" escapes). */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

function mergeById(existing: CsvRecord[], incoming: CsvRecord[], key: string): CsvRecord[] {
  const merged = [...existing];
  const positions = new Map<string, number>();
  merged.forEach((row, index) => positions.set(row[key] ?? "", index));
  for (const row of incoming) {
    const identifier = row[key] ?? "";
    const position = positions.get(identifier);
    if (position !== undefined) {
      merged[position] = row;
    } else {
      positions.set(identifier, merged.length);
      merged.push(row);
    }
  }
  return merged;
}

/**
 * Check chart_data integrity: every chart has a source_asset_id and every
 * point references an existing chart_id (Python ``validate_chart_data``).
 */
export function validateChartData(
  chartRows: readonly ChartRow[],
  pointRows: readonly ChartPointRow[],
): string[] {
  const violations: string[] = [];
  const chartIds = new Set(chartRows.map((row) => row.chart_id.trim()));
  chartRows.forEach((row, index) => {
    if (row.source_asset_id.trim() === "") {
      violations.push(
        `chart_data.csv row ${index + 1}: missing source_asset_id (chart_id='${row.chart_id}')`,
      );
    }
  });
  pointRows.forEach((row, index) => {
    const chartId = row.chart_id.trim();
    if (chartId === "") {
      violations.push(`chart_data_points.csv row ${index + 1}: missing chart_id`);
    } else if (!chartIds.has(chartId)) {
      violations.push(
        `chart_data_points.csv row ${index + 1}: chart_id '${chartId}' has no matching chart_data.csv row`,
      );
    }
  });
  return violations;
}

/**
 * Model-extraction admission gate (Python ``validate_chart_extraction``):
 * L1 rows must carry model_name; L1 points must carry categorical confidence.
 * Deterministic tiers (L2/L3) are exempt.
 */
export function validateChartExtraction(
  chartRows: readonly ChartRow[],
  pointRows: readonly ChartPointRow[],
): string[] {
  const violations: string[] = [];
  const chartById = new Map(chartRows.map((row) => [row.chart_id, row]));
  for (const row of chartRows) {
    const tier = row.extraction_tier.trim();
    if (tier !== "" && !tier.startsWith("L1")) continue;
    if (row.model_name.trim() === "") {
      violations.push(`chart_data.csv row '${row.chart_id}': missing model_name on model-extracted chart`);
    }
  }
  pointRows.forEach((row, index) => {
    const chart = chartById.get(row.chart_id);
    const tier = chart?.extraction_tier.trim() ?? "";
    if (tier !== "" && !tier.startsWith("L1")) return;
    if (
      row.confidence_level !== "high" &&
      row.confidence_level !== "medium" &&
      row.confidence_level !== "low"
    ) {
      violations.push(
        `chart_data_points.csv row ${index + 1}: invalid confidence_level on model-extracted point '${row.point_id}'`,
      );
    }
    if (row.confidence_reason.trim() === "") {
      violations.push(
        `chart_data_points.csv row ${index + 1}: missing confidence_reason on model-extracted point '${row.point_id}'`,
      );
    }
    if (row.human_review_state === "not_required") {
      violations.push(
        `chart_data_points.csv row ${index + 1}: model-extracted point '${row.point_id}' must not bypass human review`,
      );
    }
    if (
      (row.human_review_state === "accepted" || row.human_review_state === "corrected") &&
      row.review_id.trim() === ""
    ) {
      violations.push(
        `chart_data_points.csv row ${index + 1}: reviewed model-extracted point '${row.point_id}' is missing review_id`,
      );
    }
  });
  return violations;
}

/** Serialize chart rows so one invocation cannot interleave with another. */
const csvMutex = new Map<string, Promise<unknown>>();

async function withLock<T>(key: string, body: () => Promise<T>): Promise<T> {
  const previous = csvMutex.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  csvMutex.set(key, previous.then(() => gate));
  await previous;
  try {
    return await body();
  } finally {
    release();
  }
}

function chartRowToRecord(row: ChartRow): CsvRecord {
  return Object.fromEntries(
    CHART_DATA_COLUMNS.map((column) => [column, String(row[column] ?? "")]),
  );
}

function pointRowToRecord(row: ChartPointRow): CsvRecord {
  return Object.fromEntries(
    CHART_DATA_POINTS_COLUMNS.map((column) => [column, String(row[column] ?? "")]),
  );
}

function recordToChartRow(record: CsvRecord): ChartRow {
  return {
    chart_id: record.chart_id ?? "",
    source_asset_id: record.source_asset_id ?? "",
    chart_type: record.chart_type ?? "",
    title: record.title ?? "",
    x_label: record.x_label ?? "",
    x_unit: record.x_unit ?? "",
    x_scale: record.x_scale ?? "",
    y_label: record.y_label ?? "",
    y_unit: record.y_unit ?? "",
    y_scale: record.y_scale ?? "",
    data_point_count: Number.parseInt(record.data_point_count ?? "0", 10) || 0,
    legend: record.legend ?? "",
    extracted_at: record.extracted_at ?? "",
    model_name: record.model_name ?? "",
    source_label: record.source_label ?? "",
    page_number: record.page_number ?? "",
    bbox: record.bbox ?? "",
    extraction_tier: record.extraction_tier ?? "",
  };
}

function recordToPointRow(record: CsvRecord): ChartPointRow {
  return {
    point_id: record.point_id ?? "",
    chart_id: record.chart_id ?? "",
    x_value: record.x_value ?? "",
    y_value: record.y_value ?? "",
    series_label: record.series_label ?? "",
    confidence_level:
      record.confidence_level === "high" ||
      record.confidence_level === "medium" ||
      record.confidence_level === "low"
        ? record.confidence_level
        : "not_applicable",
    confidence_reason: record.confidence_reason ?? "",
    human_review_state:
      record.human_review_state === "pending" ||
      record.human_review_state === "accepted" ||
      record.human_review_state === "corrected" ||
      record.human_review_state === "rejected"
        ? record.human_review_state
        : "not_required",
    review_id: record.review_id ?? "",
    original_x_value: record.original_x_value ?? "",
    original_y_value: record.original_y_value ?? "",
  };
}

async function readCsvRows(filePath: string, columns: readonly string[], fileName: string): Promise<CsvRecord[]> {
  try {
    const content = await readFile(filePath, "utf8");
    return decodeCsv(content, columns, fileName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  await writeFile(tempPath, content, "utf8");
  try {
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

/**
 * Write (or append to) chart_data.csv / chart_data_points.csv.
 * Returns the two absolute CSV paths. Throws ``ValueError`` on integrity or
 * admission violations (never persists a broken payload).
 */
export async function writeChartCsvs(
  chartDataDir: string,
  chartRows: readonly ChartRow[],
  pointRows: readonly ChartPointRow[],
  afterMerge?: (
    mergedCharts: readonly ChartRow[],
    mergedPoints: readonly ChartPointRow[],
  ) => Promise<void>,
): Promise<{ chartCsv: string; pointsCsv: string }> {
  await mkdir(chartDataDir, { recursive: true });
  const chartCsvPath = path.join(chartDataDir, CHART_CSV_NAME);
  const pointsCsvPath = path.join(chartDataDir, CHART_POINTS_CSV_NAME);

  return withLock(chartDataDir, async () => {
    const existingCharts = await readCsvRows(chartCsvPath, CHART_DATA_COLUMNS, CHART_CSV_NAME);
    const existingPoints = await readCsvRows(pointsCsvPath, CHART_DATA_POINTS_COLUMNS, CHART_POINTS_CSV_NAME);
    const mergedCharts = mergeById(existingCharts, chartRows.map(chartRowToRecord), "chart_id");
    const incomingChartIds = new Set(chartRows.map((row) => row.chart_id));
    const preservedPoints = existingPoints.filter((row) => !incomingChartIds.has(row.chart_id ?? ""));
    const mergedPoints = mergeById(preservedPoints, pointRows.map(pointRowToRecord), "point_id");

    const normalizedCharts = mergedCharts.map(recordToChartRow);
    const normalizedPoints = mergedPoints.map(recordToPointRow);
    const violations = validateChartData(normalizedCharts, normalizedPoints);
    if (violations.length > 0) {
      throw new ValueError("chart_data integrity check failed: " + violations.join("; "));
    }
    const admissionViolations = validateChartExtraction(
      normalizedCharts,
      normalizedPoints,
    );
    if (admissionViolations.length > 0) {
      throw new ValueError("chart_data extraction admission check failed: " + admissionViolations.join("; "));
    }

    await atomicWrite(chartCsvPath, encodeCsv(CHART_DATA_COLUMNS, mergedCharts));
    await atomicWrite(pointsCsvPath, encodeCsv(CHART_DATA_POINTS_COLUMNS, mergedPoints));
    await afterMerge?.(normalizedCharts, normalizedPoints);
    return { chartCsv: chartCsvPath, pointsCsv: pointsCsvPath };
  });
}
