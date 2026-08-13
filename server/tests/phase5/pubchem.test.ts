/**
 * PubChem source tool tests (P5-06): fixture parity against the Python
 * ``backend/tests/test_skill_pubchem.py`` mock responses.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";
import {
  createPubchemTools,
  DOWNLOAD_PUBCHEM_TOOL_NAME,
  GET_COMPOUND_TOOL_NAME,
  SEARCH_PUBCHEM_TOOL_NAME,
} from "../../src/agent/tools/pubchem.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import type { QueryStatus } from "../../src/agent/tools/tool-hooks.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sources",
);
const HOSTS = ["pubchem.ncbi.nlm.nih.gov"];

function fixture(name: string): Promise<string> {
  return readFile(path.join(FIXTURES, name), "utf8");
}

let root: string;
const servers: FixtureServer[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "p5-pubchem-"));
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

describe("search_pubchem", () => {
  it("returns structured compound records from the PUG-REST API tier", async () => {
    const server = await serve({
      "GET /rest/pug/compound/name/aspirin/property/MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES/JSON": {
        status: 200,
        contentType: "application/json",
        body: await fixture("pubchem_search.json"),
      },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const [tool] = createPubchemTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      hooks: {
        onQuery: (query, source, status: QueryStatus, recordsCount?: number) =>
          queries.push([query, source, status, recordsCount]),
      },
    });

    const data = parse((await tool.execute({ term: "aspirin" })).content);
    expect(Object.keys(data).sort()).toEqual(["attempts", "count", "method_used", "records", "source", "term"]);
    expect(data["source"]).toBe("pubchem");
    expect(data["term"]).toBe("aspirin");
    expect(data["count"]).toBe(1);
    expect(data["method_used"]).toBe("api");
    expect(data["records"]).toEqual([
      {
        cid: 2244,
        molecular_formula: "C9H8O4",
        molecular_weight: 180.16,
        iupac_name: "aspirin",
        canonical_smiles: "CC(=O)O",
        url: "https://pubchem.ncbi.nlm.nih.gov/compound/2244",
      },
    ]);
    const attempts = data["attempts"] as Array<Record<string, unknown>>;
    expect(attempts[0]).toEqual({
      method: "api",
      url: expect.stringContaining(
        "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/aspirin/property/",
      ),
      status: "succeeded",
      status_code: 200,
      reason: null,
      fallback_reason: null,
    });
    expect(server.requests[0].url).toContain("MaxRecords=20");
    expect(queries).toEqual([["aspirin", "pubchem", "success", 1]]);
  });

  it("reports empty results without fabricating records (Python shape)", async () => {
    const server = await serve({
      "GET /rest/pug/compound/name/zzz/property/MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES/JSON": {
        status: 200,
        contentType: "application/json",
        body: await fixture("pubchem_empty.json"),
      },
    });
    const [tool] = createPubchemTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
    });

    const data = parse((await tool.execute({ term: "zzz" })).content);
    expect(data["count"]).toBe(0);
    expect(data["records"]).toEqual([]);
    expect(data["method_used"]).toBe("api");
  });

  it("preserves the full attempt audit on the rendered page fallback", async () => {
    const server = await serve({
      "GET /rest/pug/compound/name/aspirin/property/MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES/JSON": {
        status: 500,
        contentType: "text/plain",
        body: "boom",
      },
      "GET /": { status: 200, contentType: "text/html", body: await fixture("pubchem_page.html") },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const [tool] = createPubchemTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      browserFallback: async () => ({ status_code: 200, body_text_preview: "Aspirin rendered result" }),
      hooks: { onQuery: (q, s, st, n) => queries.push([q, s, st, n]) },
    });

    const data = parse((await tool.execute({ term: "aspirin" })).content);
    expect(Object.keys(data).sort()).toEqual([
      "attempts",
      "body_text_preview",
      "method_used",
      "page_url",
      "source",
      "status",
    ]);
    expect(data["status"]).toBe("page_fallback");
    expect(data["method_used"]).toBe("crawl");
    expect(data["page_url"]).toBe("https://pubchem.ncbi.nlm.nih.gov/#query=aspirin");
    expect(data["body_text_preview"]).toBe("Aspirin rendered result");
    const attempts = data["attempts"] as Array<Record<string, unknown>>;
    expect(attempts.map((attempt) => attempt["method"])).toEqual(["api", "html", "browser"]);
    expect(attempts[0]["status"]).toBe("failed");
    expect(attempts[1]["status"]).toBe("failed"); // static html tier is rejected by the predicate
    expect(attempts[2]["status"]).toBe("succeeded");
    expect(queries).toEqual([["aspirin", "pubchem", "page_fallback", 0]]);
  });

  it("returns the audited error JSON when all tiers fail (Python shape)", async () => {
    const server = await serve({
      "GET /rest/pug/compound/name/missing/property/MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES/JSON": {
        status: 500,
        contentType: "text/plain",
        body: "boom",
      },
      "GET /": { status: 200, contentType: "text/html", body: await fixture("pubchem_page.html") },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const [tool] = createPubchemTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      hooks: { onQuery: (q, s, st, n) => queries.push([q, s, st, n]) },
    });

    const data = parse((await tool.execute({ term: "missing" })).content);
    expect(Object.keys(data).sort()).toEqual([
      "attempted_methods",
      "attempts",
      "error",
      "page_url",
      "source",
      "status",
    ]);
    expect(data["status"]).toBe("error");
    expect(data["source"]).toBe("pubchem");
    expect(data["page_url"]).toBe("https://pubchem.ncbi.nlm.nih.gov/#query=missing");
    expect(data["attempted_methods"]).toEqual(["api", "httpx", "crawl"]);
    expect(String(data["error"])).toContain("All fetch tiers failed for pubchem");
    expect((data["attempts"] as unknown[]).length).toBe(3);
    expect(queries).toEqual([["missing", "pubchem", "failed", 0]]);
  });

  it("rejects a PUG-REST Fault document before the page tiers (predicate parity)", async () => {
    const server = await serve({
      "GET /rest/pug/compound/name/aspirin/property/MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES/JSON": {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ Fault: { Message: "not found" } }),
      },
      "GET /": { status: 200, contentType: "text/html", body: await fixture("pubchem_page.html") },
    });
    const [tool] = createPubchemTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      browserFallback: async () => ({ status_code: 200, body_text_preview: "Aspirin rendered result" }),
    });

    const data = parse((await tool.execute({ term: "aspirin" })).content);
    expect(data["status"]).toBe("page_fallback");
    expect(data["method_used"]).toBe("crawl");
  });
});

describe("get_compound", () => {
  it("returns the compound record with InChI keys from the API tier", async () => {
    const server = await serve({
      "GET /rest/pug/compound/cid/2244/property/MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,InChIKey,InChI/JSON": {
        status: 200,
        contentType: "application/json",
        body: await fixture("pubchem_compound.json"),
      },
    });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const tools = createPubchemTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      hooks: { onQuery: (q, s, st, n) => queries.push([q, s, st, n]) },
    });
    const tool = tools.find((entry) => entry.name === GET_COMPOUND_TOOL_NAME)!;

    const data = parse((await tool.execute({ cid: 2244 })).content);
    expect(Object.keys(data).sort()).toEqual(["attempts", "cid", "method_used", "record", "source"]);
    expect(data["source"]).toBe("pubchem");
    expect(data["cid"]).toBe(2244);
    expect(data["method_used"]).toBe("api");
    expect(data["record"]).toEqual({
      cid: 2244,
      molecular_formula: "C9H8O4",
      molecular_weight: 180.16,
      iupac_name: "aspirin",
      canonical_smiles: "CC(=O)O",
      inchi_key: "KEY",
      inchi: "InChI=1",
      url: "https://pubchem.ncbi.nlm.nih.gov/compound/2244",
    });
    expect(queries).toEqual([["2244", "pubchem", "success", 1]]);
  });

  it("rejects an empty PropertyTable for the compound endpoint (predicate parity)", async () => {
    const server = await serve({
      "GET /rest/pug/compound/cid/2244/property/MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,InChIKey,InChI/JSON": {
        status: 200,
        contentType: "application/json",
        body: await fixture("pubchem_empty.json"),
      },
      "GET /compound/2244": {
        status: 200,
        contentType: "text/html",
        body: await fixture("pubchem_page.html"),
      },
    });
    const tools = createPubchemTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(server.port),
      browserFallback: async () => ({ status_code: 200, body_text_preview: "Aspirin rendered result" }),
    });
    const tool = tools.find((entry) => entry.name === GET_COMPOUND_TOOL_NAME)!;

    const data = parse((await tool.execute({ cid: 2244 })).content);
    expect(data["status"]).toBe("page_fallback");
    expect(data["page_url"]).toBe("https://pubchem.ncbi.nlm.nih.gov/compound/2244");
  });
});

describe("download_pubchem", () => {
  const SDF = "\n  PubChem2026\n\n  0  0  0  0  0  0  0  0  0  0999 V2000\nM  END\n$$$$\n";

  async function downloadTool(port: number) {
    const tools = createPubchemTools({
      taskRoot: root,
      rateLimitMs: 0,
      client: client(port),
    });
    return tools.find((entry) => entry.name === DOWNLOAD_PUBCHEM_TOOL_NAME)!;
  }

  it("downloads an SDF record through acquireSource and publishes a SourceAsset", async () => {
    const server = await serve({
      "GET /rest/pug/compound/cid/2244/record/SDF": {
        status: 200,
        contentType: "chemical/x-mdl-sdfile",
        body: SDF,
      },
    });
    const tool = await downloadTool(server.port);

    const data = parse((await tool.execute({ cid: 2244, file_type: "sdf" })).content);
    expect(Object.keys(data).sort()).toEqual([
      "cid",
      "format_hint",
      "local_files",
      "retrieved_at",
      "source",
      "source_url",
    ]);
    expect(data["source"]).toBe("pubchem");
    expect(data["cid"]).toBe(2244);
    expect(data["source_url"]).toBe(
      "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/2244/record/SDF?record_type=2d",
    );
    expect(data["format_hint"]).toBe("pubchem_sdf");
    expect(data["local_files"]).toHaveLength(1);
    const localPath = String((data["local_files"] as string[])[0]);
    expect(localPath.endsWith("CID2244.sdf")).toBe(true);
    expect(await readFile(localPath, "utf8")).toBe(SDF);
    // Verified content-addressed publication under source_assets/.
    expect(localPath).toContain(path.join("source_assets", `asset_${sha256(SDF)}`));
  });

  it("builds the MOL record URL and format hint", async () => {
    const server = await serve({
      "GET /rest/pug/compound/cid/2244/record/MOL": {
        status: 200,
        contentType: "chemical/x-mdl-molfile",
        body: "M  END\n",
      },
    });
    const tool = await downloadTool(server.port);

    const data = parse((await tool.execute({ cid: 2244, file_type: "mol" })).content);
    expect(data["format_hint"]).toBe("pubchem_mol");
    expect(data["source_url"]).toBe(
      "https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/2244/record/MOL?record_type=2d",
    );
  });

  it("rejects unsupported file types without a network request", async () => {
    const server = await serve({});
    const tool = await downloadTool(server.port);

    const data = parse((await tool.execute({ cid: 2244, file_type: "json" })).content);
    expect(data["source"]).toBe("pubchem");
    expect(String(data["error"])).toContain("unsupported file_type");
    expect(String(data["error"])).toContain("json");
    expect(server.requests).toHaveLength(0);
  });

  it("returns error JSON on download failure", async () => {
    const server = await serve({
      "GET /rest/pug/compound/cid/2244/record/SDF": { status: 403, contentType: "text/plain", body: "Forbidden" },
    });
    const tool = await downloadTool(server.port);

    const data = parse((await tool.execute({ cid: 2244, file_type: "sdf" })).content);
    expect(data["source"]).toBe("pubchem");
    expect(data["source_url"]).toContain("/record/SDF");
    expect(String(data["error"])).toContain("download failed");
  });
});

describe("pubchem tool registration", () => {
  it("registers all three tools under the SKILL_TOOL_MAP names", () => {
    const tools = createPubchemTools({ taskRoot: root });
    expect(tools.map((tool) => tool.name)).toEqual([
      SEARCH_PUBCHEM_TOOL_NAME,
      GET_COMPOUND_TOOL_NAME,
      DOWNLOAD_PUBCHEM_TOOL_NAME,
    ]);
    for (const tool of tools) {
      expect(SKILL_TOOL_NAMES.has(tool.name)).toBe(true);
      expect(toolOwner(tool.name)).toBe("pubchem");
    }
  });

  it("exposes stable parameter schemas (Python signature parity)", () => {
    const tools = createPubchemTools({ taskRoot: root });
    const search = tools.find((tool) => tool.name === SEARCH_PUBCHEM_TOOL_NAME)!;
    expect(search.parameters).toEqual({
      type: "object",
      properties: {
        term: expect.objectContaining({ type: "string" }),
        max_results: expect.objectContaining({ type: "integer" }),
        strict_mode: expect.objectContaining({ type: "boolean", default: false }),
      },
      required: ["term"],
      additionalProperties: false,
    });
    const compound = tools.find((tool) => tool.name === GET_COMPOUND_TOOL_NAME)!;
    expect(compound.parameters).toEqual(
      expect.objectContaining({ required: ["cid"], additionalProperties: false }),
    );
    const download = tools.find((tool) => tool.name === DOWNLOAD_PUBCHEM_TOOL_NAME)!;
    expect(download.parameters).toEqual({
      type: "object",
      properties: {
        cid: expect.objectContaining({ type: "integer" }),
        file_type: expect.objectContaining({ type: "string", enum: ["sdf", "mol"], default: "sdf" }),
      },
      required: ["cid"],
      additionalProperties: false,
    });
  });
});
