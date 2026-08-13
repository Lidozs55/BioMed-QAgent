/**
 * P5-08 VLM chart extraction tests: strict JSON parsing, three-tier
 * degradation, CSV outputs, provenance, size caps (Python parity).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { PNG } from "pngjs";

import {
  CHART_CSV_NAME,
  CHART_POINTS_CSV_NAME,
  parseVlmJson,
  normalizeChartJson,
  writeChartCsvs,
  validateChartExtraction,
  validateChartData,
  MAX_VLM_IMAGE_BYTES,
  encodeImageBase64,
  createVlmClient,
  VLM_PROMPT,
  ChartExtractionError,
  MAX_PDF_IMAGES_PER_FILE,
} from "../../src/processing/vlm/index.js";
import { createChartDataVlmTool } from "../../src/agent/tools/extract-chart-data-vlm.js";
import { PublicHttpClient } from "../../src/external/network/http-client.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";
import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";

const roots: string[] = [];
const fixtures: FixtureServer[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function tinyPng(): Buffer {
  const png = new PNG({ width: 2, height: 2 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 200;
    png.data[index + 1] = 30;
    png.data[index + 2] = 30;
    png.data[index + 3] = 255;
  }
  return Buffer.from(PNG.sync.write(png));
}

const GOOD_VLM_JSON = JSON.stringify({
  chart_type: "bar",
  title: "TP53 expression",
  axes: {
    x: { label: "sample", unit: "", scale: "linear" },
    y: { label: "expression", unit: "TPM", scale: "linear" },
  },
  data_points: [
    { x: "S1", y: 1.2, confidence: 1.0 },
    { x: "S2", y: 2.4, confidence: 0.9 },
  ],
  legend: [],
});

describe("parseVlmJson strictness", () => {
  it("parses plain JSON", () => {
    expect(parseVlmJson(GOOD_VLM_JSON, "t").chart_type).toBe("bar");
  });

  it("tolerates markdown code fences", () => {
    expect(parseVlmJson(`\`\`\`json\n${GOOD_VLM_JSON}\n\`\`\``, "t").chart_type).toBe("bar");
  });

  it("tolerates trailing prose after the JSON object", () => {
    expect(parseVlmJson(`${GOOD_VLM_JSON}\nHere is the chart.`, "t").chart_type).toBe("bar");
  });

  it("rejects non-JSON responses", () => {
    expect(() => parseVlmJson("not json at all", "t")).toThrow(ChartExtractionError);
  });

  it("rejects objects missing the required top-level keys", () => {
    expect(() => parseVlmJson(JSON.stringify({ chart_type: "bar" }), "t")).toThrow(ChartExtractionError);
    expect(() => parseVlmJson(JSON.stringify({ chart_type: "bar", axes: {} }), "t")).toThrow(ChartExtractionError);
  });
});

describe("normalizeChartJson", () => {
  it("normalizes a well-formed record into chart + point rows", () => {
    const { chartRow, pointRows } = normalizeChartJson(
      JSON.parse(GOOD_VLM_JSON) as Record<string, unknown>,
      "asset_abc123", 0, "figure.png", "qwen-vl-max",
    );
    expect(chartRow.chart_type).toBe("bar");
    expect(chartRow.source_asset_id).toBe("asset_abc123");
    expect(chartRow.model_name).toBe("qwen-vl-max");
    expect(pointRows).toHaveLength(2);
    expect(pointRows[0]?.x_value).toBe("S1");
    expect(pointRows[0]?.y_value).toBe("1.2");
    expect(validateChartData([chartRow], pointRows)).toEqual([]);
  });

  it("defaults missing optional fields instead of throwing", () => {
    const { chartRow, pointRows } = normalizeChartJson(
      { chart_type: "other", axes: {}, data_points: [] },
      "asset_x", 0, "f.png", "m",
    );
    expect(chartRow.chart_type).toBe("other");
    expect(chartRow.x_label).toBe("");
    expect(pointRows).toEqual([]);
  });
});

describe("writeChartCsvs + validation", () => {
  it("writes chart_data.csv and chart_data_points.csv with the stable column sets", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-"));
    roots.push(taskRoot);
    const chartDataDir = path.join(taskRoot, "parsed", "chart_data");
    const { chartRow, pointRows } = normalizeChartJson(
      JSON.parse(GOOD_VLM_JSON) as Record<string, unknown>,
      "asset_abc123", 0, "figure.png", "qwen-vl-max",
    );
    expect(validateChartExtraction([chartRow], pointRows)).toEqual([]);
    const written = await writeChartCsvs(chartDataDir, [chartRow], pointRows);
    const chartCsv = await import("node:fs/promises").then((fs) => fs.readFile(written.chartCsv, "utf8"));
    // Python writes utf-8-sig (BOM); strip for the header check.
    expect(chartCsv.replace(/^\ufeff/, "").split("\n")[0]?.split(",")).toContain("chart_id");
    expect(chartCsv).toContain("bar");
    const pointsCsv = await import("node:fs/promises").then((fs) => fs.readFile(written.pointsCsv, "utf8"));
    expect(pointsCsv.replace(/^\ufeff/, "").split("\n")[0]?.split(",")).toContain("x_value");
    expect(pointsCsv).toContain("S1");
    expect(written.chartCsv.endsWith(CHART_CSV_NAME)).toBe(true);
    expect(written.pointsCsv.endsWith(CHART_POINTS_CSV_NAME)).toBe(true);
  });

  it("reports violations for model-extracted charts missing model_name", () => {
    const { chartRow, pointRows } = normalizeChartJson(
      JSON.parse(GOOD_VLM_JSON) as Record<string, unknown>,
      "asset_abc123", 0, "figure.png", "", // empty model name
    );
    const violations = validateChartExtraction([chartRow], pointRows);
    expect(violations.some((violation) => violation.includes("model_name"))).toBe(true);
  });
});

describe("VLM image encoding caps", () => {
  it("rejects image files above MAX_VLM_IMAGE_BYTES", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-"));
    roots.push(taskRoot);
    const big = path.join(taskRoot, "big.png");
    await writeFile(big, Buffer.alloc(MAX_VLM_IMAGE_BYTES + 1));
    await expect(encodeImageBase64(big)).rejects.toThrow(ChartExtractionError);
  });

  it("encodes small images to base64", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-"));
    roots.push(taskRoot);
    const small = path.join(taskRoot, "small.png");
    await writeFile(small, tinyPng());
    const encoded = await encodeImageBase64(small);
    expect(encoded).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

describe("createVlmClient L1 tier", () => {
  it("calls the OpenAI-compatible endpoint with the image and returns the raw JSON", async () => {
    const fixture = await startFixtureServer((_req, res, requests) => {
      const body = JSON.parse(requests.at(-1)?.body ?? "{}") as {
        messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
      };
      const userMessage = body.messages.at(-1)?.content ?? [];
      expect(userMessage.some((part) => part.type === "image_url" && part.image_url?.url.startsWith("data:image/png;base64,"))).toBe(true);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: GOOD_VLM_JSON } }] }));
    });
    fixtures.push(fixture);
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-"));
    roots.push(taskRoot);
    const imagePath = path.join(taskRoot, "chart.png");
    await writeFile(imagePath, tinyPng());
    const client = createVlmClient(
      { apiKey: "test-key", baseUrl: "https://vlm.example.com/v1", model: "qwen-vl-max" },
      new PublicHttpClient({
        resolve: fakeResolver({ "vlm.example.com": [PUBLIC_IP] }),
        executor: localExecutor(fixture.port),
      }),
    );
    const raw = await client.call(imagePath, VLM_PROMPT);
    expect(parseVlmJson(raw, "chart.png").chart_type).toBe("bar");
    expect(VLM_PROMPT.length).toBeGreaterThan(100);
  });

  it("fails fast when no VLM credential is configured", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-"));
    roots.push(taskRoot);
    const imagePath = path.join(taskRoot, "chart.png");
    await writeFile(imagePath, tinyPng());
    const client = createVlmClient(
      { apiKey: "", baseUrl: "https://vlm.example.com/v1", model: "qwen-vl-max" },
      new PublicHttpClient(),
    );
    await expect(client.call(imagePath, VLM_PROMPT)).rejects.toThrow(/DASHSCOPE_API_KEY/);
  });
});

describe("extract_chart_data_vlm tool", () => {
  it("runs L1 over a fixture VLM server and writes chart CSVs with provenance", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-"));
    roots.push(taskRoot);
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: GOOD_VLM_JSON } }] }));
    });
    fixtures.push(fixture);
    const httpClient = new PublicHttpClient({
      resolve: fakeResolver({ "vlm.example.com": [PUBLIC_IP] }),
      executor: localExecutor(fixture.port),
    });
    const [tool] = createChartDataVlmTool({
      taskRoot,
      vlmConfig: { apiKey: "k", baseUrl: "https://vlm.example.com/v1", model: "qwen-vl-max" },
      httpClient,
    });
    const figureDir = path.join(taskRoot, "source_assets", "figures");
    await mkdir(figureDir, { recursive: true });
    await writeFile(path.join(figureDir, "chart.png"), tinyPng());
    const result = await tool.execute({ source_path: "source_assets/figures/chart.png" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      status: string;
      total_charts: number;
      total_data_points: number;
      outputs: string[];
      metas: Array<{ sha256: string; tier: string }>;
    };
    expect(parsed.status).toBe("ok");
    expect(parsed.total_charts).toBe(1);
    expect(parsed.total_data_points).toBe(2);
    expect(parsed.outputs.some((output) => output.endsWith(CHART_CSV_NAME))).toBe(true);
    expect(parsed.outputs.some((output) => output.endsWith(CHART_POINTS_CSV_NAME))).toBe(true);
    expect(parsed.metas[0]?.tier).toBe("L1_vlm");
    expect(parsed.metas[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(SKILL_TOOL_NAMES.has("extract_chart_data_vlm")).toBe(true);
    expect(toolOwner("extract_chart_data_vlm")).toBe("extract_chart_data_vlm");
  }, 60_000);

  it("fails (not empty success) when every tier fails", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-"));
    roots.push(taskRoot);
    const [tool] = createChartDataVlmTool({
      taskRoot,
      // Missing API key → L1 fails fast; an image has no tables (L2) and no
      // captions (L3) → every tier fails.
      vlmConfig: { apiKey: "", baseUrl: "https://vlm.example.com/v1", model: "qwen-vl-max" },
    });
    const figureDir = path.join(taskRoot, "source_assets", "figures");
    await mkdir(figureDir, { recursive: true });
    await writeFile(path.join(figureDir, "chart.png"), tinyPng());
    const result = await tool.execute({ source_path: "source_assets/figures/chart.png" });
    const parsed = JSON.parse(result.content) as { status: string; error?: string };
    expect(parsed.status).toBe("error");
    expect(parsed.error).toBeTruthy();
  }, 60_000);
});

describe("PDF image extraction cap", () => {
  it("keeps the Python-parity cap constant", () => {
    expect(MAX_PDF_IMAGES_PER_FILE).toBeGreaterThan(0);
    expect(MAX_PDF_IMAGES_PER_FILE).toBeLessThanOrEqual(100);
  });
});
