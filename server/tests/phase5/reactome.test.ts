/**
 * Reactome source tool tests (P5-06): fixture parity against the Python
 * ``backend/tests/test_skill_reactome.py`` mock responses.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";
import {
  createReactomeTools,
  DOWNLOAD_REACTOME_TOOL_NAME,
  GET_PATHWAY_TOOL_NAME,
  SEARCH_REACTOME_TOOL_NAME,
} from "../../src/agent/tools/reactome.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import type { QueryStatus } from "../../src/agent/tools/tool-hooks.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sources",
);
const HOSTS = ["reactome.org"];

function fixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES, name), "utf8");
}

let root: string;
const servers: FixtureServer[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "p5-reactome-"));
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await rm(root, { recursive: true, force: true });
});

function client(port: number): PublicHttpClient {
  return new PublicHttpClient({
    resolve: fakeResolver(Object.fromEntries(HOSTS.map((host) => [host, [PUBLIC_IP]]))),
    executor: localExecutor(port),
  });
}

interface Route {
  status: number;
  contentType: string;
  body: string | Buffer;
}

async function serve(routes: Record<string, Route>): Promise<FixtureServer> {
  const server = await startFixtureServer((req, res) => {
    const key = `${req.method} ${new URL(req.url ?? "/", "http://localhost").pathname}`;
    const route = routes[key];
    if (route === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(route.status, { "content-type": route.contentType });
    res.end(route.body);
  });
  servers.push(server);
  return server;
}

function parse(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("search_reactome", () => {
  it("returns stripped pathway records from the ContentService API tier", async () => {
    const server = await serve({
      "GET /ContentService/search/query": {
        status: 200,
        contentType: "application/json",
        body: await fixture("reactome_search.json"),
      },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const [tool] = createReactomeTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      hooks: {
        onQuery: (query, source, status: QueryStatus, recordsCount?: number) =>
          queries.push([query, source, status, recordsCount]),
      },
    });

    const data = parse((await tool.execute({ term: "apoptosis" })).content);
    expect(Object.keys(data).sort()).toEqual([
      "attempts",
      "count",
      "enriched_count",
      "method_used",
      "records",
      "source",
      "term",
      "total_matches",
    ]);
    expect(data["source"]).toBe("reactome");
    expect(data["term"]).toBe("apoptosis");
    expect(data["count"]).toBe(1);
    expect(data["total_matches"]).toBe(1);
    expect(data["enriched_count"]).toBe(1);
    expect(data["method_used"]).toBe("api");
    // Highlight spans are stripped (Python _strip_html parity).
    expect(data["records"]).toEqual([
      {
        pathway_id: "R-HSA-169893",
        name: "Apoptosis",
        species: "Homo sapiens",
        summary: "Programmed cell death",
        type: "Pathway",
        url: "https://reactome.org/content/detail/R-HSA-169893",
      },
    ]);
    const attempts = data["attempts"] as Array<Record<string, unknown>>;
    expect(attempts[0]).toEqual({
      method: "api",
      url: expect.stringContaining("https://reactome.org/ContentService/search/query"),
      status: "succeeded",
      status_code: 200,
      reason: null,
      fallback_reason: null,
    });
    expect(server.requests[0].url).toContain("query=apoptosis");
    expect(server.requests[0].url).toContain("species=Homo+sapiens");
    expect(server.requests[0].url).toContain("pageSize=20");
    expect(queries).toEqual([["apoptosis", "reactome", "success", 1]]);
  });

  it("enriches the top entries without a search-API summary via the summation endpoint", async () => {
    const server = await serve({
      "GET /ContentService/search/query": {
        status: 200,
        contentType: "application/json",
        body: await fixture("reactome_search_no_summary.json"),
      },
      "GET /ContentService/data/pathways/R-HSA-169893/summation": {
        status: 200,
        contentType: "application/json",
        body: await fixture("reactome_summation.json"),
      },
    });
    const [tool] = createReactomeTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
    });

    const data = parse((await tool.execute({ term: "apoptosis" })).content);
    const records = data["records"] as Array<Record<string, unknown>>;
    expect(records[0]["summary"]).toBe("Programmed cell death.");
    expect(data["enriched_count"]).toBe(1);
    expect(server.requests).toHaveLength(2);
  });

  it("returns empty records for an API result without entries (no fabricated success)", async () => {
    const server = await serve({
      "GET /ContentService/search/query": {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ results: [], numberOfMatches: 0 }),
      },
    });
    const [tool] = createReactomeTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
    });

    const data = parse((await tool.execute({ term: "nope" })).content);
    expect(data["count"]).toBe(0);
    expect(data["total_matches"]).toBe(0);
    expect(data["records"]).toEqual([]);
    expect(data["enriched_count"]).toBe(0);
    expect(data["method_used"]).toBe("api");
  });

  it("falls back to the static page with the attempt audit (Python shape)", async () => {
    const server = await serve({
      "GET /ContentService/search/query": { status: 500, contentType: "text/plain", body: "boom" },
      "GET /content/query": {
        status: 200,
        contentType: "text/html",
        body: await fixture("reactome_page.html"),
      },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const [tool] = createReactomeTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      hooks: { onQuery: (q, s, st, n) => queries.push([q, s, st, n]) },
    });

    const data = parse((await tool.execute({ term: "apoptosis" })).content);
    expect(data["status"]).toBe("page_fallback");
    expect(data["method_used"]).toBe("httpx");
    expect(data["page_url"]).toBe("https://reactome.org/content/query?q=apoptosis");
    expect(data["body_text_preview"]).toBe("Visible pathway");
    const attempts = data["attempts"] as Array<Record<string, unknown>>;
    expect(attempts.map((attempt) => attempt["method"])).toEqual(["api", "html"]);
    expect(queries).toEqual([["apoptosis", "reactome", "page_fallback", 0]]);
  });

  it("rejects an API error document before the page tiers (predicate parity)", async () => {
    const server = await serve({
      "GET /ContentService/search/query": {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporarily unavailable" }),
      },
      // Python parity: a script-only page has no visible text, so the html
      // tier is rejected and the crawl tier renders the result.
      "GET /content/query": {
        status: 200,
        contentType: "text/html",
        body: "<html><body><script>no static result</script></body></html>",
      },
    });
    const [tool] = createReactomeTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      browserFallback: async () => ({ status_code: 200, body_text_preview: "Rendered Reactome result" }),
    });

    const data = parse((await tool.execute({ term: "apoptosis" })).content);
    expect(data["status"]).toBe("page_fallback");
    expect(data["method_used"]).toBe("crawl");
  });

  it("returns the audited error JSON when all tiers fail", async () => {
    const server = await serve({
      "GET /ContentService/search/query": { status: 500, contentType: "text/plain", body: "boom" },
      "GET /content/query": { status: 500, contentType: "text/plain", body: "boom" },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const [tool] = createReactomeTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      hooks: { onQuery: (q, s, st, n) => queries.push([q, s, st, n]) },
    });

    const data = parse((await tool.execute({ term: "apoptosis" })).content);
    expect(data["status"]).toBe("error");
    expect(data["attempted_methods"]).toEqual(["api", "httpx", "crawl"]);
    expect(String(data["error"])).toContain("All fetch tiers failed for reactome");
    expect((data["attempts"] as unknown[]).length).toBe(3);
    expect(queries).toEqual([["apoptosis", "reactome", "failed", 0]]);
  });
});

describe("get_pathway", () => {
  it("returns the pathway record from the ContentService data endpoint", async () => {
    const server = await serve({
      "GET /ContentService/data/query/R-HSA-169893": {
        status: 200,
        contentType: "application/json",
        body: await fixture("reactome_pathway.json"),
      },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const tools = createReactomeTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      hooks: { onQuery: (q, s, st, n) => queries.push([q, s, st, n]) },
    });
    const tool = tools.find((entry) => entry.name === GET_PATHWAY_TOOL_NAME)!;

    const data = parse((await tool.execute({ pathway_id: "R-HSA-169893" })).content);
    expect(Object.keys(data).sort()).toEqual(["attempts", "method_used", "pathway_id", "record", "source"]);
    expect(data["source"]).toBe("reactome");
    expect(data["pathway_id"]).toBe("R-HSA-169893");
    expect(data["method_used"]).toBe("api");
    expect(data["record"]).toEqual({
      pathway_id: "R-HSA-169893",
      name: "Apoptosis", // list-form name takes the first element (Python parity)
      species: "Homo sapiens",
      has_diagram: true,
      url: "https://reactome.org/content/detail/R-HSA-169893",
      summation: "",
      release_date: "",
    });
    expect(queries).toEqual([["R-HSA-169893", "reactome", "success", 1]]);
  });

  it("rejects a non-JSON API body before the page tiers (predicate parity)", async () => {
    const server = await serve({
      "GET /ContentService/data/query/R-HSA-169893": {
        status: 200,
        contentType: "text/plain",
        body: "Service temporarily unavailable",
      },
      "GET /content/detail/R-HSA-169893": {
        status: 200,
        contentType: "text/html",
        body: await fixture("reactome_page.html"),
      },
    });
    const tools = createReactomeTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
    });
    const tool = tools.find((entry) => entry.name === GET_PATHWAY_TOOL_NAME)!;

    const data = parse((await tool.execute({ pathway_id: "R-HSA-169893" })).content);
    expect(data["status"]).toBe("page_fallback");
    expect(data["method_used"]).toBe("httpx");
    expect(data["page_url"]).toBe("https://reactome.org/content/detail/R-HSA-169893");
  });
});

describe("download_reactome", () => {
  const TSV =
    "stId\tparticipantName\tparticipantType\n" +
    "R-HSA-109581\tApoptosis signaling\tPhysicalEntity\n";

  async function downloadTool(port: number) {
    const tools = createReactomeTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(port),
    });
    return tools.find((entry) => entry.name === DOWNLOAD_REACTOME_TOOL_NAME)!;
  }

  it("downloads the participants TSV through acquireSource and publishes a SourceAsset", async () => {
    const server = await serve({
      "GET /ContentService/exporter/participants/R-HSA-169893.tsv": {
        status: 200,
        contentType: "text/tab-separated-values",
        body: TSV,
      },
    });
    const tool = await downloadTool(server.port);

    const data = parse((await tool.execute({ pathway_id: "R-HSA-169893", file_type: "tsv" })).content);
    expect(Object.keys(data).sort()).toEqual([
      "format_hint",
      "local_files",
      "pathway_id",
      "retrieved_at",
      "source",
      "source_url",
    ]);
    expect(data["source"]).toBe("reactome");
    expect(data["pathway_id"]).toBe("R-HSA-169893");
    expect(data["source_url"]).toBe(
      "https://reactome.org/ContentService/exporter/participants/R-HSA-169893.tsv",
    );
    expect(data["format_hint"]).toBe("reactome_participants_tsv");
    expect(data["local_files"]).toHaveLength(1);
    const localPath = String((data["local_files"] as string[])[0]);
    expect(localPath.endsWith("R-HSA-169893_participants.tsv")).toBe(true);
    expect(await readFile(localPath, "utf8")).toBe(TSV);
    expect(localPath).toContain(path.join("source_assets", `asset_${sha256(TSV)}`));
  });

  it("builds the SBGN exporter URL and format hint", async () => {
    const server = await serve({
      "GET /ContentService/exporter/diagram/R-HSA-169893.sbgn": {
        status: 200,
        contentType: "application/xml",
        body: "<sbgn/>",
      },
    });
    const tool = await downloadTool(server.port);

    const data = parse((await tool.execute({ pathway_id: "R-HSA-169893", file_type: "sbgn" })).content);
    expect(data["format_hint"]).toBe("reactome_sbgn");
    expect(data["source_url"]).toBe(
      "https://reactome.org/ContentService/exporter/diagram/R-HSA-169893.sbgn",
    );
    expect(String((data["local_files"] as string[])[0]).endsWith("R-HSA-169893.sbgn")).toBe(true);
  });

  it("rejects unsupported file types without a network request", async () => {
    const server = await serve({});
    const tool = await downloadTool(server.port);

    const data = parse((await tool.execute({ pathway_id: "R-HSA-169893", file_type: "xml" })).content);
    expect(data["source"]).toBe("reactome");
    expect(String(data["error"])).toContain("unsupported file_type");
    expect(String(data["error"])).toContain("xml");
    expect(server.requests).toHaveLength(0);
  });

  it("returns error JSON on download failure", async () => {
    const server = await serve({
      "GET /ContentService/exporter/participants/R-HSA-169893.tsv": {
        status: 403,
        contentType: "text/plain",
        body: "Forbidden",
      },
    });
    const tool = await downloadTool(server.port);

    const data = parse((await tool.execute({ pathway_id: "R-HSA-169893", file_type: "tsv" })).content);
    expect(data["source"]).toBe("reactome");
    expect(data["source_url"]).toContain("/exporter/participants/");
    expect(String(data["error"])).toContain("download failed");
  });
});

describe("reactome tool registration", () => {
  it("registers all three tools under the SKILL_TOOL_MAP names", () => {
    const tools = createReactomeTools({ taskRoot: root });
    expect(tools.map((tool) => tool.name)).toEqual([
      SEARCH_REACTOME_TOOL_NAME,
      GET_PATHWAY_TOOL_NAME,
      DOWNLOAD_REACTOME_TOOL_NAME,
    ]);
    for (const tool of tools) {
      expect(SKILL_TOOL_NAMES.has(tool.name)).toBe(true);
      expect(toolOwner(tool.name)).toBe("reactome");
    }
  });

  it("exposes stable parameter schemas (Python signature parity)", () => {
    const tools = createReactomeTools({ taskRoot: root });
    const search = tools.find((tool) => tool.name === SEARCH_REACTOME_TOOL_NAME)!;
    expect(search.parameters).toEqual({
      type: "object",
      properties: {
        term: expect.objectContaining({ type: "string" }),
        max_results: expect.objectContaining({ type: "integer", default: 20 }),
      },
      required: ["term"],
      additionalProperties: false,
    });
    const pathway = tools.find((tool) => tool.name === GET_PATHWAY_TOOL_NAME)!;
    expect(pathway.parameters).toEqual(
      expect.objectContaining({ required: ["pathway_id"], additionalProperties: false }),
    );
    const download = tools.find((tool) => tool.name === DOWNLOAD_REACTOME_TOOL_NAME)!;
    expect(download.parameters).toEqual({
      type: "object",
      properties: {
        pathway_id: expect.objectContaining({ type: "string" }),
        file_type: expect.objectContaining({ type: "string", enum: ["tsv", "sbgn"], default: "tsv" }),
      },
      required: ["pathway_id"],
      additionalProperties: false,
    });
  });
});
