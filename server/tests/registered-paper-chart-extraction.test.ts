import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { SourceAssetRegistry } from "../src/runtime/source-assets/registry.js";
import type { VlmClient, VlmConfig } from "../src/processing/vlm/index.js";
import {
  extractRegisteredPaperChartEvidence,
  parseRegisteredPaperChartResponse,
  REGISTERED_PAPER_CHART_PROMPT,
  type RegisteredPaperChartExtractionRequest,
} from "../src/processing/vlm/registered-paper-chart-extraction.js";
import {
  assertChartEvidenceRows,
  assertChartEvidenceCarrierRows,
} from "../src/dataset/families/bioactivity-measurement/chart-evidence/index.js";
import {
  assertPaperEvidenceRows,
  derivePaperCanonicalIdentities,
} from "../src/dataset/families/bioactivity-measurement/paper-evidence/index.js";
import type {
  ChartEvidenceRows,
} from "../src/dataset/families/bioactivity-measurement/chart-evidence/index.js";
import type {
  PaperEvidenceRows,
} from "../src/dataset/families/bioactivity-measurement/paper-evidence/index.js";
import type { SourceAssetRegistrationReceipt } from "@biomed/contracts";

const API_KEY = "secret-fixture-key-do-not-leak";
const RESOLVED_MODEL = "fixture-vlm-model";
const PROVIDER_MODEL_VERSION = "fixture-vlm-model-2026-08-01";
const FIXED_NOW = new Date("2026-08-30T10:00:00Z");
const VECTOR_PDF_FIXTURE = path.resolve(
  "tests/phase5/fixtures/pdf/vector-dose-response.pdf",
);

interface FakeClientCall {
  imagePath: string;
  prompt: string;
  configModel: string;
}

function makeVlmResponse(overrides: {
  paper?: Record<string, unknown> | null;
  experiments?: unknown;
  activities?: unknown;
  series?: unknown;
  points?: unknown;
} = {}): string {
  const body: Record<string, unknown> = {
    paper: overrides.paper === undefined
      ? {
          title: "Quantitative inhibition of EGFR signaling",
          journal: "Open Kinase Methods",
          publication_date: "2020-04-03",
          authors: ["A. Researcher", "B. Scientist"],
          source_url: "https://pubmed.ncbi.nlm.nih.gov/31234567/",
        }
      : overrides.paper,
    experiments: overrides.experiments ?? [
      {
        experiment_id: "exp_fig2",
        protein: "EGFR",
        variant: "none",
        construct: "wild-type kinase domain",
        ligand: "erlotinib",
        assay_type: "cellular kinase assay",
        cell_line_or_system: "HCC827 cells",
        temperature: "37 C",
        buffer: "complete RPMI",
        incubation_time: "72 h",
        figure_id: "Figure_2A",
        locator_evidence: "Figure 2A dose response experiment",
      },
    ],
    activities: overrides.activities ?? [
      {
        activity_key: "act_ic50_erlo",
        experiment_id: "exp_fig2",
        compound: "Erlotinib",
        protein_variant: "EGFR",
        activity_type: "IC50",
        activity_value: "12.5",
        activity_unit: "nM",
        relation: "<",
        replicate_count: 3,
        error_value: null,
        error_type: null,
        original_text: "erlotinib inhibited EGFR signalling with an IC50 of 12.5 nM (Figure 2A)",
        table_or_figure: "Figure_2A",
        row_label: "none",
        column_label: "none",
        confidence_level: "medium",
      },
    ],
    series: overrides.series ?? [
      {
        series_key: "fig2_erlo",
        figure_id: "Figure_2A",
        series_label: "Erlotinib",
        x_axis_name: "Erlotinib concentration",
        x_axis_unit: "nM",
        y_axis_name: "EGFR activity",
        y_axis_unit: "percent",
        x_scale: "log",
        y_scale: "linear",
        legend_text: "Erlotinib",
        axis_validation_status: "clear",
        legend_validation_status: "clear",
        bbox: [40, 60, 560, 400],
        extraction_confidence: "medium",
        confidence_reason: "Axis labels and legend are legible.",
      },
    ],
    points: overrides.points ?? [
      {
        series_key: "fig2_erlo",
        activity_key: "act_ic50_erlo",
        x_value: "10",
        y_value: "64.5",
        point_type: "line_vertex",
        bbox: [200, 180, 212, 192],
        extraction_confidence: "medium",
        confidence_reason: "Marker is visible on the curve.",
      },
      {
        series_key: "fig2_erlo",
        activity_key: "act_ic50_erlo",
        x_value: "100",
        y_value: "22",
        point_type: "line_vertex",
        bbox: [300, 260, 312, 272],
        extraction_confidence: "low",
        confidence_reason: "Marker overlaps the grid line.",
      },
    ],
  };
  return JSON.stringify(body);
}

