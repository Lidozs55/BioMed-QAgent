/**
 * P5-04 GEO agent tool parity (mirrors
 * ``backend/tests/integration/test_ncbi_skill_adapters.py`` GEO parts):
 * search/describe/list/download flows through the fixture HTTP server, the
 * metadata-only matrix fail-fast, bounded listing retries, and platform
 * annotation acquisition.  Tool names must match SKILL_TOOL_MAP.
 */

import { gzipSync, gunzipSync } from "node:zlib";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { PublicHttpClient } from "../../src/external/network/index.js";
import { ContentCache } from "../../src/external/acquisition/index.js";
import {
  SKILL_TOOL_NAMES,
  toolOwner,
} from "../../src/agent/skills/skill-tool-map.js";
import {
  createGeoTools,
  httpsFtpRoot,
  matrixHasDataTable,
  type GeoToolsOptions,
} from "../../src/agent/tools/geo.js";
import type { BioMedAgentTool } from "../../src/agent/contracts.js";
import {
  fakeResolver,
  localExecutor,
  PUBLIC_IP,
  startFixtureServer,
  type FixtureHandler,
  type FixtureServer,
} from "./helpers.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/geo", import.meta.url));
const EUTILS_HOST = "eutils.ncbi.nlm.nih.gov";
const FTP_HOST = "ftp.ncbi.nlm.nih.gov";

function fixture(name: string): Promise<Buffer> {
  return readFile(path.join(FIXTURES, name));
}

interface CapturedProgress {
  stage: string;
  kind: string;
  payload: Record<string, unknown>;
}

function toolOptions(overrides: {
  port: number;
  taskRoot: string;
  queries?: Array<{ query: string; source: string; status: string; count: number }>;
  progress?: CapturedProgress[];
  sleeps?: number[];
}): GeoToolsOptions {
  return {
    taskRoot: overrides.taskRoot,
    cache: new ContentCache(path.join(overrides.taskRoot, "cache")),
    client: new PublicHttpClient({
      resolve: fakeResolver({
        [EUTILS_HOST]: [PUBLIC_IP],
        [FTP_HOST]: [PUBLIC_IP],
      }),
      executor: localExecutor(overrides.port),
    }),
    eutils: {
      email: "biomed-qagent@example.com",
      tool: "BioMedQAgent",
      userAgent: "BioMedQAgent/1.0",
    },
    sleep: (ms) => {
      overrides.sleeps?.push(ms);
      return Promise.resolve();
    },
    hooks: {
      onQuery: (query, source, status, count) => {
        overrides.queries?.push({ query, source, status, count: count ?? 0 });
      },
      onProgress: (stage, kind, payload) => {
        overrides.progress?.push({ stage, kind, payload });
      },
    },
  };
}

function tools(overrides: Parameters<typeof toolOptions>[0]): BioMedAgentTool[] {
  return createGeoTools(toolOptions(overrides));
}

