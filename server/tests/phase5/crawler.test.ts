/**
 * P5-07 crawler tests (mirror of ``backend/tests/test_tools_crawler.py``):
 * api → html → browser fallback audit, rate limiting with an injected
 * fast interval, per-host pacing lanes, response/download caps, browser tier
 * delegation, and per-hop redirect re-validation.
 */

import { afterEach, describe, expect, it } from "vitest";

import {
  BROWSER_HEADERS,
  CrawlError,
  CrawlerFacade,
  AsyncHostRateLimiter,
  fetchWithFallback,
  type BrowserPoolClient,
  type FetchResult,
} from "../../src/external/crawler/index.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import { fakeResolver, localExecutor, PUBLIC_IP, startFixtureServer, type FixtureServer } from "./helpers.js";

const HOST = "public.example";

function result(overrides: Partial<FetchResult> = {}): FetchResult {
  return {
    url: "https://public.example/data",
    content: "ok",
    status_code: 200,
    elapsed_ms: 1,
    method_used: "api",
    error: null,
    headers: {},
    attempts: [],
    ok: true,
    ...overrides,
  };
}

class FakeCrawlerFacade {
  readonly calls: string[] = [];

  constructor(private readonly results: Record<string, FetchResult>) {}

  async api(): Promise<FetchResult> {
    this.calls.push("api");
    return this.results["api"];
  }

  async html(): Promise<FetchResult> {
    this.calls.push("html");
    return this.results["html"];
  }

  async browser(): Promise<FetchResult> {
    this.calls.push("browser");
    return this.results["browser"];
  }
}

function failed(overrides: Partial<FetchResult>): FetchResult {
  return {
    url: "https://failed.example/data",
    content: "",
    status_code: 500,
    elapsed_ms: 1,
    method_used: "api",
    error: "tier failed",
    headers: {},
    attempts: [],
    ok: false,
    ...overrides,
  };
}

describe("fetchWithFallback tier chain", () => {
  it("runs api then html then browser with a complete attempt audit", async () => {
    const facade = new FakeCrawlerFacade({
      api: failed({ method_used: "api", error: "api failed", status_code: 500 }),
      html: result({ method_used: "httpx", content: "<div id='app'></div>" }),
      browser: result({ method_used: "crawl", content: "<p>rendered data</p>" }),
    });

    const outcome = await fetchWithFallback("https://api.example/data", {
      pageUrl: "https://page.example/data",
      facade,
      acceptResult: (candidate) => candidate.content.includes("rendered"),
    });

    expect(facade.calls).toEqual(["api", "html", "browser"]);
    expect(outcome.attempts.map((attempt) => attempt.method)).toEqual(["api", "html", "browser"]);
    expect(outcome.attempts[0].reason).toBe("api failed");
    expect(outcome.attempts[1].reason).toBe("semantic acceptance predicate rejected result");
    expect(outcome.attempts[2].status).toBe("succeeded");
    expect(outcome.attempts[2].fallback_reason).toBeNull();
  });

  it("stops after an accepted api result", async () => {
    const facade = new FakeCrawlerFacade({
      api: result({ method_used: "api", content: '{"data": 1}' }),
      html: result({ method_used: "httpx" }),
      browser: result({ method_used: "crawl" }),
    });

    const outcome = await fetchWithFallback("https://api.example/data", { facade });

    expect(outcome.method_used).toBe("api");
    expect(facade.calls).toEqual(["api"]);
    expect(outcome.attempts).toHaveLength(1);
  });

  it("fails closed without a run-bound facade", async () => {
    await expect(fetchWithFallback("https://api.example/data")).rejects.toThrow(
      new CrawlError("crawler facade is not bound to the current Run", []),
    );
  });

  it("reports all failed tiers with their reasons", async () => {
    const facade = new FakeCrawlerFacade({
      api: failed({ method_used: "api", error: "api failed" }),
      html: failed({ method_used: "httpx", error: "html failed" }),
      browser: failed({ method_used: "crawl", error: "browser failed" }),
    });

    let caught: CrawlError | null = null;
    try {
      await fetchWithFallback("https://api.example/data", {
        pageUrl: "https://page.example/data",
        facade,
      });
    } catch (error) {
      caught = error instanceof CrawlError ? error : null;
    }

    expect(caught).not.toBeNull();
    expect(caught?.message).toContain("All fetch tiers failed");
    expect(caught?.attempts.map((attempt) => attempt.method)).toEqual(["api", "html", "browser"]);
    expect(caught?.attempts.map((attempt) => attempt.reason)).toEqual([
      "api failed",
      "html failed",
      "browser failed",
    ]);
  });
});

