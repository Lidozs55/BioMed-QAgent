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
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { checkServerIdentity, connect as tlsConnect, type DetailedPeerCertificate, type TLSSocket } from "node:tls";
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

export interface HttpRedirectHop {
  from_url: string;
  to_url: string;
  status: number;
}

export interface HttpClientResponse {
  status: number;
  headers: Record<string, string>;
  /** Redirects followed before the final response. */
  redirectChain?: HttpRedirectHop[];
  /** Streaming body (async iterable of chunks). */
  body: AsyncIterable<Buffer>;
  /** Final URL after redirects. */
  url: string;
  /** Drain and release an intentionally unused response body. Idempotent. */
  discard(): Promise<void>;
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
) => Promise<{
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Buffer>;
  dispose?: () => void;
}>;

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

const RELAXABLE_TLS_CHAIN_ERROR_CODES = new Set([
  "CERT_UNTRUSTED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/** Only CA-chain trust failures may use the one-shot relaxed TLS retry. */
export function isRelaxableTlsChainError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && RELAXABLE_TLS_CHAIN_ERROR_CODES.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function validateRelaxedTlsPeer(
  hostname: string,
  certificate: DetailedPeerCertificate,
  now = Date.now(),
): void {
  if (Object.keys(certificate).length === 0) {
    throw Object.assign(new Error("TLS peer did not provide a certificate"), { code: "CERT_MISSING" });
  }
  const identityError = checkServerIdentity(hostname, certificate);
  if (identityError !== undefined) throw identityError;
  const validFrom = Date.parse(certificate.valid_from);
  const validTo = Date.parse(certificate.valid_to);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) {
    throw Object.assign(new Error("TLS peer certificate validity is invalid"), { code: "CERT_INVALID" });
  }
  if (now < validFrom) {
    throw Object.assign(new Error("TLS peer certificate is not yet valid"), { code: "CERT_NOT_YET_VALID" });
  }
  if (now > validTo) {
    throw Object.assign(new Error("TLS peer certificate has expired"), { code: "CERT_HAS_EXPIRED" });
  }
}

function openRelaxedTlsSocket(request: ExecutorRequest): Promise<TLSSocket> {
  const hostname = request.pinned?.connectAddress.address ?? request.url.hostname;
  const port = request.pinned?.port
    ?? (request.url.port === "" ? 443 : Number.parseInt(request.url.port, 10));
  const servername = request.pinned?.sniHostname ?? request.url.hostname;
  return new Promise<TLSSocket>((resolve, reject) => {
    const socket = tlsConnect({ host: hostname, port, servername, rejectUnauthorized: false });
    let settled = false;
    const connectTimer = request.connectTimeoutMs === undefined
      ? null
      : setTimeout(() => {
          fail(Object.assign(new Error("connect timeout"), { name: "TimeoutError" }));
        }, request.connectTimeoutMs);
    const cleanup = (): void => {
      if (connectTimer !== null) clearTimeout(connectTimer);
      socket.removeListener("error", fail);
      request.signal?.removeEventListener("abort", abort);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const abort = (): void => {
      const reason = request.signal?.reason;
      fail(reason instanceof Error ? reason : Object.assign(new Error("aborted"), { cause: reason }));
    };
    socket.once("error", fail);
    socket.once("secureConnect", () => {
      try {
        validateRelaxedTlsPeer(servername, socket.getPeerCertificate(true));
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      resolve(socket);
    });
    if (request.signal !== undefined) {
      if (request.signal.aborted) abort();
      else request.signal.addEventListener("abort", abort, { once: true });
    }
  });
}

function executeNodeRequest(
  request: ExecutorRequest,
  relaxedSocket?: TLSSocket,
): ReturnType<RequestExecutor> {
  return new Promise((resolve, reject) => {
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
        if (relaxedSocket !== undefined) {
          const agent = new HttpsAgent({ keepAlive: false, maxSockets: 1 });
          agent.createConnection = () => relaxedSocket;
          requestOptions.agent = agent;
        }
        return requestOptions;
      })(),
      (message) => {
        const body = (async function* iterate(): AsyncIterable<Buffer> {
          for await (const chunk of message) {
            yield chunk as Buffer;
          }
        })();
        resolve({
          status: message.statusCode ?? 0,
          headers: headersFromIncoming(message),
          body,
          dispose: () => message.destroy(),
        });
      },
    );
    req.on("error", reject);
    if (relaxedSocket === undefined && request.connectTimeoutMs !== undefined) {
      const connectTimer = setTimeout(() => {
        req.destroy(Object.assign(new Error("connect timeout"), { name: "TimeoutError" }));
      }, request.connectTimeoutMs);
      const clearConnectTimer = (): void => clearTimeout(connectTimer);
      req.once("socket", (socket) => {
        if (socket.connecting) socket.once("connect", clearConnectTimer);
        else clearConnectTimer();
      });
      req.once("response", clearConnectTimer);
      req.once("error", clearConnectTimer);
      req.once("close", clearConnectTimer);
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
}

/**
 * Default transport: strict TLS first; one CA-chain-only retry keeps hostname and
 * validity checks while tolerating environments whose HTTPS interception root is
 * not installed in Node's trust store.
 */
export const defaultExecutor: RequestExecutor = async (request) => {
  try {
    return await executeNodeRequest(request);
  } catch (error) {
    if (
      request.url.protocol !== "https:"
      || request.signal?.aborted === true
      || !isRelaxableTlsChainError(error)
    ) {
      throw error;
    }
    const socket = await openRelaxedTlsSocket(request);
    try {
      return await executeNodeRequest(request, socket);
    } catch (retryError) {
      socket.destroy();
      throw retryError;
    }
  }
};

export class PublicHttpClient {
  readonly resolve: AddressResolver;
  readonly maxRedirects: number;
  readonly timeoutMs: number | undefined;
  private readonly executor: RequestExecutor;

  constructor(options: {
    resolve?: AddressResolver;
    maxRedirects?: number;
    timeoutMs?: number;
    executor?: RequestExecutor;
  } = {}) {
    this.resolve = options.resolve ?? resolveAllAddresses;
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    this.timeoutMs = options.timeoutMs;
    this.executor = options.executor ?? defaultExecutor;
  }

  async request(value: string, options: HttpRequestOptions = {}): Promise<HttpClientResponse> {
    const resolve = options.resolve ?? this.resolve;
    const validateUrl = options.validateUrl ?? (async (url: string): Promise<void> => {
      await resolvePublicHttpTarget(url, { resolve });
    });
    const validateRedirect = options.validateRedirect ?? (async (from: string, to: string): Promise<void> => {
      if (new URL(from).hostname !== new URL(to).hostname) {
        throw new UnsafeUrlError("download redirect changed host");
      }
    });
    const maxRedirects = options.maxRedirects ?? this.maxRedirects;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const timeoutController = timeoutMs === undefined ? null : new AbortController();
    const timer = timeoutController === null ? null : setTimeout(() => {
      timeoutController.abort(Object.assign(
        new Error(`HTTP request timed out after ${timeoutMs}ms`),
        { name: "TimeoutError" },
      ));
    }, timeoutMs);
    const clearDeadline = (): void => {
      if (timer !== null) clearTimeout(timer);
    };
    const signal = timeoutController === null
      ? options.signal
      : options.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([options.signal, timeoutController.signal]);

    let currentUrl = value;
    let redirected = 0;
    const redirectChain: HttpRedirectHop[] = [];
    try {
      for (;;) {
        await validateUrl(currentUrl);
        const pinned = await resolvePublicHttpTarget(currentUrl, { resolve });
        const response = await this.executor({
          url: new URL(currentUrl),
          method: options.method ?? "GET",
          headers: options.headers ?? {},
          body: options.body === undefined ? null : Buffer.from(options.body),
          signal,
          connectTimeoutMs: options.connectTimeoutMs ?? (timeoutMs === undefined ? undefined : Math.min(timeoutMs, 30_000)),
          pinned,
        });
        if (REDIRECT_STATUSES.has(response.status)) {
          const location = response.headers["location"] ?? response.headers["Location"];
          for await (const chunk of response.body) void chunk;
          if (!location) throw new UnsafeUrlError("download redirect omitted Location");
          if (redirected >= maxRedirects) throw new UnsafeUrlError("download exceeded redirect limit");
          const nextUrl = new URL(location, currentUrl).toString();
          await validateRedirect(currentUrl, nextUrl);
          redirectChain.push({ from_url: currentUrl, to_url: nextUrl, status: response.status });
          currentUrl = nextUrl;
          redirected += 1;
          continue;
        }
        const iterator = response.body[Symbol.asyncIterator]();
        let bodyStarted = false;
        let bodyCompleted = false;
        const consume = async function* (): AsyncIterable<Buffer> {
          if (bodyStarted) return;
          bodyStarted = true;
          try {
            for (;;) {
              const next = await iterator.next();
              if (next.done === true) {
                bodyCompleted = true;
                break;
              }
              yield next.value;
            }
          } catch (error) {
            if (timeoutController?.signal.aborted === true) {
              throw timeoutController.signal.reason;
            }
            if (options.signal?.aborted === true) {
              throw options.signal.reason;
            }
            throw error;
          } finally {
            if (!bodyCompleted) {
              response.dispose?.();
              await iterator.return?.().catch(() => undefined);
            }
            clearDeadline();
          }
        };
        const discard = async (): Promise<void> => {
          if (!bodyStarted) {
            bodyStarted = true;
            response.dispose?.();
            await iterator.return?.().catch(() => undefined);
          }
          clearDeadline();
        };
        return {
          status: response.status,
          headers: response.headers,
          redirectChain: [...redirectChain],
          body: consume(),
          url: currentUrl,
          discard,
        };
      }
    } catch (error) {
      clearDeadline();
      throw error;
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
