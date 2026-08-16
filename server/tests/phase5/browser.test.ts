/**
 * P5-07 browser tests: strict egress policy, NodeBrowserPool, and the
 * browser tools (mirror of ``backend/tests/test_browser_pool.py`` +
 * ``test_egress_proxy.py`` + ``test_skill_browser.py`` behavior).
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  BROWSER_UA,
  MAX_BROWSER_CONTENT_BYTES,
  NodeBrowserPool,
  createStrictBrowserEgressPolicy,
  strictBrowserEgressPolicy,
} from "../../src/external/browser/index.js";
import { UnsafeUrlError } from "../../src/external/network/errors.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import { ContentCache } from "../../src/external/acquisition/content-cache.js";
import { CrawlerFacade } from "../../src/external/crawler/index.js";
import type { BrowserPoolClient } from "../../src/external/crawler/index.js";
import { createBrowserTools } from "../../src/agent/tools/browser.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";
import { fixtureEgressPolicy } from "./fixtures/browser/policy.js";

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "browser");

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("strict browser egress policy", () => {
  it("rejects non-HTTPS URLs", async () => {
    await expect(strictBrowserEgressPolicy.validateUrl("http://public.example/x", new Set())).rejects.toThrow(
      new UnsafeUrlError("browser egress only permits HTTPS URLs"),
    );
  });

  it("rejects non-443 ports", async () => {
    await expect(strictBrowserEgressPolicy.validateUrl("https://public.example:8443/x", new Set())).rejects.toThrow(
      new UnsafeUrlError("browser egress only permits HTTPS port 443"),
    );
  });

  it("rejects URL credentials", async () => {
    await expect(strictBrowserEgressPolicy.validateUrl("https://user:pass@public.example/x", new Set())).rejects.toThrow(
      new UnsafeUrlError("browser URL credentials are not allowed"),
    );
  });

  it("rejects malformed URLs", async () => {
    await expect(strictBrowserEgressPolicy.validateUrl("not a url", new Set())).rejects.toThrow(
      new UnsafeUrlError("browser URL is malformed"),
    );
  });

  it("rejects private DNS answers (SSRF regression)", async () => {
    const policy = createStrictBrowserEgressPolicy({
      resolve: fakeResolver({ "private.example": [{ address: "127.0.0.1", family: 4 }] }),
    });
    await expect(policy.validateUrl("https://private.example/x", new Set())).rejects.toThrow(
      new UnsafeUrlError("browser hostname resolved to a non-public address: 127.0.0.1"),
    );
  });

  it("rejects mixed public/private DNS answers — every address must be global", async () => {
    const policy = createStrictBrowserEgressPolicy({
      resolve: fakeResolver({
        "mixed.example": [
          { address: "93.184.216.34", family: 4 },
          { address: "10.0.0.1", family: 4 },
        ],
      }),
    });
    await expect(policy.validateUrl("https://mixed.example/x", new Set())).rejects.toThrow(
      new UnsafeUrlError("browser hostname resolved to a non-public address: 10.0.0.1"),
    );
  });

  it.each([
    ["::1", "loopback"],
    ["fe80::1", "link-local"],
    ["fc00::1", "ULA"],
  ])("rejects non-global IPv6 %s (%s)", async (address) => {
    const policy = createStrictBrowserEgressPolicy({
      resolve: fakeResolver({ "v6.example": [{ address, family: 6 }] }),
    });
    await expect(policy.validateUrl("https://v6.example/x", new Set())).rejects.toThrow(
      new UnsafeUrlError(`browser hostname resolved to a non-public address: ${address}`),
    );
  });

  it("authorizes a public host into the per-context set and pins DNS once", async () => {
    let resolutions = 0;
    const policy = createStrictBrowserEgressPolicy({
      resolve: async (hostname) => {
        resolutions += 1;
        if (hostname !== "public.example") throw new Error(`getaddrinfo ENOTFOUND ${hostname}`);
        return [PUBLIC_IP];
      },
    });
    const authorized = new Set<string>();
    await expect(policy.validateUrl("https://public.example/x", authorized)).resolves.toBe("public.example");
    expect(authorized.has("public.example")).toBe(true);
    await expect(policy.validateUrl("https://public.example/y", authorized)).resolves.toBe("public.example");
    expect(resolutions).toBe(1);
  });

  it("IDNA-normalizes unicode hostnames before resolution", async () => {
    const resolved: string[] = [];
    const policy = createStrictBrowserEgressPolicy({
      resolve: async (hostname) => {
        resolved.push(hostname);
        return [PUBLIC_IP];
      },
    });
    const authorized = new Set<string>();
    await expect(policy.validateUrl("https://b\u00fccher.example/x", authorized)).resolves.toBe("xn--bcher-kva.example");
    expect(resolved).toEqual(["xn--bcher-kva.example"]);
  });

  it("rejects localhost and empty hostnames", async () => {
    await expect(strictBrowserEgressPolicy.validateUrl("https://localhost/x", new Set())).rejects.toThrow(
      new UnsafeUrlError("browser URL must have a public hostname"),
    );
    await expect(strictBrowserEgressPolicy.validateUrl("https:///x", new Set())).rejects.toThrow(
      new UnsafeUrlError("browser URL is malformed"),
    );
  });
});

describe("NodeBrowserPool (real chromium + fixture server)", () => {
  let server: FixtureServer;
  let pool: NodeBrowserPool;
  const servers: FixtureServer[] = [];
  const pools: NodeBrowserPool[] = [];

  beforeAll(async () => {
    server = await startPoolServer();
    servers.push(server);
    pool = new NodeBrowserPool({ policy: fixtureEgressPolicy() });
    pools.push(pool);
    await pool.start();
  });

  afterAll(async () => {
    for (const fixture of servers) {
      fixture.server.closeAllConnections();
      await fixture.close();
    }
    for (const created of pools.reverse()) {
      await created.close();
    }
  });

  async function startPoolServer(): Promise<FixtureServer> {
    return startFixtureServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/simple") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><head><title>Pool</title></head><body>hello pool</body></html>");
      } else if (pathname === "/set-cookie") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>set<script>document.cookie = 'session=alpha; path=/'</script></body></html>");
      } else if (pathname === "/read-cookie") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          "<html><body>pending<script>document.body.textContent = document.cookie || 'no cookie';</script></body></html>",
        );
      } else if (pathname === "/redirect-a") {
        res.writeHead(302, { location: "/redirect-target" });
        res.end();
      } else if (pathname === "/redirect-target") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><head><title>Redirected</title></head><body>redirected body</body></html>");
      } else if (pathname === "/with-subresource") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end('<html><head><script src="http://denied.example.com/app.js"></script></head><body>rendered ok</body></html>');
      } else if (pathname === "/denied-main") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>should not render</body></html>");
      } else if (pathname === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "text/html" });
          res.end("<html><body>slow done</body></html>");
        }, 800);
      } else if (pathname === "/never") {
        // Intentionally never respond (cancellation target).
      } else if (pathname === "/big") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<html><body>${"x".repeat(MAX_BROWSER_CONTENT_BYTES + 4096)}</body></html>`);
      } else if (pathname === "/form") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          [
            "<html><body><form>",
            '<input id="q" />',
            '<select id="s"><option value="a">A</option><option value="b">B</option></select>',
            '<button type="button" id="go" onclick="document.getElementById(\'result\').textContent = document.getElementById(\'q\').value + \':\' + document.getElementById(\'s\').value">Go</button>',
            '<div id="result"></div>',
            "</form></body></html>",
          ].join(""),
        );
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    });
  }

  function url(pathname: string): string {
    return `http://127.0.0.1:${server.port}${pathname}`;
  }

  it("renders a page with the fixed project User-Agent", async () => {
    const result = await pool.fetch(url("/simple"));
    expect(result.status_code).toBe(200);
    expect(result.content).toContain("hello pool");
    expect(result.headers["content-type"]).toContain("text/html");
    expect(server.requests.some((request) => request.headers["user-agent"] === BROWSER_UA)).toBe(true);
  });

  it("isolates cookies between operations but not within a session", async () => {
    await pool.fetch(url("/set-cookie"));
    const second = await pool.fetch(url("/read-cookie"));
    expect(second.content).toContain("no cookie");

    const session = await pool.openSession({});
    try {
      await session.action({ action: "navigate", target: null, value: url("/set-cookie"), current_url: url("/set-cookie"), timeout_seconds: 15 });
      await session.action({ action: "navigate", target: null, value: url("/read-cookie"), current_url: url("/read-cookie"), timeout_seconds: 15 });
      const extracted = await session.action({ action: "extract", target: null, value: null, current_url: url("/read-cookie"), timeout_seconds: 15 });
      expect(extracted.content.toString("utf8")).toContain("session=alpha");
    } finally {
      await session.close();
    }
  });

  it("route interception validates each redirect hop", async () => {
    const validations: string[] = [];
    const recordingPool = new NodeBrowserPool({ policy: fixtureEgressPolicy({ onValidate: (value) => validations.push(value) }) });
    pools.push(recordingPool);
    await recordingPool.start();
    try {
      const result = await recordingPool.fetch(url("/redirect-a"));
      expect(result.content).toContain("redirected body");
      expect(validations).toEqual([url("/redirect-a"), url("/redirect-target")]);
    } finally {
      await recordingPool.close();
    }
  });

  it("rejects a denied redirect hop at the route layer", async () => {
    const denyingPool = new NodeBrowserPool({
      policy: fixtureEgressPolicy({ deny: (value) => value.includes("/redirect-target") }),
    });
    pools.push(denyingPool);
    await denyingPool.start();
    try {
      await expect(denyingPool.fetch(url("/redirect-a"))).rejects.toThrow(/fixture policy denied URL: .*\/redirect-target/);
    } finally {
      await denyingPool.close();
    }
  });

  it("rejects a denied main document at the goto layer before navigation", async () => {
    const denyingPool = new NodeBrowserPool({
      policy: fixtureEgressPolicy({ deny: (value) => value.includes("/denied-main") }),
    });
    pools.push(denyingPool);
    await denyingPool.start();
    try {
      await expect(denyingPool.fetch(url("/denied-main"))).rejects.toThrow(/fixture policy denied URL: .*\/denied-main/);
    } finally {
      await denyingPool.close();
    }
  });

  it("aborts an unauthorized subresource silently and still renders the page", async () => {
    const result = await pool.fetch(url("/with-subresource"));
    expect(result.status_code).toBe(200);
    expect(result.content).toContain("rendered ok");
  });

  it("rejects oversized page extraction before materializing content", async () => {
    await expect(pool.fetch(url("/big"))).rejects.toThrow(
      `browser content exceeded ${MAX_BROWSER_CONTENT_BYTES} byte limit`,
    );
  });

  it("rejects oversize screenshots (>25MP) before navigation", async () => {
    const before = server.requests.length;
    await expect(
      pool.screenshot(url("/simple"), { fullPage: false, viewportWidth: 6000, viewportHeight: 5000 }),
    ).rejects.toThrow("browser screenshot exceeded 25000000 pixel limit");
    expect(server.requests.length).toBe(before);
  });

  it("rejects a missing screenshot selector", async () => {
    await expect(pool.screenshot(url("/simple"), { selector: "#does-not-exist" })).rejects.toThrow(
      "browser screenshot selector is not visible: #does-not-exist",
    );
  });

  it("cancellation aborts mid-navigation and releases the context", async () => {
    const controller = new AbortController();
    const pending = pool.fetch(url("/never"), { signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await until(() => pool.activeOperations === 0);
    const healthy = await pool.fetch(url("/simple"));
    expect(healthy.status_code).toBe(200);
  });

  it("survives a page crash (connection refused) and stays usable", async () => {
    const dead = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("unused");
    });
    const deadPort = dead.port;
    await dead.close();
    await expect(pool.fetch(`http://127.0.0.1:${deadPort}/x`)).rejects.toThrow();
    const healthy = await pool.fetch(url("/simple"));
    expect(healthy.status_code).toBe(200);
  });

  it("enforces the maximum number of concurrent contexts", async () => {
    const limited = new NodeBrowserPool({ maxContexts: 2, policy: fixtureEgressPolicy() });
    pools.push(limited);
    await limited.start();
    const pending = [0, 1, 2, 3].map((index) => limited.fetch(url(`/slow?i=${index}`)));
    await until(() => limited.activeOperations === 2 && limited.queuedOperations === 2);
    expect(limited.activeOperations).toBe(2);
    expect(limited.queuedOperations).toBe(2);
    const results = await Promise.all(pending);
    for (const result of results) {
      expect(result.content).toContain("slow done");
    }
    expect(limited.activeOperations).toBe(0);
    expect(limited.queuedOperations).toBe(0);
    await limited.close();
  });

  it("close() drains in-flight operations and rejects new work", async () => {
    const closing = new NodeBrowserPool({ policy: fixtureEgressPolicy() });
    pools.push(closing);
    await closing.start();
    const startedAt = Date.now();
    const inFlight = closing.fetch(url("/slow"));
    const closed = closing.close();
    const result = await inFlight;
    expect(result.content).toContain("slow done");
    await closed;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(700);
    expect(closing.isClosed).toBe(true);
    await expect(closing.fetch(url("/simple"))).rejects.toThrow("browser pool is closed");
  });

  it("strict default policy blocks loopback HTTP (SSRF regression)", async () => {
    const strictPool = new NodeBrowserPool();
    pools.push(strictPool);
    await strictPool.start();
    await expect(strictPool.fetch(url("/simple"))).rejects.toThrow(
      new UnsafeUrlError("browser egress only permits HTTPS URLs"),
    );
    await strictPool.close();
  });

  it("supports the full declarative action allowlist and rejects anything else", async () => {
    const session = await pool.openSession({});
    try {
      await session.action({ action: "navigate", target: null, value: url("/form"), current_url: url("/form"), timeout_seconds: 15 });
      await session.action({ action: "fill", target: "#q", value: "GSE100", current_url: url("/form"), timeout_seconds: 15 });
      await session.action({ action: "select", target: "#s", value: "b", current_url: url("/form"), timeout_seconds: 15 });
      await session.action({ action: "click", target: "#go", value: null, current_url: url("/form"), timeout_seconds: 15 });
      await session.action({ action: "wait_for", target: "#result", value: null, current_url: url("/form"), timeout_seconds: 15 });
      const extracted = await session.action({ action: "extract", target: "#result", value: null, current_url: url("/form"), timeout_seconds: 15 });
      expect(extracted.content.toString("utf8")).toBe("GSE100:b");
      await expect(
        session.action({ action: "eval", target: null, value: "1+1", current_url: url("/form"), timeout_seconds: 15 }),
      ).rejects.toThrow("unsupported browser action: eval");
    } finally {
      await session.close();
    }
  });
});

describe("browser tools", () => {
  let root: string;
  const servers: FixtureServer[] = [];

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "p5-browser-"));
  });

  afterEach(async () => {
    for (const fixture of servers.splice(0)) {
      fixture.server.closeAllConnections();
      await fixture.close();
    }
    await rm(root, { recursive: true, force: true });
  });

  it("navigate_page parses fixture HTML with cheerio", async () => {
    const html = await readFile(path.join(FIXTURES, "browser_page.html"), "utf8");
    const fakePool: BrowserPoolClient = {
      fetch: async (value) => ({
        url: value,
        content: html,
        status_code: 200,
        elapsed_ms: 3,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      screenshot: async () => {
        throw new Error("unused in this test");
      },
    };
    const facade = new CrawlerFacade({ browserPool: fakePool, minInterval: 0 });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const [navigatePage] = createBrowserTools({
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: new PublicHttpClient(),
      crawler: facade,
      hooks: { onQuery: (query, source, status, count) => queries.push([query, source, status, count]) },
    });

    const result = await navigatePage.execute({ url: "https://example.com/paper" });
    const data = JSON.parse(result.content) as Record<string, unknown>;
    expect(data["title"]).toBe("Browser Fixture Page");
    const preview = String(data["body_text_preview"]);
    expect(preview).toContain("First visible paragraph for body text extraction.");
    expect(preview).toContain("Second paragraph with inline markup.");
    expect(preview).not.toContain("fixtureNoise");
    expect(preview).not.toContain("noscript fallback");
    expect(preview.length).toBeLessThanOrEqual(5000);
    expect(data["method_used"]).toBe("crawl");
    expect(data["status_code"]).toBe(200);
    expect(data["content_type"]).toBe("text/html; charset=utf-8");
    expect(queries).toEqual([["https://example.com/paper", "browser", "success", 1]]);
  });

  it("navigate_page degrades exactly like Python when the browser pool is unavailable", async () => {
    const facade = new CrawlerFacade({ minInterval: 0 });
    const [navigatePage] = createBrowserTools({
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: new PublicHttpClient(),
      crawler: facade,
    });

    const result = await navigatePage.execute({ url: "https://example.com/paper" });
    const data = JSON.parse(result.content) as Record<string, unknown>;
    expect(data).toEqual({
      url: "https://example.com/paper",
      status_code: 0,
      method_used: "crawl",
      error: "lifespan-owned browser pool is unavailable",
    });
  });

  it("download_from_page stages a SourceAsset through the sanctioned path", async () => {
    const pdfBytes = Buffer.from("fake pdf content \u00e9");
    const server = await startFixtureServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/data.pdf") {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end(pdfBytes);
      } else {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
      }
    });
    servers.push(server);
    const client = new PublicHttpClient({
      resolve: fakeResolver({ "127.0.0.1": [PUBLIC_IP] }),
      executor: localExecutor(server.port),
    });
    const facade = new CrawlerFacade({ minInterval: 0 });
    const queries: Array<[string, string, string, number | undefined]> = [];
    const [, downloadFromPage] = createBrowserTools({
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client,
      crawler: facade,
      hooks: { onQuery: (query, source, status, count) => queries.push([query, source, status, count]) },
    });

    const url = `http://127.0.0.1:${server.port}/data.pdf`;
    const result = await downloadFromPage.execute({ url, filename: "data.pdf" });
    const data = JSON.parse(result.content) as Record<string, unknown>;
    expect(data["source"]).toBe("browser");
    expect(data["source_url"]).toBe(url);
    expect(data["mime_type"]).toBe("application/pdf");
    expect(data["bytes_received"]).toBe(pdfBytes.length);

    const localFiles = data["local_files"] as string[];
    expect(localFiles).toHaveLength(1);
    const written = await readFile(localFiles[0]);
    expect(written.equals(pdfBytes)).toBe(true);

    const expectedSha = createHash("sha256").update(pdfBytes).digest("hex");
    const asset = data["source_asset"] as Record<string, unknown>;
    expect(asset["sha256"]).toBe(expectedSha);
    expect(asset["asset_id"]).toBe(`asset_${expectedSha}`);
    const attempt = data["download_attempt"] as Record<string, unknown>;
    expect(attempt["status"]).toBe("succeeded");
    expect(attempt["bytes_received"]).toBe(pdfBytes.length);
    expect(attempt["source_id"]).toBe(asset["source_id"]);
    expect(asset["successful_attempt_id"]).toBe(attempt["attempt_id"]);
    expect(data["retrieved_at"]).toBe(attempt["finished_at"]);
    expect(queries).toEqual([["data.pdf", "browser", "success", 1]]);
  });

  it("download_from_page rejects unsafe filenames before any transport", async () => {
    const server = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("unused");
    });
    servers.push(server);
    const [, downloadFromPage] = createBrowserTools({
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: new PublicHttpClient(),
      crawler: new CrawlerFacade({ minInterval: 0 }),
    });

    const result = await downloadFromPage.execute({
      url: `http://127.0.0.1:${server.port}/data`,
      filename: "../escape.bin",
    });
    const data = JSON.parse(result.content) as Record<string, unknown>;
    expect(data["error"]).toBe("source asset filename is unsafe");
    expect(data["source"]).toBe("browser");
    expect(server.requests).toHaveLength(0);
  });

  it("download_from_page rejects an existing flat source asset", async () => {
    await mkdir(path.join(root, "source_assets"), { recursive: true });
    await writeFile(path.join(root, "source_assets", "data.bin"), "original");
    const server = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("unused");
    });
    servers.push(server);
    const [, downloadFromPage] = createBrowserTools({
      taskRoot: root,
      cache: new ContentCache(path.join(root, "cache")),
      client: new PublicHttpClient(),
      crawler: new CrawlerFacade({ minInterval: 0 }),
    });

    const result = await downloadFromPage.execute({
      url: `http://127.0.0.1:${server.port}/data`,
      filename: "data.bin",
    });
    const data = JSON.parse(result.content) as Record<string, unknown>;
    expect(data["error"]).toBe("source asset already exists: data.bin");
    expect(server.requests).toHaveLength(0);
    expect(await readFile(path.join(root, "source_assets", "data.bin"), "utf8")).toBe("original");
  });
});