interface FixtureAssets {
  xmlReceipt: SourceAssetRegistrationReceipt;
  pdfReceipt: SourceAssetRegistrationReceipt;
  supplementReceipt: SourceAssetRegistrationReceipt;
  screenshotReceipt: SourceAssetRegistrationReceipt;
}

interface FakePageImageExtraction {
  images: { path: string; pageIndex: number; bbox: string }[];
  skippedPages: number;
}

interface FixtureDeps {
  resolveVlmConfig: () => Promise<VlmConfig>;
  vlmClientFactory: () => VlmClient;
  extractPageImages: (
    pdfBytes: Buffer,
    sourceLabel: string,
    destDir: string,
  ) => Promise<FakePageImageExtraction>;
  now: () => Date;
}

interface Fixture {
  roots: string[];
  taskRoot: string;
  registry: SourceAssetRegistry;
  assets: FixtureAssets;
  calls: FakeClientCall[];
  prompts: string[];
  depsDefaults: FixtureDeps;
}

async function writeFileAndRegister(
  registry: SourceAssetRegistry,
  taskRoot: string,
  fileName: string,
  bytes: string | Buffer,
  mediaType: string,
  role: "source" | "carrier" = "source",
): Promise<SourceAssetRegistrationReceipt> {
  const filePath = path.join(taskRoot, "source_assets", fileName);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, bytes);
  return registry.register({
    sourceId: `fixture_${fileName.replaceAll(/[^A-Za-z0-9_-]/g, "_")}`,
    relativePath: `source_assets/${fileName}`,
    mediaType,
    role,
  });
}

