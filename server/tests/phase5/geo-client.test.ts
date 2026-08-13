/**
 * P5-04 GEO E-utilities client + listing retry policy (mirrors
 * ``backend/app/integrations/ncbi/client.py`` and the listing tests in
 * ``backend/tests/integration/test_ncbi_skill_adapters.py``).
 */

import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  GeoEutilsClient,
  getGeoListing,
  parseRetryAfter,
  sleepMs,
} from "../../src/external/geo/index.js";
import { PublicHttpClient } from "../../src/external/network/index.js";
import {
  fakeResolver,
  localExecutor,
  PUBLIC_IP,
  startFixtureServer,
  type FixtureServer,
} from "./helpers.js";

const HOST = "eutils.ncbi.nlm.nih.gov";
const FTP_HOST = "ftp.ncbi.nlm.nih.gov";

function clientFor(port: number): PublicHttpClient {
  return new PublicHttpClient({
    resolve: fakeResolver({
      [HOST]: [PUBLIC_IP],
      [FTP_HOST]: [PUBLIC_IP],
    }),
    executor: localExecutor(port),
  });
}

function eutilsConfig(overrides: Record<string, unknown> = {}) {
  return {
    email: "biomed-qagent@example.com",
    tool: "BioMedQAgent",
    userAgent: "BioMedQAgent/1.0",
    baseUrl: `https://${HOST}/entrez/eutils`,
    ...overrides,
  };
}

describe("parse_retry_after parity", () => {
  const now = new Date("2026-08-15T00:00:00Z");

  test("numeric seconds and HTTP dates", () => {
    expect(parseRetryAfter("2", now)).toBe(2);
    expect(parseRetryAfter("0.5", now)).toBe(0.5);
    expect(parseRetryAfter("-3", now)).toBe(0);
    expect(
      parseRetryAfter("Fri, 15 Aug 2026 00:00:10 GMT", now),
    ).toBeCloseTo(10, 5);
    expect(parseRetryAfter("garbage", now)).toBe(0);
    expect(parseRetryAfter(undefined, now)).toBe(0);
  });
});

describe("GeoEutilsClient config validation", () => {
  test("blank identity fields fail closed", () => {
    expect(
      () =>
        new GeoEutilsClient({
          http: clientFor(1),
          config: eutilsConfig({ email: " " }),
        }),
    ).toThrow(/email must not be blank/);
    expect(
      () =>
        new GeoEutilsClient({
          http: clientFor(1),
          config: eutilsConfig({ tool: "" }),
        }),
    ).toThrow(/tool must not be blank/);
    expect(
      () =>
        new GeoEutilsClient({
          http: clientFor(1),
          config: eutilsConfig({ userAgent: "" }),
        }),
    ).toThrow(/user_agent must not be blank/);
  });

  test("retmax and ids validation", async () => {
    const eutils = new GeoEutilsClient({
      http: clientFor(1),
      config: eutilsConfig(),
      sleeper: () => Promise.resolve(),
    });
    await expect(eutils.esearch({ db: "gds", term: "x", retmax: 0 })).rejects.toThrow(
      /retmax must be positive/,
    );
    await expect(eutils.esummary({ db: "gds", ids: [] })).rejects.toThrow(
      /ids must not be empty/,
    );
  });
});