/** Standard fixture routing for the GSE178352 flow. */
function gseHandler(overrides: {
  matrixBody?: Buffer;
  supplListing?: Buffer;
  supplBody?: Buffer;
} = {}): FixtureHandler {
  return async (req, res) => {
    const url = req.url ?? "";
    if (url.startsWith("/entrez/eutils/esearch.fcgi")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(await fixture("geo_esearch.json"));
      return;
    }
    if (url.startsWith("/entrez/eutils/esummary.fcgi")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(await fixture("geo_esummary.json"));
      return;
    }
    if (url.includes("/GSE178352_series_matrix.txt.gz")) {
      res.writeHead(200, { "content-type": "application/x-gzip" });
      res.end(overrides.matrixBody ?? (await fixture("geo_series_matrix.txt.gz")));
      return;
    }
    if (url.includes("/GSE178352_family.soft.gz")) {
      res.writeHead(200, { "content-type": "application/x-gzip" });
      res.end(await fixture("gse178352_family.soft.gz"));
      return;
    }
    if (url.includes("/GSE178352_tximportCounts.txt.gz")) {
      res.writeHead(200, { "content-type": "application/gzip" });
      res.end(overrides.supplBody ?? (await fixture("geo_series_matrix.txt.gz")));
      return;
    }
    if (url.endsWith("/GSE178352/suppl/")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(overrides.supplListing ?? (await fixture("geo_suppl_listing.html")));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  };
}

describe("GEO tool registration parity", () => {
  test("all five tool names belong to the geo skill in SKILL_TOOL_MAP", () => {
    const names = [
      "search_geo",
      "describe_geo",
      "list_geo_supplementary_files",
      "download_geo",
      "download_geo_platform_annotation",
    ];
    for (const name of names) {
      expect(SKILL_TOOL_NAMES.has(name)).toBe(true);
      expect(toolOwner(name)).toBe("geo");
    }
  });

  test("createGeoTools returns the five curated tools with unique names", () => {
    const created = createGeoTools(
      toolOptions({
        port: 1,
        taskRoot: path.join(os.tmpdir(), "unused"),
      }),
    );
    expect(created.map((tool) => tool.name).sort()).toEqual(
      [
        "search_geo",
        "describe_geo",
        "list_geo_supplementary_files",
        "download_geo",
        "download_geo_platform_annotation",
      ].sort(),
    );
  });
});

describe("search_geo", () => {
  const fixtures: FixtureServer[] = [];
  let root: string;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `p5-geo-tools-${Math.random().toString(36).slice(2)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((item) => item.close()));
    await rm(root, { recursive: true, force: true });
  });

  test("returns typed GSE records with platform_count and pubmed_id", async () => {
    const fixture = await startFixtureServer(gseHandler());
    fixtures.push(fixture);
    const queries: Array<{ query: string; source: string; status: string; count: number }> = [];
    const progress: CapturedProgress[] = [];
    const [search] = tools({ port: fixture.port, taskRoot: root, queries, progress });
    const result = await search.execute({ query: "GSE178352[Accession]" });
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(payload.source).toBe("geo");
    expect(payload.term).toBe("GSE178352[Accession]");
    expect(payload.query_translation).toBe("GSE178352[Accession]");
    expect(payload.total_count).toBe(14);
    expect(payload.accessions).toEqual(["GSE178352"]);
    const records = payload.records as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(records[0].platform_count).toBe(1);
    expect(records[0].pubmed_id).toBe("34180400");
    expect(records[0].uid).toBe("200178352");
    // Numeric UIDs never leak into accessions.
    expect(payload.accessions).not.toContain("200178352");
    expect(queries).toEqual([
      { query: "GSE178352[Accession]", source: "geo", status: "success", count: 1 },
    ]);
    expect(progress).toEqual([
      {
        stage: "discovery",
        kind: "discovered_records",
        payload: {
          current: 1,
          total: 14,
          source: "geo",
          term: "GSE178352[Accession]",
        },
      },
    ]);
  });

  test("legacy term alias works and query wins", async () => {
    const fixture = await startFixtureServer(gseHandler());
    fixtures.push(fixture);
    const [search] = tools({ port: fixture.port, taskRoot: root });
    const viaTerm = JSON.parse(
      (await search.execute({ term: "term query" })).content,
    ) as Record<string, unknown>;
    expect(viaTerm.term).toBe("term query");
    const queryWins = JSON.parse(
      (await search.execute({ query: "query value", term: "ignored" })).content,
    ) as Record<string, unknown>;
    expect(queryWins.term).toBe("query value");
  });

  test("empty query and term return the stable error", async () => {
    const [search] = tools({ port: 1, taskRoot: root });
    const result = await search.execute({});
    expect(JSON.parse(result.content)).toEqual({
      source: "geo",
      error: "either 'query' or 'term' must be provided",
    });
  });
});

describe("describe_geo", () => {
  const fixtures: FixtureServer[] = [];
  let root: string;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `p5-geo-tools-${Math.random().toString(36).slice(2)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((item) => item.close()));
    await rm(root, { recursive: true, force: true });
  });

  test("never fabricates fields NCBI esummary does not return", async () => {
    const fixture = await startFixtureServer(gseHandler());
    fixtures.push(fixture);
    const [, describe] = tools({ port: fixture.port, taskRoot: root });
    const result = await describe.execute({ accession: "gse178352" });
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(payload.source).toBe("geo");
    expect(payload.accession).toBe("GSE178352");
    expect(payload.sample_count).toBe(12);
    expect(payload.platform_ids).toEqual(["GPL24676"]);
    expect(payload.platform_count).toBe(1);
    expect(payload.supplementary_file_listing_url).toBe(
      "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/GSE178352/suppl/",
    );
    expect(payload.note).toContain("esummary");
    expect(payload).not.toHaveProperty("platforms");
    expect(payload).not.toHaveProperty("overall_design");
    expect(payload).not.toHaveProperty("supplementary_file_urls");
  });

  test("propagates errors as structured payloads", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    fixtures.push(fixture);
    const [, describe] = tools({ port: fixture.port, taskRoot: root });
    const result = await describe.execute({ accession: "GSE178352" });
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(payload.source).toBe("geo");
    expect(payload.accession).toBe("GSE178352");
    expect(payload.error).toBeDefined();
  });
});

