/**
 * 侧边栏「数据可视化」面板的数据解析层。
 *
 * ``extract_chart_data_vlm`` 工具完成后的 ``tool_completed.output`` 是
 * VlmResult JSON（status=ok 时含 charts 摘要与指向任务工作区
 * ``parsed/chart_data/*.csv`` 的任务相对路径）。本模块把工具输出与两份
 * CSV（chart_data.csv 图表元数据 + chart_data_points.csv 数据点）解析为
 * 侧边栏可直接渲染的 series。Pi 路径的输出可能是
 * ``{content:[{type:"text",text:...}], details}`` 信封，统一先经
 * ``unwrapToolOutput`` 解包。
 */
import Papa from "papaparse";

import { unwrapToolOutput } from "@/lib/toolOutput";

/** extract_chart_data_vlm 工具名（与服务端 EXTRACT_CHART_DATA_VLM_TOOL_NAME 对应）。 */
export const EXTRACT_CHART_TOOL_NAME = "extract_chart_data_vlm";

export interface ChartToolSummary {
  chartId: string;
  chartType: string;
  pointCount: number;
}

export interface ChartToolOutput {
  sourceFile: string;
  charts: ChartToolSummary[];
  chartDataPath: string;
  pointsPath: string;
}

export type SidebarChartKind = "bar" | "line" | "scatter";

export interface SidebarChartSeries {
  label: string;
  points: Array<{ x: string; y: number; xNumeric: number | null }>;
}

