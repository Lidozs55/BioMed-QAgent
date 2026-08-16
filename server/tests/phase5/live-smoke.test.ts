/**
 * Phase 5 live smoke tests (live:geo / live:pubmed / live:gdc / live:xena /
 * live:pdb / live:pubchem / live:reactome / live:chembl / live:uniprot /
 * live:browser / live:vlm markers).
 *
 * Explicitly gated behind BIOMED_LIVE_SMOKE=1 — CI never runs these (public
 * services fail transiently); release verification runs them once and records
 * date/endpoint/results (docs/migration/phase5-external-capabilities-completion-plan.md §11.3).
 * Fixture parity tests are the deterministic CI gate.
 */

import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env.BIOMED_LIVE_SMOKE === "1";
const describeLive = ENABLED ? describe : describe.skip;
/** VLM needs a real DashScope credential; skipped (and recorded) without one. */
const describeVlm = ENABLED && process.env.DASHSCOPE_API_KEY ? describe : describe.skip;

/** Real PNG fixture for the VLM smoke (a scanned figure from the PDF spike). */
const VLM_FIXTURE_IMAGE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures", "pdf", "_spike", "scanned_extracted.png",
);

const roots: string[] = [];
let taskRoot = "";

beforeAll(async () => {
  if (!ENABLED) return;
  taskRoot = await mkdtemp(path.join(os.tmpdir(), "p5-live-"));
  roots.push(taskRoot);
});

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describeLive("live:ncbi", () => {
  it("esearch + esummary reach NCBI and return PubMed records", async () => {
    const { createPubmedTools } = await import("../../src/agent/tools/pubmed.js");
    const [search] = createPubmedTools({ taskRoot });
    const result = await search.execute({ query: "TP53 cancer", max_results: 3 });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { total_count: string; records: unknown[] };
    expect(Number.parseInt(parsed.total_count, 10)).toBeGreaterThan(0);
    expect(parsed.records.length).toBeGreaterThan(0);
  }, 60_000);
});

describeLive("live:geo", () => {
  it("search + describe reach NCBI GEO", async () => {
    const { createGeoTools } = await import("../../src/agent/tools/geo.js");
    const { ContentCache } = await import("../../src/external/acquisition/content-cache.js");
    const tools = createGeoTools({
      taskRoot,
      cache: new ContentCache(path.join(taskRoot, "cache")),
      client: new (await import("../../src/external/network/http-client.js")).PublicHttpClient(),
      eutils: { email: "biomed-agent@example.com", tool: "biomed-qagent", userAgent: "BioMed-QAgent/1.0" },
    });
    const search = tools.find((tool) => tool.name === "search_geo");
    const result = await search?.execute({ query: "breast cancer", max_results: 3 });
    expect(result?.isError).toBeUndefined();
    const parsed = JSON.parse(result?.content ?? "{}") as { accessions: string[] };
    expect(parsed.accessions.length).toBeGreaterThan(0);
  }, 60_000);
});

describeLive("live:gdc", () => {
  it("projects endpoint returns TCGA records", async () => {
    const { createGdcTools } = await import("../../src/agent/tools/gdc.js");
    const { ContentCache } = await import("../../src/external/acquisition/content-cache.js");
    const tools = createGdcTools({
      taskRoot,
      client: new (await import("../../src/external/network/http-client.js")).PublicHttpClient(),
      cache: new ContentCache(path.join(taskRoot, "cache")),
    });
    const search = tools.find((tool) => tool.name === "search_gdc");
    const result = await search?.execute({ query: "TCGA-BRCA", max_results: 3 });
    expect(result?.isError).toBeUndefined();
    const parsed = JSON.parse(result?.content ?? "{}") as { records: unknown[] };
    expect(parsed.records.length).toBeGreaterThan(0);
  }, 60_000);
});

describeLive("live:xena", () => {
  it("hub search returns datasets", async () => {
    const { createXenaTools } = await import("../../src/agent/tools/xena.js");
    const { ContentCache } = await import("../../src/external/acquisition/content-cache.js");
    const tools = createXenaTools({
      taskRoot,
      client: new (await import("../../src/external/network/http-client.js")).PublicHttpClient(),
      cache: new ContentCache(path.join(taskRoot, "cache")),
    });
    const search = tools.find((tool) => tool.name === "search_xena");
    const result = await search?.execute({ query: "TCGA", max_results: 3 });
    expect(result?.isError).toBeUndefined();
  }, 60_000);
});

