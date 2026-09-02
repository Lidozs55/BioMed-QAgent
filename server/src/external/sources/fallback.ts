/**
 * Shared three-tier fallback fetch for the research-only source clients
 * (Python ``app/tools/crawler.fetch_with_fallback`` parity).
 *
 * Tier chain: api (PublicHttpClient) → html (PublicHttpClient with browser
 * headers) → crawl (injectable rendered-browser fallback; the Node browser
 * pool arrives in a later Phase 5 checkpoint). Every tier runs through the
 * client's public-URL policy with per-hop re-validation, and API/HTML bodies
 * are read into memory with a bounded cap (Python ``MAX_CRAWLER_RESPONSE_BYTES``).
 *
 * The attempt audit mirrors ``CrawlAttempt``: tier method names ("api",
 * "html", "browser"), ``status``/``status_code``/``reason``/``fallback_reason``.
 * ``method_used`` on the accepted result uses the legacy names ("api",
 * "httpx", "crawl") exactly like Python ``FetchResult.method_used``.
 */

import { createHash } from "node:crypto";

import { DEFAULT_RUNTIME_LIMITS } from "@biomed/contracts";

import type { Database } from "../../dataset/contracts/enums.js";
import { AsyncHostRateLimiter } from "../crawler/rate-limit.js";
import { isAbortError } from "../network/errors.js";
import type {
  HttpClientResponse,
  PublicHttpClient,
} from "../network/http-client.js";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  "User-Agent": BROWSER_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
  Referer: "https://www.google.com/",
};

/** Python ``MAX_CRAWLER_RESPONSE_BYTES``: bounded in-memory tier responses. */
export const MAX_API_RESPONSE_BYTES = 10 * 1024 * 1024;
export const MAX_BODY_CHARS = 5000;
/**
 * Fallback pacing for callers that omit ``rateLimitMs``; derived from the
 * ``request_interval_ms`` settings default so it cannot drift from the
 * configured default (2026-09-02 audit P0-4). Production callers pass the
 * live settings value.
 */
export const DEFAULT_RATE_LIMIT_MS = DEFAULT_RUNTIME_LIMITS.request_interval_ms;

/** BeautifulSoup-style visible text: strip script/style/head/noscript, tags, collapse whitespace. */
export function visibleText(html: string): string {
  return html
    .replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .join(" ");
}

/** Python ``_HIGHLIGHT_RE`` parity: strip highlight spans from Reactome fields. */
export function stripHtml(text: string): string {
  if (!text) return "";
  return text.replace(/<[^>]+>/g, "").trim();
}

/** Python ``urllib.parse.quote`` default (safe="/") parity. */
export function quoteQuery(value: string): string {
  return encodeURIComponent(value).replace(/%2F/gi, "/");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export class ResponseTooLargeError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`crawler response exceeded ${limit} byte limit`);
    this.name = "ResponseTooLargeError";
    this.limit = limit;
  }
}

/** Drain a streaming response body into memory with a hard cap (Python parity). */
export async function readBodyCapped(
  response: HttpClientResponse,
  maxBytes: number = MAX_API_RESPONSE_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > maxBytes) throw new ResponseTooLargeError(maxBytes);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface FallbackAttempt {
  /** Tier name: "api" | "html" | "browser". */
  method: string;
  url: string;
  status: "succeeded" | "failed";
  status_code: number | null;
  reason: string | null;
  fallback_reason: string | null;
}

export class FallbackFailure extends Error {
  readonly attempts: readonly FallbackAttempt[];

  constructor(message: string, attempts: readonly FallbackAttempt[]) {
    super(message);
    this.name = "FallbackFailure";
    this.attempts = attempts;
  }
}

export interface BrowserFallbackResult {
  status_code: number;
  body_text_preview: string;
}

/**
 * Injectable rendered-browser fallback (Python crawler "crawl" tier). The
 * browser pool arrives in a later checkpoint; tools accept this optional
 * callback, and the tier fails when it is absent.
 */
export type BrowserFallback = (url: string) => Promise<BrowserFallbackResult>;

const sharedLimiters = new Map<number, AsyncHostRateLimiter>();

export async function rateLimit(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return;
  let limiter = sharedLimiters.get(minIntervalMs);
  if (limiter === undefined) {
    limiter = new AsyncHostRateLimiter({ minInterval: minIntervalMs / 1000 });
    sharedLimiters.set(minIntervalMs, limiter);
  }
  await limiter.wait("https://shared-source-pacing.invalid");
}

export interface ApiFetchOptions {
  method?: "GET" | "POST";
  jsonBody?: unknown;
  signal?: AbortSignal;
  rateLimitMs?: number;
}

export interface ApiFetchResult {
  content: string;
  status_code: number;
  url: string;
}

