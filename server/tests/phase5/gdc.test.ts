/**
 * Phase 5 checkpoint P5-05: GDC tools parity tests (Python
 * ``backend/tests/test_skill_gdc.py`` mirror) + end-to-end contract against
 * the TS GdcExpressionAdapter (goldens generated from the Python adapters).
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentCache } from "../../src/external/acquisition/index.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import {
  DESCRIBE_GDC_TOOL_NAME,
  DOWNLOAD_GDC_TOOL_NAME,
  SEARCH_GDC_TOOL_NAME,
  createDescribeGdcTool,
  createDownloadGdcTool,
  createGdcTools,
  createSearchGdcTool,
  describeGdc,
  downloadGdc,
  searchGdc,
  type GdcToolDeps,
} from "../../src/agent/tools/gdc.js";
import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";
import { getAdapter } from "../../src/dataset/adapters/adapters.js";
import { parseSourceAsset } from "../../src/dataset/contracts/index.js";
import {
  fakeResolver,
  localExecutor,
  PUBLIC_IP,
  startFixtureServer,
  type FixtureServer,
} from "./helpers.js";

const GDC_HOST = "api.gdc.cancer.gov";
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): string {
  return path.join(FIXTURES, "gdc", name);
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function md5Hex(content: Buffer): string {
  return createHash("md5").update(content).digest("hex");
}

let root: string;
const fixtures: FixtureServer[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "p5-gdc-"));
});

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((server) => server.close()));
  await rm(root, { recursive: true, force: true });
});

function client(port: number): PublicHttpClient {
  return new PublicHttpClient({
    resolve: fakeResolver({ [GDC_HOST]: [PUBLIC_IP] }),
    executor: localExecutor(port),
  });
}

function deps(port: number, hooks?: GdcToolDeps["hooks"], overrides: Partial<GdcToolDeps> = {}): GdcToolDeps {
  return {
    taskRoot: root,
    client: client(port),
    cache: new ContentCache(path.join(root, "cache")),
    rateLimitMs: 0,
    hooks,
    ...overrides,
  };
}

/** Serve one JSON payload for every request (Python urlopen mock parity). */
async function jsonServer(payload: unknown): Promise<FixtureServer> {
  const text = JSON.stringify(payload);
  const server = await startFixtureServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(text);
  });
  fixtures.push(server);
  return server;
}

/** Route /files → files JSON, /data/<id> → binary content. */
async function downloadServer(filesPayload: unknown, files: Record<string, Buffer>): Promise<FixtureServer> {
  const server = await startFixtureServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/files")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(filesPayload));
      return;
    }
    if (url.startsWith("/data/")) {
      const fileId = url.slice("/data/".length).split("?")[0];
      const content = files[fileId];
      if (content === undefined) {
        res.writeHead(404, {});
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/tab-separated-values",
        "content-length": String(content.length),
      });
      res.end(content);
      return;
    }
    res.writeHead(404, {});
    res.end("not found");
  });
  fixtures.push(server);
  return server;
}

const PROJECTS_EXPAND =
  "summary%2Csummary.case_count%2Csummary.file_count%2Csummary.data_categories";

