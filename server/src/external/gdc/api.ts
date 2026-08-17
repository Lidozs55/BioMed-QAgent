/**
 * NCI Genomic Data Commons REST API helpers (Python
 * ``skills/builtin/acquisition/gdc.py`` parity).
 *
 * URL building mirrors ``_build_url`` (urllib.parse.urlencode), JSON fetches
 * go through the policy-validating ``PublicHttpClient`` restricted to the
 * curated GDC host, and token-OR term matching mirrors ``_match_term``.
 * Downloads themselves never happen here — they route through
 * ``acquireSource`` (P5-D3); this module only speaks to the JSON metadata
 * endpoints.
 */

import type { AddressResolver } from "../network/dns.js";
import { UnsafeUrlError } from "../network/errors.js";
import {
  PublicHttpClient,
  validateCuratedSourceUrl,
} from "../network/http-client.js";
import { CURATED_SOURCE_HOSTS } from "../acquisition/downloader.js";

export const GDC_API_BASE = "https://api.gdc.cancer.gov";

/** Python ``BROWSER_UA`` (browser_pool.py). */
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

/** Python ``get_runtime_limits().http_timeout_seconds`` default. */
export const GDC_JSON_TIMEOUT_MS = 30_000;

/**
 * User-friendly data type names → GDC API data_type values
 * (Python ``_DATA_TYPE_MAP``).
 */
export const GDC_DATA_TYPE_MAP: Readonly<Record<string, string>> = {
  "rna-seq": "Gene Expression Quantification",
  rna_seq: "Gene Expression Quantification",
  rnaseq: "Gene Expression Quantification",
  "gene expression": "Gene Expression Quantification",
  "mirna-seq": "miRNA Expression Quantification",
  mirna: "miRNA Expression Quantification",
  cna: "Copy Number Segment",
  cnv: "Copy Number Segment",
  methylation: "Methylation Beta Value",
  somatic: "Masked Somatic Mutation",
  mutation: "Masked Somatic Mutation",
  clinical: "Clinical Supplement",
  slide: "Slide Image",
  biospecimen: "Biospecimen Supplement",
};

/** Token 短于该字符数时不参与 OR 匹配（避免 "and"/"or" 等噪声词）。 */
const MIN_TOKEN_LEN = 3;

/** Build a GDC API URL with query parameters (Python ``_build_url``). */
export function buildGdcUrl(
  path: string,
  params?: Readonly<Record<string, string>>,
): string {
  if (params === undefined || Object.keys(params).length === 0) {
    return `${GDC_API_BASE}${path}`;
  }
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) search.set(key, value);
  return `${GDC_API_BASE}${path}?${search.toString()}`;
}

export interface GdcRequestOptions {
  resolve?: AddressResolver;
  signal?: AbortSignal;
  timeoutMs?: number;
  connectTimeoutMs?: number;
  /** Enforced once before every external request (Python ``rate_limit``). */
  rateLimit?: () => Promise<void>;
}

/**
 * Fetch and parse JSON from a GDC metadata endpoint. The URL is validated
 * against the curated host allowlist before the request and on every
 * redirect hop (same-host only).
 */
export async function fetchGdcJson(
  client: PublicHttpClient,
  url: string,
  options: GdcRequestOptions = {},
): Promise<unknown> {
  await options.rateLimit?.();
  const resolve = options.resolve ?? client.resolve;
  await validateCuratedSourceUrl(url, CURATED_SOURCE_HOSTS, resolve);
  const response = await client.request(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      Accept: "application/json",
    },
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    connectTimeoutMs: options.connectTimeoutMs,
    validateUrl: async (value) => {
      await validateCuratedSourceUrl(value, CURATED_SOURCE_HOSTS, resolve);
    },
    validateRedirect: async (from, to) => {
      const fromHost = new URL(from).hostname;
      const toHost = await validateCuratedSourceUrl(to, CURATED_SOURCE_HOSTS, resolve);
      if (fromHost !== toHost) {
        throw new UnsafeUrlError("download redirect changed host");
      }
    },
  });
  if (response.status < 200 || response.status >= 300) {
    await response.discard();
    throw new Error(`GDC API returned HTTP ${response.status}`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Resolve a shorthand data type to its full GDC API name. */
export function normalizeGdcDataType(dataType: string): string {
  const key = dataType.trim().toLowerCase();
  return GDC_DATA_TYPE_MAP[key] ?? dataType.trim();
}

/**
 * Token-OR matching for GDC project search (Python ``_match_term``).
 * Single-token queries keep exact substring matching; multi-word queries
 * accept a record when any token of length ≥ 3 appears in the search text.
 */
export function matchGdcTerm(term: string, searchText: string): boolean {
  if (!term) return false;
  const termLower = term.toLowerCase();
  const textLower = searchText.toLowerCase();
  if (!termLower.includes(" ")) {
    return textLower.includes(termLower);
  }
  const tokens = termLower.split(" ").filter((token) => token.length >= MIN_TOKEN_LEN);
  if (tokens.length === 0) {
    return textLower.includes(termLower);
  }
  return tokens.some((token) => textLower.includes(token));
}
