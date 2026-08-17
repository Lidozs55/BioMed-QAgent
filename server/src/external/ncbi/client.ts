/**
 * NCBI E-utilities HTTP client (Python ``app/integrations/ncbi/client.py``
 * parity).
 *
 * Every request carries ``tool`` / ``email`` / ``api_key`` (when configured)
 * identity parameters plus the project User-Agent. Requests are paced by the
 * process-shared quota limiter (3 req/s without an API key, 10 req/s with
 * one), retried with bounded exponential backoff on 429/5xx (honoring the
 * ``Retry-After`` header), and bounded by a per-hop read timeout inside one
 * total wall-clock deadline. All traffic goes through ``PublicHttpClient``
 * with the curated eutils host allowlist (P5-D1).
 */

import { URL } from "node:url";

import { CURATED_SOURCE_HOSTS } from "../acquisition/downloader.js";
import type { AddressResolver } from "../network/dns.js";
import { isAbortError } from "../network/errors.js";
import { PublicHttpClient, type HttpClientResponse } from "../network/http-client.js";
import { validateHttpsSourceUrl } from "../network/url-policy.js";
import { HostRateLimiter, parseRetryAfter, timeoutSignal } from "./retry.js";

export interface NcbiClientConfig {
  email: string;
  tool: string;
  userAgent: string;
  /** Optional higher-quota NCBI API key (10 req/s instead of 3 req/s). */
  apiKey?: string;
  /** Defaults to ``https://eutils.ncbi.nlm.nih.gov/entrez/eutils``. */
  baseUrl?: string;
  /** Maximum retry attempts after the first request (default 3). */
  maxRetries?: number;
  /** Total wall-clock deadline for one request incl. retries, ms (Python ``total_timeout`` seconds × 1000, default 60000). */
  totalTimeoutMs?: number;
}

/** Process-default identity from environment (Python ``app.config.settings`` parity). */
export function defaultNcbiClientConfig(env: Record<string, string | undefined> = process.env): NcbiClientConfig {
  return {
    email: env["NCBI_EMAIL"] ?? "biomed-qagent@example.com",
    tool: env["NCBI_TOOL"] ?? "BioMedQAgent",
    apiKey: env["NCBI_API_KEY"] || undefined,
    userAgent: env["NCBI_USER_AGENT"] ?? "BioMed-QAgent/0.1 (biomed-qagent@example.com)",
  };
}

interface ResolvedNcbiClientConfig {
  email: string;
  tool: string;
  userAgent: string;
  apiKey: string | undefined;
  baseUrl: string;
  maxRetries: number;
  totalTimeoutMs: number;
}

function resolveConfig(config: NcbiClientConfig): ResolvedNcbiClientConfig {
  for (const field of ["email", "tool", "userAgent"] as const) {
    if (!config[field].trim()) {
      throw new TypeError(`NCBI ${field === "userAgent" ? "user_agent" : field} must not be blank`);
    }
  }
  const maxRetries = config.maxRetries ?? 3;
  if (maxRetries < 0) throw new TypeError("max_retries must not be negative");
  const totalTimeoutMs = config.totalTimeoutMs ?? 60_000;
  if (totalTimeoutMs <= 0) throw new TypeError("total_timeout must be positive");
  return {
    email: config.email,
    tool: config.tool,
    userAgent: config.userAgent,
    apiKey: config.apiKey,
    baseUrl: (config.baseUrl ?? "https://eutils.ncbi.nlm.nih.gov/entrez/eutils").replace(/\/+$/, ""),
    maxRetries,
    totalTimeoutMs,
  };
}

export class NcbiRequestError extends Error {
  readonly statusCode: number | null;
  readonly retryable: boolean;

  constructor(message: string, options: { statusCode: number | null; retryable: boolean }) {
    super(message);
    this.name = "NcbiRequestError";
    this.statusCode = options.statusCode;
    this.retryable = options.retryable;
  }
}

//: NCBI E-utilities policy: 3 requests/s without an API key, 10 requests/s
//: with one. Process-shared by quota (Python _PROCESS_LIMITERS parity).
const PROCESS_LIMITERS: Readonly<Record<number, HostRateLimiter>> = {
  3: new HostRateLimiter({ minInterval: 1 / 3 }),
  10: new HostRateLimiter({ minInterval: 1 / 10 }),
};

//: Per-hop transport timeouts (Python httpx.Timeout parity: connect 5s, read 30s).
const CONNECT_TIMEOUT_MS = 5_000;
const READ_TIMEOUT_MS = 30_000;

