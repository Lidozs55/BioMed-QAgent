/**
 * Unified crawler layer — three-tier fallback chain: api > html > crawl
 * (Python ``app/tools/crawler.py`` parity).
 *
 * All crawler traffic uses the real browser User-Agent, Referer, and 2s
 * per-host rate limiting. HTTP tiers ride ``PublicHttpClient`` (public-URL
 * policy, per-hop redirect re-validation, address pinning); the browser tier
 * rides the shared ``NodeBrowserPool``.
 *
 * Deviations from the Python crawler (documented):
 *
 * - Python re-runs the per-host limiter for every redirect hop inside its
 *   hand-rolled httpx loop. The Node client owns the redirect loop (bounded
 *   by ``MAX_CRAWLER_REDIRECTS``, each hop still re-validated against the
 *   public-URL policy), so pacing applies once per request rather than once
 *   per hop.
 * - The redirect-cap message comes from the shared client
 *   ("download exceeded redirect limit") instead of Python's
 *   "crawler exceeded N redirects".
 */

import { BROWSER_UA, type BrowserFetchOptions, type BrowserFetchResult, type BrowserRedirectHop, type BrowserRequestAuthorizer, type BrowserScreenshotOptions, type BrowserScreenshotResult } from "../browser/pool.js";
import { PublicHttpClient, type HttpClientResponse } from "../network/http-client.js";
import { AsyncHostRateLimiter, DEFAULT_RATE_LIMIT_SECONDS } from "./rate-limit.js";

/** Default headers for all crawler requests (project_memory L11). */
export const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": BROWSER_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
  Referer: "https://www.google.com/",
};

export const MAX_CRAWLER_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_CRAWLER_DOWNLOAD_BYTES = 4096 * 1024 * 1024; // 4 GiB: dataset-scale downloads
export const MAX_CRAWLER_REDIRECTS = 10;

export type CrawlerMethodUsed = "api" | "httpx" | "crawl";

export interface FetchResult {
  url: string;
  content: string;
  status_code: number;
  elapsed_ms: number;
  method_used: CrawlerMethodUsed;
  error: string | null;
  headers: Record<string, string>;
  /** Main-frame redirects followed by the rendered browser tier. */
  redirect_chain?: BrowserRedirectHop[];
  attempts: CrawlAttempt[];
  /** Python ``FetchResult.ok``. */
  ok: boolean;
}

export interface DownloadResult {
  url: string;
  content: Buffer;
  status_code: number;
  elapsed_ms: number;
  headers: Record<string, string>;
  error: string | null;
  ok: boolean;
}

export interface CrawlAttempt {
  method: string;
  url: string;
  started_at: string;
  status: "succeeded" | "failed";
  status_code: number | null;
  reason: string | null;
  fallback_reason: string | null;
}

export class CrawlError extends Error {
  readonly attempts: CrawlAttempt[];

