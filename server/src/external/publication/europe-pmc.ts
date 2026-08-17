/**
 * Europe PMC PMCID → fullTextXML retrieval client (Python
 * ``app/integrations/europepmc.py`` parity).
 *
 * Third tier of the PDF fallback chain:
 *     pdf_url (direct) → Unpaywall (DOI, 5s quick failure) → EPMC fullTextXML
 *
 * Europe PMC is the project_memory-mandated alternative paper acquisition
 * channel for domestic network stability. Endpoint:
 * ``https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/fullTextXML``.
 *
 * The XML is saved as an ``.xml`` asset (not a PDF), so downstream consumers
 * must handle XML parsing.
 */

import { CURATED_SOURCE_HOSTS } from "../acquisition/downloader.js";
import type { AddressResolver } from "../network/dns.js";
import { PublicHttpClient, type HttpClientResponse } from "../network/http-client.js";
import { validateHttpsSourceUrl } from "../network/url-policy.js";
import { describeError } from "../ncbi/retry.js";
import { looksLikeXml } from "./xml.js";

const EPMC_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest";
//: EPMC is domestically reachable; allow a longer timeout than Unpaywall.
const EPMC_TIMEOUT_MS = 30_000;

//: Project-wide browser User-Agent (Python BROWSER_UA parity).
export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/131.0.0.0 Safari/537.36";

export class EuropePmcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EuropePmcError";
  }
}

/** Python ``str`` repr for error messages (single-quoted, backslash escapes). */
function pythonStrRepr(value: string): string {
  const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${escaped}'`;
}

/** Python ``bytes`` repr for the non-XML excerpt (latin-1 range). */
export function pythonBytesRepr(buffer: Buffer): string {
  let out = "b'";
  for (const byte of buffer) {
    if (byte === 0x5c) out += "\\\\";
    else if (byte === 0x27) out += "\\'";
    else if (byte === 0x0a) out += "\\n";
    else if (byte === 0x0d) out += "\\r";
    else if (byte === 0x09) out += "\\t";
    else if (byte < 0x20 || byte >= 0x7f) out += `\\x${byte.toString(16).padStart(2, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return `${out}'`;
}

/** Normalize a PMCID to the bare digits form (e.g. PMC7450705 → 7450705). */
function normalizePmcid(pmcid: string): string {
  const clean = pmcid.trim();
  const digits = clean.toLowerCase().startsWith("pmc") ? clean.slice(3) : clean;
  if (!/^\d+$/.test(digits)) {
    throw new EuropePmcError(`invalid PMCID (expected PMC\\d+): ${pythonStrRepr(pmcid)}`);
  }
  return digits;
}

export interface FetchFullTextXmlOptions {
  /** Network timeout in ms (default 30000; EPMC is domestically reachable). */
  timeoutMs?: number;
  client?: PublicHttpClient;
  /** DNS resolver for policy checks; defaults to the client's resolver. */
  resolve?: AddressResolver;
  signal?: AbortSignal;
}

async function readBody(response: HttpClientResponse): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of response.body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/**
 * Fetch the fullTextXML for an open-access PMC article (Python
 * ``fetch_full_text_xml`` message parity).
 */
export async function fetchFullTextXml(pmcid: string, options: FetchFullTextXmlOptions = {}): Promise<Buffer> {
  const digits = normalizePmcid(pmcid);
  const url = `${EPMC_BASE}/PMC${digits}/fullTextXML`;
  const client = options.client ?? new PublicHttpClient({ resolve: options.resolve });
  const timeoutMs = options.timeoutMs ?? client.timeoutMs ?? EPMC_TIMEOUT_MS;
  const resolver = options.resolve ?? client.resolve;

  let response: HttpClientResponse;
  try {
    response = await client.request(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        "Accept": "application/xml, text/xml, */*",
      },
      signal: options.signal,
      timeoutMs,
      connectTimeoutMs: Math.min(timeoutMs, 30_000),
      resolve: resolver,
      validateUrl: async (value) => {
        await validateHttpsSourceUrl(value, CURATED_SOURCE_HOSTS, {
          resolvePublic: true,
          resolve: resolver,
        });
      },
    });
  } catch (error) {
    throw new EuropePmcError(`EPMC network error: ${describeError(error)}`);
  }

  if (response.status === 404) {
    await response.discard();
    throw new EuropePmcError(`PMCID PMC${digits} not found in Europe PMC (not OA or does not exist)`);
  }
  if (response.status !== 200) {
    await response.discard();
    throw new EuropePmcError(`EPMC returned HTTP ${response.status} for PMC${digits}`);
  }

  let content: Buffer;
  try {
    content = await readBody(response);
  } catch (error) {
    throw new EuropePmcError(`EPMC network error: ${describeError(error)}`);
  }
  if (content.length === 0) {
    throw new EuropePmcError(`EPMC returned empty body for PMC${digits}`);
  }

  // Sanity check: should be XML (Python bytes.lstrip + startswith(b"<") parity)
  if (!looksLikeXml(content)) {
    throw new EuropePmcError(
      `EPMC returned non-XML body for PMC${digits} (first 80 bytes: ${pythonBytesRepr(content.subarray(0, 80))})`,
    );
  }
  return content;
}

/**
 * Canonical EPMC fullTextXML URL for a PMCID (Python
 * ``fetch_full_text_xml_url`` parity) — used to register provenance before
 * the actual download via ``acquireSource()``.
 */
export function fetchFullTextXmlUrl(pmcid: string): string {
  const digits = normalizePmcid(pmcid);
  return `${EPMC_BASE}/PMC${digits}/fullTextXML`;
}
