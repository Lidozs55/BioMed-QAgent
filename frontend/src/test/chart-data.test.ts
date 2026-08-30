import { describe, expect, it } from "vitest";

import {
  buildSidebarCharts,
  parseChartToolOutput,
} from "@/lib/chartData";

const TOOL_OUTPUT = JSON.stringify({
  status: "ok",
  source_file: "figure_1.png",
  source_path: "source_assets/figures/figure_1.png",
  outputs: [
    "parsed/chart_data/chart_data.csv",
    "parsed/chart_data/chart_data_points.csv",
    "parsed/chart_data/chart_confidence.json",
  ],
  charts: [
    { chart_id: "chart_001", chart_type: "bar", data_point_count: 2, source_asset_id: "asset_1" },
  ],
  total_charts: 1,
  total_data_points: 2,
  metas: [],
});

const META_CSV = [
  "chart_id,source_asset_id,chart_type,title,x_label,x_unit,x_scale,y_label,y_unit,y_scale",
  "chart_001,asset_1,bar,活性对比,浓度,μM,linear,活性,%,linear",
].join("\n");

const POINTS_CSV = [
  "point_id,chart_id,x_value,y_value,series_label",
  "p1,chart_001,1,10,实验组",
  "p2,chart_001,2,20,实验组",
  "p3,chart_001,1,8,对照组",
].join("\n");

describe("parseChartToolOutput", () => {
  it("parses a successful VlmResult with chart CSV paths", () => {
    const parsed = parseChartToolOutput(TOOL_OUTPUT);
    expect(parsed).toEqual({
      sourceFile: "figure_1.png",
      charts: [{ chartId: "chart_001", chartType: "bar", pointCount: 2 }],
      chartDataPath: "parsed/chart_data/chart_data.csv",
      pointsPath: "parsed/chart_data/chart_data_points.csv",
    });
  });

  it("unwraps a Pi tool envelope and reads the details payload", () => {
    const envelope = JSON.stringify({
      content: [{ type: "text", text: TOOL_OUTPUT }],
      details: JSON.parse(TOOL_OUTPUT),
    });
    expect(parseChartToolOutput(envelope)?.charts).toHaveLength(1);
  });

  it("returns null for errors, garbage and missing outputs", () => {
    expect(parseChartToolOutput(null)).toBeNull();
    expect(parseChartToolOutput("not json")).toBeNull();
    expect(
      parseChartToolOutput(JSON.stringify({ status: "error", error: "boom" })),
    ).toBeNull();
    expect(parseChartToolOutput(JSON.stringify({ status: "ok", charts: [] }))).toBeNull();
  });
});

describe("buildSidebarCharts", () => {
  it("builds grouped series with axis labels and units", () => {
    const charts = buildSidebarCharts(META_CSV, POINTS_CSV);
    expect(charts).toHaveLength(1);
    const chart = charts[0];
    expect(chart.chartId).toBe("chart_001");
    expect(chart.title).toBe("活性对比");
    expect(chart.kind).toBe("bar");
    expect(chart.xLabel).toBe("浓度 (μM)");
    expect(chart.yLabel).toBe("活性 (%)");
    expect(chart.xLog).toBe(false);
    expect(chart.allXNumeric).toBe(true);
    expect(chart.series.map((series) => series.label)).toEqual(["实验组", "对照组"]);
    expect(chart.series[0].points).toEqual([
      { x: "1", y: 10, xNumeric: 1 },
      { x: "2", y: 20, xNumeric: 2 },
    ]);
  });

  it("drops rows with non-numeric y and charts without points; enables log axes", () => {
    const points = POINTS_CSV + "\np4,chart_001,3,not-a-number,实验组";
    const charts = buildSidebarCharts(META_CSV, points);
    expect(charts[0].series[0].points).toHaveLength(2);

    const logMeta = META_CSV.replace(",%,linear", ",%,log");
    const chartsLog = buildSidebarCharts(logMeta, POINTS_CSV);
    expect(chartsLog[0].yLog).toBe(true);
    expect(chartsLog[0].xLog).toBe(false);

    expect(buildSidebarCharts(META_CSV, "point_id,chart_id,x_value,y_value\n")).toEqual([]);
    expect(buildSidebarCharts("nonsense", POINTS_CSV)).toEqual([]);
  });

  it("keeps categorical x values in file order and flags non-numeric axes", () => {
    const categorical = [
      "point_id,chart_id,x_value,y_value,series_label",
      "p1,chart_001,对照,10,实验组",
      "p2,chart_001,处理,20,实验组",
    ].join("\n");
    const charts = buildSidebarCharts(META_CSV, categorical);
    expect(charts[0].allXNumeric).toBe(false);
    expect(charts[0].series[0].points.map((point) => point.x)).toEqual(["对照", "处理"]);
  });
});