describe("GeoEutilsClient request policy", () => {
  const fixtures: FixtureServer[] = [];
  let root: string;

  beforeEach(async () => {
    const dir = path.join(os.tmpdir(), `p5-geo-client-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    root = dir;
  });

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
    await rm(root, { recursive: true, force: true });
  });

  test("success returns body and sends tool/email params", async () => {
    const fixture = await startFixtureServer((req, res) => {
      expect(req.url).toContain("/entrez/eutils/esearch.fcgi?");
      expect(req.url).toContain("tool=BioMedQAgent");
      expect(req.url).toContain("email=biomed-qagent%40example.com");
      expect(req.url).toContain("db=gds");
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    fixtures.push(fixture);
    const eutils = new GeoEutilsClient({
      http: clientFor(fixture.port),
      config: eutilsConfig(),
      sleeper: () => Promise.resolve(),
    });
    const body = await eutils.esearch({ db: "gds", term: "q", retmax: 5 });
    expect(Buffer.from(body).toString("utf8")).toBe('{"ok":true}');
  });

  test("429/5xx retry honors Retry-After then succeeds", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fixture = await startFixtureServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { "retry-after": "2" });
        res.end("slow down");
        return;
      }
      if (calls === 2) {
        res.writeHead(503);
        res.end("unavailable");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    fixtures.push(fixture);
    const eutils = new GeoEutilsClient({
      http: clientFor(fixture.port),
      config: eutilsConfig(),
      sleeper: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
      jitter: () => 0,
    });
    const body = await eutils.esearch({ db: "gds", term: "q", retmax: 5 });
    expect(Buffer.from(body).toString("utf8")).toBe('{"ok":true}');
    expect(calls).toBe(3);
    // Retry backoffs (Retry-After 2s, then 0.5 * 2^1 + 0 = 1s); the small
    // ~333ms waits are the 3/s rate limiter pacing between attempts.
    expect(sleeps.filter((ms) => ms >= 900)).toEqual([2000, 1000]);
  });

  test("retry is bounded by max_retries", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(503);
      res.end("down");
    });
    fixtures.push(fixture);
    const eutils = new GeoEutilsClient({
      http: clientFor(fixture.port),
      config: eutilsConfig({ maxRetries: 2 }),
      sleeper: () => Promise.resolve(),
    });
    await expect(
      eutils.esearch({ db: "gds", term: "q", retmax: 5 }),
    ).rejects.toThrow(/NCBI returned HTTP 503/);
    await expect(
      eutils.esearch({ db: "gds", term: "q", retmax: 5 }),
    ).rejects.toMatchObject({
      statusCode: 503,
      retryable: true,
    });
  });

  test("non-retryable 4xx is not retried", async () => {
    let calls = 0;
    const fixture = await startFixtureServer((_req, res) => {
      calls += 1;
      res.writeHead(404);
      res.end("not found");
    });
    fixtures.push(fixture);
    const eutils = new GeoEutilsClient({
      http: clientFor(fixture.port),
      config: eutilsConfig(),
      sleeper: () => Promise.resolve(),
    });
    await expect(
      eutils.esearch({ db: "gds", term: "q", retmax: 5 }),
    ).rejects.toThrow(/NCBI returned HTTP 404: not found/);
    expect(calls).toBe(1);
  });

  test("rate limiter paces requests to 3/s without an API key", async () => {
    const sleeps: number[] = [];
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    fixtures.push(fixture);
    const eutils = new GeoEutilsClient({
      http: clientFor(fixture.port),
      config: eutilsConfig(),
      sleeper: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await eutils.esearch({ db: "gds", term: "q", retmax: 5 });
    await eutils.esearch({ db: "gds", term: "q", retmax: 5 });
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(300);
    expect(sleeps[0]).toBeLessThanOrEqual(1000 / 3 + 1);
  });

  test("API key raises the quota to 10/s", async () => {
    const sleeps: number[] = [];
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    fixtures.push(fixture);
    const eutils = new GeoEutilsClient({
      http: clientFor(fixture.port),
      config: eutilsConfig({ apiKey: "secret" }),
      sleeper: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    });
    await eutils.esearch({ db: "gds", term: "q", retmax: 5 });
    await eutils.esearch({ db: "gds", term: "q", retmax: 5 });
    expect(sleeps[0]).toBeGreaterThan(90);
    expect(sleeps[0]).toBeLessThanOrEqual(100 + 1);
  });
});

describe("get_geo_listing retry policy", () => {
  const fixtures: FixtureServer[] = [];
  let root: string;

  beforeEach(async () => {
    const dir = path.join(os.tmpdir(), `p5-geo-listing-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    root = dir;
  });

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
    await rm(root, { recursive: true, force: true });
  });

  test("retries 429/5xx honoring Retry-After (bounded)", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const fixture = await startFixtureServer((_req, res) => {
      calls += 1;
      if (calls === 1) {
        res.writeHead(429, { "retry-after": "2" });
        res.end();
        return;
      }
      if (calls === 2) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html></html>");
    });
    fixtures.push(fixture);
    const response = await getGeoListing(
      clientFor(fixture.port),
      `https://${FTP_HOST}/geo/series/GSE178nnn/GSE178352/suppl/`,
      {
        sleeper: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(calls).toBe(3);
    expect(response.status).toBe(200);
    expect(sleeps).toEqual([2000, 500]);
  });

  test("retries transient transport errors", async () => {
    let calls = 0;
    const fixture = await startFixtureServer((_req, res) => {
      calls += 1;
      if (calls < 3) {
        res.destroy(new Error("ECONNRESET"));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html></html>");
    });
    fixtures.push(fixture);
    const sleeps: number[] = [];
    const response = await getGeoListing(
      clientFor(fixture.port),
      `https://${FTP_HOST}/x/`,
      {
        sleeper: (ms) => {
          sleeps.push(ms);
          return Promise.resolve();
        },
      },
    );
    expect(calls).toBe(3);
    expect(response.status).toBe(200);
    expect(sleeps).toEqual([250, 500]);
  });

  test("bounded: keeps raising after attempts are exhausted", async () => {
    let calls = 0;
    const fixture = await startFixtureServer((_req, res) => {
      calls += 1;
      res.writeHead(503);
      res.end();
    });
    fixtures.push(fixture);
    await expect(
      getGeoListing(clientFor(fixture.port), `https://${FTP_HOST}/x/`, {
        sleeper: () => Promise.resolve(),
      }),
    ).rejects.toThrow(/listing returned HTTP 503/);
    expect(calls).toBe(3);
  });

  test("non-retryable 4xx is returned to the caller", async () => {
    const fixture = await startFixtureServer((_req, res) => {
      res.writeHead(404);
      res.end("missing");
    });
    fixtures.push(fixture);
    const response = await getGeoListing(
      clientFor(fixture.port),
      `https://${FTP_HOST}/x/`,
      { sleeper: () => Promise.resolve() },
    );
    expect(response.status).toBe(404);
  });
});

describe("sleepMs", () => {
  test("resolves after the given delay", async () => {
    const started = Date.now();
    await sleepMs(20);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });
});
