/**
 * ChEMBL source tool tests (P5-06): fixture parity against the Python
 * ``backend/tests/test_skill_chembl.py`` mock responses.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";
import { createChemblTools, SEARCH_CHEMBL_TOOL_NAME } from "../../src/agent/tools/chembl.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import type { QueryStatus } from "../../src/agent/tools/tool-hooks.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sources",
);
const HOSTS = ["www.ebi.ac.uk"];

function fixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES, name), "utf8");
}

let root: string;
const servers: FixtureServer[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "p5-chembl-"));
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
  body: string;
}

async function serve(routes: Record<string, Route>): Promise<FixtureServer> {
  const server = await startFixtureServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    const route = routes[pathname];
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

describe("search_chembl", () => {
  it("returns the Python-shaped structured records from the API tier", async () => {
    const server = await serve({
      "/chembl/api/data/molecule/search": {
        status: 200,
        contentType: "application/json",
        body: await fixture("chembl_search.json"),
      },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const [tool] = createChemblTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      hooks: {
        onQuery: (query, source, status: QueryStatus, recordsCount?: number) =>
          queries.push([query, source, status, recordsCount]),
      },
    });

    const result = await tool.execute({ query: "aspirin" });
    expect(result.isError).toBeUndefined();
    const data = parse(result.content);
    expect(Object.keys(data).sort()).toEqual([
      "attempts",
      "count",
      "method_used",
      "query",
      "records",
      "source",
      "total_count",
      "usage_hint",
    ]);
    expect(data["source"]).toBe("chembl");
    expect(data["query"]).toBe("aspirin");
    expect(data["count"]).toBe(1);
    expect(data["total_count"]).toBe(1);
    expect(data["method_used"]).toBe("api");
    expect(data["records"]).toEqual([
      {
        chembl_id: "CHEMBL25",
        preferred_name: "Aspirin",
        molecule_type: "Small molecule",
        max_phase: 4,
        url: "https://www.ebi.ac.uk/chembl/compound_report_card/CHEMBL25",
      },
    ]);
    expect(typeof data["usage_hint"]).toBe("string");
    expect(String(data["usage_hint"])).toContain("Agent-only");
    const attempts = data["attempts"] as Array<Record<string, unknown>>;
    expect(attempts).toHaveLength(1);
    expect(Object.keys(attempts[0]).sort()).toEqual(["method", "status", "status_code", "url"]);
    expect(attempts[0]).toEqual({
      method: "api",
      url: expect.stringContaining("https://www.ebi.ac.uk/chembl/api/data/molecule/search?q=aspirin&limit=20&format=json"),
      status: "succeeded",
      status_code: 200,
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].url).toContain("q=aspirin");
    expect(server.requests[0].url).toContain("limit=20");
    expect(server.requests[0].url).toContain("format=json");
    expect(queries).toEqual([["aspirin", "chembl", "success", 1]]);
  });

  it("falls back to the rendered page when the API tier fails (html tier)", async () => {
    const server = await serve({
      "/chembl/api/data/molecule/search": { status: 500, contentType: "text/plain", body: "boom" },
      "/chembl/g/": { status: 200, contentType: "text/html", body: await fixture("chembl_page.html") },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const [tool] = createChemblTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      hooks: { onQuery: (q, s, st, n) => queries.push([q, s, st, n]) },
    });

    const data = parse((await tool.execute({ query: "aspirin" })).content);
    expect(Object.keys(data).sort()).toEqual([
      "body_preview",
      "method_used",
      "page_url",
      "query",
      "source",
      "status",
    ]);
    expect(data["status"]).toBe("page_fallback");
    expect(data["method_used"]).toBe("httpx");
    expect(data["page_url"]).toBe("https://www.ebi.ac.uk/chembl/g/#search_results/all/query/aspirin");
    expect(data["body_preview"]).toBe("<html>render me</html>\n");
    expect(queries).toEqual([["aspirin", "chembl", "success", 0]]);
    expect(server.requests).toHaveLength(2);
  });

  it("uses the injectable browser fallback for the crawl tier", async () => {
    const server = await serve({
      "/chembl/api/data/molecule/search": { status: 500, contentType: "text/plain", body: "boom" },
      "/chembl/g/": { status: 500, contentType: "text/plain", body: "boom" },
    });
    const [tool] = createChemblTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      browserFallback: async (url) => {
        expect(url).toBe("https://www.ebi.ac.uk/chembl/g/#search_results/all/query/aspirin");
        return { status_code: 200, body_text_preview: "Rendered aspirin" };
      },
    });

    const data = parse((await tool.execute({ query: "aspirin" })).content);
    expect(data["status"]).toBe("page_fallback");
    expect(data["method_used"]).toBe("crawl");
    expect(data["body_preview"]).toBe("Rendered aspirin");
  });

  it("returns the audited error JSON when every tier fails without a browser", async () => {
    const server = await serve({
      "/chembl/api/data/molecule/search": { status: 500, contentType: "text/plain", body: "boom" },
      "/chembl/g/": { status: 500, contentType: "text/plain", body: "boom" },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const [tool] = createChemblTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      hooks: { onQuery: (q, s, st, n) => queries.push([q, s, st, n]) },
    });

    const data = parse((await tool.execute({ query: "aspirin" })).content);
    expect(Object.keys(data).sort()).toEqual([
      "attempted_methods",
      "error",
      "query",
      "source",
      "status",
    ]);
    expect(data["status"]).toBe("error");
    expect(data["source"]).toBe("chembl");
    expect(String(data["error"])).toContain("All fetch tiers failed for chembl");
    expect(data["attempted_methods"]).toEqual(["api", "html", "crawl"]);
    expect(queries).toEqual([["aspirin", "chembl", "failed", 0]]);
    // api + html tiers hit the fixture server; the crawl tier has no browser.
    expect(server.requests).toHaveLength(2);
  });

  it("reports empty results without fabricating records (Python shape)", async () => {
    const server = await serve({
      "/chembl/api/data/molecule/search": {
        status: 200,
        contentType: "application/json",
        body: await fixture("chembl_empty.json"),
      },
    });
    const [tool] = createChemblTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
    });

    const data = parse((await tool.execute({ query: "zzz" })).content);
    expect(data["count"]).toBe(0);
    expect(data["total_count"]).toBe(0);
    expect(data["records"]).toEqual([]);
    expect(data["method_used"]).toBe("api");
  });

  it("rejects an API JSON body without a molecules list (predicate parity)", async () => {
    const server = await serve({
      "/chembl/api/data/molecule/search": { status: 200, contentType: "application/json", body: "[]" },
      "/chembl/g/": { status: 200, contentType: "text/html", body: await fixture("chembl_page.html") },
    });
    const [tool] = createChemblTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
    });

    const data = parse((await tool.execute({ query: "aspirin" })).content);
    expect(data["status"]).toBe("page_fallback");
    expect(data["method_used"]).toBe("httpx");
  });

  it("propagates cancellation instead of producing a fallback result", async () => {
    const server = await serve({
      "/chembl/api/data/molecule/search": { status: 200, contentType: "application/json", body: "{}" },
    });
    const [tool] = createChemblTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
    });
    const controller = new AbortController();
    controller.abort();
    await expect(tool.execute({ query: "aspirin" }, controller.signal)).rejects.toThrow();
  });
});

describe("search_chembl registration", () => {
  it("registers under the SKILL_TOOL_MAP name", () => {
    expect(SEARCH_CHEMBL_TOOL_NAME).toBe("search_chembl");
    expect(SKILL_TOOL_NAMES.has(SEARCH_CHEMBL_TOOL_NAME)).toBe(true);
    expect(toolOwner(SEARCH_CHEMBL_TOOL_NAME)).toBe("chembl");
  });

  it("exposes the stable parameter schema (Python signature parity)", () => {
    const [tool] = createChemblTools({ taskRoot: root });
    expect(tool.name).toBe("search_chembl");
    expect(tool.label).toBe("Search ChEMBL");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {
        query: expect.objectContaining({ type: "string" }),
        max_results: expect.objectContaining({ type: "integer", default: 20 }),
      },
      required: ["query"],
      additionalProperties: false,
    });
  });

  it("fails closed with isError on a non-string query", async () => {
    const [tool] = createChemblTools({ taskRoot: root });
    const result = await tool.execute({ query: 42 });
    expect(result.isError).toBe(true);
    const data = parse(result.content);
    expect(data["status"]).toBe("error");
  });
});
