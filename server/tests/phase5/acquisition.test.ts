/**
 * P5-01 acquisition service tests: streaming limits, hash/media verification,
 * cache, atomic publication, cancellation (Python acquire_source parity).
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { acquireSource, canonicalRequestHash, ContentCache, CURATED_SOURCE_HOSTS, taskWorkDirs } from "../../src/external/acquisition/index.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import type { SourceRecord } from "../../src/dataset/contracts/source.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";

const HOST = "source.example.com";
const URL = `https://${HOST}/file.bin`;

function sourceRecord(url: string = URL): SourceRecord {
  return {
    schema_version: "1.0",
    source_id: "src_test",
    database: "gdc",
    accession: "ACC1",
    url,
    title: "fixture source",
    retrieved_at: "2026-08-14T00:00:00Z",
  };
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function md5(content: string | Buffer): string {
  return createHash("md5").update(content).digest("hex");
}

let root: string;
let dirs: ReturnType<typeof taskWorkDirs>;
const fixtures: FixtureServer[] = [];

beforeEach(async () => {
  const dir = path.join(os.tmpdir(), `p5-acq-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  root = dir;
  dirs = taskWorkDirs(root);
});

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
  await import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true }));
});

function client(port: number): PublicHttpClient {
  return new PublicHttpClient({
    resolve: fakeResolver({ [HOST]: [PUBLIC_IP] }),
    executor: localExecutor(port),
  });
}

async function acquire(options: {
  content?: string | Buffer;
  headers?: Record<string, string>;
  maxBytes?: number;
  expectedSize?: number;
  expectedSha256?: string;
  expectedMd5?: string;
  expectedMediaTypes?: ReadonlySet<string>;
  signal?: AbortSignal;
  filename?: string;
  stream?: (res: { write(chunk: string | Buffer): void; end(): void }) => void;
}) {
  const fixture = await startFixtureServer((_req, res) => {
    if (options.headers) {
      res.writeHead(200, options.headers);
    } else {
      res.writeHead(200, { "content-type": "text/plain" });
    }
    if (options.stream) {
      options.stream({ write: (c) => res.write(c), end: () => res.end() });
    } else {
      res.end(options.content ?? "hello");
    }
  });
  fixtures.push(fixture);
  const cache = new ContentCache(path.join(root, "cache"));
  const result = await acquireSource({
    source: sourceRecord(),
    filename: options.filename ?? "file.bin",
    workdirRoot: root,
    cache,
    client: client(fixture.port),
    dataLevel: "repository_processed",
    maxBytes: options.maxBytes ?? 1_000_000,
    expectedSize: options.expectedSize,
    expectedSha256: options.expectedSha256,
    expectedMd5: options.expectedMd5,
    expectedMediaTypes: options.expectedMediaTypes,
    signal: options.signal,
    allowedHosts: new Set([HOST]),
  });
  return { result, fixture, cache };
}

describe("canonicalRequestHash", () => {
  it("matches the Python canonical key (lowercased, sorted, compact)", () => {
    expect(canonicalRequestHash("gdc", "ACC1", URL)).toBe("b17e5077f5d302affe8f365360da2a5afb08d90706cb33b38f26422f61628ff6");
  });

  it("is stable across whitespace in inputs", () => {
    expect(canonicalRequestHash(" GDC ", " ACC1 ", ` ${URL} `)).toBe(canonicalRequestHash("gdc", "ACC1", URL));
  });
});

describe("acquireSource success path", () => {
  it("publishes a verified content-addressed SourceAsset", async () => {
    const { result } = await acquire({ content: "hello", filename: "hello.txt" });
    expect(result.attempt.status).toBe("succeeded");
    expect(result.attempt.bytes_received).toBe(5);
    expect(result.asset).not.toBeNull();
    expect(result.asset?.sha256).toBe(sha256("hello"));
    expect(result.asset?.asset_id).toBe(`asset_${sha256("hello")}`);
    expect(result.asset?.media_type).toBe("text/plain");
    expect(result.asset?.successful_attempt_id).toBe(result.attempt.attempt_id);
    const published = path.join(root, result.asset?.relative_path ?? "");
    expect(await readFile(published, "utf8")).toBe("hello");
    expect(result.asset?.relative_path).toBe(`source_assets/asset_${sha256("hello")}/hello.txt`);
  });

  it("writes cache metadata and serves later requests from cache", async () => {
    const first = await acquire({ content: "cached-content" });
    expect(first.result.attempt.status).toBe("succeeded");
    expect(first.fixture.requests).toHaveLength(1);

    const second = await acquire({ content: "cached-content" });
    expect(second.result.attempt.status).toBe("succeeded");
    expect(second.result.attempt.bytes_received).toBe(14);
    expect(second.fixture.requests).toHaveLength(0); // cache hit: no network
    expect(second.result.asset?.sha256).toBe(first.result.asset?.sha256);
  });

  it("reports progress with received bytes", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "10" });
      res.end("0123456789");
    });
    fixtures.push(fixture);
    const calls: Array<[number, number | null]> = [];
    const result = await acquireSource({
      source: sourceRecord(),
      filename: "f.bin",
      workdirRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: client(fixture.port),
      dataLevel: "repository_processed",
      maxBytes: 1000,
      allowedHosts: new Set([HOST]),
      progress: async (received, declared) => {
        calls.push([received, declared]);
      },
    });
    expect(result.attempt.status).toBe("succeeded");
    expect(calls.at(-1)).toEqual([10, 10]);
  });
});

describe("acquireSource failure paths", () => {
  it("rejects declared oversize before reading", async () => {
    const { result } = await acquire({ content: "x", headers: { "content-type": "text/plain", "content-length": "99999999" }, maxBytes: 100 });
    expect(result.attempt.status).toBe("failed");
    expect(result.attempt.error_code).toBe("download_incomplete");
    expect(result.attempt.error_message).toBe("declared content length exceeds maximum");
    expect(result.asset).toBeNull();
    await expect(noPartFiles()).resolves.toBe(true);
  });

  it("aborts streamed oversize bodies", async () => {
    const { result } = await acquire({
      maxBytes: 10,
      stream: ({ write, end }) => {
        for (let index = 0; index < 11; index += 1) write("x");
        end();
      },
    });
    expect(result.attempt.status).toBe("failed");
    expect(result.attempt.error_code).toBe("download_incomplete");
    expect(result.attempt.error_message).toBe("download exceeded maximum size");
    await expect(noPartFiles()).resolves.toBe(true);
  });

  it("rejects empty responses", async () => {
    const { result } = await acquire({ content: "" });
    expect(result.attempt.error_code).toBe("download_incomplete");
    expect(result.attempt.error_message).toBe("download was empty");
  });

  it("rejects content-length mismatches", async () => {
    // Synthesize the mismatch at the transport layer: a body shorter than the
    // declared Content-Length (the HTTP server parser itself honors the
    // declared length, so a real server cannot reproduce this deterministically).
    const result = await acquireSource({
      source: sourceRecord(),
      filename: "f.bin",
      workdirRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: new PublicHttpClient({
        resolve: fakeResolver({ [HOST]: [PUBLIC_IP] }),
        executor: async () => ({
          status: 200,
          headers: { "content-type": "text/plain", "content-length": "10" },
          body: (async function* iterate(): AsyncIterable<Buffer> {
            yield Buffer.from("12345");
          })(),
        }),
      }),
      dataLevel: "repository_processed",
      maxBytes: 1000,
      allowedHosts: new Set([HOST]),
    });
    expect(result.attempt.error_code).toBe("download_incomplete");
    expect(result.attempt.error_message).toBe("content length mismatch");
  });

  it("rejects unexpected media types", async () => {
    const { result } = await acquire({ content: "<html/>", headers: { "content-type": "text/html" }, expectedMediaTypes: new Set(["text/plain"]) });
    expect(result.attempt.error_code).toBe("validation_error");
    expect(result.attempt.error_message).toBe("unexpected content type: text/html");
  });

  it("rejects expected-size mismatches", async () => {
    const { result } = await acquire({ content: "hello", expectedSize: 4 });
    expect(result.attempt.error_code).toBe("download_incomplete");
    expect(result.attempt.error_message).toBe("expected size mismatch");
  });

  it("rejects SHA-256 mismatches", async () => {
    const { result } = await acquire({ content: "hello", expectedSha256: sha256("nope") });
    expect(result.attempt.error_code).toBe("checksum_mismatch");
    expect(result.attempt.error_message).toBe("expected SHA-256 mismatch");
  });

  it("verifies official MD5 when provided", async () => {
    const { result } = await acquire({ content: "hello", expectedMd5: md5("nope") });
    expect(result.attempt.error_code).toBe("checksum_mismatch");
    expect(result.attempt.error_message).toBe("expected MD5 mismatch");
  });

  it("accepts correct expected checksums", async () => {
    const { result } = await acquire({
      content: "hello",
      expectedSha256: sha256("hello"),
      expectedMd5: md5("hello"),
      expectedSize: 5,
    });
    expect(result.attempt.status).toBe("succeeded");
  });

  it("reports HTTP errors as network errors", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(503, {});
      res.end("unavailable");
    });
    fixtures.push(fixture);
    const result = await acquireSource({
      source: sourceRecord(),
      filename: "f.bin",
      workdirRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: client(fixture.port),
      dataLevel: "repository_processed",
      maxBytes: 1000,
      allowedHosts: new Set([HOST]),
    });
    expect(result.attempt.status).toBe("failed");
    expect(result.attempt.error_code).toBe("network_error");
    expect(result.attempt.error_message).toBe("download returned HTTP 503");
  });

  it("rejects source URLs outside the curated host allowlist", async () => {
    const fixture = await startFixtureServer(() => undefined);
    fixtures.push(fixture);
    const result = await acquireSource({
      source: sourceRecord("https://evil.example.com/x"),
      filename: "f.bin",
      workdirRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: client(fixture.port),
      dataLevel: "repository_processed",
      maxBytes: 1000,
      allowedHosts: new Set([HOST]),
    });
    expect(result.attempt.error_code).toBe("validation_error");
    expect(result.attempt.error_message).toBe("source URL host is not allowed");
    expect(fixture.requests).toHaveLength(0);
  });

  it("rejects redirects to another host", async () => {
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === "/file.bin") {
        res.writeHead(302, { Location: "https://other.example.com/x" });
        res.end();
      }
    });
    fixtures.push(fixture);
    const result = await acquireSource({
      source: sourceRecord(),
      filename: "f.bin",
      workdirRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: new PublicHttpClient({
        resolve: fakeResolver({ [HOST]: [PUBLIC_IP], "other.example.com": [PUBLIC_IP] }),
        executor: localExecutor(fixture.port),
      }),
      dataLevel: "repository_processed",
      maxBytes: 1000,
      allowedHosts: new Set([HOST, "other.example.com"]),
    });
    expect(result.attempt.error_code).toBe("validation_error");
    expect(result.attempt.error_message).toBe("download redirect changed host");
  });

  it("rejects a same-host redirect resolving to a private address", async () => {
    const fixture = await startFixtureServer((req, res) => {
      if (req.url === "/file.bin") {
        res.writeHead(302, { Location: `https://${HOST}/loop` });
        res.end();
      }
    });
    fixtures.push(fixture);
    const result = await acquireSource({
      source: sourceRecord(),
      filename: "f.bin",
      workdirRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: new PublicHttpClient({
        resolve: fakeResolver({ [HOST]: [{ address: "10.0.0.5", family: 4 }] }),
        executor: localExecutor(fixture.port),
      }),
      dataLevel: "repository_processed",
      maxBytes: 1000,
      allowedHosts: new Set([HOST]),
    });
    expect(result.attempt.error_code).toBe("validation_error");
    expect(result.attempt.error_message).toBe("URL resolved to a non-public address: 10.0.0.5");
  });
});

describe("cache and publication invariants", () => {
  it("fails closed on a corrupt cached blob", async () => {
    const content = "corrupt-me";
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(content);
    });
    fixtures.push(fixture);
    const cache = new ContentCache(path.join(root, "cache"));
    // Pre-seed a corrupt blob at the expected content-addressed location.
    const corrupt = "garbage";
    const blobPath = cache.blobPath(sha256(content));
    await mkdir(path.dirname(blobPath), { recursive: true });
    await writeFile(blobPath, corrupt);

    const result = await acquireSource({
      source: sourceRecord(),
      filename: "f.bin",
      workdirRoot: root,
      cache,
      client: client(fixture.port),
      dataLevel: "repository_processed",
      maxBytes: 1000,
      allowedHosts: new Set([HOST]),
    });
    expect(result.attempt.status).toBe("failed");
    expect(result.attempt.error_code).toBe("checksum_mismatch");
    expect(result.attempt.error_message).toBe("cached blob checksum mismatch");
  });

  it("fails closed when the destination collides with different content", async () => {
    const content = "real";
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(content);
    });
    fixtures.push(fixture);
    // Pre-create a differing file at the deterministic asset path.
    const destination = path.join(dirs.sourceAssets, `asset_${sha256(content)}`, "f.bin");
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, "different");

    const result = await acquireSource({
      source: sourceRecord(),
      filename: "f.bin",
      workdirRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: client(fixture.port),
      dataLevel: "repository_processed",
      maxBytes: 1000,
      allowedHosts: new Set([HOST]),
    });
    expect(result.attempt.status).toBe("failed");
    expect(result.attempt.error_message).toBe("existing task asset differs");
  });

  it("accepts an identical pre-existing destination without rewriting it", async () => {
    const content = "real";
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(content);
    });
    fixtures.push(fixture);
    const destination = path.join(dirs.sourceAssets, `asset_${sha256(content)}`, "f.bin");
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);

    const result = await acquireSource({
      source: sourceRecord(),
      filename: "f.bin",
      workdirRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: client(fixture.port),
      dataLevel: "repository_processed",
      maxBytes: 1000,
      allowedHosts: new Set([HOST]),
    });
    expect(result.attempt.status).toBe("succeeded");
    expect(await readFile(destination, "utf8")).toBe(content);
  });

  it("rejects unsafe filenames", async () => {
    const fixture = await startFixtureServer(() => undefined);
    fixtures.push(fixture);
    await expect(
      acquireSource({
        source: sourceRecord(),
        filename: "../escape.bin",
        workdirRoot: root,
        cache: new ContentCache(path.join(root, "cache")),
        client: client(fixture.port),
        dataLevel: "repository_processed",
        maxBytes: 1000,
        allowedHosts: new Set([HOST]),
      }),
    ).rejects.toThrow("unsafe source filename");
  });
});

describe("cancellation", () => {
  it("propagates aborts, cleans the part file and publishes nothing", async () => {
    const controller = new AbortController();
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("first-chunk");
      controller.abort();
    });
    fixtures.push(fixture);
    await expect(
      acquireSource({
        source: sourceRecord(),
        filename: "f.bin",
        workdirRoot: root,
        cache: new ContentCache(path.join(root, "cache")),
        client: client(fixture.port),
        dataLevel: "repository_processed",
        maxBytes: 1000,
        allowedHosts: new Set([HOST]),
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    await expect(noPartFiles()).resolves.toBe(true);
    const assets = await readdir(dirs.sourceAssets).catch(() => []);
    expect(assets).toHaveLength(0);
  });
});

describe("curated host allowlist", () => {
  it("covers the Python _ALLOWED_HOSTS set", () => {
    expect([...CURATED_SOURCE_HOSTS].sort()).toEqual([
      "api.gdc.cancer.gov",
      "api.unpaywall.org",
      "data.rcsb.org",
      "eutils.ncbi.nlm.nih.gov",
      "files.rcsb.org",
      "ftp.ncbi.nlm.nih.gov",
      "pubchem.ncbi.nlm.nih.gov",
      "reactome.org",
      "search.rcsb.org",
      "toil-xena-hub.s3.us-east-1.amazonaws.com",
      "www.ebi.ac.uk",
      "www.ncbi.nlm.nih.gov",
    ]);
  });
});

async function noPartFiles(): Promise<boolean> {
  const entries = await readdir(dirs.downloadTmp).catch(() => []);
  return !entries.some((entry) => entry.endsWith(".part"));
}
