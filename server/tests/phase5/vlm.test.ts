/**
 * P5-08 VLM chart extraction tests: strict JSON parsing, three-tier
 * degradation, CSV outputs, provenance, size caps (Python parity).
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
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
  MAX_PDF_PAGES_PER_FILE,
  MAX_PDF_RENDER_PIXELS,
  RENDER_DPI,
  renderPdfPages,
} from "../../src/processing/vlm/index.js";
import { extractPdfImages } from "../../src/processing/vlm/pdf-images.js";
import { createChartDataVlmTool } from "../../src/agent/tools/extract-chart-data-vlm.js";
import { PublicHttpClient } from "../../src/external/network/http-client.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";
import { SourceAssetRegistry } from "../../src/runtime/source-assets/registry.js";
import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";

const VECTOR_PDF_FIXTURE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pdf",
  "vector-dose-response.pdf",
);

const roots: string[] = [];
const fixtures: FixtureServer[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function tinyPng(red = 200): Buffer {
  const png = new PNG({ width: 2, height: 2 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = red;
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
    { x: "S1", y: 1.2, confidence_level: "high", confidence_reason: "clear bar label" },
    { x: "S2", y: 2.4, confidence_level: "medium", confidence_reason: "interpolated from axis ticks" },
  ],
  legend: [],
});

const LOW_VLM_JSON = JSON.stringify({
  chart_type: "bar",
  title: "Ambiguous expression",
  axes: {
    x: { label: "sample", unit: "", scale: "linear" },
    y: { label: "expression", unit: "TPM", scale: "linear" },
  },
  data_points: [
    {
      x: "S1",
      y: "1.2",
      confidence_level: "low",
      confidence_reason: "bar overlaps a faint grid line",
    },
  ],
  legend: [],
});

const MIXED_VLM_JSON = JSON.stringify({
  chart_type: "bar",
  title: "Mixed-confidence expression",
  axes: {
    x: { label: "sample", unit: "", scale: "linear" },
    y: { label: "expression", unit: "TPM", scale: "linear" },
  },
  data_points: [
    { x: "S1", y: "1.2", confidence_level: "medium", confidence_reason: "interpolated from axis ticks" },
    { x: "S2", y: "2.4", confidence_level: "low", confidence_reason: "bar overlaps a faint grid line" },
  ],
  legend: [],
});

const DOSE_RESPONSE_VLM_JSON = JSON.stringify({
  chart_type: "line",
  title: "Erlotinib dose-response",
  axes: {
    x: { label: "Concentration", unit: "nM", scale: "log" },
    y: { label: "Viability", unit: "%", scale: "linear" },
  },
  data_points: [
    { x: "1", y: "95", series_label: "Erlotinib", confidence_level: "medium", confidence_reason: "curve vertex read against axis ticks" },
    { x: "100", y: "40", series_label: "Erlotinib", confidence_level: "medium", confidence_reason: "curve vertex read against axis ticks" },
  ],
  legend: ["Erlotinib"],
});

/**
 * Minimal multi-page text-only PDF (no caption tokens: "fig", "dose",
 * "response") for the page-render cap test — same hand-assembled byte layout
 * as the committed vector fixture.
 */