describe("gdc tool registration (SKILL_TOOL_MAP contract)", () => {
  it("registers search/describe/download under the gdc skill", () => {
    expect(SKILL_TOOL_NAMES.has(SEARCH_GDC_TOOL_NAME)).toBe(true);
    expect(SKILL_TOOL_NAMES.has(DESCRIBE_GDC_TOOL_NAME)).toBe(true);
    expect(SKILL_TOOL_NAMES.has(DOWNLOAD_GDC_TOOL_NAME)).toBe(true);
    expect(toolOwner(SEARCH_GDC_TOOL_NAME)).toBe("gdc");
    expect(toolOwner(DESCRIBE_GDC_TOOL_NAME)).toBe("gdc");
    expect(toolOwner(DOWNLOAD_GDC_TOOL_NAME)).toBe("gdc");
  });

  it("exposes the stable parameter schemas", () => {
    const tools = createGdcTools(deps(0));
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_gdc",
      "describe_gdc",
      "download_gdc",
    ]);
    const search = createSearchGdcTool(deps(0));
    expect(search.parameters).toEqual({
      type: "object",
      properties: expect.objectContaining({
        query: { type: "string", description: expect.any(String) },
        max_results: { type: "integer", description: expect.any(String), default: 20 },
        term: { type: "string", description: expect.any(String) },
      }),
      additionalProperties: false,
    });
    const describe = createDescribeGdcTool(deps(0));
    expect(describe.parameters).toEqual({
      type: "object",
      properties: expect.objectContaining({
        project_id: { type: "string", description: expect.any(String) },
        data_category: { type: "string", description: expect.any(String) },
      }),
      required: ["project_id"],
      additionalProperties: false,
    });
    const download = createDownloadGdcTool(deps(0));
    expect(download.parameters).toEqual({
      type: "object",
      properties: expect.objectContaining({
        project_id: { type: "string", description: expect.any(String) },
        data_type: { type: "string", description: expect.any(String), default: "RNA-Seq" },
        data_category: { type: "string", description: expect.any(String) },
        workflow_type: { type: "string", description: expect.any(String) },
      }),
      required: ["project_id"],
      additionalProperties: false,
    });
  });

  it("executes through the BioMedAgentTool interface", async () => {
    const payload = JSON.parse(await readFile(fixture("projects.json"), "utf8")) as unknown;
    const server = await jsonServer(payload);
    const tool = createSearchGdcTool(deps(server.port));
    const result = await tool.execute({ term: "lung" });
    const data = JSON.parse(result.content) as Record<string, unknown>;
    expect(result.isError).toBeUndefined();
    expect(data["source"]).toBe("gdc");
    expect(data["term"]).toBe("lung");
  });
});