async function makeFixture(responseContent: string): Promise<Fixture> {
  const roots: string[] = [];
  const taskRoot = await mkdtemp(path.join(os.tmpdir(), "registered-paper-chart-"));
  roots.push(taskRoot);
  const registry = new SourceAssetRegistry("task_gold6_t5", taskRoot, { now: () => FIXED_NOW });
  const xml = Buffer.from(
    "<article><front><journal-meta><journal-title>Open Kinase Methods</journal-title></journal-meta>" +
      "<article-meta><article-id pub-id-type=\"pmid\">31234567</article-id>" +
      "<title-group><article-title>Quantitative inhibition of EGFR signaling</article-title></title-group>" +
      "<contrib-group><contrib contrib-type=\"author\"><name><surname>Researcher</surname>" +
      "<given-names>A.</given-names></name></contrib><contrib contrib-type=\"author\"><name>" +
      "<surname>Scientist</surname><given-names>B.</given-names></name></contrib></contrib-group>" +
      "<pub-date pub-type=\"epub\"><day>3</day><month>4</month><year>2020</year></pub-date>" +
      "</article-meta></front></article>",
    "utf8",
  );
  const pdf = Buffer.from("%PDF-1.4 fixture bytes for registered paper chart extraction\n", "utf8");
  const supplement = Buffer.from("compound,value\nErlotinib,12.5\n", "utf8");
  const screenshot = Buffer.from("fake browser screenshot bytes", "utf8");
  const assets: FixtureAssets = {
    xmlReceipt: await writeFileAndRegister(registry, taskRoot, "paper-fulltext.xml", xml, "application/xml"),
    pdfReceipt: await writeFileAndRegister(registry, taskRoot, "paper.pdf", pdf, "application/pdf", "carrier"),
    supplementReceipt: await writeFileAndRegister(registry, taskRoot, "supplement-s1.csv", supplement, "text/csv"),
    screenshotReceipt: await writeFileAndRegister(registry, taskRoot, "capture.png", screenshot, "image/png", "carrier"),
  };
  const calls: FakeClientCall[] = [];
  const prompts: string[] = [];
  const fakeClient: VlmClient = {
    call: async () => {
      throw new Error("legacy call() must not be used by the governed extraction");
    },
    callWithMeta: async (imagePath, prompt) => {
      calls.push({ imagePath, prompt, configModel: RESOLVED_MODEL });
      prompts.push(prompt);
      return { content: responseContent, model: PROVIDER_MODEL_VERSION };
    },
  };
  const pageImage = Buffer.from("fake page raster bytes", "utf8");
  return {
    roots,
    taskRoot,
    registry,
    assets,
    calls,
    prompts,
    depsDefaults: {
      resolveVlmConfig: async (): Promise<VlmConfig> => ({
        apiKey: API_KEY,
        baseUrl: "https://vlm.fixture.example/v1",
        model: RESOLVED_MODEL,
      }),
      vlmClientFactory: () => fakeClient,
      extractPageImages: async (_pdfBytes: Buffer, _sourceLabel: string, destDir: string) => {
        await mkdir(destDir, { recursive: true });
        const pagePath = path.join(destDir, "paper_p1_img0.png");
        await writeFile(pagePath, pageImage);
        return {
          images: [{ path: pagePath, pageIndex: 1, bbox: "0,0,612,792" }],
          skippedPages: 0,
        };
      },
      now: () => FIXED_NOW,
    },
  };
}

function baseRequest(fixture: Fixture): {
  paper_xml_asset_id: string;
  paper_pdf_asset_id: string;
  supplementary_asset_ids: string[];
  paper_id: string;
  paper_id_namespace: string;
} {
  return {
    paper_xml_asset_id: fixture.assets.xmlReceipt.asset_ref.asset_id,
    paper_pdf_asset_id: fixture.assets.pdfReceipt.asset_ref.asset_id,
    supplementary_asset_ids: [fixture.assets.supplementReceipt.asset_ref.asset_id],
    paper_id: "31234567",
    paper_id_namespace: "pubmed",
  };
}

async function readCarrier(fixture: Fixture, relativePath: string): Promise<Record<string, unknown>> {
  const bytes = await readFile(path.join(fixture.taskRoot, relativePath), "utf8");
  return JSON.parse(bytes) as Record<string, unknown>;
}

function rowsOf(carrier: Record<string, unknown>, tableId: string): Record<string, unknown>[] {
  const value = carrier[tableId];
  if (!Array.isArray(value)) throw new Error(`carrier omits ${tableId}`);
  return value as Record<string, unknown>[];
}

async function expectRejectionBeforeModelCall(
  fixture: Fixture,
  request: RegisteredPaperChartExtractionRequest,
  messagePattern: RegExp,
): Promise<void> {
  await expect(extractRegisteredPaperChartEvidence(request, {
    taskRoot: fixture.taskRoot,
    sourceAssetRegistry: fixture.registry,
    ...fixture.depsDefaults,
  })).rejects.toThrow(messagePattern);
  expect(fixture.calls).toHaveLength(0);
}

