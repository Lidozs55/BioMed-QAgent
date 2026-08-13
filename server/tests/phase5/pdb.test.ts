/**
 * PDB source tool tests (P5-06): fixture parity against the Python
 * ``backend/tests/test_skill_pdb.py`` mock responses.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";
import {
  createPdbTools,
  DESCRIBE_PDB_TOOL_NAME,
  DOWNLOAD_PDB_TOOL_NAME,
  SEARCH_PDB_TOOL_NAME,
} from "../../src/agent/tools/pdb.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import type { QueryStatus } from "../../src/agent/tools/tool-hooks.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sources",
);
const HOSTS = ["search.rcsb.org", "data.rcsb.org", "files.rcsb.org"];

function fixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES, name), "utf8");
}

let root: string;
const servers: FixtureServer[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "p5-pdb-"));
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

describe("search_pdb", () => {
  it("searches via the Search API and enriches the top entries via the Data API", async () => {
    const server = await serve({
      "POST /rcsbsearch/v2/query": {
        status: 200,
        contentType: "application/json",
        body: await fixture("pdb_search.json"),
      },
      "GET /rest/v1/core/entry/1cbs": {
        status: 200,
        contentType: "application/json",
        body: await fixture("pdb_entry_1cbs.json"),
      },
      "GET /rest/v1/core/entry/2xyz": {
        status: 200,
        contentType: "application/json",
        body: await fixture("pdb_entry_2xyz.json"),
      },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const [tool] = createPdbTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      hooks: {
        onQuery: (query, source, status: QueryStatus, recordsCount?: number) =>
          queries.push([query, source, status, recordsCount]),
      },
    });

    const data = parse((await tool.execute({ term: "retinoic acid", max_results: 5 })).content);
    expect(Object.keys(data).sort()).toEqual(["enriched_count", "pdb_ids", "records", "source", "term"]);
    expect(data["source"]).toBe("pdb");
    expect(data["term"]).toBe("retinoic acid");
    expect(data["pdb_ids"]).toEqual(["1CBS", "2XYZ"]);
    expect(data["enriched_count"]).toBe(2);
    expect(data["records"]).toEqual([
      {
        pdb_id: "1CBS",
        title: "Cellular retinoic acid binding protein",
        organism: "Homo sapiens",
        method: "X-RAY DIFFRACTION",
        resolution: 1.8,
        deposit_date: "1992-01-01",
      },
      {
        pdb_id: "2XYZ",
        title: "Hypothetical protein XYZ",
        organism: "",
        method: "SOLUTION NMR",
        resolution: 2.5,
        deposit_date: "2010-05-05",
      },
    ]);

    // POST body parity: full_text search with pagination and score sort.
    const post = server.requests[0];
    expect(post.method).toBe("POST");
    const body = JSON.parse(post.body) as Record<string, unknown>;
    expect(body).toEqual({
      query: {
        type: "group",
        logical_operator: "and",
        nodes: [
          {
            type: "terminal",
            service: "full_text",
            parameters: { value: "retinoic acid" },
          },
        ],
      },
      return_type: "entry",
      request_options: {
        paginate: { start: 0, rows: 5 },
        results_content_type: ["experimental"],
        sort: [{ sort_by: "score", direction: "desc" }],
      },
    });
    // Enrichment hits the Data API with the lowercased entry id.
    expect(server.requests.map((request) => `${request.method} ${new URL(request.url, "http://localhost").pathname}`))
      .toEqual([
        "POST /rcsbsearch/v2/query",
        "GET /rest/v1/core/entry/1cbs",
        "GET /rest/v1/core/entry/2xyz",
      ]);
    expect(queries).toEqual([["retinoic acid", "pdb", "success", 2]]);
  });

  it("returns empty pdb_ids/records for an empty result_set (no fabricated success)", async () => {
    const server = await serve({
      "POST /rcsbsearch/v2/query": {
        status: 200,
        contentType: "application/json",
        body: await fixture("pdb_search_empty.json"),
      },
    });
    const [tool] = createPdbTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
    });

    const data = parse((await tool.execute({ term: "nope" })).content);
    expect(data["pdb_ids"]).toEqual([]);
    expect(data["records"]).toEqual([]);
    expect(data["enriched_count"]).toBe(0);
    expect(server.requests).toHaveLength(1); // no describe calls
  });

  it("keeps default record fields when a describe enrichment fails", async () => {
    const server = await serve({
      "POST /rcsbsearch/v2/query": {
        status: 200,
        contentType: "application/json",
        body: await fixture("pdb_search.json"),
      },
      "GET /rest/v1/core/entry/1cbs": { status: 500, contentType: "text/plain", body: "boom" },
      "GET /rest/v1/core/entry/2xyz": {
        status: 200,
        contentType: "application/json",
        body: await fixture("pdb_entry_2xyz.json"),
      },
    });
    const [tool] = createPdbTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
    });

    const data = parse((await tool.execute({ term: "retinoic acid" })).content);
    const records = data["records"] as Array<Record<string, unknown>>;
    expect(records[0]).toEqual({
      pdb_id: "1CBS",
      title: "",
      organism: "",
      method: "",
      resolution: null,
      deposit_date: "",
    });
    expect(records[1]["title"]).toBe("Hypothetical protein XYZ");
  });

  it("returns error JSON (not a throw) on search failure", async () => {
    const server = await serve({
      "POST /rcsbsearch/v2/query": { status: 500, contentType: "text/plain", body: "boom" },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const [tool] = createPdbTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      hooks: { onQuery: (q, s, st, n) => queries.push([q, s, st, n]) },
    });

    const data = parse((await tool.execute({ term: "protein" })).content);
    expect(data["source"]).toBe("pdb");
    expect(data["term"]).toBe("protein");
    expect(data["pdb_ids"]).toEqual([]);
    expect(data["records"]).toEqual([]);
    expect(typeof data["error"]).toBe("string");
    expect(queries).toEqual([["protein", "pdb", "failed", 0]]);
  });
});

describe("describe_pdb", () => {
  it("returns full metadata with the uppercased pdb_id", async () => {
    const server = await serve({
      "GET /rest/v1/core/entry/1cbs": {
        status: 200,
        contentType: "application/json",
        body: await fixture("pdb_entry_describe.json"),
      },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const tools = createPdbTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      hooks: { onQuery: (q, s, st, n) => queries.push([q, s, st, n]) },
    });
    const tool = tools.find((entry) => entry.name === DESCRIBE_PDB_TOOL_NAME);
    expect(tool).toBeDefined();

    const data = parse((await tool!.execute({ pdb_id: "1cbs" })).content);
    expect(Object.keys(data).sort()).toEqual([
      "authors",
      "citation",
      "deposit_date",
      "method",
      "molecular_weight",
      "nonpolymer_entities",
      "pdb_id",
      "polymer_count",
      "polymer_entities",
      "resolution",
      "source",
      "title",
      "url",
    ]);
    expect(data["source"]).toBe("pdb");
    expect(data["pdb_id"]).toBe("1CBS");
    expect(data["title"]).toBe("Test Structure");
    expect(data["method"]).toBe("X-RAY DIFFRACTION");
    expect(data["resolution"]).toBe(2.1);
    expect(data["authors"]).toEqual(["Smith, J."]);
    expect(data["citation"]).toEqual({ title: "Test Paper" });
    expect(data["polymer_entities"]).toEqual([]);
    expect(data["nonpolymer_entities"]).toEqual([]);
    expect(data["molecular_weight"]).toBeNull();
    expect(data["polymer_count"]).toBe(0);
    expect(data["url"]).toBe("https://data.rcsb.org/rest/v1/core/entry/1cbs");
    expect(queries).toEqual([["1cbs", "pdb", "success", 1]]);
  });

  it("returns error JSON with the lowercased pdb_id on failure", async () => {
    const server = await serve({
      "GET /rest/v1/core/entry/1cbs": { status: 500, contentType: "text/plain", body: "boom" },
    });
    const tools = createPdbTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
    });
    const tool = tools.find((entry) => entry.name === DESCRIBE_PDB_TOOL_NAME)!;

    const data = parse((await tool.execute({ pdb_id: "1CBS" })).content);
    expect(data["pdb_id"]).toBe("1cbs");
    expect(typeof data["error"]).toBe("string");
  });
});

describe("download_pdb", () => {
  const PDB_CONTENT =
    "ATOM      1  N   MET A   1      11.104  6.134  6.504  1.00 20.00           N";

  async function downloadTool(port: number, hooks?: Parameters<typeof createPdbTools>[0]["hooks"]) {
    const tools = createPdbTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(port),
      hooks,
    });
    return tools.find((entry) => entry.name === DOWNLOAD_PDB_TOOL_NAME)!;
  }

  it("downloads a PDB file through acquireSource and publishes a SourceAsset", async () => {
    const server = await serve({
      "GET /download/1cbs.pdb": {
        status: 200,
        contentType: "application/octet-stream",
        body: PDB_CONTENT,
      },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const tool = await downloadTool(server.port, {
      onQuery: (q, s, st, n) => queries.push([q, s, st, n]),
    });

    const data = parse((await tool.execute({ pdb_id: "1CBS" })).content);
    expect(data["source"]).toBe("pdb");
    expect(data["pdb_id"]).toBe("1CBS");
    expect(data["source_url"]).toBe("https://files.rcsb.org/download/1cbs.pdb");
    expect(data["format_hint"]).toBe("pdb_legacy");
    expect(typeof data["retrieved_at"]).toBe("string");
    expect(data["local_files"]).toHaveLength(1);
    const localPath = String((data["local_files"] as string[])[0]);
    expect(localPath.endsWith("1cbs.pdb")).toBe(true);
    expect(await readFile(localPath, "utf8")).toBe(PDB_CONTENT);

    const attempt = data["attempt"] as Record<string, unknown>;
    expect(attempt["status"]).toBe("succeeded");
    expect(attempt["url"]).toBe("https://files.rcsb.org/download/1cbs.pdb");
    const asset = data["asset"] as Record<string, unknown>;
    expect(asset["kind"]).toBe("source");
    expect(asset["sha256"]).toBe(sha256(PDB_CONTENT));
    expect(asset["relative_path"]).toBe(
      `source_assets/asset_${sha256(PDB_CONTENT)}/1cbs.pdb`,
    );
    expect(asset["successful_attempt_id"]).toBe(attempt["attempt_id"]);
    expect(queries).toEqual([["1cbs.pdb", "pdb", "success", 1]]);
  });

  it("supports the mmCIF format hint", async () => {
    const server = await serve({
      "GET /download/1cbs.cif": {
        status: 200,
        contentType: "application/octet-stream",
        body: "data_1CBS",
      },
    });
    const tool = await downloadTool(server.port);

    const data = parse((await tool.execute({ pdb_id: "1cbs", file_type: "cif" })).content);
    expect(data["source_url"]).toBe("https://files.rcsb.org/download/1cbs.cif");
    expect(data["format_hint"]).toBe("mmcif");
    expect(String((data["local_files"] as string[])[0]).endsWith("1cbs.cif")).toBe(true);
  });

  it("returns the failed attempt record and error on HTTP failure", async () => {
    const server = await serve({
      "GET /download/1cbs.pdb": { status: 500, contentType: "text/plain", body: "server error" },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const tool = await downloadTool(server.port, {
      onQuery: (q, s, st, n) => queries.push([q, s, st, n]),
    });

    const data = parse((await tool.execute({ pdb_id: "1cbs" })).content);
    expect(data["source"]).toBe("pdb");
    const attempt = data["attempt"] as Record<string, unknown>;
    expect(attempt["status"]).toBe("failed");
    expect(data["asset"]).toBeNull();
    expect(data["error"]).toBe(attempt["error_message"]);
    expect(queries).toEqual([["1cbs.pdb", "pdb", "failed", 0]]);
  });

  it("rejects unsupported file types without a network request", async () => {
    const server = await serve({});
    const tool = await downloadTool(server.port);

    const data = parse((await tool.execute({ pdb_id: "1cbs", file_type: "xml" })).content);
    expect(data["source"]).toBe("pdb");
    expect(String(data["error"])).toContain("unsupported file_type");
    expect(String(data["error"])).toContain("xml");
    expect(server.requests).toHaveLength(0);
  });
});

describe("pdb tool registration", () => {
  it("registers all three tools under the SKILL_TOOL_MAP names", () => {
    const tools = createPdbTools({ taskRoot: root });
    expect(tools.map((tool) => tool.name)).toEqual([
      SEARCH_PDB_TOOL_NAME,
      DESCRIBE_PDB_TOOL_NAME,
      DOWNLOAD_PDB_TOOL_NAME,
    ]);
    for (const tool of tools) {
      expect(SKILL_TOOL_NAMES.has(tool.name)).toBe(true);
      expect(toolOwner(tool.name)).toBe("pdb");
    }
  });

  it("exposes stable parameter schemas (Python signature parity)", () => {
    const tools = createPdbTools({ taskRoot: root });
    const search = tools.find((tool) => tool.name === SEARCH_PDB_TOOL_NAME)!;
    expect(search.parameters).toEqual({
      type: "object",
      properties: {
        term: expect.objectContaining({ type: "string" }),
        max_results: expect.objectContaining({ type: "integer", default: 20 }),
      },
      required: ["term"],
      additionalProperties: false,
    });
    const describe = tools.find((tool) => tool.name === DESCRIBE_PDB_TOOL_NAME)!;
    expect(describe.parameters).toEqual(
      expect.objectContaining({ required: ["pdb_id"], additionalProperties: false }),
    );
    const download = tools.find((tool) => tool.name === DOWNLOAD_PDB_TOOL_NAME)!;
    expect(download.parameters).toEqual({
      type: "object",
      properties: {
        pdb_id: expect.objectContaining({ type: "string" }),
        file_type: expect.objectContaining({ type: "string", enum: ["pdb", "cif"], default: "pdb" }),
      },
      required: ["pdb_id"],
      additionalProperties: false,
    });
  });
});
