/**
 * Outbound URL policy (Python ``app/tools/network_safety.py`` parity).
 *
 * P5-D1: one bottom-layer policy module; every egress path (curated source
 * acquisition, declarative public HTTP, browser egress) funnels through the
 * primitives here instead of re-implementing SSRF guards.
 *
 * Policy ladder:
 *
 * ```text
 * PublicHttpPolicy              HTTP/HTTPS, no URL credentials, every resolved
 *                               address must be global, per-hop redirect
 *                               re-validation
 * CredentialedPublicHttpsPolicy PublicHttpPolicy + HTTPS forced
 * CuratedSourcePolicy           HTTPS only, exact hostname allowlist, port 443,
 *                               no IP literals, no cross-host redirects
 * BrowserEgressPolicy           HTTPS only, port 443, per-context authorized host
 * ```
 */

import { URL } from "node:url";

import { UnsafeUrlError } from "./errors.js";
import {
  isGlobalAddress,
  resolveAllAddresses,
  type AddressResolver,
  type ResolvedAddress,
} from "./dns.js";

export interface PinnedTarget {
  /** URL rewritten to connect to the pinned public IP (Python connect_url). */
  connectUrl: string;
  /** Host header to send (Python host_header). */
  hostHeader: string;
  /** TLS SNI hostname (Python sni_hostname). */
  sniHostname: string;
  /** Original hostname. */
  hostname: string;
  /** All validated resolved addresses (pinned). */
  resolvedAddresses: ResolvedAddress[];
  /** Preferred connect address (IPv4 first). */
  connectAddress: ResolvedAddress;
  /** Effective port. */
  port: number;
}

export interface UrlPolicyOptions {
  /** Force HTTPS for credentialed requests. */
  requireHttps?: boolean;
  /** Injectable resolver for tests. Defaults to OS DNS (all records). */
  resolve?: AddressResolver;
}

function parseUrl(value: string): URL {
  try {
    return new URL(value);
  } catch {
    // Node rejects out-of-range ports in the constructor; Python reports
    // them as "URL contains an invalid port" (urlsplit accepts, .port raises).
    if (hasOutOfRangePort(value)) throw new UnsafeUrlError("URL contains an invalid port");
    throw new UnsafeUrlError("URL is malformed");
  }
}

function hasOutOfRangePort(value: string): boolean {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]*)/.exec(value);
  if (match === null) return false;
  const authority = match[1];
  const hostPort = authority.includes("@") ? authority.split("@").at(-1) ?? "" : authority;
  const colon = hostPort.lastIndexOf(":");
  if (colon === -1 || colon < hostPort.lastIndexOf("]")) return false;
  const portText = hostPort.slice(colon + 1);
  if (!/^\d+$/.test(portText)) return false;
  const port = Number.parseInt(portText, 10);
  return port < 1 || port > 65535;
}

/** Validate scheme/credentials/shape without touching DNS. */
export function assertHttpUrlShape(url: URL, requireHttps: boolean): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError("only HTTP(S) URLs are allowed");
  }
  if (requireHttps && url.protocol !== "https:") {
    throw new UnsafeUrlError("credentialed requests require HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeUrlError("URL credentials are not allowed");
  }
  const hostname = url.hostname;
  if (!hostname || hostname.toLowerCase() === "localhost") {
    throw new UnsafeUrlError("URL must have a public hostname");
  }
  if (url.port !== "") {
    const parsed = Number.parseInt(url.port, 10);
    if (!/^\d+$/.test(url.port) || parsed < 1 || parsed > 65535) {
      throw new UnsafeUrlError("URL contains an invalid port");
    }
  }
}

/**
 * Resolve *url* once and return an address-pinned HTTP target. Every resolved
 * address must be global — a mixed public/private DNS answer is rejected
 * (Python ``resolve_public_http_target`` parity).
 */
