/**
 * Cache registration + import-session tool tests.
 *
 * - CacheRegistrar: raw downloads → global cache (CACHE_COMMIT), content
 *   addressing, namespace sanitization, best-effort failure semantics.
 * - acquireSource ``onPublished``: fired on fresh download AND cache hit.
 * - createImportTools: list_source_assets / read_source_asset /
 *   commit_to_cache over a fixture ``source_assets/`` directory.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { DatabaseClient } from "../../src/persistence/db-client.js";
import { CacheRegistrar } from "../../src/persistence/cache-registrar.js";
import { createImportTools } from "../../src/agent/tools/import-tools.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

class FakeBridge {
  readonly calls: Array<{ op: string; args: Record<string, unknown> }> = [];
  failCommit = false;

  async call<T>(op: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push({ op, args });
    if (this.failCommit && op === "cache.commit") {
      throw new Error("bridge down");
    }
    return { ok: true } as T;
  }
}

function fakeClient(bridge: FakeBridge): DatabaseClient {
  return { call: bridge.call.bind(bridge) } as unknown as DatabaseClient;
}

describe("CacheRegistrar", () => {
  it("registers a verified download as a content-addressed cache dataset", async () => {
    const root = await temporaryDirectory("registrar-");
    const bridge = new FakeBridge();
    const registrar = new CacheRegistrar(fakeClient(bridge));
    const file = path.join(root, "raw.bin");
    await writeFile(file, Buffer.from("payload-bytes"));

    await registrar.registerNow("geo", {
      filename: "GSE1_series_matrix.txt.gz",
      filePath: file,
      sha256: sha256Bytes(Buffer.from("payload-bytes")),
      sizeBytes: 13,
      mediaType: "application/gzip",
      sourceUrl: "https://ftp.ncbi.nlm.nih.gov/geo/series/.../GSE1_series_matrix.txt.gz",
      sourceDatabase: "geo",
    }, "task-1");

    const commit = bridge.calls.find((call) => call.op === "cache.commit");
    expect(commit).toBeDefined();
    expect(commit!.args).toMatchObject({
      dataset_id: `blob_${sha256Bytes(Buffer.from("payload-bytes")).slice(0, 16)}`,
      source_namespace: "geo",
      created_by_task_id: "task-1",
      keywords: ["geo", "GSE1_series_matrix.txt.gz"],
      extra: expect.objectContaining({
        kind: "raw_download",
        original_filename: "GSE1_series_matrix.txt.gz",
      }),
    });
    const assetFiles = commit!.args["asset_files"] as Record<string, { path: string; media_type: string }>;
    const assetName = Object.keys(assetFiles)[0]!;
    expect(assetName).toMatch(/^blob_[0-9a-f]{8}_GSE1_series_matrix\.txt\.gz$/);
    expect(assetFiles[assetName]).toEqual({ path: file, media_type: "application/gzip" });
  });

  it("sanitizes the cache namespace and staged asset name", async () => {
    const bridge = new FakeBridge();
    const registrar = new CacheRegistrar(fakeClient(bridge));
    const content = Buffer.from("a,b\n1,2\n");
    const file = path.join(await temporaryDirectory("registrar-"), "weird file name (1).csv");
    await writeFile(file, content);

    await registrar.registerNow("My GEO Source!", {
      filename: "weird file name (1).csv",
      filePath: file,
      sha256: sha256Bytes(content),
      sizeBytes: content.length,
      mediaType: "text/csv",
      sourceUrl: "https://example.test/weird.csv",
    });

    const commit = bridge.calls.find((call) => call.op === "cache.commit")!;
    expect(commit.args["source_namespace"]).toBe("my_geo_source");
    const assetFiles = commit.args["asset_files"] as Record<string, unknown>;
    const assetName = Object.keys(assetFiles)[0]!;
    expect(assetName).toBe(`blob_${sha256Bytes(content).slice(0, 8)}_weird_file_name_1_.csv`);
  });

  it("never throws when the bridge commit fails", async () => {
    const bridge = new FakeBridge();
    bridge.failCommit = true;
    const registrar = new CacheRegistrar(fakeClient(bridge));
    const file = path.join(await temporaryDirectory("registrar-"), "raw.bin");
    await writeFile(file, "x");

    await expect(registrar.registerNow("geo", {
      filename: "raw.bin",
      filePath: file,
      sha256: sha256Bytes(Buffer.from("x")),
      sizeBytes: 1,
      mediaType: "application/octet-stream",
      sourceUrl: "https://example.test/raw.bin",
    })).resolves.toBeUndefined();
  });
});

describe("acquireSource onPublished", () => {
  it("fires on fresh downloads and on cache hits", async () => {
    const { acquireSource, ContentCache } = await import("../../src/external/acquisition/index.js");
    const { PublicHttpClient } = await import("../../src/external/network/index.js");
    const { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer } = await import("./helpers.js");
    const root = await temporaryDirectory("onpublished-");
    const cache = new ContentCache(path.join(root, "cache"));
    const published: Array<Record<string, unknown>> = [];
    const payload = Buffer.from("fixture-bytes");
    const host = "source.example.com";
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(payload);
    });
    const client = new PublicHttpClient({
      resolve: fakeResolver({ [host]: [PUBLIC_IP] }),
      executor: localExecutor(fixture.port),
    });
    const run = async () => {
      await acquireSource({
        source: {
          schema_version: "1.0",
          source_id: "src_test_1",
          database: "gdc",
          accession: "T1",
          url: `https://${host}/file.bin`,
          title: "t",
          retrieved_at: new Date().toISOString(),
        },
        filename: "file.bin",
        workdirRoot: root,
        cache,
        client,
        dataLevel: "repository_processed",
        maxBytes: 1024 * 1024,
        allowedHosts: new Set([host]),
        onPublished: (event) => {
          published.push(event);
        },
      });
    };
    await run();
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      filename: "file.bin",
      sha256: sha256Bytes(payload),
      sizeBytes: payload.length,
      sourceDatabase: "gdc",
    });
    await run();
    expect(published).toHaveLength(2);
    await fixture.close();
  });
});

describe("import tools", () => {
  async function setup() {
    const root = await temporaryDirectory("import-tools-");
    const taskRoot = path.join(root, "task");
    const assets = path.join(taskRoot, "source_assets");
    await mkdir(assets, { recursive: true });
    await writeFile(path.join(assets, "expr.csv"), "gene,value\nTP53,1.5\nBRCA1,2.5\n");
    await writeFile(path.join(assets, "notes.txt"), "hello import\n");
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    await writeFile(path.join(assets, "blob.bin"), binary);
    const bridge = new FakeBridge();
    const tools = createImportTools({ taskRoot, db: fakeClient(bridge) });
    return { taskRoot, assets, bridge, tools, binary };
  }

  it("lists the uploaded source assets", async () => {
    const { tools } = await setup();
    const list = tools.find((tool) => tool.name === "list_source_assets")!;
    const result = JSON.parse((await list.execute!({})).content) as { files: Array<{ name: string; size_bytes: number }> };
    expect(result.files.map((file) => file.name).sort()).toEqual(["blob.bin", "expr.csv", "notes.txt"]);
    expect(result.files.find((file) => file.name === "expr.csv")!.size_bytes).toBe(30);
  });

  it("reads a text asset as a bounded preview", async () => {
    const { tools } = await setup();
    const read = tools.find((tool) => tool.name === "read_source_asset")!;
    const result = JSON.parse((await read.execute!({ filename: "expr.csv" })).content) as {
      filename: string;
      binary: boolean;
      preview: string;
    };
    expect(result).toMatchObject({ filename: "expr.csv", binary: false });
    expect(result.preview).toContain("TP53");
  });

  it("flags binary assets instead of dumping raw bytes", async () => {
    const { tools, binary } = await setup();
    const read = tools.find((tool) => tool.name === "read_source_asset")!;
    const result = JSON.parse((await read.execute!({ filename: "blob.bin" })).content) as {
      binary: boolean;
      header_preview: string;
    };
    expect(result.binary).toBe(true);
    expect(result.header_preview).toContain(".");
    void binary;
  });

  it("rejects unknown filenames and traversal", async () => {
    const { tools } = await setup();
    const read = tools.find((tool) => tool.name === "read_source_asset")!;
    const missing = JSON.parse((await read.execute!({ filename: "nope.csv" })).content) as { error: string };
    expect(missing.error).toContain("cannot read source asset");
    const traversal = JSON.parse((await read.execute!({ filename: "../secret.txt" })).content) as { error: string };
    expect(traversal.error).toContain("unsafe source asset filename");
  });

  it("commits an uploaded file into the user_import cache namespace", async () => {
    const { tools, bridge, taskRoot } = await setup();
    const commit = tools.find((tool) => tool.name === "commit_to_cache")!;
    const result = JSON.parse((await commit.execute!({ filename: "expr.csv", keywords: ["TP53"] })).content) as {
      committed: boolean;
      dataset: Record<string, unknown>;
    };
    expect(result.committed).toBe(true);
    expect(result.dataset).toMatchObject({ ok: true });

    const call = bridge.calls.find((item) => item.op === "cache.commit")!;
    const expr = Buffer.from("gene,value\nTP53,1.5\nBRCA1,2.5\n");
    expect(call.args["source_namespace"]).toBe("user_import");
    expect(call.args["dataset_id"]).toBe(`blob_${sha256Bytes(expr).slice(0, 16)}`);
    expect(call.args["csv_rows"]).toEqual([{
      source_filename: "expr.csv",
      sha256: sha256Bytes(expr),
      size_bytes: "30",
      media_type: "text/csv",
      imported_at: expect.any(String) as unknown as string,
    }]);
    expect(call.args["asset_files"]).toEqual({
      "expr.csv": { path: path.join(taskRoot, "source_assets", "expr.csv"), media_type: "text/csv" },
    });
  });

  it("commit_to_cache reports bridge failures as tool errors", async () => {
    const { tools, bridge } = await setup();
    bridge.failCommit = true;
    const commit = tools.find((tool) => tool.name === "commit_to_cache")!;
    const result = JSON.parse((await commit.execute!({ filename: "expr.csv" })).content) as {
      committed: boolean;
      error: string;
    };
    expect(result.committed).toBe(false);
    expect(result.error).toContain("cache commit failed");
  });
});