describe("search_gdc", () => {
  it("returns matching projects with the GDC result shape", async () => {
    const payload = JSON.parse(await readFile(fixture("projects.json"), "utf8")) as unknown;
    const server = await jsonServer(payload);
    const queries: Array<[string, string, string, number]> = [];
    const starts: Array<[string, string]> = [];
    const result = await searchGdc(
      { term: "lung", max_results: 5 },
      deps(server.port, {
        onQueryStarted: (q, s) => starts.push([q, s]),
        onQuery: (q, s, st, n = 0) => queries.push([q, s, st, n]),
      }),
    );

    expect(result.source).toBe("gdc");
    expect(result.term).toBe("lung");
    expect(result.project_ids).toEqual(["TCGA-LUAD"]);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toEqual({
      project_id: "TCGA-LUAD",
      name: "Lung Adenocarcinoma",
      disease_type: ["Adenomas and Adenocarcinomas"],
      primary_site: ["Lung"],
      case_count: 500,
      file_count: 3000,
      data_categories: ["Transcriptome Profiling"],
    });
    expect(queries).toEqual([["lung", "gdc", "success", 1]]);
    // The query lifecycle opens before the request is issued.
    expect(starts).toEqual([["lung", "gdc"]]);
  });

  it("mirrors the GDC API query exactly (params and browser UA)", async () => {
    const payload = JSON.parse(await readFile(fixture("projects.json"), "utf8")) as unknown;
    const server = await jsonServer(payload);
    await searchGdc({ term: "lung" }, deps(server.port));
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].url).toBe(
      `/projects?format=json&size=200&expand=${PROJECTS_EXPAND}`,
    );
    expect(server.requests[0].headers["user-agent"]).toContain("Mozilla/5.0");
    expect(server.requests[0].headers["accept"]).toBe("application/json");
  });

  it("accepts query as the recommended parameter (term is a legacy alias)", async () => {
    const payload = JSON.parse(await readFile(fixture("projects.json"), "utf8")) as unknown;
    const server = await jsonServer(payload);
    const viaQuery = await searchGdc({ query: "PAAD" }, deps(server.port));
    expect(viaQuery.term).toBe("PAAD");
    expect(viaQuery.project_ids).toEqual(["TCGA-PAAD"]);

    // query wins over term (Python parity).
    const both = await searchGdc({ query: "PAAD", term: "lung" }, deps(server.port));
    expect(both.term).toBe("PAAD");
    expect(both.project_ids).toEqual(["TCGA-PAAD"]);
  });

  it("uses token-OR matching for multi-word terms", async () => {
    const payload = JSON.parse(await readFile(fixture("projects.json"), "utf8")) as unknown;
    const server = await jsonServer(payload);
    const result = await searchGdc({ term: "breast cancer TP53", max_results: 20 }, deps(server.port));
    expect(result.project_ids).toEqual(["TCGA-BRCA"]);
    expect(result.records).toHaveLength(1);
  });

  it("keeps exact substring matching for single-token terms", async () => {
    const payload = JSON.parse(await readFile(fixture("projects.json"), "utf8")) as unknown;
    const server = await jsonServer(payload);
    const result = await searchGdc({ term: "TCGA-BRCA", max_results: 5 }, deps(server.port));
    expect(result.project_ids).toEqual(["TCGA-BRCA"]);
  });

  it("caps results at max_results", async () => {
    const payload = JSON.parse(await readFile(fixture("projects.json"), "utf8")) as unknown;
    const server = await jsonServer(payload);
    const result = await searchGdc({ term: "TCGA", max_results: 2 }, deps(server.port));
    expect(result.records).toHaveLength(2);
  });

  it("returns empty records for an empty term (never fakes success records)", async () => {
    const payload = JSON.parse(await readFile(fixture("projects.json"), "utf8")) as unknown;
    const server = await jsonServer(payload);
    const result = await searchGdc({ query: "" }, deps(server.port));
    expect(result.records).toEqual([]);
    expect(result.project_ids).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("returns error JSON (not a throw) on network failure", async () => {
    const server = await startFixtureServer((_req, res) => {
      res.writeHead(503, {});
      res.end("unavailable");
    });
    fixtures.push(server);
    const queries: Array<[string, string, string, number]> = [];
    const result = await searchGdc(
      { term: "breast" },
      deps(server.port, { onQuery: (q, s, st, n = 0) => queries.push([q, s, st, n]) }),
    );
    expect(result.source).toBe("gdc");
    expect(result.term).toBe("breast");
    expect(result.error).toBeDefined();
    expect(result.project_ids).toEqual([]);
    expect(result.records).toEqual([]);
    expect(queries).toEqual([["breast", "gdc", "failed", 0]]);
  });
});