export interface SidebarChart {
  chartId: string;
  title: string;
  kind: SidebarChartKind;
  xLabel: string;
  yLabel: string;
  xLog: boolean;
  yLog: boolean;
  series: SidebarChartSeries[];
  allXNumeric: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function chartPayload(output: string | null): Record<string, unknown> | null {
  const unwrapped = unwrapToolOutput(output);
  if (unwrapped === null) return null;
  if (unwrapped.details !== null) return unwrapped.details;
  return asRecord(safeJsonParse(unwrapped.text));
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 解析一次 extract_chart_data_vlm 的工具输出；非 ok 结果、缺产物路径或
 * 无图表时返回 null（面板据以忽略该条工具调用）。
 */
export function parseChartToolOutput(output: string | null): ChartToolOutput | null {
  const payload = chartPayload(output);
  if (payload === null || payload["status"] !== "ok") return null;
  const outputs = Array.isArray(payload["outputs"])
    ? payload["outputs"].filter((value): value is string => typeof value === "string")
    : [];
  const chartDataPath = outputs.find((path) => path.endsWith("chart_data.csv")) ?? null;
  const pointsPath = outputs.find((path) => path.endsWith("chart_data_points.csv")) ?? null;
  if (chartDataPath === null || pointsPath === null) return null;
  const charts: ChartToolSummary[] = (Array.isArray(payload["charts"]) ? payload["charts"] : [])
    .map((entry) => {
      const record = asRecord(entry);
      if (record === null || typeof record["chart_id"] !== "string") return null;
      return {
        chartId: record["chart_id"],
        chartType: typeof record["chart_type"] === "string" ? record["chart_type"] : "bar",
        pointCount: typeof record["data_point_count"] === "number" ? record["data_point_count"] : 0,
      } satisfies ChartToolSummary;
    })
    .filter((entry): entry is ChartToolSummary => entry !== null);
  if (charts.length === 0) return null;
  return {
    sourceFile: typeof payload["source_file"] === "string" ? payload["source_file"] : "",
    charts,
    chartDataPath,
    pointsPath,
  };
}

function parseRows(text: string): { headers: string[]; rows: string[][] } {
  const parsed = Papa.parse<string[]>(text.replace(/^\ufeff/, ""), {
    skipEmptyLines: "greedy",
  });
  const data = parsed.data ?? [];
  const [headers = [], ...rows] = data;
  return { headers, rows };
}

function cell(row: string[], index: number): string {
  return row[index] ?? "";
}

function labelWithUnit(label: string, unit: string): string {
  return unit === "" ? label : label + " (" + unit + ")";
}

/**
 * 把两份 CSV 解析为可渲染图表列表。chart_data.csv 按 chart_id 后写覆盖
 * 先写（与服务端 merge-by-id 累积语义一致）；无有效数值点的图表跳过。
 */
export function buildSidebarCharts(metaText: string, pointsText: string): SidebarChart[] {
  const meta = parseRows(metaText);
  const metaIndex = {
    chartId: meta.headers.indexOf("chart_id"),
    chartType: meta.headers.indexOf("chart_type"),
    title: meta.headers.indexOf("title"),
    xLabel: meta.headers.indexOf("x_label"),
    xUnit: meta.headers.indexOf("x_unit"),
    xScale: meta.headers.indexOf("x_scale"),
    yLabel: meta.headers.indexOf("y_label"),
    yUnit: meta.headers.indexOf("y_unit"),
    yScale: meta.headers.indexOf("y_scale"),
  };
  if (metaIndex.chartId < 0) return [];
  const metaById = new Map<string, {
    chartType: string;
    title: string;
    xLabel: string;
    yLabel: string;
    xScale: string;
    yScale: string;
  }>();
  for (const row of meta.rows) {
    metaById.set(cell(row, metaIndex.chartId), {
      chartType: cell(row, metaIndex.chartType),
      title: cell(row, metaIndex.title),
      xLabel: labelWithUnit(cell(row, metaIndex.xLabel), cell(row, metaIndex.xUnit)),
      yLabel: labelWithUnit(cell(row, metaIndex.yLabel), cell(row, metaIndex.yUnit)),
      xScale: cell(row, metaIndex.xScale),
      yScale: cell(row, metaIndex.yScale),
    });
  }

  const points = parseRows(pointsText);
  const pointIndex = {
    chartId: points.headers.indexOf("chart_id"),
    xValue: points.headers.indexOf("x_value"),
    yValue: points.headers.indexOf("y_value"),
    series: points.headers.indexOf("series_label"),
  };
  if (pointIndex.chartId < 0) return [];
  const pointsByChart = new Map<string, Map<string, SidebarChartSeries>>();
  for (const row of points.rows) {
    const chartId = cell(row, pointIndex.chartId);
    if (!metaById.has(chartId)) continue;
    const xRaw = cell(row, pointIndex.xValue);
    const y = Number(cell(row, pointIndex.yValue));
    if (xRaw === "" || !Number.isFinite(y)) continue;
    const seriesLabel = cell(row, pointIndex.series) === "" ? "数据" : cell(row, pointIndex.series);
    const bySeries = pointsByChart.get(chartId) ?? new Map<string, SidebarChartSeries>();
    const series = bySeries.get(seriesLabel) ?? { label: seriesLabel, points: [] };
    series.points.push({ x: xRaw, y, xNumeric: Number(xRaw) });
    bySeries.set(seriesLabel, series);
    pointsByChart.set(chartId, bySeries);
  }

  const charts: SidebarChart[] = [];
  for (const [chartId, metaRow] of metaById) {
    const bySeries = pointsByChart.get(chartId);
    if (bySeries === undefined || bySeries.size === 0) continue;
    const series = [...bySeries.values()];
    const allXNumeric = series.every((entry) =>
      entry.points.every((point) => point.xNumeric !== null && Number.isFinite(point.xNumeric)),
    );
    charts.push({
      chartId,
      title: metaRow.title === "" ? chartId : metaRow.title,
      kind: chartKind(metaRow.chartType),
      xLabel: metaRow.xLabel,
      yLabel: metaRow.yLabel,
      xLog: metaRow.xScale === "log" && allXNumeric,
      yLog: metaRow.yScale === "log",
      series,
      allXNumeric,
    });
  }
  return charts;
}

function chartKind(chartType: string): SidebarChartKind {
  if (chartType === "line") return "line";
  if (chartType === "scatter") return "scatter";
  return "bar";
}
