/**
 * P5-03 NCBI + PubMed tests: eutils client (rate limit, Retry-After/backoff,
 * timeout), parsers (esearch/PubMed record golden parity), query
 * simplification, search/discovery orchestration, the 3-tier supplementary
 * fallback chain, and SKILL_TOOL_MAP tool registration.
 *
 * Golden record fixture (fixtures/pubmed/pubmed_records.golden.json) is
 * generated from the Python implementation over the real efetch XML fixture
 * (backend/tests/fixtures/ncbi/gse178352/pubmed_34180400.xml); the Python
 * ``parse_pubmed_xml`` returns pydantic models that are not directly JSON
 * serializable, so the golden captures the exact wire record mapping of
 * ``skills/builtin/discovery/pubmed.py`` (title/abstract/authors "; "-joined/
 * journal/pub_date/doi/pmid/pmcid/is_open_access/source_url).
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RUNTIME_LIMITS } from "@biomed/contracts";

import { createPubmedTools, downloadSupplementaryAdapter, searchPubmedAdapter } from "../../src/agent/tools/pubmed.js";
import { SKILL_TOOL_NAMES, toolOwner } from "../../src/agent/skills/skill-tool-map.js";
import { ContentCache } from "../../src/external/acquisition/content-cache.js";
import {
  NcbiEutilsClient,
  NcbiRequestError,
  type NcbiClientConfig,
} from "../../src/external/ncbi/client.js";
import {
  searchPubmed,
  type NcbiDiscoveryClient,
} from "../../src/external/ncbi/discovery.js";
import {
  extractArticleIdentifiers,
  parseNcbiEsearch,
  parsePubmedXml,
} from "../../src/external/ncbi/parsers.js";
import { simplifyNcbiQuery } from "../../src/external/ncbi/query-utils.js";
import { HostRateLimiter, parseRetryAfter } from "../../src/external/ncbi/retry.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import {
  EuropePmcError,
  fetchFullTextXml,
  fetchFullTextXmlUrl,
} from "../../src/external/publication/europe-pmc.js";
import {
  PublicationFallbackError,
  acquirePublicationWithFallback,
  makeSourceId,
} from "../../src/external/publication/publication-fallback.js";
import {
  UnpaywallError,
  lookupPdfUrl,
} from "../../src/external/publication/unpaywall.js";
import type { SourceRecord } from "../../src/dataset/contracts/source.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";

const PY_FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../tests/fixtures/ncbi/gse178352",
);
const TS_FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const EU_HOST = "eutils.ncbi.nlm.nih.gov";
const UNPAYWALL_HOST = "api.unpaywall.org";
const EPMC_HOST = "www.ebi.ac.uk";
const NCBI_WWW_HOST = "www.ncbi.nlm.nih.gov";

function pyFixture(name: string): Promise<Buffer> {
  return readFile(path.join(PY_FIXTURES, name));
}

async function golden(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(TS_FIXTURES, "pubmed", name), "utf8")) as unknown;
}

function fixtureHttpClient(port: number): PublicHttpClient {
  return new PublicHttpClient({
    resolve: fakeResolver({
      [EU_HOST]: [PUBLIC_IP],
      [UNPAYWALL_HOST]: [PUBLIC_IP],
      [EPMC_HOST]: [PUBLIC_IP],
      [NCBI_WWW_HOST]: [PUBLIC_IP],
    }),
    executor: localExecutor(port),
  });
}

function testConfig(overrides: Partial<NcbiClientConfig> = {}): NcbiClientConfig {
  return {
    email: "developer@example.com",
    tool: "BioMedQAgent",
    userAgent: "BioMed-QAgent/0.1 (developer@example.com)",
    apiKey: "secret-key",
    ...overrides,
  };
}

function immediateLimiter(): HostRateLimiter {
  return new HostRateLimiter({ minInterval: 0 });
}

let root: string;
const fixtures: FixtureServer[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "p5-pubmed-"));
});

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parsers: esearch
// ---------------------------------------------------------------------------

describe("parseNcbiEsearch", () => {
  it("parses the real esearch fixture (count/ids/querytranslation)", async () => {
    expect(parseNcbiEsearch(await pyFixture("pubmed_esearch.json"))).toEqual({
      count: 1,
      retmax: 1,
      retstart: 0,
      ids: ["34180400"],
      query_translation: "34180400[UID]",
    });
  });

  it("parses an empty result page", () => {
    const page = parseNcbiEsearch(
      Buffer.from(
        JSON.stringify({
          esearchresult: {
            count: "0",
            retmax: "0",
            retstart: "0",
            idlist: [],
            querytranslation: "none",
          },
        }),
      ),
    );
    expect(page).toEqual({ count: 0, retmax: 0, retstart: 0, ids: [], query_translation: "none" });
  });

  it("rejects malformed JSON and non-numeric UIDs (Python pydantic parity)", () => {
    expect(() => parseNcbiEsearch(Buffer.from("{not json"))).toThrow(/invalid NCBI esearch JSON/);
    expect(() =>
      parseNcbiEsearch(
        Buffer.from(JSON.stringify({ esearchresult: { idlist: ["abc"] } })),
      ),
    ).toThrow("NCBI search IDs must be numeric UIDs");
    expect(() => parseNcbiEsearch(Buffer.from("{}"))).toThrow(/missing esearchresult/);
  });
});

// ---------------------------------------------------------------------------
// parsers: PubMed efetch XML
// ---------------------------------------------------------------------------

describe("parsePubmedXml", () => {
  it("matches the Python-generated golden record JSON (wire record shape)", async () => {
    const records = parsePubmedXml(await pyFixture("pubmed_34180400.xml"));
    expect(records).toEqual(await golden("pubmed_records.golden.json"));
  });

  it("preserves primary article metadata (Python test parity)", async () => {
    const records = parsePubmedXml(await pyFixture("pubmed_34180400.xml"));
    expect(records).toHaveLength(1);
    const record = records[0] as (typeof records)[number];
    expect(record.pmid).toBe("34180400");
    expect(record.pmcid).toBe("PMC8275131");
    expect(record.doi).toBe("10.7554/eLife.64977");
    expect(record.title).toBe(
      "Unique integrated stress response sensors regulate cancer cell susceptibility when Hsp70 activity is compromised.",
    );
    expect(record.authors).toBe(
      "Sara Sannino; Megan E Yates; Mark E Schurdak; Steffi Oesterreich; Adrian V Lee; Peter Wipf; Jeffrey L Brodsky",
    );
    expect(record.authors.split("; ")).toHaveLength(7);
    expect(record.journal).toBe("eLife");
    expect(record.pub_date).toBe("2021-06-28");
    expect(record.abstract).toContain("Molecular chaperones");
    expect(record.is_open_access).toBe(true);
    expect(record.source_url).toBe("https://pubmed.ncbi.nlm.nih.gov/34180400/");
    expect(Object.keys(record).sort()).toEqual([
      "abstract", "authors", "doi", "is_open_access", "journal",
      "pmcid", "pmid", "pub_date", "source_url", "title",
    ]);
  });

  it("falls back to ArticleDate and skips unknown dates (Python parity)", () => {
    const records = parsePubmedXml(
      Buffer.from(
        "<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>1</PMID><Article>" +
          "<ArticleTitle>T</ArticleTitle><ArticleDate><Year>2020</Year>" +
          "<Month>Aug</Month><Day>9</Day></ArticleDate>" +
          "</Article></MedlineCitation></PubmedArticle></PubmedArticleSet>",
      ),
    );
    expect(records[0]?.pub_date).toBe("2020-08-09");

    const noDate = parsePubmedXml(
      Buffer.from(
        "<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>2</PMID><Article>" +
          "<ArticleTitle>T</ArticleTitle><ArticleDate><Year>2020</Year></ArticleDate>" +
          "</Article></MedlineCitation></PubmedArticle></PubmedArticleSet>",
      ),
    );
    expect(noDate[0]?.pub_date).toBe("");
    expect(noDate[0]?.is_open_access).toBe(false);
    expect(noDate[0]?.pmcid).toBe("");
    expect(noDate[0]?.doi).toBe("");
  });

  it("throws on malformed XML (Python ET.fromstring parity)", () => {
    expect(() => parsePubmedXml(Buffer.from("<PubmedArticleSet><PubmedArticle>"))).toThrow();
  });

  it("skips articles without an Article block (Python parity)", () => {
    const records = parsePubmedXml(
      Buffer.from(
        "<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>1</PMID>" +
          "</MedlineCitation></PubmedArticle>" +
          "<PubmedArticle><MedlineCitation><PMID>2</PMID><Article>" +
          "<ArticleTitle>Kept</ArticleTitle></Article></MedlineCitation>" +
          "</PubmedArticle></PubmedArticleSet>",
      ),
    );
    expect(records.map((record) => record.pmid)).toEqual(["2"]);
  });
});

describe("extractArticleIdentifiers", () => {
  it("extracts the first pmc and doi ArticleIds in document order", async () => {
    expect(extractArticleIdentifiers(await pyFixture("pubmed_34180400.xml"))).toEqual({
      pmcid: "PMC8275131",
      doi: "10.7554/eLife.64977",
    });
  });

  it("returns empty strings when the ids are absent", () => {
    expect(
      extractArticleIdentifiers(
        Buffer.from(
          "<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>1</PMID>" +
            "<Article><ArticleTitle>T</ArticleTitle></Article></MedlineCitation>" +
            "<PubmedData><ArticleIdList><ArticleId IdType=\"pubmed\">1</ArticleId>" +
            "</ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>",
        ),
      ),
    ).toEqual({ pmcid: "", doi: "" });
  });
});

// ---------------------------------------------------------------------------
// query-utils
// ---------------------------------------------------------------------------

describe("simplifyNcbiQuery", () => {
  it("converts natural-language topics into structured queries (Python-pinned cases)", () => {
    expect(simplifyNcbiQuery("METTL5 expression in pancreatic cancer tumor vs normal tissue")).toBe(
      "(METTL5) AND pancreatic cancer",
    );
    expect(simplifyNcbiQuery("METTL5 expression in pancreatic cancer")).toBe(
      "(METTL5) AND pancreatic cancer",
    );
    expect(simplifyNcbiQuery("TP53 and BRCA1 mutations in breast cancer")).toBe(
      "(TP53 OR BRCA1) AND mutations breast cancer",
    );
    expect(simplifyNcbiQuery("METTL5")).toBe("METTL5");
    expect(simplifyNcbiQuery("METTL5 vs control")).toBe("METTL5");
    expect(simplifyNcbiQuery("vs control group")).toBe("");
    expect(simplifyNcbiQuery("tumor tissue samples")).toBe("");
  });

  it("returns the original query when no gene/disease pattern is detected", () => {
    expect(simplifyNcbiQuery("breast cancer")).toBe("breast cancer");
    expect(simplifyNcbiQuery("a b c d e f")).toBe("a b c d e f");
    expect(simplifyNcbiQuery("a b c d e f g")).toBe("a b c d e f g");
    expect(simplifyNcbiQuery("KRAS G12D colorectal cancer cells")).toBe(
      "KRAS G12D colorectal cancer cells",
    );
  });
});

// ---------------------------------------------------------------------------
// retry helpers
// ---------------------------------------------------------------------------

describe("HostRateLimiter / parseRetryAfter", () => {
  it("spaces same-host requests by minInterval (3 req/s policy)", async () => {
    let now = 0;
    const delays: number[] = [];
    const limiter = new HostRateLimiter({
      minInterval: 1 / 3,
      now: () => now,
      sleep: async (delayMs) => {
        delays.push(delayMs);
        now += delayMs;
      },
    });
    const url = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
    await limiter.wait(url);
    await limiter.wait(url);
    await limiter.wait(url);
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeCloseTo(1000 / 3, 5);
    expect(delays[1]).toBeCloseTo(1000 / 3, 5);
  });

  it("parses Retry-After seconds and HTTP dates (Python parity)", () => {
    const nowMs = Date.parse("2026-07-12T08:00:00Z");
    expect(parseRetryAfter("2", nowMs)).toBe(2);
    expect(parseRetryAfter("Sun, 12 Jul 2026 08:00:03 GMT", nowMs)).toBeCloseTo(3, 5);
    expect(parseRetryAfter("invalid", nowMs)).toBe(0);
    expect(parseRetryAfter(undefined, nowMs)).toBe(0);
    expect(parseRetryAfter("-4", nowMs)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// eutils client
// ---------------------------------------------------------------------------

describe("NcbiEutilsClient", () => {
  it("sends NCBI identity + query parameters with the configured User-Agent", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    fixtures.push(fixture);
    const http = fixtureHttpClient(fixture.port);
    const client = new NcbiEutilsClient({
      http,
      config: testConfig(),
      limiter: immediateLimiter(),
    });
    expect(await client.esearch({ db: "pubmed", term: "breast cancer", retmax: 20 })).toEqual(
      Buffer.from("{}"),
    );

    const request = fixture.requests[0];
    expect(request).toBeDefined();
    const url = new URL(request?.url ?? "", "http://fixture");
    expect(url.pathname).toBe("/entrez/eutils/esearch.fcgi");
    expect(url.searchParams.get("db")).toBe("pubmed");
    expect(url.searchParams.get("term")).toBe("breast cancer");
    expect(url.searchParams.get("retmax")).toBe("20");
    expect(url.searchParams.get("retmode")).toBe("json");
    expect(url.searchParams.get("tool")).toBe("BioMedQAgent");
    expect(url.searchParams.get("email")).toBe("developer@example.com");
    expect(url.searchParams.get("api_key")).toBe("secret-key");
    expect(request?.headers["user-agent"]).toBe("BioMed-QAgent/0.1 (developer@example.com)");
  });

  it("preserves explicit id order in esummary/efetch", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("response");
    });
    fixtures.push(fixture);
    const client = new NcbiEutilsClient({
      http: fixtureHttpClient(fixture.port),
      config: testConfig(),
      limiter: immediateLimiter(),
    });
    await client.esummary({ db: "gds", ids: ["3", "1", "2"] });
    await client.efetch({ db: "pubmed", ids: ["9", "8"], retmode: "xml" });

    const first = new URL(fixture.requests[0]?.url ?? "", "http://fixture");
    const second = new URL(fixture.requests[1]?.url ?? "", "http://fixture");
    expect(first.searchParams.get("id")).toBe("3,1,2");
    expect(first.searchParams.get("retmode")).toBe("json");
    expect(second.searchParams.get("id")).toBe("9,8");
    expect(second.searchParams.get("retmode")).toBe("xml");
  });

  it("retries 429 with Retry-After then returns the response", async () => {
    const statuses = [429, 200];
    const fixture = await startFixtureServer((_req, res) => {
      const status = statuses.shift() ?? 500;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (status === 429) headers["Retry-After"] = "0";
      res.writeHead(status, headers);
      res.end("ok");
    });
    fixtures.push(fixture);
    const delays: number[] = [];
    const client = new NcbiEutilsClient({
      http: fixtureHttpClient(fixture.port),
      config: testConfig({ maxRetries: 3 }),
      limiter: immediateLimiter(),
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      jitter: () => 0,
    });
    const result = await client.esearch({ db: "pubmed", term: "test", retmax: 1 });
    expect(result.toString()).toBe("ok");
    expect(delays).toEqual([500]);
    expect(fixture.requests).toHaveLength(2);
  });

  it("retries 5xx and gives up after max_retries (bounded exponential backoff)", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("busy");
    });
    fixtures.push(fixture);
    const delays: number[] = [];
    const client = new NcbiEutilsClient({
      http: fixtureHttpClient(fixture.port),
      config: testConfig({ maxRetries: 3 }),
      limiter: immediateLimiter(),
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      jitter: () => 0,
    });
    await expect(client.esearch({ db: "pubmed", term: "test", retmax: 1 })).rejects.toMatchObject({
      statusCode: 503,
      retryable: true,
    });
    expect(fixture.requests).toHaveLength(4);
    expect(delays).toEqual([500, 1000, 2000]);
  });

  it("does not retry a non-retryable 400", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad request");
    });
    fixtures.push(fixture);
    const client = new NcbiEutilsClient({
      http: fixtureHttpClient(fixture.port),
      config: testConfig(),
      limiter: immediateLimiter(),
    });
    await expect(client.esearch({ db: "pubmed", term: "bad", retmax: 1 })).rejects.toMatchObject({
      statusCode: 400,
      retryable: false,
      message: expect.stringContaining("bad request"),
    });
    expect(fixture.requests).toHaveLength(1);
  });

  it("raises the total-timeout error when the server never responds", async () => {
    const fixture = await startFixtureServer(() => {
      // Hold the connection; the client's total timeout must abort the request.
    });
    fixtures.push(fixture);
    const client = new NcbiEutilsClient({
      http: fixtureHttpClient(fixture.port),
      config: testConfig({ maxRetries: 0, totalTimeoutMs: 200 }),
      limiter: immediateLimiter(),
    });
    await expect(client.esearch({ db: "pubmed", term: "test", retmax: 1 })).rejects.toMatchObject({
      message: "NCBI request exceeded total timeout",
      statusCode: null,
      retryable: true,
    });
  });
});

// ---------------------------------------------------------------------------
// discovery orchestration
// ---------------------------------------------------------------------------

describe("searchPubmed (discovery)", () => {
  it("returns records in esearch order and batches ids by 200", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const ids = Array.from({ length: 201 }, (_value, index) => String(index + 1));
    const searchPayload = Buffer.from(
      JSON.stringify({
        esearchresult: {
          count: String(ids.length),
          retmax: String(ids.length),
          retstart: "0",
          idlist: ids,
          querytranslation: "batch test",
        },
      }),
    );
    const client: NcbiDiscoveryClient = {
      async esearch(options) {
        calls.push(["esearch", { ...options }]);
        return searchPayload;
      },
      async esummary(options) {
        calls.push(["esummary", { ...options }]);
        return Buffer.from("{}");
      },
      async efetch(options) {
        calls.push(["efetch", { ...options }]);
        const articles = options.ids
          .map(
            (pmid) =>
              `<PubmedArticle><MedlineCitation><PMID>${pmid}</PMID>` +
              `<Article><ArticleTitle>Title ${pmid}</ArticleTitle></Article>` +
              `</MedlineCitation></PubmedArticle>`,
          )
          .join("");
        return Buffer.from(`<PubmedArticleSet>${articles}</PubmedArticleSet>`);
      },
    };
    const result = await searchPubmed(client, "batch", 201);
    expect(result.records.map((record) => record.pmid)).toEqual(ids);
    const fetchCalls = calls.filter(([name]) => name === "efetch");
    expect(fetchCalls.map(([, options]) => (options.ids as string[]).length)).toEqual([200, 1]);
  });

  it("does not call efetch for an empty result", async () => {
    const calls: string[] = [];
    const client: NcbiDiscoveryClient = {
      async esearch() {
        calls.push("esearch");
        return Buffer.from(
          JSON.stringify({
            esearchresult: {
              count: "0",
              retmax: "0",
              retstart: "0",
              idlist: [],
              querytranslation: "none",
            },
          }),
        );
      },
      async esummary() {
        throw new Error("esummary must not be called");
      },
      async efetch() {
        throw new Error("efetch must not be called");
      },
    };
    const result = await searchPubmed(client, "no result", 5);
    expect(result.records).toEqual([]);
    expect(calls).toEqual(["esearch"]);
  });
});

// ---------------------------------------------------------------------------
// search_pubmed adapter (tool payload)
// ---------------------------------------------------------------------------

describe("searchPubmedAdapter", () => {
  function fixtureServicesWithEutils(eutils: NcbiDiscoveryClient): {
    eutils: NcbiDiscoveryClient;
    http: PublicHttpClient;
    cache: ContentCache;
    taskRoot: string;
  } {
    return {
      eutils,
      http: new PublicHttpClient(),
      cache: new ContentCache(path.join(root, "cache")),
      taskRoot: root,
    };
  }

  it("produces the stable wire payload with summary and usage_hint", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const eutils: NcbiDiscoveryClient = {
      async esearch(options) {
        calls.push(["esearch", { ...options }]);
        return await pyFixture("pubmed_esearch.json");
      },
      async esummary() {
        throw new Error("unused");
      },
      async efetch(options) {
        calls.push(["efetch", { ...options }]);
        return await pyFixture("pubmed_34180400.xml");
      },
    };
    const hookCalls: Array<[string, string, string, number]> = [];
    const payload = (await searchPubmedAdapter("Hsp70 breast cancer", 20, {
      ...fixtureServicesWithEutils(eutils),
      hooks: { onQuery: (query, source, status, count) => hookCalls.push([query, source, status, count ?? 0]) },
    })) as {
      summary: string;
      source: string;
      query: string;
      query_translation: string;
      total_count: number;
      records_count: number;
      records: Array<{ pmid: string }>;
      usage_hint: string;
    };
    expect(payload.source).toBe("pubmed");
    expect(payload.query).toBe("Hsp70 breast cancer");
    expect(payload.query_translation).toBe("34180400[UID]");
    expect(payload.total_count).toBe(1);
    expect(payload.records_count).toBe(1);
    expect(payload.records[0]?.pmid).toBe("34180400");
    expect(payload.summary).toBe("找到 1 篇相关文献（共 1 篇匹配）\n前 1 篇标题：\n1. Unique integrated stress response sensors regulate cancer cell susceptibility when Hsp70 activity is compromised.");
    expect(payload.usage_hint).toContain("analyze_papers");
    expect(calls).toEqual([
      ["esearch", { db: "pubmed", term: "Hsp70 breast cancer", retmax: 20 }],
      ["efetch", { db: "pubmed", ids: ["34180400"], retmode: "xml" }],
    ]);
    expect(hookCalls).toEqual([["Hsp70 breast cancer", "pubmed", "success", 1]]);
  });

  it("logs failed QueryStatus and rethrows (Python adapter parity)", async () => {
    const eutils: NcbiDiscoveryClient = {
      async esearch() {
        throw new NcbiRequestError("NCBI request failed: ConnectError: down", {
          statusCode: null,
          retryable: true,
        });
      },
      async esummary() {
        throw new Error("unused");
      },
      async efetch() {
        throw new Error("unused");
      },
    };
    const hookCalls: Array<[string, string, string, number]> = [];
    await expect(
      searchPubmedAdapter("anything", 5, {
        ...fixtureServicesWithEutils(eutils),
        hooks: { onQuery: (query, source, status, count) => hookCalls.push([query, source, status, count ?? 0]) },
      }),
    ).rejects.toMatchObject({ retryable: true });
    expect(hookCalls).toEqual([["anything", "pubmed", "failed", 0]]);
  });

  it("auto-falls back to simplify_ncbi_query for long NL queries with 0 hits", async () => {
    const rawQuery =
      "METTL5 expression in pancreatic cancer tumor vs normal tissue samples across cohorts";
    const simplifiedQuery = "(METTL5) AND pancreatic cancer";
    const terms: string[] = [];
    const eutils: NcbiDiscoveryClient = {
      async esearch(options) {
        terms.push(options.term);
        if (options.term === simplifiedQuery) {
          return Buffer.from(
            JSON.stringify({
              esearchresult: {
                count: "1",
                retmax: "1",
                retstart: "0",
                idlist: ["34180400"],
                querytranslation: "34180400[UID]",
              },
            }),
          );
        }
        return Buffer.from(
          JSON.stringify({
            esearchresult: {
              count: "0",
              retmax: "0",
              retstart: "0",
              idlist: [],
              querytranslation: "none",
            },
          }),
        );
      },
      async esummary() {
        throw new Error("unused");
      },
      async efetch() {
        return await pyFixture("pubmed_34180400.xml");
      },
    };
    const hookCalls: Array<[string, string, string, number]> = [];
    const payload = (await searchPubmedAdapter(rawQuery, 20, {
      ...fixtureServicesWithEutils(eutils),
      hooks: { onQuery: (query, source, status, count) => hookCalls.push([query, source, status, count ?? 0]) },
    })) as { query: string; records_count: number };
    expect(terms).toEqual([rawQuery, simplifiedQuery]);
    expect(payload.query).toBe(simplifiedQuery);
    expect(payload.records_count).toBe(1);
    expect(hookCalls).toEqual([[rawQuery, "pubmed", "success", 1]]);
  });

  it("does not fall back for short queries", async () => {
    const terms: string[] = [];
    const eutils: NcbiDiscoveryClient = {
      async esearch(options) {
        terms.push(options.term);
        return Buffer.from(
          JSON.stringify({
            esearchresult: {
              count: "0",
              retmax: "0",
              retstart: "0",
              idlist: [],
              querytranslation: "none",
            },
          }),
        );
      },
      async esummary() {
        throw new Error("unused");
      },
      async efetch() {
        throw new Error("efetch must not be called");
      },
    };
    const payload = (await searchPubmedAdapter("no result", 5, fixtureServicesWithEutils(eutils))) as {
      summary: string;
      records_count: number;
    };
    expect(terms).toEqual(["no result"]);
    expect(payload.records_count).toBe(0);
    expect(payload.summary).toBe("找到 0 篇相关文献（共 0 篇匹配）");
  });
});

// ---------------------------------------------------------------------------
// unpaywall + europe-pmc clients
// ---------------------------------------------------------------------------

describe("lookupPdfUrl (Unpaywall)", () => {
  it("resolves a DOI to the best OA pdf_url and strips DOI prefixes", async () => {
    const fixture = await startFixtureServer((req, res) => {
      expect(req.url).toContain("/v2/10.1234/test");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          is_oa: true,
          best_oa_location: { url_for_pdf: "https://www.ncbi.nlm.nih.gov/pub/pmc/PMC1.pdf" },
        }),
      );
    });
    fixtures.push(fixture);
    const client = fixtureHttpClient(fixture.port);
    expect(await lookupPdfUrl("https://doi.org/10.1234/test", { client })).toBe(
      "https://www.ncbi.nlm.nih.gov/pub/pmc/PMC1.pdf",
    );
  });

  it("raises Python-parity errors for 404 / no-OA / landing-only / non-HTTPS / non-JSON", async () => {
    const fixture = await startFixtureServer((req, res) => {
      const url = req.url ?? "";
      if (url.includes("10.999/nonjson")) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>upstream error page</html>");
        return;
      }
      const body: Record<string, unknown> = { is_oa: false };
      if (url.includes("10.999/landing")) {
        body["is_oa"] = true;
        body["best_oa_location"] = { url: "https://example.com/landing" };
      }
      if (url.includes("10.999/plain-http")) {
        body["is_oa"] = true;
        body["best_oa_location"] = { url_for_pdf: "http://insecure.example.com/a.pdf" };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    fixtures.push(fixture);
    const client = fixtureHttpClient(fixture.port);
    await expect(lookupPdfUrl("10.404/missing", { client })).rejects.toThrow(
      UnpaywallError,
    );
    await expect(lookupPdfUrl("10.999/not-oa", { client })).rejects.toThrow(
      "DOI 10.999/not-oa has no open-access version",
    );
    await expect(lookupPdfUrl("10.999/landing", { client })).rejects.toThrow(
      "DOI 10.999/landing has OA landing page but no direct PDF URL; landing=https://example.com/landing",
    );
    await expect(lookupPdfUrl("10.999/plain-http", { client })).rejects.toThrow(
      "Unpaywall returned non-HTTPS PDF URL (rejected): http://insecure.example.com/a.pdf",
    );
    await expect(lookupPdfUrl("10.999/nonjson", { client })).rejects.toThrow(
      /Unpaywall returned non-JSON response/,
    );
    await expect(lookupPdfUrl("", { client })).rejects.toThrow("empty DOI after normalization");
  });

  it("reports 404 with the DOI not found message", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
    fixtures.push(fixture);
    await expect(lookupPdfUrl("10.404/missing", { client: fixtureHttpClient(fixture.port) })).rejects.toThrow(
      "DOI not found in Unpaywall: 10.404/missing",
    );
  });
});

describe("fetchFullTextXml (Europe PMC)", () => {
  const XML = "<?xml version=\"1.0\"?><article><body>test full text</body></article>";

  function epmcClient(port: number): PublicHttpClient {
    return fixtureHttpClient(port);
  }

  it("fetches fullTextXML and normalizes the PMCID", async () => {
    const fixture = await startFixtureServer((req, res) => {
      expect(req.url).toBe("/europepmc/webservices/rest/PMC7450705/fullTextXML");
      expect(req.headers["user-agent"]).toContain("Mozilla/5.0");
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(XML);
    });
    fixtures.push(fixture);
    expect(await fetchFullTextXml("pmc7450705", { client: epmcClient(fixture.port) })).toEqual(
      Buffer.from(XML),
    );
    expect(fetchFullTextXmlUrl("PMC7450705")).toBe(
      "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC7450705/fullTextXML",
    );
    expect(() => fetchFullTextXmlUrl("pmc12ab")).toThrow(EuropePmcError);
  });

  it("raises Python-parity errors for 404 / 5xx / empty / non-XML bodies", async () => {
    const fixture = await startFixtureServer((req, res) => {
      const url = req.url ?? "";
      if (url.includes("PMC404")) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      if (url.includes("PMC500")) {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("boom");
        return;
      }
      if (url.includes("PMC777")) {
        res.writeHead(200, { "content-type": "application/xml", "content-length": "0" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/xml" });
      res.end("this is not xml at all");
    });
    fixtures.push(fixture);
    const client = epmcClient(fixture.port);
    await expect(fetchFullTextXml("PMC404", { client })).rejects.toThrow(
      "PMCID PMC404 not found in Europe PMC (not OA or does not exist)",
    );
    await expect(fetchFullTextXml("PMC500", { client })).rejects.toThrow(
      "EPMC returned HTTP 500 for PMC500",
    );
    await expect(fetchFullTextXml("PMC777", { client })).rejects.toThrow(
      "EPMC returned empty body for PMC777",
    );
    await expect(fetchFullTextXml("PMC999", { client })).rejects.toThrow(
      /EPMC returned non-XML body for PMC999 \(first 80 bytes: b'this is not xml/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3-tier publication fallback
// ---------------------------------------------------------------------------

const PDF_BYTES = Buffer.from("%PDF-1.5\n%test PDF content for fallback chain\n%%EOF");
const EPMC_XML = Buffer.from('<?xml version="1.0"?><article><body>test full text</body></article>');
const PMC_URL = "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8275131/";
const PDF_URL = "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8275131/pdf/main.pdf";

function fallbackSource(url = PMC_URL): SourceRecord {
  return {
    schema_version: "1.0",
    source_id: makeSourceId("pubmed", "34180400", url),
    database: "pubmed",
    accession: "34180400",
    url,
    title: "Test publication",
    retrieved_at: "2026-07-18T00:00:00Z",
  };
}

describe("acquirePublicationWithFallback", () => {
  it("tier 1: downloads a direct PDF URL without calling Unpaywall", async () => {
    const fixture = await startFixtureServer((req, res) => {
      if ((req.url ?? "").includes("/pdf/main.pdf")) {
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-length": String(PDF_BYTES.length),
        });
        res.end(PDF_BYTES);
        return;
      }
      res.writeHead(500);
      res.end("unexpected request");
    });
    fixtures.push(fixture);
    let lookupCalls = 0;
    const outcome = await acquirePublicationWithFallback({
      source: fallbackSource(PDF_URL),
      filename: "PMC8275131.pdf",
      workdirRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: fixtureHttpClient(fixture.port),
      dataLevel: "metadata",
      maxBytes: 10 * 1024 * 1024,
      doi: "10.7554/eLife.64977",
      pmcid: "PMC8275131",
      lookupPdf: async () => {
        lookupCalls += 1;
        throw new Error("lookup must not be called");
      },
    });
    expect(lookupCalls).toBe(0);
    expect(outcome.result.asset?.media_type).toBe("application/pdf");
    expect(outcome.result.asset?.size_bytes).toBe(PDF_BYTES.length);
    expect(outcome.result.asset?.relative_path.endsWith("PMC8275131.pdf")).toBe(true);
    expect(outcome.tierFailures).toEqual([]);
    expect(await readFile(path.join(root, outcome.result.asset?.relative_path ?? ""))).toEqual(
      PDF_BYTES,
    );
  });

  it("tier 2: resolves via Unpaywall when the source URL is a landing page", async () => {
    const fixture = await startFixtureServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/v2/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            is_oa: true,
            best_oa_location: { url_for_pdf: "https://api.unpaywall.org/pdf/10.7554/eLife.64977.pdf" },
          }),
        );
        return;
      }
      if (url.startsWith("/pdf/")) {
        res.writeHead(200, {
          "content-type": "application/pdf",
          "content-length": String(PDF_BYTES.length),
        });
        res.end(PDF_BYTES);
        return;
      }
      res.writeHead(500);
      res.end("unexpected request");
    });
    fixtures.push(fixture);
    const outcome = await acquirePublicationWithFallback({
      source: fallbackSource(),
      filename: "PMC8275131.pdf",
      workdirRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: fixtureHttpClient(fixture.port),
      dataLevel: "metadata",
      maxBytes: 10 * 1024 * 1024,
      doi: "10.7554/eLife.64977",
      pmcid: "PMC8275131",
    });
    expect(outcome.result.attempt.url).toBe("https://api.unpaywall.org/pdf/10.7554/eLife.64977.pdf");
    expect(outcome.result.asset?.media_type).toBe("application/pdf");
    expect(outcome.tierFailures).toEqual(["tier1_direct: skipped (source.url not a direct PDF link)"]);
  });

  it("tier 3: falls through to Europe PMC fullTextXML as an .xml asset", async () => {
    const fixture = await startFixtureServer((req, res) => {
      const url = req.url ?? "";
      if (url.startsWith("/v2/")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (url.includes("/fullTextXML")) {
        res.writeHead(200, {
          "content-type": "text/xml",
          "content-length": String(EPMC_XML.length),
        });
        res.end(EPMC_XML);
        return;
      }
      res.writeHead(500);
      res.end("unexpected request");
    });
    fixtures.push(fixture);
    const outcome = await acquirePublicationWithFallback({
      source: fallbackSource(),
      filename: "PMC8275131.pdf",
      workdirRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: fixtureHttpClient(fixture.port),
      dataLevel: "metadata",
      maxBytes: 10 * 1024 * 1024,
      doi: "10.7554/eLife.64977",
      pmcid: "PMC8275131",
    });
    expect(outcome.result.asset?.media_type).toBe("text/xml");
    expect(outcome.result.asset?.relative_path.endsWith("PMC8275131.xml")).toBe(true);
    expect(outcome.result.attempt.url).toContain("/europepmc/webservices/rest/PMC8275131/fullTextXML");
    expect(outcome.result.asset?.sha256).toBe(createHash("sha256").update(EPMC_XML).digest("hex"));
    expect(outcome.tierFailures).toEqual([
      "tier1_direct: skipped (source.url not a direct PDF link)",
      "tier2_unpaywall_lookup: DOI not found in Unpaywall: 10.7554/eLife.64977",
    ]);
  });

  it("throws PublicationFallbackError listing every tier when all tiers fail", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("server error");
    });
    fixtures.push(fixture);
    await expect(
      acquirePublicationWithFallback({
        source: fallbackSource(PDF_URL),
        filename: "PMC8275131.pdf",
        workdirRoot: root,
        cache: new ContentCache(path.join(root, "cache")),
        client: fixtureHttpClient(fixture.port),
        dataLevel: "metadata",
        maxBytes: 10 * 1024 * 1024,
        doi: "10.7554/eLife.64977",
        pmcid: "PMC8275131",
        lookupPdf: async () => {
          throw new UnpaywallError("no OA version");
        },
      }),
    ).rejects.toMatchObject({
      name: "PublicationFallbackError",
      code: "network_error",
      message: expect.stringContaining("all PDF acquisition tiers failed"),
    });
    await expect(
      acquirePublicationWithFallback({
        source: fallbackSource(PDF_URL),
        filename: "PMC8275131.pdf",
        workdirRoot: root,
        cache: new ContentCache(path.join(root, "cache")),
        client: fixtureHttpClient(fixture.port),
        dataLevel: "metadata",
        maxBytes: 10 * 1024 * 1024,
        doi: "10.7554/eLife.64977",
        pmcid: "PMC8275131",
        lookupPdf: async () => {
          throw new UnpaywallError("no OA version");
        },
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof PublicationFallbackError)) return false;
      return (
        error.message.includes("tier1_direct") &&
        error.message.includes("tier2_unpaywall") &&
        error.message.includes("tier3_epmc") &&
        error.code === "network_error"
      );
    });
  });

  it("skips missing DOI/PMCID tiers with Python skip messages", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(500);
      res.end("server error");
    });
    fixtures.push(fixture);
    await expect(
      acquirePublicationWithFallback({
        source: fallbackSource(),
        filename: "PMC8275131.pdf",
        workdirRoot: root,
        cache: new ContentCache(path.join(root, "cache")),
        client: fixtureHttpClient(fixture.port),
        dataLevel: "metadata",
        maxBytes: 10 * 1024 * 1024,
      }),
    ).rejects.toSatisfy((error: unknown) => {
      if (!(error instanceof PublicationFallbackError)) return false;
      return (
        error.message.includes("tier1_direct: skipped (source.url not a direct PDF link)") &&
        error.message.includes("tier2_unpaywall: skipped (no DOI provided)") &&
        error.message.includes("tier3_epmc: skipped (no PMCID provided)")
      );
    });
  });
});

// ---------------------------------------------------------------------------
// makeSourceId
// ---------------------------------------------------------------------------

describe("makeSourceId", () => {
  it("matches the Python make_source_id digest", () => {
    expect(makeSourceId("pubmed", "34180400", PMC_URL)).toBe("src_ddf0a229327f7e3d41fe60d13260cf0d");
    expect(makeSourceId("pubmed", "PMC7450705", "https://ftp.ncbi.nlm.nih.gov/pub/pmc/PMC7450705.pdf")).toBe(
      "src_b4afd31b932b159242eda0173ffdabb7",
    );
  });
});

// ---------------------------------------------------------------------------
// download_supplementary adapter + tools
// ---------------------------------------------------------------------------

describe("downloadSupplementaryAdapter", () => {
  it("returns the no-PMCID error (Python adapter parity)", async () => {
    const xmlNoPmc = Buffer.from(
      '<?xml version="1.0"?><PubmedArticleSet><PubmedArticle>' +
        "<MedlineCitation><PMID>12345</PMID>" +
        "<Article><ArticleTitle>No PMC</ArticleTitle></Article>" +
        "</MedlineCitation>" +
        "<PubmedData><ArticleIdList>" +
        '<ArticleId IdType="pubmed">12345</ArticleId>' +
        '<ArticleId IdType="doi">10.1/2</ArticleId>' +
        "</ArticleIdList></PubmedData>" +
        "</PubmedArticle></PubmedArticleSet>",
    );
    const eutils: NcbiDiscoveryClient = {
      async esearch() {
        throw new Error("esearch must not be called");
      },
      async esummary() {
        throw new Error("esummary must not be called");
      },
      async efetch() {
        return xmlNoPmc;
      },
    };
    const payload = (await downloadSupplementaryAdapter("12345", 1, {
      eutils,
      http: new PublicHttpClient(),
      cache: new ContentCache(path.join(root, "cache")),
      taskRoot: root,
    })) as { source: string; accession: string; error: string };
    expect(payload).toEqual({
      source: "pubmed",
      accession: "12345",
      error: "No PMCID found — article is not in the PMC open-access subset",
    });
  });

  it("returns the efetch failure error payload", async () => {
    const eutils: NcbiDiscoveryClient = {
      async esearch() {
        throw new Error("unused");
      },
      async esummary() {
        throw new Error("unused");
      },
      async efetch() {
        throw new NcbiRequestError("NCBI returned HTTP 500: down", { statusCode: 500, retryable: true });
      },
    };
    const payload = (await downloadSupplementaryAdapter("1", 1, {
      eutils,
      http: new PublicHttpClient(),
      cache: new ContentCache(path.join(root, "cache")),
      taskRoot: root,
    })) as { source: string; accession: string; error: string };
    expect(payload.source).toBe("pubmed");
    expect(payload.accession).toBe("1");
    expect(payload.error).toBe("Failed to fetch PubMed record: NCBI returned HTTP 500: down");
  });

  it("downloads the Europe PMC supplementary archive before publication fallback", async () => {
    const supplementaryZip = Buffer.from("PK\x03\x04fixture-supplementary-archive");
    const fixture = await startFixtureServer(async (req, res) => {
      const url = req.url ?? "";
      if (url.includes("efetch.fcgi")) {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(await pyFixture("pubmed_34180400.xml"));
        return;
      }
      if (url.includes("/supplementaryFiles")) {
        res.writeHead(200, {
          "content-type": "application/zip",
          "content-length": String(supplementaryZip.length),
        });
        res.end(supplementaryZip);
        return;
      }
      res.writeHead(500);
      res.end("publication fallback must not run after supplementary success");
    });
    fixtures.push(fixture);
    const http = fixtureHttpClient(fixture.port);
    const eutils = new NcbiEutilsClient({ http, config: testConfig(), limiter: immediateLimiter() });
    const payload = (await downloadSupplementaryAdapter("34180400", 1, {
      eutils,
      http,
      cache: new ContentCache(path.join(root, "cache")),
      taskRoot: root,
    })) as {
      local_files: string[];
      source_assets: Array<{ media_type: string }>;
      download_attempts: Array<{ status: string; url: string }>;
      format_hint: string;
      warnings?: string[];
    };
    expect(payload.local_files[0]?.endsWith("pubmed_34180400_supplementary.zip")).toBe(true);
    expect(await readFile(payload.local_files[0] ?? "")).toEqual(supplementaryZip);
    expect(payload.source_assets[0]?.media_type).toBe("application/zip");
    expect(payload.download_attempts).toHaveLength(1);
    expect(payload.download_attempts[0]?.url).toContain("/PMC8275131/supplementaryFiles");
    expect(payload.format_hint).toBe("supplementary_archive");
    expect(payload.warnings).toBeUndefined();
  });

  it("falls back to the EPMC XML asset when no supplementary archive is available", async () => {
    const fixture = await startFixtureServer(async (req, res) => {
      const url = req.url ?? "";
      if (url.includes("efetch.fcgi")) {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(await pyFixture("pubmed_34180400.xml"));
        return;
      }
      if (url.includes("/supplementaryFiles") || url.startsWith("/v2/")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (url.includes("/fullTextXML")) {
        res.writeHead(200, {
          "content-type": "text/xml",
          "content-length": String(EPMC_XML.length),
        });
        res.end(EPMC_XML);
        return;
      }
      res.writeHead(500);
      res.end("unexpected request");
    });
    fixtures.push(fixture);
    const http = fixtureHttpClient(fixture.port);
    const eutils = new NcbiEutilsClient({ http, config: testConfig(), limiter: immediateLimiter() });
    const hooks: Array<[string, string, Record<string, unknown>]> = [];
    const payload = (await downloadSupplementaryAdapter("34180400", 1, {
      eutils,
      http,
      cache: new ContentCache(path.join(root, "cache")),
      taskRoot: root,
      hooks: { onProgress: (stage, kind, value) => hooks.push([stage, kind, value]) },
    })) as {
      source: string;
      accession: string;
      source_url: string;
      local_files: string[];
      source_assets: Array<{ media_type: string; relative_path: string }>;
      download_attempts: Array<{ status: string; url: string }>;
      format_hint: string;
      retrieved_at: string;
      warnings: string[];
    };
    expect(payload.source).toBe("pubmed");
    expect(payload.accession).toBe("34180400");
    expect(payload.source_url).toBe(PMC_URL);
    expect(payload.local_files).toHaveLength(1);
    expect(payload.local_files[0]?.endsWith("pubmed_34180400.xml")).toBe(true);
    expect(await readFile(payload.local_files[0] ?? "")).toEqual(EPMC_XML);
    expect(payload.source_assets).toHaveLength(1);
    expect(payload.source_assets[0]?.media_type).toBe("text/xml");
    expect(payload.download_attempts).toHaveLength(2);
    expect(payload.download_attempts[0]?.status).toBe("failed");
    expect(payload.download_attempts[0]?.url).toContain("/PMC8275131/supplementaryFiles");
    expect(payload.download_attempts[1]?.status).toBe("succeeded");
    expect(payload.download_attempts[1]?.url).toContain("/europepmc/webservices/rest/PMC8275131/fullTextXML");
    expect(payload.format_hint).toBe("full_text_xml");
    expect(payload.retrieved_at).toBeTruthy();
    expect(payload.warnings).toEqual([
      expect.stringContaining("supplementary_archive"),
      "tier1_direct: skipped (source.url not a direct PDF link)",
      "tier2_unpaywall_lookup: DOI not found in Unpaywall: 10.7554/eLife.64977",
    ]);
    expect(hooks[0]?.[0]).toBe("acquisition");
    expect(hooks[0]?.[1]).toBe("downloaded_bytes");
    expect(hooks.at(-1)?.[2]).toMatchObject({ filename: "pubmed_34180400.pdf" });
  });

  it("returns the all-tiers-failed error payload with details and attempts", async () => {
    const fixture = await startFixtureServer(async (req, res) => {
      const url = req.url ?? "";
      if (url.includes("efetch.fcgi")) {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(await pyFixture("pubmed_34180400.xml"));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    });
    fixtures.push(fixture);
    const http = fixtureHttpClient(fixture.port);
    const eutils = new NcbiEutilsClient({ http, config: testConfig(), limiter: immediateLimiter() });
    const payload = (await downloadSupplementaryAdapter("34180400", 1, {
      eutils,
      http,
      cache: new ContentCache(path.join(root, "cache")),
      taskRoot: root,
    })) as {
      source: string;
      accession: string;
      source_url: string;
      error: string;
      details: string[];
      download_attempts: Array<{ status: string; error_code: string | null }>;
    };
    expect(payload.source).toBe("pubmed");
    expect(payload.accession).toBe("34180400");
    expect(payload.source_url).toBe(PMC_URL);
    expect(payload.error).toContain("all PDF acquisition tiers failed");
    expect(payload.details).toEqual([
      expect.stringContaining("supplementary_archive"),
      "tier1_direct: skipped (source.url not a direct PDF link)",
      "tier2_unpaywall_lookup: DOI not found in Unpaywall: 10.7554/eLife.64977",
      expect.stringContaining("tier3_epmc: attempt status=failed"),
    ]);
    expect(payload.download_attempts).toHaveLength(2);
    expect(payload.download_attempts[0]?.status).toBe("failed");
    expect(payload.download_attempts[1]?.status).toBe("failed");
    // The fixture serves 404 for the tier URLs: the fine-grained taxonomy
    // classifies deterministic HTTP client errors instead of network_error.
    expect(payload.download_attempts[1]?.error_code).toBe("http_client_error");
  });
});

// ---------------------------------------------------------------------------
// tool registration + execution
// ---------------------------------------------------------------------------

describe("createPubmedTools", () => {
  it("registers both tools under their SKILL_TOOL_MAP names", () => {
    const tools = createPubmedTools({ taskRoot: root });
    expect(tools.map((tool) => tool.name)).toEqual(["search_pubmed", "download_supplementary"]);
    for (const tool of tools) {
      expect(SKILL_TOOL_NAMES.has(tool.name)).toBe(true);
      expect(toolOwner(tool.name)).toBe("pubmed");
    }
  });

  it("exposes the stable parameter schemas", () => {
    const tools = createPubmedTools({ taskRoot: root });
    const search = tools[0] as (typeof tools)[number];
    const download = tools[1] as (typeof tools)[number];
    expect(search?.parameters).toEqual({
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search query for PubMed." },
        max_results: { type: "integer", description: "Maximum number of records to fetch (default 20)." },
      },
      required: ["query"],
      additionalProperties: false,
    });
    expect(download?.parameters).toEqual({
      type: "object",
      properties: {
        pmid: { type: "string", description: "PubMed ID (PMID) of the article." },
        max_size_mb: {
          type: "integer",
          description:
            `Maximum download size in MiB (default ${DEFAULT_RUNTIME_LIMITS.max_download_mib}).`,
        },
      },
      required: ["pmid"],
      additionalProperties: false,
    });
  });

  it("executes search_pubmed through the BioMedAgentTool interface against fixtures", async () => {
    const fixture = await startFixtureServer(async (req, res) => {
      const url = req.url ?? "";
      if (url.includes("esearch.fcgi")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(await pyFixture("pubmed_esearch.json"));
        return;
      }
      if (url.includes("efetch.fcgi")) {
        res.writeHead(200, { "content-type": "application/xml" });
        res.end(await pyFixture("pubmed_34180400.xml"));
        return;
      }
      res.writeHead(500);
      res.end("unexpected request");
    });
    fixtures.push(fixture);
    const http = fixtureHttpClient(fixture.port);
    const tools = createPubmedTools({
      taskRoot: root,
      http,
      eutils: new NcbiEutilsClient({ http, config: testConfig(), limiter: immediateLimiter() }),
      cacheRoot: path.join(root, "cache"),
    });
    const tool = tools.find((candidate) => candidate.name === "search_pubmed");
    expect(tool).toBeDefined();
    const result = await tool?.execute({ query: "Hsp70 breast cancer", max_results: 20 });
    expect(result?.isError).toBeUndefined();
    const parsed = JSON.parse(result?.content ?? "{}") as {
      source: string;
      records: Array<{ pmid: string }>;
    };
    expect(parsed.source).toBe("pubmed");
    expect(parsed.records.map((record) => record.pmid)).toEqual(["34180400"]);
  });

  it("marks search failures isError (Python rethrow parity)", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("down");
    });
    fixtures.push(fixture);
    const http = fixtureHttpClient(fixture.port);
    const tools = createPubmedTools({
      taskRoot: root,
      http,
      eutils: new NcbiEutilsClient({
        http,
        config: testConfig({ maxRetries: 0 }),
        limiter: immediateLimiter(),
      }),
      cacheRoot: path.join(root, "cache"),
    });
    const tool = tools.find((candidate) => candidate.name === "search_pubmed");
    const result = await tool?.execute({ query: "anything" });
    expect(result?.isError).toBe(true);
    expect(JSON.parse(result?.content ?? "{}") as { error: string }).toHaveProperty("error");
  });
});