/** One rate-limited API request (Python ``fetch_json`` semantics, bounded body). */
export async function apiFetch(
  client: PublicHttpClient,
  url: string,
  options: ApiFetchOptions = {},
): Promise<ApiFetchResult> {
  await rateLimit(options.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS);
  const response = await client.request(url, {
    method: options.method ?? "GET",
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "application/json",
      ...(options.jsonBody !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: options.jsonBody !== undefined ? JSON.stringify(options.jsonBody) : undefined,
    signal: options.signal,
  });
  const content = await readBodyCapped(response);
  return { content, status_code: response.status, url: response.url };
}

export interface FallbackFetchResult {
  method_used: "api" | "httpx" | "crawl";
  content: string;
  status_code: number;
  url: string;
  attempts: readonly FallbackAttempt[];
}

export interface FallbackFetchOptions {
  sourceName: string;
  apiUrl: string;
  pageUrl: string;
  /** Semantic acceptance predicate (Python ``accept_result``); default accepts all. */
  acceptResult?: (methodUsed: "api" | "httpx" | "crawl", content: string) => boolean;
  client: PublicHttpClient;
  browserFallback?: BrowserFallback;
  signal?: AbortSignal;
  rateLimitMs?: number;
}

interface FallbackTier {
  method: string;
  methodUsed: "api" | "httpx" | "crawl";
  url: string;
  run: () => Promise<ApiFetchResult>;
}

/**
 * Exact API → HTML → browser fallback sequence with a complete attempt audit
 * (Python ``fetch_with_fallback``). Throws ``FallbackFailure`` when every tier
 * fails; cancellation and predicate exceptions propagate.
 */
export async function fallbackFetch(options: FallbackFetchOptions): Promise<FallbackFetchResult> {
  const acceptResult = options.acceptResult ?? (() => true);
  const rateLimitMs = options.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
  const attempts: FallbackAttempt[] = [];

  const tiers: readonly FallbackTier[] = [
    {
      method: "api",
      methodUsed: "api",
      url: options.apiUrl,
      run: () => apiFetch(options.client, options.apiUrl, { signal: options.signal, rateLimitMs: options.rateLimitMs }),
    },
    {
      method: "html",
      methodUsed: "httpx",
      url: options.pageUrl,
      run: async () => {
        await rateLimit(rateLimitMs);
        const response = await options.client.request(options.pageUrl, {
          headers: BROWSER_HEADERS,
          signal: options.signal,
        });
        const content = await readBodyCapped(response);
        return { content, status_code: response.status, url: response.url };
      },
    },
    {
      method: "browser",
      methodUsed: "crawl",
      url: options.pageUrl,
      run: async () => {
        await rateLimit(rateLimitMs);
        const fallback = options.browserFallback;
        if (fallback === undefined) {
          throw new Error("lifespan-owned browser pool is unavailable");
        }
        const result = await fallback(options.pageUrl);
        return { content: result.body_text_preview, status_code: result.status_code, url: options.pageUrl };
      },
    },
  ];

  for (let index = 0; index < tiers.length; index += 1) {
    const tier = tiers[index];
    let fetched: ApiFetchResult | null = null;
    let transportError: string | null = null;
    try {
      fetched = await tier.run();
    } catch (error) {
      if (isAbortError(error) || options.signal?.aborted === true) throw error;
      transportError = error instanceof Error ? error.message : String(error);
    }
    const ok = fetched !== null && fetched.status_code >= 200 && fetched.status_code < 300;
    let accepted = ok;
    if (accepted && fetched !== null) {
      accepted = acceptResult(tier.methodUsed, fetched.content);
    }
    let reason: string | null = null;
    if (!accepted) {
      reason =
        transportError ??
        (ok
          ? "semantic acceptance predicate rejected result"
          : fetched !== null && fetched.status_code > 0
            ? `HTTP ${fetched.status_code}`
            : "transport returned no successful response");
    }
    attempts.push({
      method: tier.method,
      url: fetched !== null ? fetched.url : tier.url,
      status: accepted ? "succeeded" : "failed",
      status_code: fetched !== null && fetched.status_code > 0 ? fetched.status_code : null,
      reason,
      fallback_reason: !accepted && index + 1 < tiers.length ? `falling back to ${tiers[index + 1].method}` : null,
    });
    if (accepted && fetched !== null) {
      return {
        method_used: tier.methodUsed,
        content: fetched.content,
        status_code: fetched.status_code,
        url: fetched.url,
        attempts,
      };
    }
  }
  throw new FallbackFailure(
    `All fetch tiers failed for ${options.sourceName}. Tried: ${attempts.map((attempt) => attempt.method).join(", ")}`,
    attempts,
  );
}

/** Python ``make_source_id`` parity: ``src_<sha256(canonical)[:32]>``. */
export function makeSourceId(database: Database, accession: string, url: string): string {
  const canonical = JSON.stringify({
    accession: accession.trim().toLowerCase(),
    database,
    url: url.trim(),
  });
  if (accession.trim() === "" || url.trim() === "") {
    throw new TypeError("accession and url must not be blank");
  }
  return `src_${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}