describe("list_geo_supplementary_files", () => {
  const fixtures: FixtureServer[] = [];
  let root: string;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `p5-geo-tools-${Math.random().toString(36).slice(2)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((item) => item.close()));
    await rm(root, { recursive: true, force: true });
  });

  test("parses the suppl listing into typed file entries", async () => {
    const fixture = await startFixtureServer(gseHandler());
    fixtures.push(fixture);
    const [, , list] = tools({ port: fixture.port, taskRoot: root });
    const result = await list.execute({ accession: "GSE178352" });
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(payload.source).toBe("geo");
    expect(payload.accession).toBe("GSE178352");
    expect(payload.supplementary_file_count).toBe(1);
    expect(payload.listing_url).toBe(
      "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/GSE178352/suppl/",
    );
    const files = payload.supplementary_files as Array<Record<string, unknown>>;
    expect(files).toHaveLength(1);
    expect(files[0].filename).toBe("GSE178352_tximportCounts.txt.gz");
    expect(files[0].media_type).toBe("application/gzip");
    expect(files[0].data_level).toBe("repository_processed");
    expect(String(files[0].url).endsWith("/GSE178352_tximportCounts.txt.gz")).toBe(
      true,
    );
  });

  test("listing 429/5xx retry is bounded and honors Retry-After", async () => {
    let listingCalls = 0;
    const sleeps: number[] = [];
    const server = await startFixtureServer(async (req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/entrez/eutils/esearch.fcgi")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(await fixture("geo_esearch.json"));
        return;
      }
      if (url.startsWith("/entrez/eutils/esummary.fcgi")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(await fixture("geo_esummary.json"));
        return;
      }
      listingCalls += 1;
      if (listingCalls === 1) {
        res.writeHead(429, { "retry-after": "2" });
        res.end();
        return;
      }
      if (listingCalls === 2) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await fixture("geo_suppl_listing.html"));
    });
    fixtures.push(server);
    const [, , list] = tools({ port: server.port, taskRoot: root, sleeps });
    const result = await list.execute({ accession: "GSE178352" });
    expect(JSON.parse(result.content).supplementary_file_count).toBe(1);
    expect(listingCalls).toBe(3);
    // The first sleep is the E-utilities rate limiter pacing; the listing
    // retries are the last two (Retry-After 2s, then exponential 0.5s).
    expect(sleeps.slice(-2)).toEqual([2000, 500]);
  });
});

describe("download_geo", () => {
  const fixtures: FixtureServer[] = [];
  let root: string;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `p5-geo-tools-${Math.random().toString(36).slice(2)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((item) => item.close()));
    await rm(root, { recursive: true, force: true });
  });

  test("suppl download returns a compressed repository-processed asset", async () => {
    const compressed = Buffer.from("gzip bytes stay compressed");
    const fixture = await startFixtureServer(
      gseHandler({ supplBody: compressed }),
    );
    fixtures.push(fixture);
    const progress: CapturedProgress[] = [];
    const [, , , download] = tools({ port: fixture.port, taskRoot: root, progress });
    const result = await download.execute({
      accession: "GSE178352",
      file_type: "suppl",
      max_size_mb: 1,
    });
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(payload.source).toBe("geo");
    expect(payload.accession).toBe("GSE178352");
    expect(payload.format_hint).toBe("suppl");
    const asset = payload.asset as Record<string, unknown>;
    expect(asset.data_level).toBe("repository_processed");
    expect(asset.relative_path).toContain("GSE178352_tximportCounts.txt.gz");
    const localFiles = payload.local_files as string[];
    expect(localFiles).toHaveLength(1);
    const downloaded = await readFile(localFiles[0]);
    expect(downloaded).toEqual(compressed);
    // acquireSource now emits the live throttled tick plus the unified
    // terminal tick (no Content-Length → live total is null; final total is
    // the verified size) — the old tool-level onProgress emitted only one.
    expect(progress).toEqual([
      {
        stage: "acquisition",
        kind: "downloaded_bytes",
        payload: {
          current: compressed.length,
          total: null,
          source: "geo",
          accession: "GSE178352",
          filename: "GSE178352_tximportCounts.txt.gz",
          records: 1,
        },
      },
      {
        stage: "acquisition",
        kind: "downloaded_bytes",
        payload: {
          current: compressed.length,
          total: compressed.length,
          source: "geo",
          accession: "GSE178352",
          filename: "GSE178352_tximportCounts.txt.gz",
          records: 1,
        },
      },
    ]);
  });

  test("matrix download succeeds when an expression table is present", async () => {
    const fixture = await startFixtureServer(gseHandler());
    fixtures.push(fixture);
    const [, , , download] = tools({ port: fixture.port, taskRoot: root });
    const result = await download.execute({
      accession: "GSE178352",
      file_type: "matrix",
      max_size_mb: 1,
    });
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(payload.error).toBeUndefined();
    expect(payload.format_hint).toBe("matrix");
    expect(payload.source_url).toContain("/GSE178352_series_matrix.txt.gz");
  });

  test("metadata-only series matrix fails fast with empty_series_matrix", async () => {
    const metadataOnly = await fixture("geo_metadata_only_matrix.txt.gz");
    const server = await startFixtureServer(gseHandler({ matrixBody: metadataOnly }));
    fixtures.push(server);
    const [, , , download] = tools({ port: server.port, taskRoot: root });
    const result = await download.execute({
      accession: "GSE178352",
      file_type: "matrix",
      max_size_mb: 1,
    });
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(payload.reason_code).toBe("empty_series_matrix");
    expect(String(payload.error)).toContain("suppl");
    expect(payload).not.toHaveProperty("asset");
    expect(payload).not.toHaveProperty("local_files");
  });

  test("unsupported file_type lists the valid values", async () => {
    const fixture = await startFixtureServer(gseHandler());
    fixtures.push(fixture);
    const [, , , download] = tools({ port: fixture.port, taskRoot: root });
    const result = await download.execute({
      accession: "GSE178352",
      file_type: "series_matrix",
    });
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(String(payload.error)).toContain("unsupported file_type");
    expect(String(payload.error)).toContain("matrix, soft, suppl");
  });

  test("multi-file suppl requires an explicit filename and lists candidates", async () => {
    const multiListing = Buffer.from(
      '<a href="GSE178352_one.txt.gz">one</a>\n' +
        '<a href="GSE178352_two.txt.gz">two</a>\n',
      "utf8",
    );
    const fixture = await startFixtureServer(gseHandler({ supplListing: multiListing }));
    fixtures.push(fixture);
    const [, , , download] = tools({ port: fixture.port, taskRoot: root });
    const ambiguous = JSON.parse(
      (await download.execute({ accession: "GSE178352", file_type: "suppl" }))
        .content,
    ) as Record<string, unknown>;
    expect(String(ambiguous.error)).toContain(
      "multiple supplementary files found; specify filename",
    );
    expect(String(ambiguous.error)).toContain("GSE178352_one.txt.gz");
    expect(String(ambiguous.error)).toContain("GSE178352_two.txt.gz");

    const missing = JSON.parse(
      (
        await download.execute({
          accession: "GSE178352",
          file_type: "suppl",
          filename: "GSE178352_nope.txt.gz",
        })
      ).content,
    ) as Record<string, unknown>;
    expect(String(missing.error)).toContain(
      "no matching GEO supplementary file found for filename=",
    );
    expect(String(missing.error)).toContain("GSE178352_one.txt.gz");
  });

  test("explicit suppl filename resolves and downloads", async () => {
    const multiListing = Buffer.from(
      '<a href="GSE178352_one.txt.gz">one</a>\n' +
        '<a href="GSE178352_two.txt.gz">two</a>\n',
      "utf8",
    );
    const compressed = gzipSync(Buffer.from("payload", "utf8"));
    const esearch = await fixture("geo_esearch.json");
    const esummary = await fixture("geo_esummary.json");
    const server = await startFixtureServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/entrez/eutils/esearch.fcgi")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(esearch);
        return;
      }
      if (url.startsWith("/entrez/eutils/esummary.fcgi")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(esummary);
        return;
      }
      if (url.endsWith("/GSE178352/suppl/")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(multiListing);
        return;
      }
      if (url.endsWith("/GSE178352_two.txt.gz")) {
        res.writeHead(200, { "content-type": "application/gzip" });
        res.end(compressed);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    fixtures.push(server);
    const [, , , download] = tools({ port: server.port, taskRoot: root });
    const result = await download.execute({
      accession: "GSE178352",
      file_type: "suppl",
      filename: "GSE178352_two.txt.gz",
    });
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(payload.error).toBeUndefined();
    expect(String(payload.source_url).endsWith("/GSE178352_two.txt.gz")).toBe(true);
    const localFiles = payload.local_files as string[];
    expect(await readFile(localFiles[0])).toEqual(compressed);
  });

  test("soft download streams the family SOFT asset", async () => {
    const server = await startFixtureServer(gseHandler());
    fixtures.push(server);
    const familySoft = await fixture("gse178352_family.soft.gz");
    const [, , , download] = tools({ port: server.port, taskRoot: root });
    const result = await download.execute({
      accession: "GSE178352",
      file_type: "soft",
    });
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(payload.error).toBeUndefined();
    expect(payload.format_hint).toBe("soft");
    expect(String(payload.source_url).endsWith("/GSE178352_family.soft.gz")).toBe(
      true,
    );
    const localFiles = payload.local_files as string[];
    expect(await readFile(localFiles[0])).toEqual(familySoft);
  });

  test("explicit size cap rejects an oversized declared download", async () => {
    const esearch = await fixture("geo_esearch.json");
    const esummary = await fixture("geo_esummary.json");
    const server = await startFixtureServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/entrez/eutils/esearch.fcgi")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(esearch);
        return;
      }
      if (url.startsWith("/entrez/eutils/esummary.fcgi")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(esummary);
        return;
      }
      if (url.includes("_series_matrix.txt.gz")) {
        res.writeHead(200, { "content-type": "application/x-gzip", "content-length": "112099269" });
        res.end("tiny body");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    fixtures.push(server);
    const [, , , download] = tools({ port: server.port, taskRoot: root });
    const result = await download.execute({
      accession: "GSE178352",
      file_type: "matrix",
      max_size_mb: 100,
    });
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    const attempt = payload.attempt as Record<string, unknown>;
    expect(attempt.status).toBe("failed");
    expect(attempt.error_code).toBe("download_incomplete");
    expect(payload.error).toBe("declared content length exceeds maximum");
  });

  test("matrix_has_data_table positive, negative and truncated", async () => {
    const withTable = path.join(root, "with_table.txt.gz");
    await writeFile(
      withTable,
      gzipSync(
        Buffer.from(
          '!Series_title = "x"\n!series_matrix_table_begin\n"ID_REF"\t"GSM1"\n',
        ),
      ),
    );
    const metadataOnly = path.join(root, "meta_only.txt.gz");
    await writeFile(
      metadataOnly,
      gzipSync(
        Buffer.from('!Series_title = "x"\n!Sample_data_row_count = 0\n'),
      ),
    );
    expect(matrixHasDataTable(withTable)).toBe(true);
    expect(matrixHasDataTable(metadataOnly)).toBe(false);
    const raw = await readFile(withTable);
    const truncated = path.join(root, "truncated.txt.gz");
    await writeFile(truncated, raw.subarray(0, raw.length / 2));
    expect(matrixHasDataTable(truncated)).toBe(false);
  });
});

