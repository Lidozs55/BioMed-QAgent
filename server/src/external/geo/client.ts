/**
 * GEO/NCBI E-utilities client with NCBI rate-limit + bounded-retry policy
 * (P5-04; Python ``app/integrations/ncbi/client.py`` parity, GEO parts).
 *
 * Mirrors the Python ``NcbiEutilsClient`` behavior:
 * - 3 requests/s without an API key, 10 requests/s with one;
 * - bounded retry on 429/5xx (``Retry-After`` honored, exponential backoff
 *   with jitter) — never on 4xx validation errors;
 * - total request timeout;
 * - ``tool`` / ``email`` (and optional ``api_key``) parameters on every
 *   request.
 */

import type { PublicHttpClient } from "../network/http-client.js";
import type { HttpClientResponse } from "../network/http-client.js";

const DEFAULT_BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TOTAL_TIMEOUT_MS = 60_000;

/** Local ValueError mirroring Python's ``ValueError`` message contract. */
export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export interface GeoEutilsConfig {
  email: string;
  tool: string;
  userAgent: string;
  apiKey?: string | null;
  baseUrl?: string;
  maxRetries?: number;
  totalTimeoutMs?: number;
}

export class GeoRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GeoRequestError";
  }
}

/** Python ``parse_retry_after`` (numeric seconds or HTTP date). */
export function parseRetryAfter(value: string | undefined, now: Date): number {
  if (!value) return 0;
  const numeric = Number.parseFloat(value);
  if (!Number.isNaN(numeric)) return Math.max(0, numeric);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, (parsed - now.getTime()) / 1000);
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Per-host request pacing (Python ``AsyncHostRateLimiter`` equivalent). */
class EutilsRateLimiter {
  private lastRequestAt = 0;

  constructor(
    private readonly minIntervalMs: number,
    private readonly waiter: (ms: number) => Promise<void>,
  ) {}

  async wait(): Promise<void> {
    const now = Date.now();
    if (this.lastRequestAt !== 0) {
      const elapsed = now - this.lastRequestAt;
      if (elapsed < this.minIntervalMs) {
        await this.waiter(this.minIntervalMs - elapsed);
      }
    }
    this.lastRequestAt = Date.now();
  }
}