describe("describe_gdc", () => {
  it("returns project metadata (direct data object, not hits[])", async () => {
    const payload = JSON.parse(await readFile(fixture("project_tcga_luad.json"), "utf8")) as unknown;
    const server = await jsonServer(payload);
    const queries: Array<[string, string, string, number]> = [];
    const result = await describeGdc(
      { project_id: "TCGA-LUAD" },
      deps(server.port, { onQuery: (q, s, st, n = 0) => queries.push([q, s, st, n]) }),
    );
    expect(result).toEqual({
      source: "gdc",
      project_id: "TCGA-LUAD",
      name: "Lung Adenocarcinoma",
      disease_type: ["Adenomas and Adenocarcinomas"],
      primary_site: ["Lung"],
      program: "TCGA",
      case_count: 500,
      file_count: 3000,
      data_categories: [
        { category: "Transcriptome Profiling", file_count: 1500 },
        { category: "Simple Nucleotide Variation", file_count: 500 },
      ],
      experimental_strategies: ["RNA-Seq"],
      dbgap_accession: "phs000218",
      state: "open",
    });
    expect(queries).toEqual([["TCGA-LUAD", "gdc", "success", 1]]);
    expect(server.requests[0].url).toBe(
      "/projects/TCGA-LUAD?format=json&expand=summary%2Csummary.case_count%2Csummary.file_count%2Csummary.data_categories%2Csummary.experimental_strategies",
    );
  });

  it("filters data categories by the optional data_category argument", async () => {
    const payload = JSON.parse(await readFile(fixture("project_tcga_luad.json"), "utf8")) as unknown;
    const server = await jsonServer(payload);
    const result = await describeGdc(
      { project_id: "TCGA-LUAD", data_category: "Transcriptome" },
      deps(server.port),
    );
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    expect(result.data_categories).toEqual([
      { category: "Transcriptome Profiling", file_count: 1500 },
    ]);
  });

  it("returns an error for unknown projects (empty data object)", async () => {
    const server = await jsonServer({ data: {} });
    const result = await describeGdc({ project_id: "UNKNOWN-PROJ" }, deps(server.port));
    expect(result.source).toBe("gdc");
    if (!("error" in result)) throw new Error("expected an error");
    expect(result.error.toLowerCase()).toContain("not found");
  });

  it("returns an error on network failure", async () => {
    const server = await startFixtureServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not found" }));
    });
    fixtures.push(server);
    const result = await describeGdc({ project_id: "NOPE" }, deps(server.port));
    expect(result.source).toBe("gdc");
    expect("error" in result).toBe(true);
  });
});