function buildTextOnlyPdf(
  pageCount: number,
  mediaBox: readonly [width: number, height: number] = [612, 792],
): Buffer {
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  const pageIds = Array.from({ length: pageCount }, (_, index) => 5 + index * 2);
  objects[2] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";
  for (let index = 0; index < pageCount; index += 1) {
    const contentsId = 4 + index * 2;
    const text = `BT /F1 11 Tf 72 700 Td (Cohort ${index + 1} observations were recorded.) Tj ET`;
    objects[contentsId] = `<< /Length ${Buffer.byteLength(text, "latin1")} >>\nstream\n${text}\nendstream`;
    objects[contentsId + 1] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${mediaBox[0]} ${mediaBox[1]}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${contentsId} 0 R >>`;
  }
  const bytes: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const offsets: number[] = [];
  for (let num = 1; num < objects.length; num += 1) {
    offsets[num] = bytes.reduce((sum, part) => sum + part.length, 0);
    bytes.push(Buffer.from(`${num} 0 obj\n${objects[num]}\nendobj\n`, "latin1"));
  }
  const startxref = bytes.reduce((sum, part) => sum + part.length, 0);
  let xref = `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let num = 1; num < objects.length; num += 1) {
    xref += `${String(offsets[num]).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  bytes.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(bytes);
}

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
    expect(pointRows.map((point) => point.confidence_level)).toEqual(["medium", "medium"]);
    expect(pointRows.map((point) => point.human_review_state)).toEqual(["pending", "pending"]);
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

  it("rejects numeric pseudo-probabilities and requires categorical reasons", () => {
    const numeric = JSON.parse(GOOD_VLM_JSON) as Record<string, unknown>;
    numeric.data_points = [{ x: "S1", y: "1.2", confidence: 0.93 }];
    expect(() =>
      normalizeChartJson(numeric, "asset_x", 0, "f.png", "m"),
    ).toThrow(/numeric confidence/);
    expect(VLM_PROMPT).not.toContain("0.0-1.0");
    expect(VLM_PROMPT).toContain("confidence_reason");
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

  it("round-trips quoted CR/LF and quotes across successive merges", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-multiline-"));
    roots.push(taskRoot);
    const chartDataDir = path.join(taskRoot, "parsed", "chart_data");
    const first = normalizeChartJson(
      JSON.parse(GOOD_VLM_JSON) as Record<string, unknown>,
      "asset_first", 0, "first.png", "qwen-vl-max",
    );
    first.chartRow.title = "line one\r\nline two, \"quoted\"";
    first.pointRows[0]!.confidence_reason = "visible label\nwith quoted \"note\"";
    await writeChartCsvs(chartDataDir, [first.chartRow], first.pointRows);

    const second = normalizeChartJson(
      JSON.parse(GOOD_VLM_JSON) as Record<string, unknown>,
      "asset_second", 0, "second.png", "qwen-vl-max",
    );
    await expect(writeChartCsvs(chartDataDir, [second.chartRow], second.pointRows)).resolves.toBeDefined();
    await expect(readFile(path.join(chartDataDir, CHART_CSV_NAME), "utf8"))
      .resolves.toContain("line one\r\nline two, \"\"quoted\"\"");
    await expect(readFile(path.join(chartDataDir, CHART_POINTS_CSV_NAME), "utf8"))
      .resolves.toContain("visible label\nwith quoted \"\"note\"\"");
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
    await expect(client.call(imagePath, VLM_PROMPT)).rejects.toThrow(
      /visual model credential is missing; configure the visual model provider API key in Settings/i,
    );
  });
});

describe("extract_chart_data_vlm tool", () => {
  it("refuses credentialed VLM access when no permission gate is available", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-permission-"));
    roots.push(taskRoot);
    const executor = vi.fn();
    const [tool] = createChartDataVlmTool({
      taskRoot,
      vlmConfig: { apiKey: "k", baseUrl: "https://vlm.example.com/v1", model: "qwen-vl-max" },
      httpClient: new PublicHttpClient({
        resolve: fakeResolver({ "vlm.example.com": [PUBLIC_IP] }),
        executor,
      }),
    });
    const figureDir = path.join(taskRoot, "source_assets", "figures");
    await mkdir(figureDir, { recursive: true });
    await writeFile(path.join(figureDir, "chart.png"), tinyPng());

    const result = await tool.execute({ source_path: "source_assets/figures/chart.png" });

    expect(JSON.parse(result.content)).toMatchObject({
      status: "error",
      code: "permission_gate_unavailable",
      retryable: false,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/permission gate/i);
    expect(executor).not.toHaveBeenCalled();
  });

  it("does not call DashScope when credential permission is rejected", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-permission-"));
    roots.push(taskRoot);
    const executor = vi.fn();
    const [tool] = createChartDataVlmTool({
      taskRoot,
      approvalGate: { request: async () => "reject" },
      vlmConfig: { apiKey: "k", baseUrl: "https://vlm.example.com/v1", model: "qwen-vl-max" },
      httpClient: new PublicHttpClient({
        resolve: fakeResolver({ "vlm.example.com": [PUBLIC_IP] }),
        executor,
      }),
    });
    const figureDir = path.join(taskRoot, "source_assets", "figures");
    await mkdir(figureDir, { recursive: true });
    await writeFile(path.join(figureDir, "chart.png"), tinyPng());

    const result = await tool.execute({ source_path: "source_assets/figures/chart.png" });

    expect(JSON.parse(result.content)).toMatchObject({
      status: "error",
      code: "permission_denied",
      retryable: false,
    });
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/rejected/i);
    expect(executor).not.toHaveBeenCalled();
  });

  it("runs L1 over a fixture VLM server and writes chart CSVs with provenance", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-"));
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-workspace-"));
    roots.push(taskRoot, workspaceRoot);
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
      workspaceRoot,
      approvalGate: { request: async () => "approve" },
      vlmConfig: { apiKey: "k", baseUrl: "https://vlm.example.com/v1", model: "qwen-vl-max" },
      httpClient,
      hilGate: {
        requestHIL: async () => ({
          schema_version: "1.0",
          review_id: "review_vlm_ok",
          request_id: "request_vlm_ok",
          decision: { action: "accept" },
          reviewer: "user",
          reviewed_at: "2026-08-16T00:00:00.000Z",
          evidence_digest: "a".repeat(64),
          reason: null,
        }),
      },
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
    expect(parsed.outputs.some((output) => output.endsWith("confidence_records.json"))).toBe(true);
    await expect(readFile(
      path.join(workspaceRoot, "parsed", "chart_data", CHART_CSV_NAME),
      "utf8",
    )).resolves.toContain("bar");
    await expect(readFile(
      path.join(workspaceRoot, "parsed", "chart_data", CHART_POINTS_CSV_NAME),
      "utf8",
    )).resolves.toContain("S1");
    await expect(readFile(
      path.join(workspaceRoot, "parsed", "chart_data", "confidence_records.json"),
      "utf8",
    )).resolves.toContain("human_review_state");
    const confidenceArtifact = JSON.parse(
      await readFile(path.join(taskRoot, "parsed", "chart_data", "confidence_records.json"), "utf8"),
    ) as {
      batch_defaults: unknown[];
      record_overrides: Array<{
        channel: string;
        level: string;
        components: { human_review_state: string };
      }>;
    };
    expect(confidenceArtifact.batch_defaults).toEqual([]);
    expect(confidenceArtifact.record_overrides).toHaveLength(2);
    expect(confidenceArtifact.record_overrides).toEqual(expect.arrayContaining([
      expect.objectContaining({
        channel: "vlm",
        level: "medium",
        components: expect.objectContaining({ human_review_state: "accepted" }),
      }),
    ]));
    const pointCsv = await readFile(
      path.join(taskRoot, "parsed", "chart_data", CHART_POINTS_CSV_NAME),
      "utf8",
    );
    expect(pointCsv).not.toContain(",high,");
    expect(pointCsv).not.toContain(",not_required,");
    expect(pointCsv).toContain("accepted,review_vlm_ok");
    await writeFile(path.join(figureDir, "chart-second.png"), tinyPng(100));
    const secondResult = await tool.execute({
      source_path: "source_assets/figures/chart-second.png",
    });
    expect(secondResult.isError).toBeUndefined();
    const mergedConfidenceArtifact = JSON.parse(
      await readFile(path.join(taskRoot, "parsed", "chart_data", "confidence_records.json"), "utf8"),
    ) as { record_overrides: unknown[] };
    expect(mergedConfidenceArtifact.record_overrides).toHaveLength(4);
    expect(parsed.metas[0]?.tier).toBe("L1_vlm");
    expect(parsed.metas[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(SKILL_TOOL_NAMES.has("extract_chart_data_vlm")).toBe(true);
    expect(toolOwner("extract_chart_data_vlm")).toBe("extract_chart_data_vlm");
  }, 60_000);

  it("batches every pending VLM estimate into one data_review request", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-review-"));
    roots.push(taskRoot);
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: MIXED_VLM_JSON } }] }));
    });
    fixtures.push(fixture);
    const requests: Array<{ review_type: string | null; item_count: number }> = [];
    const [tool] = createChartDataVlmTool({
      taskRoot,
      approvalGate: { request: async () => "approve" },
      vlmConfig: { apiKey: "k", baseUrl: "https://vlm.example.com/v1", model: "qwen-vl-max" },
      httpClient: new PublicHttpClient({
        resolve: fakeResolver({ "vlm.example.com": [PUBLIC_IP] }),
        executor: localExecutor(fixture.port),
      }),
      hilGate: {
        requestHIL: async (input) => {
          requests.push({ review_type: input.review_type, item_count: input.review_items.length });
          return {
            schema_version: "1.0",
            review_id: "review_vlm_1",
            request_id: "request_vlm_1",
            decision: { action: "accept" },
            reviewer: "user",
            reviewed_at: "2026-08-16T01:00:00.000Z",
            evidence_digest: "a".repeat(64),
            reason: null,
          };
        },
      },
    });
    const figureDir = path.join(taskRoot, "source_assets", "figures");
    await mkdir(figureDir, { recursive: true });
    await writeFile(path.join(figureDir, "chart.png"), tinyPng());
    const result = await tool.execute({ source_path: "source_assets/figures/chart.png" });
    expect(result.isError).toBeUndefined();
    // Medium- and low-confidence VLM estimates are BOTH pending review: one
    // coalesced data_review request covers the whole source.
    expect(requests).toEqual([{ review_type: "vlm_extraction", item_count: 2 }]);
    const points = await readFile(
      path.join(taskRoot, "parsed", "chart_data", CHART_POINTS_CSV_NAME),
      "utf8",
    );
    expect(points).toContain("confidence_level");
    expect(points).toContain("medium,interpolated from axis ticks,accepted,review_vlm_1");
    expect(points).toContain("low,bar overlaps a faint grid line,accepted,review_vlm_1");
  }, 60_000);

  it("records review provenance on a correct decision while preserving original values", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-correct-"));
    roots.push(taskRoot);
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: LOW_VLM_JSON } }] }));
    });
    fixtures.push(fixture);
    const [tool] = createChartDataVlmTool({
      taskRoot,
      approvalGate: { request: async () => "approve" },
      vlmConfig: { apiKey: "k", baseUrl: "https://vlm.example.com/v1", model: "qwen-vl-max" },
      httpClient: new PublicHttpClient({
        resolve: fakeResolver({ "vlm.example.com": [PUBLIC_IP] }),
        executor: localExecutor(fixture.port),
      }),
      hilGate: {
        requestHIL: async (input) => ({
          schema_version: "1.0",
          review_id: "review_vlm_correct",
          request_id: "request_vlm_correct",
          decision: {
            action: "correct",
            correction: {
              points: Object.fromEntries(input.review_items.map((item) => [
                item.item_id,
                { y_value: "3.3" },
              ])),
            },
          },
          reviewer: "user",
          reviewed_at: "2026-08-16T02:00:00.000Z",
          evidence_digest: "b".repeat(64),
          reason: "bar top misread",
        }),
      },
    });
    const figureDir = path.join(taskRoot, "source_assets", "figures");
    await mkdir(figureDir, { recursive: true });
    await writeFile(path.join(figureDir, "chart.png"), tinyPng());
    const result = await tool.execute({ source_path: "source_assets/figures/chart.png" });
    expect(result.isError).toBeUndefined();
    const rows = (await readFile(
      path.join(taskRoot, "parsed", "chart_data", CHART_POINTS_CSV_NAME),
      "utf8",
    )).trim().split(/\r?\n/);
    // header + the single corrected point; original x/y survive correction.
    expect(rows).toHaveLength(2);
    const columns = rows[0]?.split(",");
    const values = rows[1]?.split(",");
    if (columns === undefined || values === undefined) throw new Error("missing CSV rows");
    const xIndex = columns.indexOf("x_value");
    const yIndex = columns.indexOf("y_value");
    const originalXIndex = columns.indexOf("original_x_value");
    const originalYIndex = columns.indexOf("original_y_value");
    const stateIndex = columns.indexOf("human_review_state");
    const reviewIndex = columns.indexOf("review_id");
    expect(values[stateIndex]).toBe("corrected");
    expect(values[reviewIndex]).toBe("review_vlm_correct");
    expect(values[yIndex]).toBe("3.3");
    expect(values[originalYIndex]).toBe("1.2");
    expect(values[originalXIndex]).toBe(values[xIndex]);
  }, 60_000);

  it("leaves no publishable estimate when the review skips pending points", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-skip-"));
    roots.push(taskRoot);
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: LOW_VLM_JSON } }] }));
    });
    fixtures.push(fixture);
    const [tool] = createChartDataVlmTool({
      taskRoot,
      approvalGate: { request: async () => "approve" },
      vlmConfig: { apiKey: "k", baseUrl: "https://vlm.example.com/v1", model: "qwen-vl-max" },
      httpClient: new PublicHttpClient({
        resolve: fakeResolver({ "vlm.example.com": [PUBLIC_IP] }),
        executor: localExecutor(fixture.port),
      }),
      hilGate: {
        requestHIL: async () => ({
          schema_version: "1.0",
          review_id: "review_vlm_skip",
          request_id: "request_vlm_skip",
          decision: { action: "skip" },
          reviewer: "user",
          reviewed_at: "2026-08-16T03:00:00.000Z",
          evidence_digest: "c".repeat(64),
          reason: "illegible source",
        }),
      },
    });
    const figureDir = path.join(taskRoot, "source_assets", "figures");
    await mkdir(figureDir, { recursive: true });
    await writeFile(path.join(figureDir, "chart.png"), tinyPng());
    const result = await tool.execute({ source_path: "source_assets/figures/chart.png" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { status: string; total_data_points: number };
    expect(parsed.status).toBe("ok");
    expect(parsed.total_data_points).toBe(0);
    const points = (await readFile(
      path.join(taskRoot, "parsed", "chart_data", CHART_POINTS_CSV_NAME),
      "utf8",
    )).trim().split(/\r?\n/);
    expect(points).toHaveLength(1); // header only: the skipped estimate is gone
  }, 60_000);

  it("keeps CSV rows and confidence records aligned across concurrent invocations", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-concurrent-"));
    roots.push(taskRoot);
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: GOOD_VLM_JSON } }] }));
    });
    fixtures.push(fixture);
    let activeApprovals = 0;
    let maximumActiveApprovals = 0;
    const [tool] = createChartDataVlmTool({
      taskRoot,
      approvalGate: {
        request: async () => {
          activeApprovals += 1;
          maximumActiveApprovals = Math.max(maximumActiveApprovals, activeApprovals);
          await new Promise((resolve) => setTimeout(resolve, 10));
          activeApprovals -= 1;
          return "approve";
        },
      },
      vlmConfig: { apiKey: "k", baseUrl: "https://vlm.example.com/v1", model: "qwen-vl-max" },
      httpClient: new PublicHttpClient({
        resolve: fakeResolver({ "vlm.example.com": [PUBLIC_IP] }),
        executor: localExecutor(fixture.port),
      }),
      hilGate: {
        requestHIL: async () => ({
          schema_version: "1.0",
          review_id: "review_vlm_concurrent",
          request_id: "request_vlm_concurrent",
          decision: { action: "accept" },
          reviewer: "user",
          reviewed_at: "2026-08-16T04:00:00.000Z",
          evidence_digest: "d".repeat(64),
          reason: null,
        }),
      },
    });
    const figureDir = path.join(taskRoot, "source_assets", "figures");
    await mkdir(figureDir, { recursive: true });
    await Promise.all([
      writeFile(path.join(figureDir, "first.png"), tinyPng(90)),
      writeFile(path.join(figureDir, "second.png"), tinyPng(110)),
    ]);

    const results = await Promise.all([
      tool.execute({ source_path: "source_assets/figures/first.png" }),
      tool.execute({ source_path: "source_assets/figures/second.png" }),
    ]);

    expect(maximumActiveApprovals).toBe(1);
    expect(results.every((result) => JSON.parse(result.content).status === "ok")).toBe(true);
    const pointCsv = await readFile(
      path.join(taskRoot, "parsed", "chart_data", CHART_POINTS_CSV_NAME),
      "utf8",
    );
    const pointCount = pointCsv.trim().split(/\r?\n/).length - 1;
    const confidence = JSON.parse(await readFile(
      path.join(taskRoot, "parsed", "chart_data", "confidence_records.json"),
      "utf8",
    )) as { record_overrides: unknown[] };
    expect(pointCount).toBe(4);
    expect(confidence.record_overrides).toHaveLength(pointCount);
  }, 60_000);

  it("registers a reviewed VLM evidence manifest only from a formal Core input asset", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-formal-"));
    roots.push(taskRoot);
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: GOOD_VLM_JSON } }] }));
    });
    fixtures.push(fixture);
    const figureDir = path.join(taskRoot, "source_assets", "figures");
    await mkdir(figureDir, { recursive: true });
    await writeFile(path.join(figureDir, "chart.png"), tinyPng());
    const registry = new SourceAssetRegistry("task_vlm_formal", taskRoot, {
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });
    const source = await registry.register({
      sourceId: "source_figure",
      relativePath: "source_assets/figures/chart.png",
      role: "source",
      mediaType: "image/png",
    });
    await registry.registerCoreAcquisitionProvenance(source, {
      provider_id: "fixture.files.v1",
      implementation_digest: "a".repeat(64),
      request_identity_digest: "b".repeat(64),
    });
    const [tool] = createChartDataVlmTool({
      taskRoot,
      taskId: "task_vlm_formal",
      sourceAssetRegistry: registry,
      approvalGate: { request: async () => "approve" },
      hilGate: {
        requestHIL: async (request) => ({
          schema_version: "1.0",
          review_id: "review_formal_vlm",
          request_id: "request_formal_vlm",
          decision: { action: "accept" },
          reviewer: "user",
          reviewed_at: "2026-08-28T00:00:00.000Z",
          evidence_digest: createHash("sha256").update(JSON.stringify(request.evidence)).digest("hex"),
          reason: "Formal point review",
        }),
      },
      vlmConfig: { apiKey: "k", baseUrl: "https://vlm.example.com/v1", model: "qwen-vl-max" },
      httpClient: new PublicHttpClient({
        resolve: fakeResolver({ "vlm.example.com": [PUBLIC_IP] }),
        executor: localExecutor(fixture.port),
      }),
    });

    const result = await tool.execute({ source_asset_id: source.asset_ref.asset_id });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      formal_status: string;
      prompt_digest: string;
      operation_result: { result_manifest_id: string; operation_kind: string; output_kind: string };
      formal_evidence_assets: Array<{
        asset_id: string;
        provenance: {
          operation_kind: string;
          parent_asset_ids: string[];
          evidence: {
            model_version: string;
            manifest: { points: Array<{ human_review_state: string; review_evidence_digest: string }> };
          };
        };
      }>;
    };
    expect(parsed.formal_status).toBe("core_registered");
    expect(parsed.prompt_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.formal_evidence_assets).toHaveLength(1);
    expect(parsed.operation_result).toMatchObject({
      operation_kind: "parse",
      output_kind: "source_asset",
    });
    await expect(registry.resolveDerivedOperationResult(parsed.operation_result.result_manifest_id))
      .resolves.toMatchObject({ output_kind: "source_asset" });
    expect(parsed.formal_evidence_assets[0]).toMatchObject({
      provenance: {
        operation_kind: "vlm_extraction",
        parent_asset_ids: [source.asset_ref.asset_id],
        evidence: {
          model_version: "qwen-vl-max",
          manifest: {
            points: [
              expect.objectContaining({
                human_review_state: "accepted",
                review_evidence_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
              }),
              expect.objectContaining({ human_review_state: "accepted" }),
            ],
          },
        },
      },
    });
    await expect(registry.resolveFormalInput(parsed.formal_evidence_assets[0]!.asset_id))
      .resolves.toMatchObject({ acquisition_provenance: null });
  }, 60_000);

  it("marks a processor-returned error as a tool error (isError, not empty success)", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-"));
    roots.push(taskRoot);
    const [tool] = createChartDataVlmTool({
      taskRoot,
      approvalGate: { request: async () => "approve" },
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
    // A {status:"error"} processor result must surface as a tool error.
    expect(result.isError).toBe(true);
  }, 60_000);
});

describe("PDF image extraction cap", () => {
  it("keeps the Python-parity cap constant", () => {
    expect(MAX_PDF_IMAGES_PER_FILE).toBeGreaterThan(0);
    expect(MAX_PDF_IMAGES_PER_FILE).toBeLessThanOrEqual(100);
  });
});

describe("vector PDF page rendering tier", () => {
  it("finds no embedded raster in the vector-only fixture (embedded rasters stay the first tier)", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-"));
    roots.push(taskRoot);
    const extraction = await extractPdfImages(VECTOR_PDF_FIXTURE, path.join(taskRoot, "download_tmp"));
    expect(extraction.images).toEqual([]);
    expect(extraction.skippedExtra).toBe(0);
  });

  it("selects the caption page and renders it at 144 DPI with a detected pixel bbox", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-"));
    roots.push(taskRoot);
    const rendering = await renderPdfPages(VECTOR_PDF_FIXTURE, path.join(taskRoot, "rendered_pages"));
    // Page 1 carries no caption tokens, so only page 2 is a caption candidate.
    expect(rendering.selection).toBe("caption");
    expect(rendering.pages.map((page) => page.pageIndex)).toEqual([2]);
    const page = rendering.pages[0];
    if (page === undefined) throw new Error("caption page was not rendered");
    const png = PNG.sync.read(await readFile(page.path));
    expect(png.width).toBe(Math.round((612 * RENDER_DPI) / 72));
    expect(png.height).toBe(Math.round((792 * RENDER_DPI) / 72));
    const bbox = page.bbox.split(",").map((value) => Number(value));
    expect(bbox).toHaveLength(4);
    const [x0, y0, x1, y1] = bbox;
    if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) {
      throw new Error("rendered page bbox is incomplete");
    }
    // Detected drawing region, not the full-page rectangle.
    expect(x0).toBeGreaterThan(0);
    expect(y0).toBeGreaterThan(0);
    expect(x1).toBeLessThanOrEqual(png.width);
    expect(y1).toBeLessThanOrEqual(png.height);
    expect(x1).toBeGreaterThan(x0);
    expect(y1).toBeGreaterThan(y0);
  }, 60_000);

  it("renders an admitted custom DPI and rejects unsafe DPI or oversized pages", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-"));
    roots.push(taskRoot);
    const custom = await renderPdfPages(VECTOR_PDF_FIXTURE, path.join(taskRoot, "custom_dpi"), {
      dpi: 216,
    });
    const customPage = custom.pages[0];
    if (customPage === undefined) throw new Error("custom-DPI page was not rendered");
    const png = PNG.sync.read(await readFile(customPage.path));
    expect(png.width).toBe(Math.round((612 * 216) / 72));
    expect(png.height).toBe(Math.round((792 * 216) / 72));

    await expect(renderPdfPages(VECTOR_PDF_FIXTURE, path.join(taskRoot, "unsafe_dpi"), {
      dpi: 301,
    })).rejects.toThrow(/DPI must be an integer between 72 and 300/);

    const oversized = path.join(taskRoot, "oversized_page.pdf");
    await writeFile(oversized, buildTextOnlyPdf(1, [5000, 5000]));
    await expect(renderPdfPages(oversized, path.join(taskRoot, "oversized"), {
      dpi: 144,
    })).rejects.toThrow(new RegExp(`exceeded the ${MAX_PDF_RENDER_PIXELS} pixel rendering limit`));
  }, 60_000);

  it("caps page rendering at 12 pages and falls back to the first pages without caption candidates", async () => {
    expect(MAX_PDF_PAGES_PER_FILE).toBe(12);
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-"));
    roots.push(taskRoot);
    const pdfPath = path.join(taskRoot, "text_only_pages.pdf");
    await writeFile(pdfPath, buildTextOnlyPdf(16));
    const rendering = await renderPdfPages(pdfPath, path.join(taskRoot, "rendered_pages"));
    expect(rendering.selection).toBe("first_pages");
    expect(rendering.pages).toHaveLength(MAX_PDF_PAGES_PER_FILE);
    expect(rendering.skippedPages).toBe(4);
    for (const [index, page] of rendering.pages.entries()) {
      // First-pages fallback keeps source order with 1-based page numbers.
      expect(page.pageIndex).toBe(index + 1);
    }
  }, 60_000);

  it("raises a typed extraction error when page rendering is cancelled", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-"));
    roots.push(taskRoot);
    const controller = new AbortController();
    controller.abort();
    await expect(
      renderPdfPages(VECTOR_PDF_FIXTURE, path.join(taskRoot, "rendered_pages"), {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/cancel/i);
    await expect(
      renderPdfPages(VECTOR_PDF_FIXTURE, path.join(taskRoot, "rendered_pages"), {
        signal: controller.signal,
      }),
    ).rejects.toThrow(ChartExtractionError);
  });

  it("raises a typed extraction error when the PDF cannot be opened for rendering", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-"));
    roots.push(taskRoot);
    const garbage = path.join(taskRoot, "garbage.pdf");
    await writeFile(garbage, "this is not a real pdf at all");
    await expect(renderPdfPages(garbage, path.join(taskRoot, "rendered_pages"))).rejects.toThrow(
      /page rendering/,
    );
    await expect(renderPdfPages(garbage, path.join(taskRoot, "rendered_pages"))).rejects.toThrow(
      ChartExtractionError,
    );
  });

  it("recovers a vector chart through the fake VLM with a 1-based page locator and pixel bbox", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-vector-"));
    roots.push(taskRoot);
    const imageUrls: string[] = [];
    const fixture = await startFixtureServer((_req, res, requests) => {
      const body = JSON.parse(requests.at(-1)?.body ?? "{}") as {
        messages: Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>;
      };
      const part = (body.messages.at(-1)?.content ?? []).find((item) => item.type === "image_url");
      imageUrls.push(part?.image_url?.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: DOSE_RESPONSE_VLM_JSON } }] }));
    });
    fixtures.push(fixture);
    const [tool] = createChartDataVlmTool({
      taskRoot,
      approvalGate: { request: async () => "approve" },
      vlmConfig: { apiKey: "k", baseUrl: "https://vlm.example.com/v1", model: "qwen-vl-max" },
      httpClient: new PublicHttpClient({
        resolve: fakeResolver({ "vlm.example.com": [PUBLIC_IP] }),
        executor: localExecutor(fixture.port),
      }),
      hilGate: {
        requestHIL: async () => ({
          schema_version: "1.0",
          review_id: "review_vlm_vector",
          request_id: "request_vlm_vector",
          decision: { action: "accept" },
          reviewer: "user",
          reviewed_at: "2026-08-30T05:00:00.000Z",
          evidence_digest: "e".repeat(64),
          reason: null,
        }),
      },
    });
    const sourceDir = path.join(taskRoot, "source_assets");
    await mkdir(sourceDir, { recursive: true });
    await copyFile(VECTOR_PDF_FIXTURE, path.join(sourceDir, "vector-dose-response.pdf"));

    const result = await tool.execute({ source_path: "source_assets/vector-dose-response.pdf" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      status: string;
      total_charts: number;
      total_data_points: number;
      degradation?: string[];
      metas: Array<{ tier: string; sha256: string }>;
    };
    expect(parsed.status).toBe("ok");
    expect(parsed.total_charts).toBe(1);
    expect(parsed.total_data_points).toBe(2);
    expect(parsed.metas[0]?.tier).toBe("L1_vlm_page_render");
    expect(parsed.metas[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.degradation).toContain("L1_vlm_page_render");

    // Caption guidance: only the page carrying "Figure 1" reaches the model.
    expect(imageUrls).toHaveLength(1);
    const dataUrl = imageUrls[0] ?? "";
    const base64Prefix = "data:image/png;base64,";
    expect(dataUrl.startsWith(base64Prefix)).toBe(true);
    const pageImage = PNG.sync.read(Buffer.from(dataUrl.slice(base64Prefix.length), "base64"));
    expect(pageImage.width).toBe(1224); // 612pt page at 144 DPI
    expect(pageImage.height).toBe(1584); // 792pt page at 144 DPI

    // SourceLocator 2.0 payload: 1-based page number + detected pixel bbox.
    const chartCsv = await readFile(path.join(taskRoot, "parsed", "chart_data", CHART_CSV_NAME), "utf8");
    const rows = chartCsv.replace(/^\ufeff/, "").trim().split(/\r?\n/);
    expect(rows).toHaveLength(2);
    const columns = rows[0]?.split(",") ?? [];
    const values = rows[1] ?? "";
    const pageNumberIndex = columns.indexOf("page_number");
    expect(pageNumberIndex).toBeGreaterThan(0);
    expect(values.split(",")[pageNumberIndex]).toBe("2");
    const bboxMatch = /"(\d+),(\d+),(\d+),(\d+)"/.exec(values);
    if (bboxMatch === null) throw new Error("chart row carries no pixel bbox");
    const [, x0, y0, x1, y1] = bboxMatch;
    expect(Number(x0)).toBeGreaterThan(0);
    expect(Number(y0)).toBeGreaterThan(0);
    expect(Number(x1)).toBeLessThanOrEqual(pageImage.width);
    expect(Number(y1)).toBeLessThanOrEqual(pageImage.height);
  }, 60_000);

  it("surfaces a page-render failure as a tool error instead of an empty success", async () => {
    const taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-vlm-vector-"));
    roots.push(taskRoot);
    const [tool] = createChartDataVlmTool({
      taskRoot,
      approvalGate: { request: async () => "approve" },
      vlmConfig: { apiKey: "k", baseUrl: "https://vlm.example.com/v1", model: "qwen-vl-max" },
    });
    const sourceDir = path.join(taskRoot, "source_assets");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(path.join(sourceDir, "garbage.pdf"), "this is not a real pdf at all");

    const result = await tool.execute({ source_path: "source_assets/garbage.pdf" });
    const parsed = JSON.parse(result.content) as { status: string; error?: string };
    expect(parsed.status).toBe("error");
    expect(parsed.error).toMatch(/page rendering/);
    expect(result.isError).toBe(true);
  });
});