  constructor(message: string, attempts: CrawlAttempt[]) {
    super(message);
    this.name = "CrawlError";
    this.attempts = attempts;
  }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.constructor.name}: ${error.message}`;
  return String(error);
}

/** Structural surface the facade consumes from ``NodeBrowserPool``. */
export interface BrowserPoolClient {
  fetch(url: string, options?: BrowserFetchOptions): Promise<BrowserFetchResult>;
  screenshot(url: string, options?: BrowserScreenshotOptions): Promise<BrowserScreenshotResult>;
}

export interface CrawlerFacadeOptions {
  browserPool?: BrowserPoolClient | null;
  minInterval?: number;
  client?: PublicHttpClient;
  limiter?: AsyncHostRateLimiter;
  /** Injectable response cap (Python monkeypatches the module constant). */
  responseCap?: number;
  /** Injectable download cap (Python monkeypatches the module constant). */
  downloadCap?: number;
  /** Injectable redirect bound (Python monkeypatches the module constant). */
  redirectCap?: number;
  browserTimeoutMs?: number;
}

export interface ApiRequestOptions {
  method?: "GET" | "POST";
  jsonBody?: Record<string, unknown>;
  rawBody?: string;
  signal?: AbortSignal;
}

export interface CrawlerScreenshotOptions {
  fullPage?: boolean;
  selector?: string | null;
  viewportWidth?: number;
  viewportHeight?: number;
  waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
  authorizeRequest?: BrowserRequestAuthorizer;
  signal?: AbortSignal;
}

export class CrawlerFacade {
  private readonly browserPool: BrowserPoolClient | null;
  private readonly limiter: AsyncHostRateLimiter;
  private readonly client: PublicHttpClient;
  private readonly responseCap: number;
  private readonly downloadCap: number;
  private readonly redirectCap: number;
  private readonly browserTimeoutMs: number | undefined;
  private closed = false;

  constructor(options: CrawlerFacadeOptions = {}) {
    this.browserPool = options.browserPool ?? null;
    this.limiter =
      options.limiter ??
      new AsyncHostRateLimiter({ minInterval: options.minInterval ?? DEFAULT_RATE_LIMIT_SECONDS });
    this.client = options.client ?? new PublicHttpClient();
    this.responseCap = options.responseCap ?? MAX_CRAWLER_RESPONSE_BYTES;
    this.downloadCap = options.downloadCap ?? MAX_CRAWLER_DOWNLOAD_BYTES;
    this.redirectCap = options.redirectCap ?? MAX_CRAWLER_REDIRECTS;
    this.browserTimeoutMs = options.browserTimeoutMs;
  }

  /** Expose the shared host pacing lane (used by the sanctioned download path). */
  async pace(url: string): Promise<void> {
    await this.limiter.wait(url);
  }

  /** Fetch structured API content (Python ``CrawlerFacade.api``). */
  async api(url: string, signal?: AbortSignal): Promise<FetchResult> {
    return this.apiRequest(url, { signal });
  }

  /** Send one pinned API request (Python ``CrawlerFacade.api_request``). */
  async apiRequest(url: string, options: ApiRequestOptions = {}): Promise<FetchResult> {
    const method = (options.method ?? "GET").toUpperCase().trim();
    if (method !== "GET" && method !== "POST") {
      throw new Error("crawler API method must be GET or POST");
    }
    if (options.jsonBody !== undefined && options.rawBody !== undefined) {
      throw new Error("crawler API body must be either JSON or raw text, not both");
    }
    const contentType = options.rawBody !== undefined ? "text/plain" : "application/json";
    const body =
      options.rawBody !== undefined ? options.rawBody : options.jsonBody !== undefined ? JSON.stringify(options.jsonBody) : undefined;
    return this.request(url, {
      methodUsed: "api",
      method,
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "application/json",
        "Content-Type": contentType,
      },
      body,
      signal: options.signal,
    });
  }

  /** Fetch static HTML content (Python ``CrawlerFacade.html``). */
  async html(url: string, signal?: AbortSignal): Promise<FetchResult> {
    return this.request(url, {
      methodUsed: "httpx",
      headers: BROWSER_HEADERS,
      signal,
    });
  }

  /** Render content through the shared browser pool (Python ``CrawlerFacade.browser``). */
  async browser(url: string, signal?: AbortSignal): Promise<FetchResult> {
    if (this.closed) {
      return failedFetch(url, "crawl", "crawler facade is closed");
    }
    const pool = this.browserPool;
    if (pool === null) {
      return failedFetch(url, "crawl", "lifespan-owned browser pool is unavailable");
    }
    const startedAt = Date.now();
    try {
      await this.limiter.wait(url);
      const result = await pool.fetch(url, {
        extraHeaders: { ...BROWSER_HEADERS },
        timeoutMs: this.browserTimeoutMs,
        signal,
      });
      return {
        url: result.url,
        content: result.content,
        status_code: result.status_code,
        elapsed_ms: result.elapsed_ms,
        method_used: "crawl",
        error: null,
        headers: result.headers,
        redirect_chain: result.redirect_chain ?? [],
        attempts: [],
        ok: result.status_code >= 200 && result.status_code < 300,
      };
    } catch (error) {
      if (signal?.aborted === true) throw error;
      return failedFetch(url, "crawl", errorText(error), Date.now() - startedAt);
    }
  }

  /** Download bounded binary content through the pinned HTTP path. */
  async download(url: string, signal?: AbortSignal): Promise<DownloadResult> {
    const startedAt = Date.now();
    try {
      await this.limiter.wait(url);
      const response = await this.client.request(url, {
        headers: { ...BROWSER_HEADERS },
        maxRedirects: this.redirectCap,
        validateRedirect: async () => undefined,
        signal,
      });
      return await this.downloadResponse(response, startedAt);
    } catch (error) {
      if (signal?.aborted === true) throw error;
      return {
        url,
        content: Buffer.alloc(0),
        status_code: 0,
        elapsed_ms: Date.now() - startedAt,
        headers: {},
        error: errorText(error),
        ok: false,
      };
    }
  }

  /** Capture a screenshot through the shared limiter and browser pool. */
  async screenshot(url: string, options: CrawlerScreenshotOptions = {}): Promise<BrowserScreenshotResult> {
    if (this.closed) {
      throw new Error("crawler facade is closed");
    }
    const pool = this.browserPool;
    if (pool === null) {
      throw new Error("lifespan-owned browser pool is unavailable");
    }
    await this.limiter.wait(url);
    return pool.screenshot(url, {
      fullPage: options.fullPage,
      selector: options.selector,
      viewportWidth: options.viewportWidth,
      viewportHeight: options.viewportHeight,
      waitUntil: options.waitUntil,
      timeoutMs: options.timeoutMs ?? this.browserTimeoutMs,
      extraHeaders: options.extraHeaders,
      authorizeRequest: options.authorizeRequest,
      signal: options.signal,
    });
  }

  async aclose(): Promise<void> {
    this.closed = true;
  }

  private async request(
    url: string,
    options: {
      methodUsed: "api" | "httpx";
      method?: "GET" | "POST";
      headers: Readonly<Record<string, string>>;
      body?: string;
      signal?: AbortSignal;
    },
  ): Promise<FetchResult> {
    const startedAt = Date.now();
    try {
      if (this.closed) {
        throw new Error("crawler facade is closed");
      }
      await this.limiter.wait(url);
      const response = await this.client.request(url, {
        method: options.method ?? "GET",
        headers: { ...options.headers },
        body: options.body,
        maxRedirects: this.redirectCap,
        validateRedirect: async () => undefined,
        signal: options.signal,
      });
      return await this.textResponse(response, startedAt, options.methodUsed);
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      return failedFetch(url, options.methodUsed, errorText(error), Date.now() - startedAt);
    }
  }

  private async textResponse(
    response: HttpClientResponse,
    startedAt: number,
    methodUsed: "api" | "httpx",
  ): Promise<FetchResult> {
    const declaredLength = response.headers["content-length"] ?? response.headers["Content-Length"] ?? "";
    if (declaredLength !== "" && Number.parseInt(declaredLength, 10) > this.responseCap) {
      await response.discard();
      return {
        url: response.url,
        content: "",
        status_code: response.status,
        elapsed_ms: Date.now() - startedAt,
        method_used: methodUsed,
        error: `crawler response exceeded ${this.responseCap} byte limit`,
        headers: response.headers,
        attempts: [],
        ok: false,
      };
    }
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > this.responseCap) {
        return {
          url: response.url,
          content: "",
          status_code: response.status,
          elapsed_ms: Date.now() - startedAt,
          method_used: methodUsed,
          error: `crawler response exceeded ${this.responseCap} byte limit`,
          headers: response.headers,
          attempts: [],
          ok: false,
        };
      }
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks).toString("utf8");
    return {
      url: response.url,
      content,
      status_code: response.status,
      elapsed_ms: Date.now() - startedAt,
      method_used: methodUsed,
      error: null,
      headers: response.headers,
      attempts: [],
      ok: response.status >= 200 && response.status < 300,
    };
  }

  private async downloadResponse(response: HttpClientResponse, startedAt: number): Promise<DownloadResult> {
    const declaredLength = response.headers["content-length"] ?? response.headers["Content-Length"] ?? "";
    if (declaredLength !== "" && Number.parseInt(declaredLength, 10) > this.downloadCap) {
      await response.discard();
      return oversizedDownload(response.url, response.status, Date.now() - startedAt, response.headers, this.downloadCap);
    }
    const chunks: Buffer[] = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > this.downloadCap) {
        return oversizedDownload(response.url, response.status, Date.now() - startedAt, response.headers, this.downloadCap);
      }
      chunks.push(chunk);
    }
    return {
      url: response.url,
      content: Buffer.concat(chunks),
      status_code: response.status,
      elapsed_ms: Date.now() - startedAt,
      headers: response.headers,
      error: null,
      ok: response.status >= 200 && response.status < 300,
    };
  }
}

function failedFetch(url: string, methodUsed: CrawlerMethodUsed, error: string, elapsedMs = 0): FetchResult {
  return {
    url,
    content: "",
    status_code: 0,
    elapsed_ms: elapsedMs,
    method_used: methodUsed,
    error,
    headers: {},
    attempts: [],
    ok: false,
  };
}

function oversizedDownload(url: string, statusCode: number, elapsedMs: number, headers: Record<string, string>, cap: number): DownloadResult {
  return {
    url,
    content: Buffer.alloc(0),
    status_code: statusCode,
    elapsed_ms: elapsedMs,
    headers,
    error: `crawler download exceeded ${cap} byte limit`,
    ok: false,
  };
}

export interface CrawlerFacadeLike {
  api(url: string, signal?: AbortSignal): Promise<FetchResult>;
  html(url: string, signal?: AbortSignal): Promise<FetchResult>;
  browser(url: string, signal?: AbortSignal): Promise<FetchResult>;
}

export interface FetchWithFallbackOptions {
  pageUrl?: string | null;
  sourceName?: string;
  useCrawlFallback?: boolean;
  acceptResult?: (result: FetchResult) => boolean;
  facade?: CrawlerFacadeLike;
  signal?: AbortSignal;
}

/**
 * Run the exact API → HTML → browser fallback sequence with a complete
 * attempt audit (Python ``fetch_with_fallback``). Throws ``CrawlError`` when
 * every tier fails; cancellation propagates.
 */
export async function fetchWithFallback(apiUrl: string | null, options: FetchWithFallbackOptions = {}): Promise<FetchResult> {
  let pageUrl = options.pageUrl ?? null;
  if (pageUrl === null) {
    if (apiUrl === null) {
      throw new Error("api_url or page_url is required");
    }
    pageUrl = apiUrl;
  }
  const facade = options.facade;
  if (facade === undefined) {
    throw new CrawlError("crawler facade is not bound to the current Run", []);
  }
  const sourceName = options.sourceName ?? "unknown";
  const acceptResult = options.acceptResult ?? (() => true);

  const tiers: Array<{ method: string; legacy: CrawlerMethodUsed; url: string; run: () => Promise<FetchResult> }> = [];
  if (apiUrl !== null) {
    tiers.push({ method: "api", legacy: "api", url: apiUrl, run: () => facade.api(apiUrl, options.signal) });
  }
  tiers.push({ method: "html", legacy: "httpx", url: pageUrl, run: () => facade.html(pageUrl, options.signal) });
  if (options.useCrawlFallback ?? true) {
    tiers.push({ method: "browser", legacy: "crawl", url: pageUrl, run: () => facade.browser(pageUrl, options.signal) });
  }

  const attempts: CrawlAttempt[] = [];
  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index];
    const startedAt = new Date().toISOString();
    let result: FetchResult;
    try {
      result = await tier.run();
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      result = failedFetch(tier.url, tier.legacy, errorText(error));
    }
    let accepted = result.ok;
    if (accepted) {
      accepted = acceptResult(result);
    }
    const reason = attemptReason(result, accepted);
    attempts.push({
      method: tier.method,
      url: tier.url,
      started_at: startedAt,
      status: accepted ? "succeeded" : "failed",
      status_code: result.status_code > 0 ? result.status_code : null,
      reason,
      fallback_reason: !accepted && index + 1 < tiers.length ? `falling back to ${tiers[index + 1].method}` : null,
    });
    if (accepted) {
      return { ...result, attempts };
    }
  }
  throw new CrawlError(
    `All fetch tiers failed for ${sourceName}. Tried: ${attempts.map((attempt) => attempt.method).join(", ")}`,
    attempts,
  );
}

function attemptReason(result: FetchResult, accepted: boolean): string | null {
  if (accepted) return null;
  if (result.error !== null) return result.error;
  if (result.ok) return "semantic acceptance predicate rejected result";
  if (result.status_code > 0) return `HTTP ${result.status_code}`;
  return "transport returned no successful response";
}
