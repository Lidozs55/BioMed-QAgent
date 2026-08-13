import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireSource, ContentCache } from "../../src/external/acquisition/index.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import { makeSourceId } from "../../src/external/sources/fallback.js";
import { DATA_LEVEL, DATABASE } from "../../src/dataset/contracts/enums.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer } from "./helpers.js";

describe("debug acquireSource with fixture url", () => {
  it("reports what happens", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "p5-dbg-"));
    const pdfBytes = Buffer.from("fake pdf content");
    const server = await startFixtureServer((req, res) => {
      res.writeHead(200, { "content-type": "application/pdf" });
      res.end(pdfBytes);
    });
    const client = new PublicHttpClient({
      resolve: fakeResolver({ "127.0.0.1": [PUBLIC_IP] }),
      executor: localExecutor(server.port),
    });
    const url = `http://127.0.0.1:${server.port}/data.pdf`;
    const sourceId = makeSourceId(DATABASE.BROWSER, "data.pdf", url);
    const result = await acquireSource({
      source: {
        schema_version: "1.0",
        source_id: sourceId,
        database: DATABASE.BROWSER,
        accession: "data.pdf",
        url,
        title: "Browser download data.pdf",
        retrieved_at: new Date().toISOString(),
      },
      filename: "data.pdf",
      workdirRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client,
      dataLevel: DATA_LEVEL.METADATA,
      maxBytes: 4096 * 1024 * 1024,
      requestHeaders: { "User-Agent": "test" },
      accept: "*/*",
    });
    console.log("ATTEMPT:", JSON.stringify(result.attempt));
    console.log("ASSET:", result.asset === null ? "null" : JSON.stringify(result.asset));
    expect(result.attempt.status).toBe("succeeded");
    await rm(root, { recursive: true, force: true });
    await server.close();
  });
});
