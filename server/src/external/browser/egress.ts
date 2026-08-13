/**
 * Browser egress policy (Python ``app/tools/egress_proxy.py`` parity).
 *
 * The Python runtime pins every browser request through a loopback CONNECT
 * proxy: ``authorize_url`` records the HTTPS origin in a per-context lease and
 * the proxy re-checks membership + DNS-pins the address before dialing. The
 * Node port has no proxy — instead the same policy is enforced at both layers
 * that exist here:
 *
 * 1. ``NodeBrowserPool`` runs the operation's ``authorizeRequest`` (default:
 *    this policy) on the target URL *before* ``page.goto`` (goto layer).
 * 2. A ``context.route`` interception (glob ``**`` + ``/*``) runs the same
 *    authorizer for every request the browser wants to make, including each
 *    redirect hop (route layer). Main-document rejections are fatal;
 *    subresource rejections abort silently.
 *
 * The strict policy enforces: HTTPS only, port 443 only, no URL credentials,
 * a non-empty IDNA-normalized hostname, and DNS pinning — every address the
 * hostname resolves to must be global (Python ``_resolve_public_address``
 * parity; checking only the first record is forbidden). The first sighting of
 * a hostname validates + pins it into the per-context ``authorizedHosts`` set
 * (Python ``EgressProxyLease.authorize_url`` parity); later requests to the
 * same host are permitted by membership without re-resolving.
 *
 * The policy is injectable: fixture tests (``http://127.0.0.1`` servers)
 * install a test-mode policy, while the strict policy remains the production
 * default.
 */

import { URL } from "node:url";

import { UnsafeUrlError } from "../network/errors.js";
import {
  isGlobalAddress,
  resolveAllAddresses,
  type AddressResolver,
  type ResolvedAddress,
} from "../network/dns.js";

export interface BrowserEgressPolicy {
  /**
   * Validate one browser request URL against the strict egress rules and the
   * per-context authorized host set. On first sighting the hostname is
   * DNS-pinned (every resolved address must be global) and authorized into
   * *authorizedHosts*. Throws ``UnsafeUrlError`` on any violation. Returns
   * the normalized hostname.
   */
  validateUrl(url: string, authorizedHosts: Set<string>): Promise<string>;
}

export interface BrowserEgressPolicyOptions {
  /** Injectable DNS resolver for tests. Defaults to OS DNS (all records). */
  resolve?: AddressResolver;
}

/** Parse-only strict HTTPS authority check (no DNS); returns the normalized hostname. */
export function strictHttpsAuthority(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UnsafeUrlError("browser URL is malformed");
  }
  if (url.protocol !== "https:") {
    throw new UnsafeUrlError("browser egress only permits HTTPS URLs");
  }
  if (url.username !== "" || url.password !== "") {
    throw new UnsafeUrlError("browser URL credentials are not allowed");
  }
  if (url.hostname === "") {
    throw new UnsafeUrlError("browser URL must have a hostname");
  }
  const port = url.port === "" ? 443 : Number.parseInt(url.port, 10);
  if (port !== 443) {
    throw new UnsafeUrlError("browser egress only permits HTTPS port 443");
  }
  return normalizeBrowserHost(url.hostname);
}

/**
 * IDNA-normalized lowercase hostname (Python ``_normalize_host`` parity).
 * IP literals keep their brackets stripped for IPv6.
 */
export function normalizeBrowserHost(hostname: string): string {
  const bare = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (bare === "" || bare === "localhost") {
    throw new UnsafeUrlError("browser URL must have a public hostname");
  }
  // WHATWG URL parsing applies IDNA (punycode) conversion.
  let encoded: string;
  try {
    encoded = new URL(`https://${bare}/`).hostname;
  } catch {
    throw new UnsafeUrlError("browser URL must have a public hostname");
  }
  return encoded;
}

/** Create the strict production browser egress policy. */
export function createStrictBrowserEgressPolicy(
  options: BrowserEgressPolicyOptions = {},
): BrowserEgressPolicy {
  const resolve = options.resolve ?? resolveAllAddresses;
  return {
    validateUrl: async (url, authorizedHosts) => {
      const host = strictHttpsAuthority(url);
      if (authorizedHosts.has(host)) {
        return host;
      }
      let addresses: ResolvedAddress[];
      try {
        addresses = await resolve(host);
      } catch {
        throw new UnsafeUrlError(`browser hostname could not be resolved: ${host}`);
      }
      if (addresses.length === 0) {
        throw new UnsafeUrlError(`browser hostname could not be resolved: ${host}`);
      }
      for (const address of addresses) {
        if (!isGlobalAddress(address.address)) {
          throw new UnsafeUrlError(
            `browser hostname resolved to a non-public address: ${address.address}`,
          );
        }
      }
      authorizedHosts.add(host);
      return host;
    },
  };
}

/** The strict production policy (default pool egress). */
export const strictBrowserEgressPolicy: BrowserEgressPolicy =
  createStrictBrowserEgressPolicy();