describe("registered paper chart evidence extraction", () => {
  it("registers a governed carrier with resolved model provenance, digests, locators, and bounded summary", async () => {
    const fixture = await makeFixture(makeVlmResponse());
    try {
      const result = await extractRegisteredPaperChartEvidence(baseRequest(fixture), {
        taskRoot: fixture.taskRoot,
        sourceAssetRegistry: fixture.registry,
        ...fixture.depsDefaults,
      });

      expect(result.status).toBe("ok");
      expect(result.carrier.asset_id).toBe(
        `asset_${createHash("sha256")
          .update(await readFile(path.join(fixture.taskRoot, result.carrier.relative_path)))
          .digest("hex")}`,
      );
      expect(result.carrier.relative_path).toMatch(/^source_assets\/paper_chart_evidence\//);
      expect(result.carrier.media_type).toBe("application/json");
      expect(result.carrier.role).toBe("carrier");
      expect(result.carrier.receipt_id).toMatch(/^receipt_/);

      // The carrier must resolve as a task-owned registration.
      const resolved = await fixture.registry.resolveCarrier(result.carrier.asset_id);
      expect(resolved.registration_receipt.asset_ref.asset_id).toBe(result.carrier.asset_id);

      expect(result.model).toEqual({
        provider: "vlm.fixture.example",
        model: RESOLVED_MODEL,
        model_version: PROVIDER_MODEL_VERSION,
      });
      expect(result.rows).toEqual({
        paper_records: 1,
        experiment_records: 1,
        activity_value_records: 1,
        supplementary_asset_records: 1,
        chart_series: 1,
        chart_points: 2,
        papers: 1,
        sources: 2,
      });
      expect(result.warnings).toEqual([]);

      const carrier = await readCarrier(fixture, result.carrier.relative_path);
      expect(Object.keys(carrier)).toEqual([
        "schema_version",
        "carrier_kind",
        "paper_id",
        "paper_id_namespace",
        "extraction",
        "paper_records",
        "experiment_records",
        "activity_value_records",
        "supplementary_asset_records",
        "chart_series",
        "chart_points",
        "papers",
        "sources",
      ]);

      const paperRecord = rowsOf(carrier, "paper_records")[0] as Record<string, unknown>;
      expect(paperRecord).toMatchObject({ pmid: "31234567", pmcid: "none", doi: "none" });

      const series = rowsOf(carrier, "chart_series")[0] as Record<string, unknown>;
      expect(series).toMatchObject({
        model_name: RESOLVED_MODEL,
        model_version: PROVIDER_MODEL_VERSION,
        extraction_method: "vlm",
        human_review_status: "pending",
      });
      expect((series as { source_locator: { asset_id: string } }).source_locator.asset_id).toBe(
        fixture.assets.pdfReceipt.asset_ref.asset_id,
      );

      const points = rowsOf(carrier, "chart_points") as Record<string, unknown>[];
      for (const point of points) {
        expect(point.estimated_or_exact).toBe("estimated");
        expect(point.review_status).toBe("pending");
        expect(point.review_id).toBeNull();
      }

      // The carrier rows satisfy the paper evidence gate and the carrier-stage
      // chart gate, while estimated+pending points deliberately fail the
      // publication-stage closure until evidence-bound review.
      const paperRows = {
        paper_records: rowsOf(carrier, "paper_records"),
        experiment_records: rowsOf(carrier, "experiment_records"),
        activity_value_records: rowsOf(carrier, "activity_value_records"),
        supplementary_asset_records: rowsOf(carrier, "supplementary_asset_records"),
      } as unknown as PaperEvidenceRows;
      const chartRows = {
        chart_series: rowsOf(carrier, "chart_series"),
        chart_points: rowsOf(carrier, "chart_points"),
        papers: rowsOf(carrier, "papers"),
        sources: rowsOf(carrier, "sources"),
      } as unknown as ChartEvidenceRows;
      const registeredIds = new Set([
        fixture.assets.xmlReceipt.asset_ref.asset_id,
        fixture.assets.pdfReceipt.asset_ref.asset_id,
        fixture.assets.supplementReceipt.asset_ref.asset_id,
      ]);
      expect(() => assertPaperEvidenceRows(paperRows, registeredIds)).not.toThrow();
      const derived = derivePaperCanonicalIdentities(paperRows);
      const derivedIds = new Set(derived.activities.map((activity) => activity.activity_id));
      expect(() => assertChartEvidenceCarrierRows(chartRows, derivedIds)).not.toThrow();
      expect(() => assertChartEvidenceRows(chartRows, derivedIds)).toThrow(/estimated point/);
      for (const point of rowsOf(carrier, "chart_points")) {
        expect(derivedIds.has(point.activity_id as string)).toBe(true);
      }

      // Bounded summary only: no credentials, no raw provider payloads.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(API_KEY);
      const carrierPoints = rowsOf(carrier, "chart_points") as Array<{ point_id: string }>;
      expect(result.pending_review).toEqual({
        series_count: 1,
        point_count: 2,
        review_ids: carrierPoints.map((point) => point.point_id),
      });
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("preserves mixed-content order in authoritative registered JATS metadata", async () => {
    const fixture = await makeFixture(makeVlmResponse({ paper: null }));
    try {
      const mixedTitle = await writeFileAndRegister(
        fixture.registry,
        fixture.taskRoot,
        "mixed-title.xml",
        "<article><front><article-meta><article-id pub-id-type=\"pmid\">31234567</article-id>" +
          "<title-group><article-title>Inhibition of EGFR<sup>WT</sup>, EGFR<sup>T790M</sup>, " +
          "and <italic>EGFR</italic><sup>L858R</sup></article-title></title-group>" +
          "</article-meta></front></article>",
        "application/xml",
      );
      const result = await extractRegisteredPaperChartEvidence({
        ...baseRequest(fixture),
        paper_xml_asset_id: mixedTitle.asset_ref.asset_id,
      }, {
        taskRoot: fixture.taskRoot,
        sourceAssetRegistry: fixture.registry,
        ...fixture.depsDefaults,
      });
      const carrier = await readCarrier(fixture, result.carrier.relative_path);
      expect(rowsOf(carrier, "paper_records")[0]?.title).toBe(
        "Inhibition of EGFR WT, EGFR T790M, and EGFR L858R",
      );
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("uses registered JATS metadata when the VLM omits page-level paper metadata", async () => {
    const fixture = await makeFixture(makeVlmResponse({ paper: null }));
    try {
      const result = await extractRegisteredPaperChartEvidence(baseRequest(fixture), {
        taskRoot: fixture.taskRoot,
        sourceAssetRegistry: fixture.registry,
        ...fixture.depsDefaults,
      });

      const carrier = await readCarrier(fixture, result.carrier.relative_path);
      expect(rowsOf(carrier, "paper_records")[0]).toMatchObject({
        title: "Quantitative inhibition of EGFR signaling",
        journal: "Open Kinase Methods",
        publication_date: "2020-04-03",
        authors: ["A. Researcher", "B. Scientist"],
      });
      expect(rowsOf(carrier, "papers")[0]).toMatchObject({
        title: "Quantitative inhibition of EGFR signaling",
        journal: "Open Kinase Methods",
        publication_date: "2020-04-03",
        authors: ["A. Researcher", "B. Scientist"],
      });
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("renders complete caption-selected PDF pages by default before calling the VLM", async () => {
    const fixture = await makeFixture(makeVlmResponse());
    try {
      const pdfPath = path.join(fixture.taskRoot, ...fixture.assets.pdfReceipt.relative_path.split("/"));
      await copyFile(VECTOR_PDF_FIXTURE, pdfPath);
      fixture.assets.pdfReceipt = await fixture.registry.register({
        sourceId: "fixture_vector_pdf",
        relativePath: fixture.assets.pdfReceipt.relative_path,
        mediaType: "application/pdf",
        role: "carrier",
      });

      const result = await extractRegisteredPaperChartEvidence(baseRequest(fixture), {
        taskRoot: fixture.taskRoot,
        sourceAssetRegistry: fixture.registry,
        resolveVlmConfig: fixture.depsDefaults.resolveVlmConfig,
        vlmClientFactory: fixture.depsDefaults.vlmClientFactory,
        now: fixture.depsDefaults.now,
      });

      expect(result.status).toBe("ok");
      expect(fixture.calls).toHaveLength(1);
      expect(path.basename(fixture.calls[0]!.imagePath)).toBe("paper_p2.png");
      const rendered = PNG.sync.read(await readFile(fixture.calls[0]!.imagePath));
      expect(rendered.width).toBe(1836);
      expect(rendered.height).toBe(2376);
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  }, 60_000);

  it("reports bounded PDF page candidates that were skipped by the renderer", async () => {
    const fixture = await makeFixture(makeVlmResponse());
    try {
      const result = await extractRegisteredPaperChartEvidence(baseRequest(fixture), {
        taskRoot: fixture.taskRoot,
        sourceAssetRegistry: fixture.registry,
        ...fixture.depsDefaults,
        extractPageImages: async (pdfBytes, sourceLabel, destDir) => {
          const extracted = await fixture.depsDefaults.extractPageImages(pdfBytes, sourceLabel, destDir);
          return { ...extracted, skippedPages: 4 };
        },
      });
      expect(result.warnings).toContain(
        "4 additional PDF page candidate(s) were not rendered because of the page cap",
      );
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("batches all pending carrier estimates into one data_review request", async () => {
    const fixture = await makeFixture(makeVlmResponse());
    try {
      const requests: Array<{
        kind: string;
        review_type: string | null;
        item_count: number;
        requirement_id: string | null;
      }> = [];
      const result = await extractRegisteredPaperChartEvidence(baseRequest(fixture), {
        taskRoot: fixture.taskRoot,
        sourceAssetRegistry: fixture.registry,
        ...fixture.depsDefaults,
        hilGate: {
          requestHIL: async (input) => {
            requests.push({
              kind: input.kind,
              review_type: input.review_type,
              item_count: input.review_items.length,
              requirement_id: input.requirement_id,
            });
            return {
              schema_version: "1.0",
              review_id: "review_carrier_1",
              request_id: "request_carrier_1",
              decision: { action: "accept" as const },
              reviewer: "user" as const,
              reviewed_at: "2026-08-30T11:00:00.000Z",
              evidence_digest: "a".repeat(64),
              reason: null,
            };
          },
        },
      });

      // ONE coalesced evidence-bound review for the whole carrier.
      expect(requests).toEqual([{
        kind: "data_review",
        review_type: "vlm_extraction",
        item_count: 2,
        requirement_id: null,
      }]);
      expect(result.pending_review.review).toMatchObject({
        review_id: "review_carrier_1",
        action: "accept",
        reviewer: "user",
      });

      // The registered carrier rows stay pending: the review provenance is
      // durable, but the carrier never masquerades as review-closed rows.
      const carrier = await readCarrier(fixture, result.carrier.relative_path);
      for (const point of rowsOf(carrier, "chart_points")) {
        expect(point.review_status).toBe("pending");
        expect(point.review_id).toBeNull();
      }
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("rejects the extraction outcome when the reviewer rejects the batched review", async () => {
    const fixture = await makeFixture(makeVlmResponse());
    try {
      await expect(extractRegisteredPaperChartEvidence(baseRequest(fixture), {
        taskRoot: fixture.taskRoot,
        sourceAssetRegistry: fixture.registry,
        ...fixture.depsDefaults,
        hilGate: {
          requestHIL: async () => ({
            schema_version: "1.0",
            review_id: "review_carrier_rejected",
            request_id: "request_carrier_rejected",
            decision: { action: "reject" as const },
            reviewer: "user" as const,
            reviewed_at: "2026-08-30T11:00:00.000Z",
            evidence_digest: "b".repeat(64),
            reason: "not evidence-bound",
          }),
        },
      })).rejects.toThrow(/rejected by human review/);
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("rejects absolute paths before any model call", async () => {
    const fixture = await makeFixture(makeVlmResponse());
    try {
      await expectRejectionBeforeModelCall(fixture, {
        ...baseRequest(fixture),
        paper_pdf_asset_id: path.join(fixture.taskRoot, "source_assets", "paper.pdf"),
      }, /registered asset id.*not a path/);
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("rejects workspace-relative paths before any model call", async () => {
    const fixture = await makeFixture(makeVlmResponse());
    try {
      await expectRejectionBeforeModelCall(fixture, {
        ...baseRequest(fixture),
        paper_xml_asset_id: "source_assets/paper-fulltext.xml",
      }, /registered asset id.*not a path/);
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("rejects cross-task asset ids before any model call", async () => {
    const fixture = await makeFixture(makeVlmResponse());
    const otherRoot = await mkdtemp(path.join(os.tmpdir(), "registered-paper-chart-other-"));
    try {
      const otherRegistry = new SourceAssetRegistry("task_other", otherRoot, { now: () => FIXED_NOW });
      const otherPdf = await writeFileAndRegister(
        otherRegistry,
        otherRoot,
        "paper.pdf",
        "different task pdf bytes",
        "application/pdf",
        "carrier",
      );
      await expectRejectionBeforeModelCall(fixture, {
        ...baseRequest(fixture),
        paper_pdf_asset_id: otherPdf.asset_ref.asset_id,
      }, /not registered in this task/);
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("rejects unregistered byte digests before any model call", async () => {
    const fixture = await makeFixture(makeVlmResponse());
    try {
      await expectRejectionBeforeModelCall(fixture, {
        ...baseRequest(fixture),
        supplementary_asset_ids: [`asset_${"e".repeat(64)}`],
      }, /not registered in this task/);
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("rejects a registered JATS carrier without the requested identity namespace", async () => {
    const fixture = await makeFixture(makeVlmResponse());
    try {
      const unidentifiedXml = await writeFileAndRegister(
        fixture.registry,
        fixture.taskRoot,
        "unidentified-paper.xml",
        "<article><front><article-meta><title-group><article-title>Unidentified paper</article-title>" +
          "</title-group></article-meta></front></article>",
        "application/xml",
      );
      await expectRejectionBeforeModelCall(fixture, {
        ...baseRequest(fixture),
        paper_xml_asset_id: unidentifiedXml.asset_ref.asset_id,
      }, /has no pubmed identity for requested paper_id/);
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("rejects a registered JATS carrier whose paper identity conflicts with the request", async () => {
    const fixture = await makeFixture(makeVlmResponse());
    try {
      const mismatchedXml = await writeFileAndRegister(
        fixture.registry,
        fixture.taskRoot,
        "mismatched-paper.xml",
        "<article><front><article-meta><article-id pub-id-type=\"pmid\">99999999</article-id>" +
          "<title-group><article-title>Different paper</article-title></title-group>" +
          "</article-meta></front></article>",
        "application/xml",
      );
      await expectRejectionBeforeModelCall(fixture, {
        ...baseRequest(fixture),
        paper_xml_asset_id: mismatchedXml.asset_ref.asset_id,
      }, /identity does not match requested paper_id/);
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("rejects browser-only screenshot registrations before any model call", async () => {
    const fixture = await makeFixture(makeVlmResponse());
    try {
      await expectRejectionBeforeModelCall(fixture, {
        ...baseRequest(fixture),
        paper_xml_asset_id: fixture.assets.screenshotReceipt.asset_ref.asset_id,
      }, /browser screenshot/);
      await expectRejectionBeforeModelCall(fixture, {
        ...baseRequest(fixture),
        supplementary_asset_ids: [fixture.assets.screenshotReceipt.asset_ref.asset_id],
      }, /browser screenshot/);
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("rejects wrong media types before any model call", async () => {
    const fixture = await makeFixture(makeVlmResponse());
    try {
      await expectRejectionBeforeModelCall(fixture, {
        ...baseRequest(fixture),
        paper_xml_asset_id: fixture.assets.supplementReceipt.asset_ref.asset_id,
      }, /media type/);
      await expectRejectionBeforeModelCall(fixture, {
        ...baseRequest(fixture),
        paper_pdf_asset_id: fixture.assets.supplementReceipt.asset_ref.asset_id,
      }, /media type/);
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("downgrades a series with a defective point to an explicit unclear no-points series", async () => {
    const fixture = await makeFixture(makeVlmResponse({
      points: [
        {
          series_key: "fig2_erlo",
          activity_key: "act_ic50_erlo",
          x_value: "10",
          y_value: "64.5",
          point_type: "line_vertex",
          bbox: [200, 180, 212, 192],
          extraction_confidence: "medium",
          confidence_reason: "",
        },
      ],
    }));
    try {
      const result = await extractRegisteredPaperChartEvidence(baseRequest(fixture), {
        taskRoot: fixture.taskRoot,
        sourceAssetRegistry: fixture.registry,
        ...fixture.depsDefaults,
      });
      expect(result.rows.chart_points).toBe(0);
      const carrier = await readCarrier(fixture, result.carrier.relative_path);
      const series = rowsOf(carrier, "chart_series")[0] as Record<string, unknown>;
      expect(series.axis_validation_status).toBe("unclear");
      expect(series.legend_validation_status).toBe("unclear");
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("degrades a series with missing figure identity and legend status instead of inventing them", async () => {
    const fixture = await makeFixture(makeVlmResponse({
      series: [
        {
          series_key: "fig3_unknown",
          series_label: "Untreated",
          x_axis_name: "Time",
          x_axis_unit: "h",
          y_axis_name: "Viability",
          y_axis_unit: "percent",
          x_scale: "linear",
          y_scale: "linear",
          legend_text: "Untreated",
          bbox: [40, 60, 560, 400],
          extraction_confidence: "medium",
          confidence_reason: "Series visible but figure identity is ambiguous.",
        },
      ],
      points: [],
    }));
    try {
      const result = await extractRegisteredPaperChartEvidence(baseRequest(fixture), {
        taskRoot: fixture.taskRoot,
        sourceAssetRegistry: fixture.registry,
        ...fixture.depsDefaults,
      });
      expect(result.rows.chart_points).toBe(0);
      const carrier = await readCarrier(fixture, result.carrier.relative_path);
      const series = rowsOf(carrier, "chart_series")[0] as Record<string, unknown>;
      expect(series.figure_id).toBe("unknown");
      expect(series.legend_validation_status).toBe("unclear");
      expect(series.axis_validation_status).toBe("unclear");
    } finally {
      await Promise.all(fixture.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("fails when the model omits required activity confidence", async () => {
    const missingConfidence = await makeFixture(makeVlmResponse({
      activities: [
        {
          activity_key: "act_ic50_erlo",
          experiment_id: "exp_fig2",
          compound: "Erlotinib",
          protein_variant: "EGFR",
          activity_type: "IC50",
          activity_value: "12.5",
          activity_unit: "nM",
          relation: "<",
          replicate_count: 3,
          error_value: null,
          error_type: null,
          original_text: "erlotinib inhibited EGFR signalling with an IC50 of 12.5 nM (Figure 2A)",
          table_or_figure: "Figure_2A",
          row_label: "none",
          column_label: "none",
        },
      ],
    }));
    try {
      await expect(extractRegisteredPaperChartEvidence(baseRequest(missingConfidence), {
        taskRoot: missingConfidence.taskRoot,
        sourceAssetRegistry: missingConfidence.registry,
        ...missingConfidence.depsDefaults,
      })).rejects.toThrow(/confidence_level/);
    } finally {
      await Promise.all(missingConfidence.roots.map((root) => rm(root, { recursive: true, force: true })));
    }
  });

  it("parses the structured contract strictly and rejects non-object payloads", () => {
    const parsed = parseRegisteredPaperChartResponse(makeVlmResponse(), "page 1");
    expect(parsed.series).toHaveLength(1);
    expect(parsed.points).toHaveLength(2);
    expect(parsed.activities).toHaveLength(1);
    expect(parsed.experiments).toHaveLength(1);
    expect(REGISTERED_PAPER_CHART_PROMPT).toMatch(/series_key/);
    expect(() => parseRegisteredPaperChartResponse("[]", "page 1")).toThrow(/non-object/);
    expect(() => parseRegisteredPaperChartResponse("not json", "page 1")).toThrow(/non-JSON/);
  });
});