describe("download_geo_platform_annotation", () => {
  const fixtures: FixtureServer[] = [];
  let root: string;

  beforeEach(async () => {
    root = path.join(os.tmpdir(), `p5-geo-tools-${Math.random().toString(36).slice(2)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((item) => item.close()));
    await rm(root, { recursive: true, force: true });
  });

  test("locates the annot layout and returns the asset", async () => {
    const compressed = gzipSync(Buffer.from("gzip platform table bytes"));
    const server = await startFixtureServer((req, res) => {
      const url = req.url ?? "";
      if (url.endsWith("/GPL570/annot/")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<a href="GPL570.annot.gz">GPL570.annot.gz</a>');
        return;
      }
      if (url.endsWith("/annot/GPL570.annot.gz")) {
        res.writeHead(200, { "content-type": "application/gzip" });
        res.end(compressed);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    fixtures.push(server);
    const [, , , , annotation] = tools({ port: server.port, taskRoot: root });
    const result = await annotation.execute({ gpl: "GPL570", max_size_mb: 1 });
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(payload.platform).toBe("GPL570");
    expect(payload.format_hint).toBe("platform_annotation");
    const asset = payload.asset as Record<string, unknown>;
    expect(asset.data_level).toBe("repository_processed");
    const localFiles = payload.local_files as string[];
    expect(localFiles).toHaveLength(1);
    expect(localFiles[0].endsWith("GPL570.annot.gz")).toBe(true);
    expect(await readFile(localFiles[0])).toEqual(compressed);
  });

  test("rejects an invalid gpl before any network work", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    fixtures.push(fixture);
    const [, , , , annotation] = tools({ port: fixture.port, taskRoot: root });
    const result = await annotation.execute({ gpl: "not-a-gpl" });
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(String(payload.error)).toContain("must match");
    expect(fixture.requests).toHaveLength(0);
  });

  test("no downloadable annotation table fails cleanly", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<a href="other.txt">other</a>');
    });
    fixtures.push(fixture);
    const [, , , , annotation] = tools({ port: fixture.port, taskRoot: root });
    const result = await annotation.execute({ gpl: "GPL19072" });
    const payload = JSON.parse(result.content) as Record<string, unknown>;
    expect(payload.platform).toBe("GPL19072");
    expect(String(payload.error)).toContain("no downloadable annotation table");
  });
});

describe("https_ftp_root parity", () => {
  test("converts ftp roots and builds uppercase-prefixed fallbacks", () => {
    expect(
      httpsFtpRoot(
        "ftp://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/GSE178352/",
        "GSE178352",
      ),
    ).toBe("https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/GSE178352/");
    expect(httpsFtpRoot("", "gse178352")).toBe(
      "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE178nnn/gse178352/",
    );
    expect(httpsFtpRoot("https://x/", "GSE1")).toBe("https://x/");
  });
});

describe("acquired GEO matrix fixture content", () => {
  test("the standard matrix fixture gunzips to a series-matrix table", async () => {
    const compressed = await fixture("geo_series_matrix.txt.gz");
    const text = gunzipSync(compressed).toString("utf8");
    expect(text).toContain("!series_matrix_table_begin");
    expect(text).toContain("ENSG00000141510");
  });
});
