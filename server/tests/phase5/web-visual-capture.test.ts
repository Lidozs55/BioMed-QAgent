/**
 * P5-07 web visual capture tests (mirror of
 * ``backend/tests/test_skill_web_visual_capture.py``): PNG + provenance meta
 * under ``source_assets/figures/``, selector section capture, viewport
 * clamping, unsafe-label rejection before transport, oversize warning, and
 * fail-fast missing selectors against the real chromium pool.
 */

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeBrowserPool, type BrowserScreenshotResult } from "../../src/external/browser/index.js";
import { CrawlerFacade, type BrowserPoolClient } from "../../src/external/crawler/index.js";
import { createWebVisualCaptureTools } from "../../src/agent/tools/web-visual-capture.js";
import { startFixtureServer, type FixtureServer } from "./helpers.js";
import { fixtureEgressPolicy } from "./fixtures/browser/policy.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from("visual-evidence")]);

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

interface Captured {
  queries: Array<[string, string, string, number | undefined]>;
  progress: Array<{ stage: string; kind: string; payload: Record<string, unknown> }>;
  screenshots: Array<{ url: string; options: Record<string, unknown> }>;
}

function makePool(png: Buffer, statusCode = 200, error?: Error): { pool: BrowserPoolClient; captured: Captured } {
  const captured: Captured = { queries: [], progress: [], screenshots: [] };
  const pool: BrowserPoolClient = {
    fetch: async () => {
      throw new Error("unused in this test");
    },
    screenshot: async (url, options) => {
      captured.screenshots.push({ url, options: { ...options } });
      if (error !== undefined) throw error;
      const result: BrowserScreenshotResult = {
        url,
        buffer: png,
        status_code: statusCode,
        elapsed_ms: 2,
      };
      return result;
    },
  };
  return { pool, captured };
}