describeLive("live:pdb", () => {
  it("search reaches RCSB", async () => {
    const { createPdbTools } = await import("../../src/agent/tools/pdb.js");
    const tools = createPdbTools({ taskRoot });
    const search = tools.find((tool) => tool.name === "search_pdb");
    const result = await search?.execute({ term: "kinase", max_results: 3 });
    expect(result?.isError).toBeUndefined();
  }, 60_000);
});

describeLive("live:pubchem", () => {
  it("search reaches PubChem PUG REST", async () => {
    const { createPubchemTools } = await import("../../src/agent/tools/pubchem.js");
    const tools = createPubchemTools({ taskRoot });
    const search = tools.find((tool) => tool.name === "search_pubchem");
    const result = await search?.execute({ term: "aspirin", max_results: 3 });
    expect(result?.isError).toBeUndefined();
  }, 60_000);
});

describeLive("live:reactome", () => {
  it("search reaches the Reactome content service", async () => {
    const { createReactomeTools } = await import("../../src/agent/tools/reactome.js");
    const tools = createReactomeTools({ taskRoot });
    const search = tools.find((tool) => tool.name === "search_reactome");
    const result = await search?.execute({ term: "apoptosis", max_results: 3 });
    expect(result?.isError).toBeUndefined();
  }, 60_000);
});

describeLive("live:chembl", () => {
  it("search reaches the ChEMBL REST API", async () => {
    const { createChemblTools } = await import("../../src/agent/tools/chembl.js");
    const tools = createChemblTools({ taskRoot });
    const search = tools.find((tool) => tool.name === "search_chembl");
    const result = await search?.execute({ query: "aspirin", max_results: 3 });
    expect(result?.isError).toBeUndefined();
    const parsed = JSON.parse(result?.content ?? "{}") as { count: number };
    expect(parsed.count).toBeGreaterThan(0);
  }, 60_000);
});

describeLive("live:uniprot", () => {
  it("search reaches the UniProt REST API", async () => {
    const { createUniprotTools } = await import("../../src/agent/tools/uniprot.js");
    const tools = createUniprotTools({ taskRoot });
    const search = tools.find((tool) => tool.name === "search_uniprot");
    const result = await search?.execute({ query: "TP53 human", max_results: 3 });
    expect(result?.isError).toBeUndefined();
    const parsed = JSON.parse(result?.content ?? "{}") as { count: number };
    expect(parsed.count).toBeGreaterThan(0);
  }, 60_000);
});

describeLive("live:browser", () => {
  it("navigates a public page through the Playwright browser pool", async () => {
    const { NodeBrowserPool } = await import("../../src/external/browser/pool.js");
    const { CrawlerFacade } = await import("../../src/external/crawler/crawler.js");
    const { PublicHttpClient } = await import("../../src/external/network/http-client.js");
    const { ContentCache } = await import("../../src/external/acquisition/content-cache.js");
    const { createBrowserTools } = await import("../../src/agent/tools/browser.js");
    const pool = new NodeBrowserPool({ maxContexts: 1 });
    await pool.start();
    try {
      const client = new PublicHttpClient();
      const crawler = new CrawlerFacade({ browserPool: pool, client });
      const [navigate] = createBrowserTools({
        taskRoot,
        cache: new ContentCache(path.join(taskRoot, "cache")),
        client,
        crawler,
      });
      const result = await navigate.execute({ url: "https://example.com/" });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content) as { status_code?: number; error?: string };
      expect(parsed.error).toBeUndefined();
      expect(parsed.status_code).toBe(200);
    } finally {
      await pool.close();
    }
  }, 120_000);
});

describeVlm("live:vlm", () => {
  it("reaches DashScope Qwen-VL and extracts chart data from a real image", async () => {
    const { createChartDataVlmTool } = await import("../../src/agent/tools/extract-chart-data-vlm.js");
    const figureDir = path.join(taskRoot, "source_assets", "figures");
    await mkdir(figureDir, { recursive: true });
    await copyFile(VLM_FIXTURE_IMAGE, path.join(figureDir, "chart.png"));
    const [tool] = createChartDataVlmTool({
      taskRoot,
      approvalGate: { request: async () => "approve" },
    });
    const result = await tool.execute({ source_path: "source_assets/figures/chart.png" });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as { status?: string; total_charts?: number };
    expect(parsed.status).toBe("ok");
    expect(parsed.total_charts).toBeGreaterThan(0);
  }, 120_000);
});