describe("download_gdc", () => {
  async function expressionFilesPayload(md5?: string, size?: number): Promise<Record<string, unknown>> {
    const content = await readFile(fixture("gdc_expression.tsv"));
    return {
      data: {
        hits: [
          {
            file_id: "abc-123-uuid",
            file_name: "gdc_expression.tsv",
            data_type: "Gene Expression Quantification",
            data_format: "TSV",
            data_category: "Transcriptome Profiling",
            file_size: size ?? content.length,
            md5sum: md5 ?? md5Hex(content),
          },
        ],
        pagination: { total: 1 },
      },
    };
  }

  it("downloads with official md5 + size verification and writes the manifest", async () => {
    const content = await readFile(fixture("gdc_expression.tsv"));
    // Verbatim Python-test fixture shape (test_download_gdc_success), with the
    // checksum/size fields injected for the served fixture bytes.
    const payload = JSON.parse(await readFile(fixture("files_response.json"), "utf8")) as {
      data: { hits: Array<Record<string, unknown>> };
    };
    payload.data.hits[0]["file_name"] = "gdc_expression.tsv";
    payload.data.hits[0]["file_size"] = content.length;
    payload.data.hits[0]["md5sum"] = md5Hex(content);
    const server = await downloadServer(payload, { "abc-123-uuid": content });
    const result = await downloadGdc(
      { project_id: "TCGA-LUAD", data_type: "RNA-Seq" },
      deps(server.port),
    );

    expect(result.source).toBe("gdc");
    expect(result.accession).toBe("TCGA-LUAD");
    expect(result.data_type).toBe("RNA-Seq");
    expect(result.file_count).toBe(1);
    expect(result.downloaded).toBe(1);
    expect(result.local_files).toHaveLength(2);
    expect(result.format_hint).toBe("gdc_rna_seq");
    expect(result.retrieved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.error).toBeUndefined();
    expect(result.source_url).toContain("https://api.gdc.cancer.gov/files?filters=");

    // The files query mirrors the GDC filter JSON exactly.
    expect(server.requests[0].url).toContain("/files?filters=");
    const filters = decodeFilters(server.requests[0].url);
    expect(filters).toEqual({
      op: "and",
      content: [
        { op: "=", content: { field: "cases.project.project_id", value: ["TCGA-LUAD"] } },
        { op: "=", content: { field: "files.data_type", value: ["Gene Expression Quantification"] } },
      ],
    });

    // Manifest: written by the tool, listing the queried file metadata.
    const manifestPath = result.local_files?.[0];
    expect(manifestPath).toBeDefined();
    expect(path.relative(root, manifestPath ?? "").startsWith("agent_results")).toBe(true);
    const manifest = JSON.parse(await readFile(manifestPath ?? "", "utf8")) as Record<string, unknown>;
    expect(manifest["project_id"]).toBe("TCGA-LUAD");
    expect(manifest["data_type"]).toBe("RNA-Seq");
    expect(manifest["gdc_data_type"]).toBe("Gene Expression Quantification");
    expect(manifest["total_files"]).toBe(1);
    expect(manifest["returned_files"]).toBe(1);
    expect((manifest["files"] as Array<Record<string, unknown>>)[0]["file_id"]).toBe("abc-123-uuid");

    // Downloaded file content matches the fixture byte-for-byte.
    const downloaded = result.local_files?.[1];
    expect(downloaded).toBeDefined();
    expect(await readFile(downloaded ?? "")).toEqual(content);
  });

  it("fails md5 verification and reports zero downloaded files", async () => {
    const content = await readFile(fixture("gdc_expression.tsv"));
    const payload = await expressionFilesPayload("0".repeat(32));
    const server = await downloadServer(payload, { "abc-123-uuid": content });
    const result = await downloadGdc(
      { project_id: "TCGA-LUAD", data_type: "RNA-Seq" },
      deps(server.port),
    );
    expect(result.downloaded).toBe(0);
    expect(result.local_files).toHaveLength(1);
    expect(result.error).toContain("failed to download any matching GDC data files");
  });

  it("fails expected-size verification and reports zero downloaded files", async () => {
    const content = await readFile(fixture("gdc_expression.tsv"));
    const payload = await expressionFilesPayload(md5Hex(content), 1);
    const server = await downloadServer(payload, { "abc-123-uuid": content });
    const result = await downloadGdc(
      { project_id: "TCGA-LUAD", data_type: "RNA-Seq" },
      deps(server.port),
    );
    expect(result.downloaded).toBe(0);
    expect(result.error).toContain("failed to download any matching GDC data files");
  });

  it("rejects oversized downloads through the acquisition maxBytes gate", async () => {
    const content = await readFile(fixture("gdc_expression.tsv"));
    const payload = await expressionFilesPayload();
    const server = await downloadServer(payload, { "abc-123-uuid": content });
    const result = await downloadGdc(
      { project_id: "TCGA-LUAD", data_type: "RNA-Seq" },
      deps(server.port, undefined, { maxDownloadBytes: 16 }),
    );
    expect(result.downloaded).toBe(0);
    expect(result.error).toContain("failed to download any matching GDC data files");
  });

  it("reports only successfully saved files on partial failure", async () => {
    const content = await readFile(fixture("gdc_expression.tsv"));
    const payload = {
      data: {
        hits: [
          {
            file_id: "ok-file",
            file_name: "ok.tsv",
            data_type: "Gene Expression Quantification",
            data_format: "TSV",
            data_category: "Transcriptome Profiling",
            file_size: content.length,
            md5sum: md5Hex(content),
          },
          {
            file_id: "failed-file",
            file_name: "failed.tsv",
            data_type: "Gene Expression Quantification",
            data_format: "TSV",
            data_category: "Transcriptome Profiling",
            file_size: 1,
            md5sum: md5Hex(Buffer.from("x")),
          },
        ],
        pagination: { total: 2 },
      },
    };
    // The second download request returns 500 (Python ConnectionError parity).
    const server = await startFixtureServer((req, res) => {
      const url = req.url ?? "/";
      if (url.startsWith("/files")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      } else if (url.startsWith("/data/ok-file")) {
        res.writeHead(200, { "content-type": "text/tab-separated-values" });
        res.end(content);
      } else {
        res.writeHead(500, {});
        res.end("boom");
      }
    });
    fixtures.push(server);
    const result = await downloadGdc(
      { project_id: "TCGA-LUAD", data_type: "RNA-Seq" },
      deps(server.port),
    );
    expect(result.file_count).toBe(2);
    expect(result.downloaded).toBe(1);
    expect(result.local_files).toHaveLength(2);
    expect(result.error).toBeUndefined();
  });

  it("skips unsafe GDC filenames", async () => {
    const payload = {
      data: {
        hits: [
          {
            file_id: "evil",
            file_name: "../evil.tsv",
            data_type: "Gene Expression Quantification",
            data_format: "TSV",
            data_category: "Transcriptome Profiling",
            file_size: 1,
            md5sum: "0".repeat(32),
          },
        ],
        pagination: { total: 1 },
      },
    };
    const server = await downloadServer(payload, {});
    const result = await downloadGdc(
      { project_id: "TCGA-LUAD", data_type: "RNA-Seq" },
      deps(server.port),
    );
    expect(result.downloaded).toBe(0);
    expect(result.error).toContain("failed to download any matching GDC data files");
    // No data download was attempted for the unsafe filename.
    expect(server.requests.every((request) => !request.url.startsWith("/data/"))).toBe(true);
  });

  it("returns error JSON when no files match", async () => {
    const payload = JSON.parse(await readFile(fixture("empty_files_response.json"), "utf8")) as unknown;
    const server = await jsonServer(payload);
    const result = await downloadGdc(
      { project_id: "UNKNOWN", data_type: "RNA-Seq" },
      deps(server.port),
    );
    expect(result.source).toBe("gdc");
    expect(result.error).toContain("no files found for project 'UNKNOWN' with data_type 'RNA-Seq'");
    expect(result.file_count).toBe(0);
  });

  it("returns error JSON on files-query network failure", async () => {
    const server = await startFixtureServer((_req, res) => {
      res.writeHead(500, {});
      res.end("timeout");
    });
    fixtures.push(server);
    const result = await downloadGdc(
      { project_id: "TCGA-LUAD", data_type: "RNA-Seq" },
      deps(server.port),
    );
    expect(result.source).toBe("gdc");
    expect(result.error).toBeDefined();
  });

  it("appends data_category and workflow_type filters", async () => {
    const content = await readFile(fixture("gdc_expression.tsv"));
    const payload = await expressionFilesPayload();
    const server = await downloadServer(payload, { "abc-123-uuid": content });
    await downloadGdc(
      {
        project_id: "TCGA-PAAD",
        data_type: "Gene Expression Quantification",
        data_category: "Transcriptome Profiling",
        workflow_type: "STAR - Counts",
      },
      deps(server.port),
    );
    const filters = decodeFilters(server.requests[0].url);
    expect(filters).toEqual({
      op: "and",
      content: [
        { op: "=", content: { field: "cases.project.project_id", value: ["TCGA-PAAD"] } },
        { op: "=", content: { field: "files.data_type", value: ["Gene Expression Quantification"] } },
        { op: "=", content: { field: "files.data_category", value: ["Transcriptome Profiling"] } },
        { op: "=", content: { field: "files.analysis.workflow_type", value: ["STAR - Counts"] } },
      ],
    });
  });

  it("uses the widened default file budget", async () => {
    const content = await readFile(fixture("gdc_expression.tsv"));
    const hits = Array.from({ length: 7 }, (_, index) => ({
      file_id: `file-${index}`,
      file_name: `file_${index}.tsv`,
      data_type: "Gene Expression Quantification",
      data_format: "TSV",
      data_category: "Transcriptome Profiling",
      file_size: content.length,
      md5sum: md5Hex(content),
    }));
    const server = await startFixtureServer((req, res) => {
      const url = req.url ?? "/";
      if (url.startsWith("/files")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { hits, pagination: { total: 7 } } }));
      } else if (url.startsWith("/data/")) {
        res.writeHead(200, { "content-type": "text/tab-separated-values" });
        res.end(content);
      } else {
        res.writeHead(404, {});
        res.end();
      }
    });
    fixtures.push(server);
    const result = await downloadGdc(
      { project_id: "TCGA-LUAD", data_type: "RNA-Seq" },
      deps(server.port),
    );
    expect(result.file_count).toBe(7);
    expect(result.downloaded).toBe(7);
    expect(result.local_files).toHaveLength(8);
    expect(server.requests.filter((request) => request.url.startsWith("/data/"))).toHaveLength(7);
  });
});