async function collectBody(body: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export interface GeoDiscoveryClient {
  esearch(request: { db: string; term: string; retmax: number }, signal?: AbortSignal): Promise<Uint8Array>;
  esummary(request: { db: string; ids: string[] }, signal?: AbortSignal): Promise<Uint8Array>;
}

export interface GeoEutilsClientOptions {
  http: PublicHttpClient;
  config: GeoEutilsConfig;
  /** Injectable waiter for rate-limit pacing and retry backoff (tests). */
  sleeper?: (ms: number) => Promise<void>;
  /** Injectable backoff jitter in seconds (Python ``jitter``). */
  jitter?: () => number;
  /** Injectable clock (Python ``now``). */
  now?: () => Date;
}

export class GeoEutilsClient implements GeoDiscoveryClient {
  readonly config: Required<Omit<GeoEutilsConfig, "apiKey">> & {
    apiKey: string | null;
  };
  private readonly http: PublicHttpClient;
  private readonly limiter: EutilsRateLimiter;
  private readonly sleeper: (ms: number) => Promise<void>;
  private readonly jitter: () => number;
  private readonly now: () => Date;

  constructor(options: GeoEutilsClientOptions) {
    const config = options.config;
    this.http = options.http;
    if (!config.email.trim()) throw new ValueError("NCBI email must not be blank");
    if (!config.tool.trim()) throw new ValueError("NCBI tool must not be blank");
    if (!config.userAgent.trim()) {
      throw new ValueError("NCBI user_agent must not be blank");
    }
    if ((config.maxRetries ?? DEFAULT_MAX_RETRIES) < 0) {
      throw new ValueError("max_retries must not be negative");
    }
    if ((config.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS) <= 0) {
      throw new ValueError("total_timeout must be positive");
    }
    this.config = {
      email: config.email.trim(),
      tool: config.tool.trim(),
      userAgent: config.userAgent.trim(),
      apiKey: config.apiKey?.trim() || null,
      baseUrl: (config.baseUrl ?? DEFAULT_BASE_URL).trim(),
      maxRetries: config.maxRetries ?? DEFAULT_MAX_RETRIES,
      totalTimeoutMs: config.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS,
    };
    const quota = this.config.apiKey ? 10 : 3;
    this.sleeper = options.sleeper ?? sleepMs;
    this.jitter = options.jitter ?? Math.random;
    this.now = options.now ?? (() => new Date());
    this.limiter = new EutilsRateLimiter((1 / quota) * 1000, this.sleeper);
  }

  private commonParams(): Record<string, string> {
    const params: Record<string, string> = {
      tool: this.config.tool,
      email: this.config.email,
    };
    if (this.config.apiKey) params.api_key = this.config.apiKey;
    return params;
  }

  private requestUrl(endpoint: string, params: Record<string, string>): string {
    const url = new URL(`${this.config.baseUrl.replace(/\/+$/, "")}/${endpoint}`);
    for (const [key, value] of Object.entries({ ...params, ...this.commonParams() })) {
      url.searchParams.append(key, value);
    }
    return url.toString();
  }

  private async request(
    endpoint: string,
    params: Record<string, string>,
    callerSignal?: AbortSignal,
  ): Promise<Buffer> {
    const url = this.requestUrl(endpoint, params);
    const timeoutSignal = AbortSignal.timeout(this.config.totalTimeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    try {
      for (let attempt = 0; attempt <= this.config.maxRetries; attempt += 1) {
        await this.limiter.wait();
        let response: HttpClientResponse;
        try {
          response = await this.http.request(url, {
            headers: { "User-Agent": this.config.userAgent },
            signal,
          });
        } catch (error) {
          if (error instanceof Error && error.name === "TimeoutError") {
            throw new GeoRequestError(
              "NCBI request exceeded total timeout",
              null,
              true,
            );
          }
          if (callerSignal?.aborted === true) throw error;
          throw new GeoRequestError(
            `NCBI request failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
            null,
            true,
          );
        }
        const body = await collectBody(response.body);
        const status = response.status;
        if (status >= 200 && status < 300) return body;
        const retryable = status === 429 || (status >= 500 && status < 600);
        if (retryable && attempt < this.config.maxRetries) {
          const retryAfter = parseRetryAfter(
            response.headers["Retry-After"] ?? response.headers["retry-after"],
            this.now(),
          );
          const backoff = 0.5 * 2 ** attempt + this.jitter();
          await this.sleeper(Math.max(backoff, retryAfter) * 1000);
          continue;
        }
        const excerpt = body.toString("utf8").slice(0, 500);
        throw new GeoRequestError(
          `NCBI returned HTTP ${status}: ${excerpt}`,
          status,
          retryable,
        );
      }
    } catch (error) {
      if (error instanceof GeoRequestError) throw error;
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new GeoRequestError("NCBI request exceeded total timeout", null, true);
      }
      if (callerSignal?.aborted === true) throw error;
      throw error;
    }
    throw new Error("unreachable");
  }

  async esearch(request: {
    db: string;
    term: string;
    retmax: number;
  }, signal?: AbortSignal): Promise<Uint8Array> {
    if (request.retmax <= 0) throw new ValueError("retmax must be positive");
    return this.request(
      "esearch.fcgi",
      {
        db: request.db,
        term: request.term,
        retmax: String(request.retmax),
        retmode: "json",
      },
      signal,
    );
  }

  async esummary(request: {
    db: string;
    ids: string[];
  }, signal?: AbortSignal): Promise<Uint8Array> {
    if (request.ids.length === 0) throw new ValueError("ids must not be empty");
    return this.request(
      "esummary.fcgi",
      { db: request.db, id: request.ids.join(","), retmode: "json" },
      signal,
    );
  }
}

/**
 * Bounded-retry fetch of small GEO listing pages (Python ``_get_geo_listing``).
 * Retries 429/5xx and transport errors up to ``attempts`` times, honoring
 * ``Retry-After`` when present; non-retryable 4xx statuses are returned to
 * the caller (which raises).
 */
export async function getGeoListing(
  client: PublicHttpClient,
  url: string,
  options: {
    attempts?: number;
    sleeper?: (ms: number) => Promise<void>;
    now?: () => Date;
    signal?: AbortSignal;
  } = {},
): Promise<{ status: number; headers: Record<string, string>; body: Buffer; url: string }> {
  const attempts = options.attempts ?? 3;
  const sleeper = options.sleeper ?? sleepMs;
  const now = options.now ?? (() => new Date());
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let response: HttpClientResponse | null = null;
    try {
      response = await client.request(url, { signal: options.signal });
      if (response.status === 429 || response.status >= 500) {
        throw new ListingStatusError(response.status, response.headers);
      }
      return {
        status: response.status,
        headers: response.headers,
        body: await collectBody(response.body),
        url: response.url,
      };
    } catch (error) {
      if (error instanceof ListingStatusError && attempt < attempts) {
        await sleeper(retryDelay(error.headers, attempt, now()) * 1000);
        continue;
      }
      if (
        error instanceof ListingStatusError ||
        (error instanceof Error && error.name === "TimeoutError") ||
        (options.signal?.aborted ?? false)
      ) {
        throw error;
      }
      // Transport-level failure (Python TimeoutException / TransportError).
      if (attempt < attempts) {
        await sleeper(retryDelay(null, attempt, now()) * 1000);
        continue;
      }
      throw error;
    }
  }
  throw new Error("unreachable");
}

class ListingStatusError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Record<string, string>,
  ) {
    super(`listing returned HTTP ${status}`);
    this.name = "ListingStatusError";
  }
}

/** Python ``_retry_delay``: Retry-After when usable, else 0.25 * 2^(n-1). */
function retryDelay(
  headers: Record<string, string> | null,
  attempt: number,
  now: Date,
): number {
  const fallback = 0.25 * 2 ** (attempt - 1);
  if (headers === null) return fallback;
  const delay = parseRetryAfter(
    headers["Retry-After"] ?? headers["retry-after"],
    now,
  );
  return delay > 0 ? delay : fallback;
}
