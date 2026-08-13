/**
 * Policy-enforcing HTTP client (P5-01, P5-D1).
 *
 * Redirect handling is manual and every hop is re-validated:
 *
 * ```text
 * max redirects = 5 (configurable)
 * every hop re-runs URL policy validation
 * every hop re-resolves DNS against the policy resolver
 * cross-host redirects rejected by default (curated sources always)
 * ```
 *
 * The default transport pins the connection to the validated public address
 * (node ``lookup`` override + explicit ``Host`` header + ``servername`` SNI),
 * mirroring Python's ``PublicHttpTarget`` semantics so a DNS rebinding answer
 * between validation and connect cannot redirect the socket.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { IncomingMessage } from "node:http";
import type { LookupFunction } from "node:net";
import type { RequestOptions } from "node:https";
import { URL } from "node:url";

import { UnsafeUrlError } from "./errors.js";
import {
  resolvePublicHttpTarget,
  validateHttpsSourceUrl,
  type PinnedTarget,
} from "./url-policy.js";
import { resolveAllAddresses, type AddressResolver } from "./dns.js";

export interface HttpClientResponse {
  status: number;
  headers: Record<string, string>;
  /** Streaming body (async iterable of chunks). */
  body: AsyncIterable<Buffer>;
  /** Final URL after redirects. */
  url: string;
}

export interface HttpRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  headers?: Record<string, string>;
  body?: Buffer | Uint8Array | string;
  signal?: AbortSignal;
  /** Total per-hop body-read deadline (ms). */
  timeoutMs?: number;
  connectTimeoutMs?: number;
  maxRedirects?: number;
  /**
   * Per-hop redirect validation. Called with (from, to) before following;
   * throwing UnsafeUrlError aborts the request. Default: reject cross-host.
   */
  validateRedirect?: (from: string, to: string) => void | Promise<void>;
  /** Policy URL validation applied to the initial URL and every hop. */
  validateUrl?: (url: string) => void | Promise<void>;
  /** Injectable resolver for tests. Defaults to OS DNS (all records). */
  resolve?: AddressResolver;
  /**
   * Injectable transport for tests. Receives the pinned connect target; the
   * default transport connects to the pinned public IP with the original
   * hostname as Host header and SNI.
   */
  executor?: RequestExecutor;
}

export interface ExecutorRequest {
  url: URL;
  method: string;
  headers: Record<string, string>;
  body: Buffer | null;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  pinned: PinnedTarget | null;
}

export type RequestExecutor = (
  request: ExecutorRequest,
) => Promise<{ status: number; headers: Record<string, string>; body: AsyncIterable<Buffer> }>;

export const DEFAULT_MAX_REDIRECTS = 5;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function headersFromIncoming(message: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

/** Default transport: node http/https with address-pinned connect. */
export const defaultExecutor: RequestExecutor = (request) =>
  new Promise((resolve, reject) => {
    const { url, pinned } = request;
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? httpsRequest : httpRequest;
    const headers = { ...request.headers };
    let hostname = url.hostname;
    let port: number | undefined = url.port === "" ? undefined : Number.parseInt(url.port, 10);
    let lookup: LookupFunction | undefined;
    if (pinned !== null) {
      // Connect to the pinned IP; keep Host header + SNI on the hostname.
      headers["Host"] = pinned.hostHeader;
      hostname = pinned.connectAddress.address;
      port = pinned.port;
      lookup = (_host, _options, callback) => {
        callback(null, pinned.resolvedAddresses.map((address) => ({
          address: address.address,
          family: address.family,
        })));
      };
    }
    const req = transport(
      ((): RequestOptions => {
        const requestOptions: RequestOptions = {
          hostname,
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers,
          servername: pinned?.sniHostname ?? url.hostname,
        };
        if (port !== undefined) requestOptions.port = port;
        if (lookup !== undefined) requestOptions.lookup = lookup as LookupFunction;
        return requestOptions;
      })(),
      (message) => {
        const body = (async function* iterate(): AsyncIterable<Buffer> {
          for await (const chunk of message) {
            yield chunk as Buffer;
          }
        })();
        resolve({ status: message.statusCode ?? 0, headers: headersFromIncoming(message), body });
      },
    );
    req.on("error", reject);
    if (request.connectTimeoutMs !== undefined) {
      req.setTimeout(request.connectTimeoutMs, () => {
        req.destroy(Object.assign(new Error("connect timeout"), { name: "TimeoutError" }));
      });
    }
    if (request.signal !== undefined) {
      const abort = (): void => {
        const reason = request.signal?.reason;
        req.destroy(reason instanceof Error ? reason : Object.assign(new Error("aborted"), { cause: reason }));
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    }
    if (request.body !== null && !BODYLESS_METHODS.has(request.method)) {
      req.write(request.body);
    }
    req.end();
  });

export class PublicHttpClient {
  readonly resolve: AddressResolver;
  readonly maxRedirects: number;
  private readonly executor: RequestExecutor;

  constructor(options: {
    resolve?: AddressResolver;
    maxRedirects?: number;
    executor?: RequestExecutor;
  } = {}) {
    this.resolve = options.resolve ?? resolveAllAddresses;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.executor = options.executor ?? defaultExecutor;
  }

  async request(value: string, options: HttpRequestOptions = {}): Promise<HttpClientResponse> {
    const resolve = options.resolve ?? this.resolve;
    const validateUrl =
      options.validateUrl ??
      (async (url: string): Promise<void> => {
        await resolvePublicHttpTarget(url, { resolve });
      });
    const validateRedirect =
      options.validateRedirect ??
      (async (from: string, to: string): Promise<void> => {
        const fromHost = new URL(from).hostname;
        const toHost = new URL(to).hostname;
        if (fromHost !== toHost) {
          throw new UnsafeUrlError("download redirect changed host");
        }
      });
    const maxRedirects = options.maxRedirects ?? this.maxRedirects;

    let currentUrl = value;
    let redirected = 0;
    for (;;) {
      await validateUrl(currentUrl);
      const pinned = await resolvePublicHttpTarget(currentUrl, { resolve });
      const response = await this.executor({
        url: new URL(currentUrl),
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        body: options.body === undefined ? null : Buffer.from(options.body),
        signal: options.signal,
        connectTimeoutMs: options.connectTimeoutMs,
        pinned,
      });
      if (!REDIRECT_STATUSES.has(response.status)) {
        return { status: response.status, headers: response.headers, body: response.body, url: currentUrl };
      }
      const location = response.headers["location"] ?? response.headers["Location"];
      if (!location) {
        throw new UnsafeUrlError("download redirect omitted Location");
      }
      if (redirected >= maxRedirects) {
        throw new UnsafeUrlError("download exceeded redirect limit");
      }
      const nextUrl = new URL(location, currentUrl).toString();
      await validateRedirect(currentUrl, nextUrl);
      currentUrl = nextUrl;
      redirected += 1;
      // Drain the (tiny) redirect body so the socket can be reused.
      for await (const chunk of response.body) {
        void chunk;
      }
    }
  }
}

/**
 * Curated-source request helper: exact-host allowlist + HTTPS + port 443 +
 * same-host redirects. Returns the normalized origin hostname.
 */
export async function validateCuratedSourceUrl(
  value: string,
  allowedHosts: ReadonlySet<string>,
  resolve?: AddressResolver,
): Promise<string> {
  return validateHttpsSourceUrl(value, allowedHosts, { resolvePublic: true, resolve });
}

export { resolvePublicHttpTarget };
export type { PinnedTarget };