describe("end-to-end: downloaded GDC file parses with the TS GdcExpressionAdapter", () => {
  it("matches the Python adapter golden (row count, schema, statistics)", async () => {
    const content = await readFile(fixture("gdc_expression.tsv"));
    const payload = {
      data: {
        hits: [
          {
            file_id: "abc-123-uuid",
            file_name: "gdc_expression.tsv",
            data_type: "Gene Expression Quantification",
            data_format: "TSV",
            data_category: "Transcriptome Profiling",
            file_size: content.length,
            md5sum: md5Hex(content),
          },
        ],
        pagination: { total: 1 },
      },
    };
    const server = await downloadServer(payload, { "abc-123-uuid": content });
    const result = await downloadGdc(
      { project_id: "TCGA-LUAD", data_type: "RNA-Seq" },
      deps(server.port),
    );
    const downloaded = result.local_files?.[1];
    expect(downloaded).toBeDefined();

    const bytes = await readFile(downloaded ?? "");
    const checksum = sha256Hex(bytes);
    const asset = parseSourceAsset({
      schema_version: "1.0",
      asset_id: `asset_${checksum}`,
      kind: "source",
      relative_path: path
        .relative(root, downloaded ?? "")
        .split(path.sep)
        .join("/"),
      sha256: checksum,
      size_bytes: bytes.length,
      media_type: "text/tab-separated-values",
      generated_by_step_id: null,
      source_id: "src_test",
      successful_attempt_id: "attempt_1",
      derived_from_asset_id: null,
      data_level: "repository_processed",
    });

    const outputDir = path.join(root, "adapter-out");
    const batch = await getAdapter("gdc.expression.v1").parse(asset, downloaded ?? "", {
      buildId: "build_test",
      bindingId: "binding_1",
      schemaRef: "gene_expression.long.v1",
      outputDir,
    });
    const golden = JSON.parse(await readFile(fixture("gdc_adapter.golden.json"), "utf8")) as Record<string, unknown>;
    expect(comparableBatch(batch)).toEqual(golden);
  });
});

