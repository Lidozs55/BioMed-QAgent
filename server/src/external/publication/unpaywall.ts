/**
 * Unpaywall DOI → OA PDF URL lookup client (Python
 * ``app/integrations/unpaywall.py`` parity).
 *
 * Second tier of the PDF fallback chain:
 *     pdf_url (direct) → Unpaywall (DOI, 5s quick failure) → EPMC fullTextXML
 *
 * Endpoint: ``https://api.unpaywall.org/v2/{doi}?email={email}``.
 * Only resolves the DOI to a best-oa-location pdf_url; the actual download
 * goes through ``acquireSource`` once the URL is known.
 */

import { URL } from "node:url";

import { CURATED_SOURCE_HOSTS } from "../acquisition/downloader.js";
import type { AddressResolver } from "../network/dns.js";
import { PublicHttpClient, type HttpClientResponse } from "../network/http-client.js";
import { validateHttpsSourceUrl } from "../network/url-policy.js";
import { describeError, timeoutSignal } from "../ncbi/retry.js";

const UNPAYWALL_BASE = "https://api.unpaywall.org/v2";
//: 5-second quick failure per project_memory L1 hard constraint.
const UNPAYWALL_TIMEOUT_MS = 5_000;

export class UnpaywallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnpaywallError";
  }
}

export interface LookupPdfUrlOptions {
  /** Unpaywall contact email; defaults to ``NCBI_EMAIL`` then a placeholder. */
  email?: string;
  /** Quick-failure timeout in ms (default 5000 per project_memory L1). */
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
 * Resolve a DOI to an open-access PDF URL via Unpaywall.
 *
 * Leading ``https://doi.org/`` / ``http://doi.org/`` / ``doi:`` prefixes are
 * stripped automatically. Raises ``UnpaywallError`` on any failure (Python
 * message parity).
 */
export async function lookupPdfUrl(doi: string, options: LookupPdfUrlOptions = {}): Promise<string> {
  let cleanDoi = doi.trim();
  for (const prefix of ["https://doi.org/", "http://doi.org/", "doi:"]) {
    if (cleanDoi.toLowerCase().startsWith(prefix)) {
      cleanDoi = cleanDoi.slice(prefix.length);
      break;
    }
  }
  if (!cleanDoi) throw new UnpaywallError("empty DOI after normalization");

  const contactEmail = options.email ?? process.env["NCBI_EMAIL"] ?? "biomed-qagent@example.com";
  const timeoutMs = options.timeoutMs ?? UNPAYWALL_TIMEOUT_MS;
  const client = options.client ?? new PublicHttpClient({ resolve: options.resolve });
  const resolver = options.resolve ?? client.resolve;
  const url = new URL(`${UNPAYWALL_BASE}/${cleanDoi}`);
  url.searchParams.set("email", contactEmail);

  const timer = timeoutSignal(timeoutMs);
  let response: HttpClientResponse;
  let body: Buffer;
  try {
    response = await client.request(url.toString(), {
      signal: options.signal === undefined ? timer.signal : AbortSignal.any([options.signal, timer.signal]),
      connectTimeoutMs: timeoutMs,
      resolve: resolver,
      validateUrl: async (value) => {
        await validateHttpsSourceUrl(value, CURATED_SOURCE_HOSTS, {
          resolvePublic: true,
          resolve: resolver,
        });
      },
    });
    body = await readBody(response);
  } catch (error) {
    throw new UnpaywallError(`Unpaywall network error: ${describeError(error)}`);
  } finally {
    timer.cancel();
  }

  if (response.status === 404) {
    throw new UnpaywallError(`DOI not found in Unpaywall: ${cleanDoi}`);
  }
  if (response.status !== 200) {
    throw new UnpaywallError(`Unpaywall returned HTTP ${response.status} for DOI ${cleanDoi}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(body.toString("utf8"));
  } catch (error) {
    throw new UnpaywallError(`Unpaywall returned non-JSON response: ${describeError(error)}`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new UnpaywallError("Unpaywall returned a non-object JSON document");
  }
  const record = data as Record<string, unknown>;

  // is_oa flag is the authoritative OA status
  if (!record["is_oa"]) {
    throw new UnpaywallError(`DOI ${cleanDoi} has no open-access version`);
  }

  // best_oa_location is the preferred OA location (Unpaywall ranks them)
  const bestOa = record["best_oa_location"];
  if (typeof bestOa !== "object" || bestOa === null || Array.isArray(bestOa)) {
    throw new UnpaywallError(`DOI ${cleanDoi} has no best_oa_location`);
  }
  const best = bestOa as Record<string, unknown>;
  const rawPdfUrl = best["url_for_pdf"];
  if (typeof rawPdfUrl !== "string" || rawPdfUrl === "") {
    // Fall back to landing page if no direct PDF URL
    const landing = best["url"];
    if (typeof landing !== "string" || landing === "") {
      throw new UnpaywallError(`DOI ${cleanDoi} best_oa_location has no url_for_pdf`);
    }
    throw new UnpaywallError(
      `DOI ${cleanDoi} has OA landing page but no direct PDF URL; landing=${landing}`,
    );
  }
  if (!rawPdfUrl.startsWith("https://")) {
    throw new UnpaywallError(`Unpaywall returned non-HTTPS PDF URL (rejected): ${rawPdfUrl}`);
  }
  return rawPdfUrl;
}