describe("web_visual_capture tools", () => {
  let root: string;
  const fixtures: FixtureServer[] = [];
  const pools: NodeBrowserPool[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "p5-visual-"));
  });

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      fixture.server.closeAllConnections();
      await fixture.close();
    }
    await rm(root, { recursive: true, force: true });
  });

  afterAll(async () => {
    for (const pool of pools.reverse()) {
      await pool.close();
    }
  });

  it("capture_web_page commits PNG and provenance meta under source_assets/figures", async () => {
    const { pool, captured } = makePool(PNG);
    const facade = new CrawlerFacade({ browserPool: pool, minInterval: 0 });
    const { captureWebPage } = createWebVisualCaptureTools({
      taskRoot: root,
      crawler: facade,
      hooks: {
        onQuery: (query, source, status, count) => captured.queries.push([query, source, status, count]),
        onProgress: (stage, kind, payload) => captured.progress.push({ stage, kind, payload }),
      },
    });

    const result = await captureWebPage.execute({ url: "https://example.org/figure", label: "figure_1" });
    const data = JSON.parse(result.content) as Record<string, unknown>;

    expect(data["error"]).toBeUndefined();
    expect(data["source"]).toBe("web_visual_capture");
    expect(data["status_code"]).toBe(200);
    expect(data["label"]).toBe("figure_1");
    expect(data["sha256"]).toBe(sha256(PNG));
    expect(data["viewport"]).toEqual({ width: 1920, height: 1080 });

    const localFiles = data["local_files"] as string[];
    expect(localFiles).toHaveLength(1);
    const imagePath = path.resolve(localFiles[0]);
    expect(path.dirname(imagePath)).toBe(path.join(root, "source_assets", "figures"));
    expect(await readFile(imagePath)).toEqual(PNG);

    const metaPath = path.resolve(String(data["meta_file"]));
    expect(path.dirname(metaPath)).toBe(path.join(root, "source_assets", "figures"));
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    expect(meta["label"]).toBe("figure_1");
    expect(meta["sha256"]).toBe(sha256(PNG));
    expect(meta["size_bytes"]).toBe(PNG.length);
    expect(meta["source_url"]).toBe("https://example.org/figure");
    expect(meta["full_page"]).toBe(true);
    expect(meta["selector"]).toBeNull();
    expect(meta["captured_at"]).toBe(data["captured_at"]);
    expect(meta["source_id"]).toBe(data["source_id"]);

    expect(captured.queries).toEqual([["https://example.org/figure", "web_visual_capture", "success", 1]]);
  });

  it("capture_page_section forwards the selector and clamps the viewport", async () => {
    const { pool, captured } = makePool(PNG);
    const facade = new CrawlerFacade({ browserPool: pool, minInterval: 0 });
    const { capturePageSection } = createWebVisualCaptureTools({
      taskRoot: root,
      crawler: facade,
      hooks: { onQuery: () => undefined },
    });

    const result = await capturePageSection.execute({
      url: "https://example.org/paper",
      selector: "figure.primary",
      viewport_width: 9000,
      viewport_height: 9000,
    });
    const data = JSON.parse(result.content) as Record<string, unknown>;

    expect(data["error"]).toBeUndefined();
    expect(data["selector"]).toBe("figure.primary");
    expect(data["full_page"]).toBe(false);
    expect(data["viewport"]).toEqual({ width: 1920, height: 1080 });

    expect(captured.screenshots).toHaveLength(1);
    expect(captured.screenshots[0].url).toBe("https://example.org/paper");
    expect(captured.screenshots[0].options["selector"]).toBe("figure.primary");
    expect(captured.screenshots[0].options["fullPage"]).toBe(false);
    expect(captured.screenshots[0].options["viewportWidth"]).toBe(1920);
    expect(captured.screenshots[0].options["viewportHeight"]).toBe(1080);
  });

  it("rejects an unsafe label before any browser transport", async () => {
    const { pool, captured } = makePool(PNG);
    const facade = new CrawlerFacade({ browserPool: pool, minInterval: 0 });
    const { captureWebPage } = createWebVisualCaptureTools({
      taskRoot: root,
      crawler: facade,
      hooks: {
        onQuery: (query, source, status, count) => captured.queries.push([query, source, status, count]),
      },
    });

    const result = await captureWebPage.execute({ url: "https://example.org/figure", label: "../escape" });
    const data = JSON.parse(result.content) as Record<string, unknown>;

    expect(String(data["error"])).toContain("label must be");
    expect(captured.screenshots).toHaveLength(0);
    expect(captured.queries).toEqual([["https://example.org/figure", "web_visual_capture", "failed", 0]]);
  });

  it("returns an error payload when the browser capture raises", async () => {
    const { pool, captured } = makePool(PNG, 200, new Error("browser failed"));
    const facade = new CrawlerFacade({ browserPool: pool, minInterval: 0 });
    const { captureWebPage } = createWebVisualCaptureTools({
      taskRoot: root,
      crawler: facade,
      hooks: {
        onQuery: (query, source, status, count) => captured.queries.push([query, source, status, count]),
        onProgress: (stage, kind, payload) => captured.progress.push({ stage, kind, payload }),
      },
    });

    const result = await captureWebPage.execute({ url: "https://example.org/figure" });
    const data = JSON.parse(result.content) as Record<string, unknown>;

    expect(data["error"]).toBe("browser failed");
    expect(data["source"]).toBe("web_visual_capture");
    expect(captured.queries).toEqual([["https://example.org/figure", "web_visual_capture", "failed", 0]]);
    expect(captured.progress.some((entry) => entry.kind === "warning")).toBe(true);
  });

  it("reports non-2xx captures as an error payload with a warning", async () => {
    const { pool, captured } = makePool(PNG, 503);
    const facade = new CrawlerFacade({ browserPool: pool, minInterval: 0 });
    const { captureWebPage } = createWebVisualCaptureTools({
      taskRoot: root,
      crawler: facade,
      hooks: {
        onQuery: (query, source, status, count) => captured.queries.push([query, source, status, count]),
        onProgress: (stage, kind, payload) => captured.progress.push({ stage, kind, payload }),
      },
    });

    const result = await captureWebPage.execute({ url: "https://example.org/figure" });
    const data = JSON.parse(result.content) as Record<string, unknown>;

    expect(data["error"]).toBe("HTTP 503");
    expect(data["status_code"]).toBe(503);
    expect(captured.queries).toEqual([["https://example.org/figure", "web_visual_capture", "failed", 0]]);
    expect(
      captured.progress.some((entry) => entry.kind === "warning" && String(entry.payload["message"]).includes("HTTP 503")),
    ).toBe(true);
  });

  it("warns on oversized screenshots but still commits them", async () => {
    const oversize = Buffer.alloc(10 * 1024 * 1024 + 1, 0x50);
    const { pool, captured } = makePool(oversize);
    const facade = new CrawlerFacade({ browserPool: pool, minInterval: 0 });
    const { captureWebPage } = createWebVisualCaptureTools({
      taskRoot: root,
      crawler: facade,
      hooks: {
        onQuery: (query, source, status, count) => captured.queries.push([query, source, status, count]),
        onProgress: (stage, kind, payload) => captured.progress.push({ stage, kind, payload }),
      },
    });

    const result = await captureWebPage.execute({ url: "https://example.org/figure", label: "big" });
    const data = JSON.parse(result.content) as Record<string, unknown>;

    expect(data["error"]).toBeUndefined();
    expect(data["sha256"]).toBe(sha256(oversize));
    expect(captured.queries).toEqual([["https://example.org/figure", "web_visual_capture", "success", 1]]);
    expect(
      captured.progress.some((entry) => entry.kind === "warning" && String(entry.payload["message"]).includes("screenshot oversize")),
    ).toBe(true);
  });

  describe("real chromium pool", () => {
    it("capture_web_page lands a real PNG with a matching sha256 meta", async () => {
      const server = await startFixtureServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><head><title>Visual</title></head><body>capture me</body></html>");
      });
      fixtures.push(server);
      const pool = new NodeBrowserPool({ policy: fixtureEgressPolicy() });
      pools.push(pool);
      await pool.start();
      const facade = new CrawlerFacade({ browserPool: pool, minInterval: 0 });
      const { captureWebPage } = createWebVisualCaptureTools({
        taskRoot: root,
        crawler: facade,
        hooks: { onQuery: () => undefined },
      });

      const url = `http://127.0.0.1:${server.port}/simple`;
      const result = await captureWebPage.execute({ url, label: "real_capture" });
      const data = JSON.parse(result.content) as Record<string, unknown>;

      expect(data["error"]).toBeUndefined();
      expect(data["status_code"]).toBe(200);
      const pngBytes = await readFile(path.resolve((data["local_files"] as string[])[0]));
      expect(pngBytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      expect(data["sha256"]).toBe(sha256(pngBytes));
      const meta = JSON.parse(await readFile(path.resolve(String(data["meta_file"])), "utf8")) as Record<string, unknown>;
      expect(meta["sha256"]).toBe(sha256(pngBytes));
      expect(meta["source_url"]).toBe(url);
      expect(meta["full_page"]).toBe(true);
      await pool.close();
    });

    it("fails fast when the section selector is missing", async () => {
      const server = await startFixtureServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>no selector here</body></html>");
      });
      fixtures.push(server);
      const pool = new NodeBrowserPool({ policy: fixtureEgressPolicy() });
      pools.push(pool);
      await pool.start();
      const facade = new CrawlerFacade({ browserPool: pool, minInterval: 0 });
      const { capturePageSection } = createWebVisualCaptureTools({
        taskRoot: root,
        crawler: facade,
        hooks: { onQuery: () => undefined },
      });

      const startedAt = Date.now();
      const result = await capturePageSection.execute({
        url: `http://127.0.0.1:${server.port}/simple`,
        selector: "#does-not-exist",
      });
      const data = JSON.parse(result.content) as Record<string, unknown>;

      expect(String(data["error"])).toContain("browser screenshot selector is not visible: #does-not-exist");
      expect(data["source"]).toBe("web_visual_capture");
      expect(Date.now() - startedAt).toBeLessThan(20_000);
      await pool.close();
    });
  });
});
