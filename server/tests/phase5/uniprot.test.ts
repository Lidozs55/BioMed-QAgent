/**
 * UniProt source tool tests (P5-06): fixture parity against the Python
 * ``backend/tests/test_skill_uniprot.py`` mock responses.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";
import { createUniprotTools, SEARCH_UNIPROT_TOOL_NAME } from "../../src/agent/tools/uniprot.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import type { QueryStatus } from "../../src/agent/tools/tool-hooks.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sources",
);
const HOSTS = ["rest.uniprot.org", "www.uniprot.org"];

function fixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES, name), "utf8");
}

let root: string;
const servers: FixtureServer[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "p5-uniprot-"));
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

describe("search_uniprot", () => {
  it("returns the Python-shaped structured records from the API tier", async () => {
    const server = await serve({
      "/uniprotkb/search": {
        status: 200,
        contentType: "application/json",
        body: await fixture("uniprot_search.json"),
      },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const [tool] = createUniprotTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      hooks: {
        onQuery: (query, source, status: QueryStatus, recordsCount?: number) =>
          queries.push([query, source, status, recordsCount]),
      },
    });

    const result = await tool.execute({ query: "TP53" });
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
    expect(data["source"]).toBe("uniprot");
    expect(data["count"]).toBe(1);
    expect(data["total_count"]).toBe(1);
    expect(data["records"]).toEqual([
      {
        accession: "P04637",
        protein_name: "Cellular tumor antigen p53",
        gene: "TP53",
        organism: "Homo sapiens",
        reviewed: true,
        url: "https://www.uniprot.org/uniprotkb/P04637",
      },
    ]);
    expect(String(data["usage_hint"])).toContain("Agent-only");
    const attempts = data["attempts"] as Array<Record<string, unknown>>;
    expect(attempts[0]).toEqual({
      method: "api",
      url: expect.stringContaining("https://rest.uniprot.org/uniprotkb/search?query=TP53&format=json&size=20"),
      status: "succeeded",
      status_code: 200,
    });
    expect(server.requests[0].url).toContain("query=TP53");
    expect(server.requests[0].url).toContain("size=20");
    expect(queries).toEqual([["TP53", "uniprot", "success", 1]]);
  });

  it("falls back to the rendered search page when the API tier fails", async () => {
    const server = await serve({
      "/uniprotkb/search": { status: 500, contentType: "text/plain", body: "boom" },
      "/uniprotkb": { status: 200, contentType: "text/html", body: await fixture("uniprot_page.html") },
    });
    const [tool] = createUniprotTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
    });

    const data = parse((await tool.execute({ query: "TP53" })).content);
    expect(data["status"]).toBe("page_fallback");
    expect(data["method_used"]).toBe("httpx");
    expect(data["page_url"]).toBe("https://www.uniprot.org/uniprotkb?query=TP53");
    expect(data["body_preview"]).toBe("<html>render me</html>\n");
  });

  it("reports empty results without fabricating records (Python shape)", async () => {
    const server = await serve({
      "/uniprotkb/search": {
        status: 200,
        contentType: "application/json",
        body: await fixture("uniprot_empty.json"),
      },
    });
    const [tool] = createUniprotTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
    });

    const data = parse((await tool.execute({ query: "NOPE" })).content);
    expect(data["count"]).toBe(0);
    expect(data["total_count"]).toBe(0); // totalResults missing → len(records)
    expect(data["records"]).toEqual([]);
    expect(data["method_used"]).toBe("api");
  });

  it("returns the audited error JSON when every tier fails", async () => {
    const server = await serve({
      "/uniprotkb/search": { status: 500, contentType: "text/plain", body: "boom" },
      "/uniprotkb": { status: 404, contentType: "text/plain", body: "missing" },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const [tool] = createUniprotTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      hooks: { onQuery: (q, s, st, n) => queries.push([q, s, st, n]) },
    });

    const data = parse((await tool.execute({ query: "TP53" })).content);
    expect(data["status"]).toBe("error");
    expect(String(data["error"])).toContain("All fetch tiers failed for uniprot");
    expect(data["attempted_methods"]).toEqual(["api", "html", "crawl"]);
    expect(queries).toEqual([["TP53", "uniprot", "failed", 0]]);
  });
});

describe("search_uniprot registration", () => {
  it("registers under the SKILL_TOOL_MAP name", () => {
    expect(SEARCH_UNIPROT_TOOL_NAME).toBe("search_uniprot");
    expect(SKILL_TOOL_NAMES.has(SEARCH_UNIPROT_TOOL_NAME)).toBe(true);
    expect(toolOwner(SEARCH_UNIPROT_TOOL_NAME)).toBe("uniprot");
  });

  it("exposes the stable parameter schema (Python signature parity)", () => {
    const [tool] = createUniprotTools({ taskRoot: root });
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
});