function decodeFilters(requestUrl: string): unknown {
  const url = new URL(`http://fixture.invalid${requestUrl}`);
  return JSON.parse(url.searchParams.get("filters") ?? "") as unknown;
}

function comparableBatch(batch: {
  batch_id: string;
  binding_id: string;
  dataset_family: string;
  row_granularity: string;
  schema_ref: string;
  row_count: number;
  column_count: number;
  parser_id: string;
  parser_version: string;
  statistics: Record<string, unknown>;
  warnings: string[];
  declared_mappings: unknown[];
  file_asset: { kind: string; media_type: string; generated_by_step_id: string | null } | null;
}): Record<string, unknown> {
  return {
    batch_id: batch.batch_id,
    binding_id: batch.binding_id,
    dataset_family: batch.dataset_family,
    row_granularity: batch.row_granularity,
    schema_ref: batch.schema_ref,
    row_count: batch.row_count,
    column_count: batch.column_count,
    parser_id: batch.parser_id,
    parser_version: batch.parser_version,
    statistics: batch.statistics,
    warnings: batch.warnings,
    declared_mappings: batch.declared_mappings,
    file_asset_kind: batch.file_asset?.kind ?? null,
    file_asset_media_type: batch.file_asset?.media_type ?? null,
    file_asset_generated_by: batch.file_asset?.generated_by_step_id ?? null,
  };
}