export async function resolvePublicHttpTarget(
  value: string,
  options: UrlPolicyOptions = {},
): Promise<PinnedTarget> {
  const url = parseUrl(value);
  assertHttpUrlShape(url, options.requireHttps ?? false);
  const hostname = url.hostname;
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number.parseInt(url.port, 10);
  const resolve = options.resolve ?? resolveAllAddresses;
  let addresses: ResolvedAddress[];
  try {
    addresses = await resolve(hostname);
  } catch {
    throw new UnsafeUrlError(`URL hostname could not be resolved: ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new UnsafeUrlError(`URL hostname could not be resolved: ${hostname}`);
  }
  for (const address of addresses) {
    if (!isGlobalAddress(address.address)) {
      throw new UnsafeUrlError(`URL resolved to a non-public address: ${address.address}`);
    }
  }
  const connectAddress = addresses.find((address) => address.family === 4) ?? addresses[0];
  const defaultPort = url.protocol === "https:" ? 443 : 80;
  const ipLiteral = connectAddress.family === 6 ? `[${connectAddress.address}]` : connectAddress.address;
  const connectNetloc = port === defaultPort ? ipLiteral : `${ipLiteral}:${port}`;
  const connectUrl = `${url.protocol}//${connectNetloc}${url.pathname}${url.search}`;
  const hostHeader = port === defaultPort ? hostname : `${hostname}:${port}`;
  return {
    connectUrl,
    hostHeader,
    sniHostname: hostname,
    hostname,
    resolvedAddresses: addresses,
    connectAddress,
    port,
  };
}

/** Public HTTP(S) URL that resolves exclusively to global addresses. */
export async function validatePublicHttpUrl(
  value: string,
  options: Omit<UrlPolicyOptions, "requireHttps"> = {},
): Promise<string> {
  await resolvePublicHttpTarget(value, { ...options, requireHttps: false });
  return value;
}

/** Public HTTPS URL suitable for sending credentials. */
export async function validateCredentialedPublicUrl(
  value: string,
  options: Omit<UrlPolicyOptions, "requireHttps"> = {},
): Promise<string> {
  await resolvePublicHttpTarget(value, { ...options, requireHttps: true });
  return value;
}

/**
 * Curated-source URL validation (Python ``_validate_https_source_url`` parity).
 * Returns the normalized lowercase hostname when accepted.
 */
export async function validateHttpsSourceUrl(
  value: string,
  allowedHosts: ReadonlySet<string>,
  options: { resolvePublic?: boolean; resolve?: AddressResolver } = {},
): Promise<string> {
  let url: URL;
  try {
    url = parseUrl(value);
  } catch {
    throw new UnsafeUrlError("source URL is malformed");
  }
  if (url.protocol !== "https:") {
    throw new UnsafeUrlError("source URL must use HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeUrlError("source URL credentials are forbidden");
  }
  const hostname = (url.hostname || "").toLowerCase().replace(/\.$/, "");
  if (!allowedHosts.has(hostname)) {
    throw new UnsafeUrlError("source URL host is not allowed");
  }
  if (url.port !== "" && url.port !== "443") {
    throw new UnsafeUrlError("source URL port is not allowed");
  }
  if (isIpLiteral(hostname)) {
    throw new UnsafeUrlError("source URL IP literals are forbidden");
  }
  if (options.resolvePublic) {
    try {
      await resolvePublicHttpTarget(value, {
        requireHttps: true,
        resolve: options.resolve,
      });
    } catch (error) {
      if (error instanceof UnsafeUrlError) throw error;
      throw new UnsafeUrlError(`URL hostname could not be resolved: ${hostname}`);
    }
  }
  return hostname;
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.includes(":") && hostname.startsWith("[")) return true; // [::1]-style
  if (hostname.includes(":")) {
    const bare = hostname.replace(/^\[|\]$/g, "");
    return /^[0-9a-fA-F:]+$/.test(bare) && bare.includes(":");
  }
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
}

export { isGlobalAddress };