describe("AsyncHostRateLimiter pacing", () => {
  it("does not serialize different hosts while pacing the same host", async () => {
    const sleeps: number[] = [];
    const lane: { release: (() => void) | null } = { release: null };
    const limiter = new AsyncHostRateLimiter({
      minInterval: 1,
      clock: () => 0,
      sleeper: (delay) => {
        sleeps.push(delay);
        return new Promise<void>((resolve) => {
          lane.release = resolve;
        });
      },
    });

    await limiter.wait("https://host-a.example/first");
    const sameHost = limiter.wait("https://HOST-A.example/second");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // The same-host lane is parked on the sleeper; a different host is free.
    await limiter.wait("https://host-b.example/first");
    expect(sleeps).toHaveLength(1);
    lane.release?.();
    await sameHost;
    expect(sleeps).toEqual([1]);
  });

  it("bounds one-off host state (LRU eviction)", async () => {
    const limiter = new AsyncHostRateLimiter({ minInterval: 0, maxHosts: 4 });
    for (let index = 0; index < 20; index += 1) {
      await limiter.wait(`https://host-${index}.example/data`);
    }
    expect(limiter.trackedHostCount).toBe(4);
  });

  it("normalizes hostnames case-insensitively with trailing-dot stripping", async () => {
    const limiter = new AsyncHostRateLimiter({ minInterval: 0 });
    await limiter.wait("https://Host-A.example/x");
    await limiter.wait("https://host-a.example./y");
    expect(limiter.trackedHostCount).toBe(1);
  });
});

describe("CrawlerFacade", () => {
  const fixtures: FixtureServer[] = [];

  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) {
      fixture.server.closeAllConnections();
      await fixture.close();
    }
  });

  it("shares one per-host pacing lane across the html and browser tiers", async () => {
    const sleeps: number[] = [];
    const limiter = new AsyncHostRateLimiter({
      minInterval: 1,
      clock: () => 0,
      sleeper: (delay) => {
        sleeps.push(delay);
        return Promise.resolve();
      },
    });
    const browserPool: BrowserPoolClient = {
      fetch: async (url) => ({
        url,
        content: "<html>rendered</html>",
        status_code: 200,
        elapsed_ms: 1,
        headers: {},
      }),
      screenshot: async () => {
        throw new Error("unused in this test");
      },
    };
    const facade = new CrawlerFacade({ browserPool, minInterval: 0, limiter });

    await facade.html("https://host-a.example/page");
    await facade.browser("https://host-a.example/page");
    await facade.browser("https://host-b.example/page");
    await facade.aclose();

    // Only the second request to host-a had to wait for the interval.
    expect(sleeps).toEqual([1]);
  });

  it("delegates the browser tier to the bound pool and reports it as crawl", async () => {
    const browserPool: BrowserPoolClient = {
      fetch: async (url) => ({
        url,
        content: "<html>rendered by chromium</html>",
        status_code: 200,
        elapsed_ms: 7,
        headers: { "content-type": "text/html" },
      }),
      screenshot: async () => {
        throw new Error("unused in this test");
      },
    };
    const facade = new CrawlerFacade({ browserPool, minInterval: 0 });
    const outcome = await facade.browser("https://public.example/page");
    expect(outcome.method_used).toBe("crawl");
    expect(outcome.ok).toBe(true);
    expect(outcome.content).toContain("rendered by chromium");
    await facade.aclose();
  });

  it("degrades to an explicit unavailable error without a bound pool", async () => {
    const facade = new CrawlerFacade({ minInterval: 0 });
    const outcome = await facade.browser("https://public.example/page");
    expect(outcome.ok).toBe(false);
    expect(outcome.status_code).toBe(0);
    expect(outcome.method_used).toBe("crawl");
    expect(outcome.error).toBe("lifespan-owned browser pool is unavailable");
    await facade.aclose();
  });

  it("rejects oversized responses and downloads with the configured caps", async () => {
    const server = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end("123456789");
    });
    fixtures.push(server);
    const client = new PublicHttpClient({
      resolve: fakeResolver({ [HOST]: [PUBLIC_IP] }),
      executor: localExecutor(server.port),
    });
    const facade = new CrawlerFacade({
      minInterval: 0,
      client,
      responseCap: 8,
      downloadCap: 8,
    });

    const text = await facade.html(`https://${HOST}/data`);
    const binary = await facade.download(`https://${HOST}/data`);
    await facade.aclose();

    expect(text.ok).toBe(false);
    expect(text.error).toBe("crawler response exceeded 8 byte limit");
    expect(text.content).toBe("");
    expect(binary.ok).toBe(false);
    expect(binary.error).toBe("crawler download exceeded 8 byte limit");
    expect(binary.content).toHaveLength(0);
  });

  it("re-validates every redirect hop against the public-URL policy", async () => {
    const resolved: string[] = [];
    const server = await startFixtureServer((req, res) => {
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      if (pathname === "/start") {
        res.writeHead(302, { location: `https://other.example/secret` });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("secret");
      }
    });
    fixtures.push(server);
    const base = fakeResolver({ [HOST]: [PUBLIC_IP] });
    const client = new PublicHttpClient({
      resolve: async (hostname) => {
        resolved.push(hostname);
        return base(hostname);
      },
      executor: localExecutor(server.port),
    });
    const facade = new CrawlerFacade({ minInterval: 0, client });

    const outcome = await facade.download(`https://${HOST}/start`);
    await facade.aclose();

    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("URL hostname could not be resolved: other.example");
    // Each hop is resolved for validation and again for pinning.
    expect([...new Set(resolved)]).toEqual([HOST, "other.example"]);
  });

  it("exposes browser headers with the required fields", () => {
    expect(BROWSER_HEADERS["User-Agent"]).toContain("Chrome");
    expect(BROWSER_HEADERS["Referer"]).toBeDefined();
    expect(BROWSER_HEADERS["Accept"]).toBeDefined();
    expect(BROWSER_HEADERS["Accept-Language"]).toBeDefined();
  });
});
