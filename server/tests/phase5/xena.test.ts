/**
 * Phase 5 checkpoint P5-05: Xena tools parity tests (Python
 * ``backend/tests/test_skill_xena.py`` mirror) + end-to-end contract against
 * the TS XenaMatrixAdapter (goldens generated from the Python adapters).
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ContentCache, CURATED_SOURCE_HOSTS } from "../../src/external/acquisition/index.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import {
  DOWNLOAD_XENA_TOOL_NAME,
  SEARCH_XENA_TOOL_NAME,
  createDownloadXenaTool,
  createSearchXenaTool,
  createXenaTools,
  downloadXena,
  searchXena,
  type XenaToolDeps,
} from "../../src/agent/tools/xena.js";
import { XENA_QUERY_BODY, XENA_QUERY_URL } from "../../src/external/xena/index.js";
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

const XENA_QUERY_HOST = "toil.xenahubs.net";
const XENA_S3_HOST = "toil-xena-hub.s3.us-east-1.amazonaws.com";
const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): string {
  return path.join(FIXTURES, "xena", name);
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

let root: string;
const fixtures: FixtureServer[] = [];

beforeEach(async () => {
  root = path.join(os.tmpdir(), `p5-xena-${Math.random().toString(36).slice(2)}`);
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((server) => server.close()));
  await rm(root, { recursive: true, force: true });
});

function client(port: number): PublicHttpClient {
  return new PublicHttpClient({
    resolve: fakeResolver({
      [XENA_QUERY_HOST]: [PUBLIC_IP],
      [XENA_S3_HOST]: [PUBLIC_IP],
    }),
    executor: localExecutor(port),
  });
}

function deps(port: number, hooks?: XenaToolDeps["hooks"], overrides: Partial<XenaToolDeps> = {}): XenaToolDeps {
  return {
    taskRoot: root,
    client: client(port),
    cache: new ContentCache(path.join(root, "cache")),
    rateLimitMs: 0,
    hooks,
    ...overrides,
  };
}

describe("xena tool registration (SKILL_TOOL_MAP contract)", () => {
  it("registers search/download under the xena skill", () => {
    expect(SKILL_TOOL_NAMES.has(SEARCH_XENA_TOOL_NAME)).toBe(true);
    expect(SKILL_TOOL_NAMES.has(DOWNLOAD_XENA_TOOL_NAME)).toBe(true);
    expect(toolOwner(SEARCH_XENA_TOOL_NAME)).toBe("xena");
    expect(toolOwner(DOWNLOAD_XENA_TOOL_NAME)).toBe("xena");
  });

  it("exposes the stable parameter schemas", () => {
    const tools = createXenaTools(deps(0));
    expect(tools.map((tool) => tool.name)).toEqual(["search_xena", "download_xena"]);
    const search = createSearchXenaTool(deps(0));
    expect(search.parameters).toEqual({
      type: "object",
      properties: expect.objectContaining({
        query: { type: "string", description: expect.any(String) },
        max_results: { type: "integer", description: expect.any(String), default: 20 },
        term: { type: "string", description: expect.any(String) },
      }),
      additionalProperties: false,
    });
    const download = createDownloadXenaTool(deps(0));
    expect(download.parameters).toEqual({
      type: "object",
      properties: expect.objectContaining({
        dataset_id: { type: "string", description: expect.any(String) },
        file_type: { type: "string", description: expect.any(String), default: "tsv" },
        cohort: { type: "string", description: expect.any(String) },
      }),
      required: ["dataset_id"],
      additionalProperties: false,
    });
  });

  it("executes through the BioMedAgentTool interface", async () => {
    const server = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    });
    fixtures.push(server);
    const tool = createSearchXenaTool(deps(server.port));
    const result = await tool.execute({ query: "BRCA" });
    const data = JSON.parse(result.content) as Record<string, unknown>;
    expect(result.isError).toBeUndefined();
    expect(data["source"]).toBe("xena");
    expect(data["count"]).toBe(0);
  });
});

describe("search_xena (official hub query API)", () => {
  async function queryServer(status = 200, body?: string): Promise<FixtureServer> {
    const content = body ?? (await readFile(fixture("hub_query.json"), "utf8"));
    const server = await startFixtureServer((req, res) => {
      if (req.method === "POST" && (req.url ?? "/").startsWith("/data/")) {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(content);
        return;
      }
      res.writeHead(404, {});
      res.end("not found");
    });
    fixtures.push(server);
    return server;
  }

  it("fetches the official query API and maps types/cohorts", async () => {
    const server = await queryServer();
    const queries: Array<[string, string, string, number]> = [];
    const result = await searchXena(
      { term: "BRCA", max_results: 10 },
      deps(server.port, { onQuery: (q, s, st, n = 0) => queries.push([q, s, st, n]) }),
    );

    expect(result.source).toBe("xena");
    expect(result.term).toBe("BRCA");
    // BRCA cohort datasets: HiSeqV2, clinical, mutation_broad.
    expect(result.count).toBe(3);
    expect(result.records.map((record) => record.dataset_id)).toEqual([
      "TCGA.BRCA.sampleMap/HiSeqV2",
      "TCGA.BRCA.sampleMap/clinical",
      "TCGA.BRCA.sampleMap/mutation_broad",
    ]);
    const hiSeq = result.records[0];
    expect(hiSeq.type).toBe("gene_expression"); // genomicMatrix mapping
    expect(hiSeq.cohort).toBe("TCGA.BRCA");
    expect(hiSeq.size_bytes).toBe(0); // query API does not carry sizes
    expect(hiSeq.last_modified).toBe("");
    expect(result.records[1].type).toBe("clinical"); // clinicalMatrix mapping
    expect(result.records[2].type).toBe("mutation"); // sparseMatrix mapping
    expect(queries).toEqual([["BRCA", "xena", "success", 3]]);
  });

  it("sends the official POST body and headers", async () => {
    const server = await queryServer();
    await searchXena({ term: "BRCA" }, deps(server.port));
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].method).toBe("POST");
    expect(server.requests[0].url).toBe("/data/");
    expect(server.requests[0].body).toBe(XENA_QUERY_BODY);
    expect(server.requests[0].headers["content-type"]).toBe("text/plain");
    expect(server.requests[0].headers["accept"]).toBe("application/json");
    expect(server.requests[0].headers["user-agent"]).toContain("Mozilla/5.0");
  });

  it("accepts query as the recommended parameter and prefers it over term", async () => {
    const server = await queryServer();
    const viaQuery = await searchXena({ query: "BRCA", max_results: 10 }, deps(server.port));
    expect(viaQuery.term).toBe("BRCA");
    expect(viaQuery.count).toBe(3);

    const both = await searchXena({ query: "BRCA", term: "LUAD" }, deps(server.port));
    expect(both.term).toBe("BRCA");
    expect(both.count).toBe(3);
  });

  it("returns all datasets for an empty term", async () => {
    const server = await queryServer();
    const result = await searchXena({ term: "", max_results: 50 }, deps(server.port));
    expect(result.count).toBe(5);
    expect(result.records).toHaveLength(5);
  });

  it("caps records at max_results", async () => {
    const server = await queryServer();
    const result = await searchXena({ term: "", max_results: 2 }, deps(server.port));
    expect(result.count).toBe(5);
    expect(result.records).toHaveLength(2);
  });

  it("maps the probeMap official type", async () => {
    const server = await queryServer();
    const result = await searchXena({ term: "hugo_gencode" }, deps(server.port));
    expect(result.records).toHaveLength(1);
    expect(result.records[0].type).toBe("probe_map");
    expect(result.records[0].dataset_id).toBe("probeMap/hugo_gencode_good_hg19_V24lift37");
  });

  it("returns empty records for a non-matching term (never fakes success)", async () => {
    const server = await queryServer();
    const result = await searchXena({ term: "zzz-no-match" }, deps(server.port));
    expect(result.count).toBe(0);
    expect(result.records).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it("falls back to the S3 listing when the query API fails", async () => {
    const xml = await readFile(fixture("s3_listing.xml"), "utf8");
    const server = await startFixtureServer((req, res) => {
      const url = req.url ?? "/";
      if (req.method === "POST" && url.startsWith("/data/")) {
        res.writeHead(500, {});
        res.end("query down");
        return;
      }
      if (req.method === "GET" && url.startsWith("/?")) {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(xml);
        return;
      }
      res.writeHead(404, {});
      res.end("not found");
    });
    fixtures.push(server);

    const result = await searchXena({ term: "HiSeq" }, deps(server.port));
    expect(result.count).toBe(1);
    const record = result.records[0];
    expect(record.dataset_id).toBe("TCGA.BRCA.sampleMap/HiSeqV2");
    expect(record.type).toBe("gene_expression");
    expect(record.cohort).toBe("TCGA.BRCA");
    expect(record.size_bytes).toBe(50000);
    expect(record.last_modified).toBe("2024-01-01");

    expect(server.requests).toHaveLength(2);
    expect(server.requests[0].method).toBe("POST");
    expect(server.requests[1].method).toBe("GET");
    expect(server.requests[1].url).toBe("/?list-type=2&prefix=download%2F&max-keys=1000");
  });

  it("returns error JSON when both the query API and the S3 listing fail", async () => {
    const server = await startFixtureServer((_req, res) => {
      res.writeHead(500, {});
      res.end("down");
    });
    fixtures.push(server);
    const queries: Array<[string, string, string, number]> = [];
    const result = await searchXena(
      { term: "mutation" },
      deps(server.port, { onQuery: (q, s, st, n = 0) => queries.push([q, s, st, n]) }),
    );
    expect(result.source).toBe("xena");
    expect(result.term).toBe("mutation");
    expect(result.count).toBe(0);
    expect(result.records).toEqual([]);
    expect(result.error).toBeDefined();
    expect(queries).toEqual([["mutation", "xena", "failed", 0]]);
  });
});

describe("download_xena", () => {
  async function matrixBytes(): Promise<Buffer> {
    return readFile(fixture("xena_matrix.tsv"));
  }

  async function gzServer(content: Buffer, status = 200): Promise<FixtureServer> {
    const server = await startFixtureServer((req, res) => {
      if ((req.url ?? "/").startsWith("/download/")) {
        res.writeHead(status, { "content-type": "application/gzip" });
        res.end(content);
        return;
      }
      res.writeHead(404, {});
      res.end("not found");
    });
    fixtures.push(server);
    return server;
  }

  it("downloads, decompresses and reports both files", async () => {
    const raw = await matrixBytes();
    const gz = gzipSync(raw);
    const server = await gzServer(gz);

    const result = await downloadXena(
      { dataset_id: "TCGA.BRCA.sampleMap/HiSeqV2", file_type: "tsv" },
      deps(server.port),
    );
    expect(result.source).toBe("xena");
    expect(result.dataset_id).toBe("TCGA.BRCA.sampleMap/HiSeqV2");
    expect(result.cohort).toBeUndefined();
    expect(result.source_url).toBe(
      "https://toil-xena-hub.s3.us-east-1.amazonaws.com/download/TCGA.BRCA.sampleMap/HiSeqV2.gz",
    );
    expect(result.local_files).toHaveLength(2);
    expect(result.format_hint).toBe("xena_tsv");
    expect(result.retrieved_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.error).toBeUndefined();

    // local_files[0] is the published .gz asset, [1] the decompressed file.
    expect(await readFile(result.local_files?.[0] ?? "")).toEqual(gz);
    expect(await readFile(result.local_files?.[1] ?? "")).toEqual(raw);
    expect((result.local_files?.[0] ?? "").endsWith(".gz")).toBe(true);

    // The download request targeted the curated S3 host with the canonical .gz name
    // (the host allowlist itself is asserted in the policy test below; the local
    // test executor rewrites the Host header to reach the fixture server).
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0].url).toBe("/download/TCGA.BRCA.sampleMap/HiSeqV2.gz");
  });

  it("never builds a .tsv.gz URL (the historical 403 bug)", async () => {
    const raw = await matrixBytes();
    const server = await gzServer(gzipSync(raw));
    const result = await downloadXena(
      { dataset_id: "TCGA.BRCA.sampleMap/HiSeqV2", file_type: "tsv" },
      deps(server.port),
    );
    expect(result.source_url.endsWith(".gz")).toBe(true);
    expect(result.source_url.includes(".tsv.gz")).toBe(false);
    expect(server.requests[0].url).toBe("/download/TCGA.BRCA.sampleMap/HiSeqV2.gz");
  });

  it("decodes %2F in dataset_id and normalizes the file_type hint", async () => {
    const raw = await matrixBytes();
    const server = await gzServer(gzipSync(raw));
    const result = await downloadXena(
      { dataset_id: "probeMap%2Fhugo_gencode_good_hg19_V24lift37", file_type: ".TSV" },
      deps(server.port),
    );
    expect(result.source_url).toBe(
      "https://toil-xena-hub.s3.us-east-1.amazonaws.com/download/probeMap/hugo_gencode_good_hg19_V24lift37.gz",
    );
    expect(result.source_url.includes("%2F")).toBe(false);
    expect(result.format_hint).toBe("xena_tsv");
  });

  it("echoes the optional cohort label", async () => {
    const raw = await matrixBytes();
    const server = await gzServer(gzipSync(raw));
    const result = await downloadXena(
      { dataset_id: "TCGA.PAAD.sampleMap/HiSeqV2", cohort: "TCGA Pancreatic Cancer (PAAD)" },
      deps(server.port),
    );
    expect(result.cohort).toBe("TCGA Pancreatic Cancer (PAAD)");
    expect(result.local_files).toHaveLength(2);
  });

  it("returns an error on HTTP failure", async () => {
    const server = await gzServer(Buffer.from("x"), 403);
    const result = await downloadXena(
      { dataset_id: "TCGA.BRCA.sampleMap/HiSeqV2", file_type: "tsv" },
      deps(server.port),
    );
    expect(result.source).toBe("xena");
    expect(result.error).toContain("download failed");
    expect(result.local_files).toBeUndefined();
  });

  it("returns an error when decompression fails", async () => {
    const server = await gzServer(Buffer.from("definitely not gzip"));
    const result = await downloadXena(
      { dataset_id: "TCGA.BRCA.sampleMap/HiSeqV2", file_type: "tsv" },
      deps(server.port),
    );
    expect(result.error).toContain("decompression failed");
    expect(result.local_files).toHaveLength(1);
  });

  it("enforces the curated S3 host policy through acquireSource", () => {
    // The download host is fixed to the S3 hub; acquireSource's default
    // allowlist is the single gate (download_xena passes no override).
    expect(CURATED_SOURCE_HOSTS.has(XENA_S3_HOST)).toBe(true);
    expect(XENA_QUERY_URL).toBe("https://toil.xenahubs.net/data/");
  });

  it("rejects oversized downloads through the acquisition maxBytes gate", async () => {
    const raw = await matrixBytes();
    const server = await gzServer(gzipSync(raw));
    const result = await downloadXena(
      { dataset_id: "TCGA.BRCA.sampleMap/HiSeqV2", file_type: "tsv" },
      deps(server.port, undefined, { maxDownloadBytes: 16 }),
    );
    expect(result.error).toContain("download failed");
  });
});

describe("end-to-end: downloaded Xena file parses with the TS XenaMatrixAdapter", () => {
  it("matches the Python adapter golden (row count, schema, statistics)", async () => {
    const raw = await readFile(fixture("xena_matrix.tsv"));
    const gz = gzipSync(raw);
    const server = await startFixtureServer((req, res) => {
      if ((req.url ?? "/").startsWith("/download/")) {
        res.writeHead(200, { "content-type": "application/gzip" });
        res.end(gz);
        return;
      }
      res.writeHead(404, {});
      res.end();
    });
    fixtures.push(server);

    const result = await downloadXena(
      { dataset_id: "TCGA.BRCA.sampleMap/HiSeqV2", file_type: "tsv" },
      deps(server.port),
    );
    const decompressed = result.local_files?.[1];
    expect(decompressed).toBeDefined();
    expect(await readFile(decompressed ?? "")).toEqual(raw);

    const bytes = await readFile(decompressed ?? "");
    const checksum = sha256Hex(bytes);
    const asset = parseSourceAsset({
      schema_version: "1.0",
      asset_id: `asset_${checksum}`,
      kind: "source",
      relative_path: path
        .relative(root, decompressed ?? "")
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
    const batch = getAdapter("xena.matrix.v1").parse(asset, decompressed ?? "", {
      buildId: "build_test",
      bindingId: "binding_1",
      schemaRef: "gene_expression.long.v1",
      outputDir,
    });
    const golden = JSON.parse(await readFile(fixture("xena_adapter.golden.json"), "utf8")) as Record<string, unknown>;
    expect(comparableBatch(batch)).toEqual(golden);
  });
});

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
