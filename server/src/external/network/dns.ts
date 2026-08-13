/**
 * DNS resolution helpers for outbound safety checks.
 *
 * Python parity (``app/tools/network_safety.py``): every address the resolver
 * returns must be global — checking only the first result is forbidden. The
 * default resolver uses ``dns.lookup(host, { all: true })`` so both A and AAAA
 * records are inspected; callers that pin a connection re-run resolution once
 * per redirect hop.
 */

import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { promisify } from "node:util";

export interface ResolvedAddress {
  /** Numeric IPv4/IPv6 address string. */
  address: string;
  /** 4 or 6. */
  family: 4 | 6;
}

export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const lookupAll = promisify(dnsLookup) as unknown as (
  hostname: string,
  options: { all: true; verbatim?: boolean },
) => Promise<LookupAddress[]>;

/** Default resolver: OS DNS with ALL records (A + AAAA). */
export const resolveAllAddresses: AddressResolver = async (hostname) => {
  const records = await lookupAll(hostname, { all: true, verbatim: true });
  return records.map((record) => ({
    address: record.address,
    family: record.family as 4 | 6,
  }));
};

function parseIp(value: string): { v4: boolean; parts: number[] } | null {
  const family = isIP(value);
  if (family === 0) return null;
  if (family === 4) {
    const parts = value.split(".").map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => Number.isNaN(part) || part > 255)) {
      return null;
    }
    return { v4: true, parts };
  }
  // Normalize IPv6: expand :: via a parse-free structural check instead of
  // re-serializing the address. We only need prefix classification.
  return { v4: false, parts: ipv6Words(value) };
}

function ipv6Words(value: string): number[] {
  // Produces 8 hextet words (BigInt-safe) or NaN words for malformed input.
  const zone = value.indexOf("%");
  const text = zone >= 0 ? value.slice(0, zone) : value;
  const halves = text.split("::");
  if (halves.length > 2) return [Number.NaN];
  const parseHalf = (half: string): number[] =>
    half === "" ? [] : half.split(":").map((word) => Number.parseInt(word, 16));
  const left = parseHalf(halves[0] ?? "");
  const right = halves.length === 2 ? parseHalf(halves[1] ?? "") : [];
  if (left.some((word) => Number.isNaN(word)) || right.some((word) => Number.isNaN(word))) {
    return [Number.NaN];
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing === 0)) return [Number.NaN];
  return halves.length === 2
    ? [...left, ...Array.from({ length: missing }, () => 0), ...right]
    : left;
}

/** RFC 6890/4291-style public-address classification. */
export function isGlobalIPv4(value: string): boolean {
  const parsed = parseIp(value);
  if (parsed === null || !parsed.v4) return false;
  const [a, b] = parsed.parts;
  if (a === 0 || a === 10 || a === 127) return false; // unspecified / RFC1918 / loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 192 && b === 0 && parsed.parts[2] === 0) return false; // 192.0.0.0/24
  if (a === 192 && b === 0 && parsed.parts[2] === 2) return false; // 192.0.2.0/24 TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmark
  if (a === 198 && b === 51 && parsed.parts[2] === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && parsed.parts[2] === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast/reserved
  if (a === 255 && b === 255 && parsed.parts[2] === 255 && parsed.parts[3] === 255) {
    return false; // limited broadcast
  }
  return true;
}

export function isGlobalIPv6(value: string): boolean {
  const parsed = parseIp(value);
  if (parsed === null || parsed.v4) return false;
  const [w0, w1] = parsed.parts;
  if (parsed.parts.length !== 8 || w0 === undefined || w1 === undefined) return false;
  if (w0 === 0) return false; // ::/8 unspecified/loopback/compat
  if (w0 === 0xfe80) return false; // link-local fe80::/10
  if ((w0 & 0xfe00) === 0xfc00) return false; // ULA fc00::/7
  if (w0 === 0x2001 && w1 === 0x0db8) return false; // documentation 2001:db8::/32
  if ((w0 & 0xff00) === 0xff00) return false; // multicast
  return true;
}

export function isGlobalAddress(address: string): boolean {
  return address.includes(":") ? isGlobalIPv6(address) : isGlobalIPv4(address);
}