async function readBody(response: HttpClientResponse): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export interface NcbiEutilsClientOptions {
  http: PublicHttpClient;
  config: NcbiClientConfig;
  limiter?: HostRateLimiter;
  /** Injectable sleeper (ms) for retry backoff tests. */
  sleep?: (delayMs: number) => Promise<void>;
  /** Injectable jitter source (default ``Math.random``). */
  jitter?: () => number;
  /** Injectable clock returning epoch milliseconds. */
  now?: () => number;
  /** DNS resolver for policy checks; defaults to the client's resolver. */
  resolve?: AddressResolver;
}

export class NcbiEutilsClient {
  readonly config: ResolvedNcbiClientConfig;
  readonly limiter: HostRateLimiter;
  private readonly http: PublicHttpClient;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly jitter: () => number;
  private readonly now: () => number;
  private readonly resolve?: AddressResolver;

  constructor(options: NcbiEutilsClientOptions) {
    this.config = resolveConfig(options.config);
    this.http = options.http;
    this.limiter = options.limiter ?? PROCESS_LIMITERS[this.config.apiKey ? 10 : 3];
    this.sleep = options.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.jitter = options.jitter ?? Math.random;
    this.now = options.now ?? Date.now;
    this.resolve = options.resolve;
  }

  private async request(endpoint: string, params: Record<string, string>, signal?: AbortSignal): Promise<Buffer> {
    const common: Record<string, string> = {
      tool: this.config.tool,
      email: this.config.email,
    };
    if (this.config.apiKey) common["api_key"] = this.config.apiKey;
    const url = new URL(`${this.config.baseUrl}/${endpoint}`);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    for (const [key, value] of Object.entries(common)) url.searchParams.set(key, value);
    const urlString = url.toString();
    const resolver = this.resolve ?? this.http.resolve;

    const total = timeoutSignal(this.config.totalTimeoutMs);
    try {
      for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
        await this.limiter.wait(urlString);
        const hop = timeoutSignal(READ_TIMEOUT_MS);
        const requestSignal = AbortSignal.any([
          ...(signal ? [signal] : []),
          total.signal,
          hop.signal,
        ]);
        let response: HttpClientResponse;
        try {
          response = await this.http.request(urlString, {
            headers: { "User-Agent": this.config.userAgent },
            signal: requestSignal,
            connectTimeoutMs: CONNECT_TIMEOUT_MS,
            resolve: resolver,
            validateUrl: async (value) => {
              await validateHttpsSourceUrl(value, CURATED_SOURCE_HOSTS, {
                resolvePublic: true,
                resolve: resolver,
              });
            },
          });
        } catch (error) {
          if (total.signal.aborted) {
            throw new NcbiRequestError("NCBI request exceeded total timeout", {
              statusCode: null,
              retryable: true,
            });
          }
          if (signal?.aborted === true) throw error;
          if (isAbortError(error)) {
            throw new NcbiRequestError(`NCBI request failed: ${error.name}: ${error.message}`, {
              statusCode: null,
              retryable: true,
            });
          }
          throw new NcbiRequestError(
            `NCBI request failed: ${error instanceof Error ? error.name : typeof error}: ${error instanceof Error ? error.message : String(error)}`,
            { statusCode: null, retryable: true },
          );
        } finally {
          hop.cancel();
        }
        if (response.status >= 200 && response.status < 300) {
          return await readBody(response);
        }
        const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
        const body = await readBody(response);
        if (retryable && attempt < this.config.maxRetries) {
          const retryAfter = parseRetryAfter(
            response.headers["retry-after"] ?? response.headers["Retry-After"],
            this.now(),
          );
          const backoffSeconds = 0.5 * 2 ** attempt + this.jitter();
          await this.sleep(Math.max(backoffSeconds, retryAfter) * 1000);
          continue;
        }
        const excerpt = body.toString("utf8").slice(0, 500);
        throw new NcbiRequestError(`NCBI returned HTTP ${response.status}: ${excerpt}`, {
          statusCode: response.status,
          retryable,
        });
      }
    } finally {
      total.cancel();
    }
    throw new Error("unreachable");
  }

  async esearch(
    options: { db: string; term: string; retmax: number },
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (options.retmax <= 0) throw new TypeError("retmax must be positive");
    return await this.request(
      "esearch.fcgi",
      {
        db: options.db,
        term: options.term,
        retmax: String(options.retmax),
        retmode: "json",
      },
      signal,
    );
  }

  async esummary(options: { db: string; ids: readonly string[] }, signal?: AbortSignal): Promise<Buffer> {
    if (options.ids.length === 0) throw new TypeError("ids must not be empty");
    return await this.request(
      "esummary.fcgi",
      { db: options.db, id: options.ids.join(","), retmode: "json" },
      signal,
    );
  }

  async efetch(
    options: { db: string; ids: readonly string[]; retmode: string },
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (options.ids.length === 0) throw new TypeError("ids must not be empty");
    return await this.request(
      "efetch.fcgi",
      { db: options.db, id: options.ids.join(","), retmode: options.retmode },
      signal,
    );
  }
}
