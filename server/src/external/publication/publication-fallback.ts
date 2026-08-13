/**
 * 3-tier publication acquisition fallback (Python
 * ``app/integrations/acquisition.py::acquire_publication_with_fallback``
 * parity):
 *
 * ```text
 * pdf_url (direct) → Unpaywall (DOI, 5s quick failure) → EPMC fullTextXML
 * ```
 *
 * Every tier downloads through ``acquireSource`` (P5-D3) with the curated
 * host allowlist (``CURATED_SOURCE_HOSTS``, which includes
 * ``api.unpaywall.org`` exactly like the Python ``_ALLOWED_HOSTS``); a
 * resolved Unpaywall PDF URL on any other host is rejected by URL validation.
 *
 * Tier 3 downloads the Europe PMC fullTextXML through ``acquireSource``
 * (instead of the Python raw-body fetch) and then re-checks the XML sanity
 * exactly like ``fetch_full_text_xml``; a non-XML body discards the published
 * task asset and fails the tier.
 *
 * Shape difference vs Python (documented, parity-preserving): the function
 * returns a ``PublicationFallbackOutcome`` wrapping the first successful
 * ``AcquisitionResult`` plus all tier attempts and earlier-tier failure
 * strings, so the ``download_supplementary`` tool can populate its stable
 * ``warnings`` / ``download_attempts`` keys. On total failure it throws
 * ``PublicationFallbackError`` (an ``AcquisitionError`` with
 * code ``network_error``) carrying the same ``all PDF acquisition tiers
 * failed: ...`` message Python raises.
 */

import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import path from "node:path";

import { ContentCache } from "../acquisition/content-cache.js";
import { acquireSource, CURATED_SOURCE_HOSTS } from "../acquisition/downloader.js";
import { taskWorkDirs } from "../acquisition/workdir.js";
import type { DataLevel } from "../../dataset/contracts/enums.js";
import type {
  AcquisitionResult,
  DownloadAttempt,
  SourceAsset,
  SourceRecord,
} from "../../dataset/contracts/source.js";
import type { AddressResolver } from "../network/dns.js";
import { AcquisitionError } from "../network/errors.js";
import type { PublicHttpClient } from "../network/http-client.js";
import { EuropePmcError, fetchFullTextXmlUrl, pythonBytesRepr } from "./europe-pmc.js";
import { UnpaywallError, lookupPdfUrl } from "./unpaywall.js";

/** Python ``make_source_id`` (``app/domain/contracts/ids.py``) parity. */
export function makeSourceId(database: string, accession: string, url: string): string {
  const canonical = {
    accession: accession.trim().toLowerCase(),
    database,
    url: url.trim(),
  };
  if (!canonical.accession || !canonical.url) {
    throw new TypeError("accession and url must not be blank");
  }
  return `src_${createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32)}`;
}

export class PublicationFallbackError extends AcquisitionError {
  /** Per-tier failure descriptions (Python failure list). */
  readonly failures: string[];
  /** Every tier's DownloadAttempt in execution order. */
  readonly attempts: DownloadAttempt[];

  constructor(failures: string[], attempts: DownloadAttempt[]) {
    super("network_error", `all PDF acquisition tiers failed: ${failures.join(" | ")}`);
    this.name = "PublicationFallbackError";
    this.failures = failures;
    this.attempts = attempts;
  }
}

export interface PublicationFallbackOutcome {
  /** First successful acquisition result (asset non-null). */
  result: AcquisitionResult;
  /** Every tier's attempt in execution order (failed tiers included). */
  attempts: DownloadAttempt[];
  /** Failure descriptions of tiers tried before the successful one. */
  tierFailures: string[];
}

export interface PublicationFallbackOptions {
  /** Base SourceRecord; ``source.url`` is the tier-1 candidate. */
  source: SourceRecord;
  /** Output filename (e.g. ``"PMC7450705.pdf"``); tier 3 rewrites to ``.xml``. */
  filename: string;
  workdirRoot: string;
  cache: ContentCache;
  client: PublicHttpClient;
  dataLevel: DataLevel;
  maxBytes: number;
  /** DOI for tier 2 (Unpaywall). If undefined, tier 2 is skipped. */
  doi?: string;
  /** PMCID for tier 3 (EPMC). If undefined, tier 3 is skipped. */
  pmcid?: string;
  signal?: AbortSignal;
  /** DNS resolver for policy checks; defaults to the client's resolver. */
  resolve?: AddressResolver;
  /** Unpaywall contact email (forwarded to the lookup). */
  email?: string;
  /** Test seam replacing the Unpaywall lookup (Python monkeypatch parity). */
  lookupPdf?: (doi: string) => Promise<string>;
  /** Forwarded to ``acquireSource`` (Python adapter progress parity). */
  progress?: (bytesReceived: number, total: number | null) => void | Promise<void>;
}

async function readAssetHead(asset: SourceAsset, workdirRoot: string): Promise<Buffer> {
  const file = path.join(workdirRoot, ...asset.relative_path.split("/"));
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(80);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const LSTRIP_WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0b, 0x0c]);

/** Python ``fetch_full_text_xml`` XML sanity check (bytes.lstrip + "<"). */
function looksLikeXml(head: Buffer): boolean {
  let index = 0;
  while (index < head.length && LSTRIP_WHITESPACE.has(head[index] ?? 0)) index++;
  return head[index] === 0x3c;
}

/** Best-effort removal of a published task asset rejected by the XML check. */
async function discardPublishedAsset(asset: SourceAsset, workdirRoot: string): Promise<void> {
  const dirs = taskWorkDirs(workdirRoot);
  await rm(path.join(dirs.sourceAssets, asset.asset_id), { recursive: true, force: true }).catch(
    () => undefined,
  );
}

/**
 * Acquire a publication PDF/XML via the 3-tier fallback chain.
 *
 * Tier order: 1. direct ``source.url`` (only when PDF-like);
 * 2. Unpaywall DOI → OA pdf_url (5s quick failure); 3. Europe PMC
 * fullTextXML by PMCID (saved as an ``.xml`` asset).
 */
export async function acquirePublicationWithFallback(
  options: PublicationFallbackOptions,
): Promise<PublicationFallbackOutcome> {
  const {
    source,
    filename,
    workdirRoot,
    cache,
    client,
    dataLevel,
    maxBytes,
    doi,
    pmcid,
    signal,
    resolve,
    email,
    progress,
  } = options;
  const lookup = options.lookupPdf ?? ((value: string) => lookupPdfUrl(value, { client, resolve, email }));
  const failures: string[] = [];
  const attempts: DownloadAttempt[] = [];

  const acquire = async (tierSource: SourceRecord, tierFilename: string): Promise<AcquisitionResult> => {
    const result = await acquireSource({
      source: tierSource,
      filename: tierFilename,
      workdirRoot,
      cache,
      client,
      dataLevel,
      maxBytes,
      signal,
      resolve,
      allowedHosts: CURATED_SOURCE_HOSTS,
      progress,
    });
    attempts.push(result.attempt);
    return result;
  };

  // --- Tier 1: direct pdf_url (source.url) ---
  // Only attempt if source.url looks like a direct PDF link (Python heuristic).
  const urlLower = source.url.toLowerCase();
  const lastPathSegment = urlLower.split("?")[0]?.split("/").at(-1) ?? "";
  const looksLikePdf = urlLower.endsWith(".pdf") || lastPathSegment.includes("pdf");
  if (looksLikePdf) {
    try {
      const result = await acquire(source, filename);
      if (result.asset !== null && result.attempt.status === "succeeded") {
        return { result, attempts, tierFailures: failures };
      }
      failures.push(
        `tier1_direct: attempt status=${result.attempt.status}, error=${result.attempt.error_message ?? "none"}`,
      );
    } catch (error) {
      if (error instanceof AcquisitionError) failures.push(`tier1_direct: ${error.message}`);
      else throw error;
    }
  } else {
    failures.push("tier1_direct: skipped (source.url not a direct PDF link)");
  }

  // --- Tier 2: Unpaywall (DOI → pdf_url) ---
  if (doi) {
    let resolved: string | null = null;
    try {
      resolved = await lookup(doi);
    } catch (error) {
      if (error instanceof UnpaywallError) {
        failures.push(`tier2_unpaywall_lookup: ${error.message}`);
      } else {
        throw error;
      }
    }
    if (resolved !== null) {
      const unpaywallSource: SourceRecord = { ...source, url: resolved, accession: doi };
      try {
        const result = await acquire(unpaywallSource, filename);
        if (result.asset !== null && result.attempt.status === "succeeded") {
          return { result, attempts, tierFailures: failures };
        }
        failures.push(
          `tier2_unpaywall_download: attempt status=${result.attempt.status}, error=${result.attempt.error_message ?? "none"}`,
        );
      } catch (error) {
        if (error instanceof AcquisitionError) failures.push(`tier2_unpaywall_download: ${error.message}`);
        else throw error;
      }
    }
  } else {
    failures.push("tier2_unpaywall: skipped (no DOI provided)");
  }

  // --- Tier 3: Europe PMC (PMCID → fullTextXML) ---
  if (pmcid) {
    const digits = pmcid.trim().replace(/^pmc/i, "");
    const xmlFilename = filename.includes(".")
      ? `${filename.slice(0, filename.lastIndexOf("."))}.xml`
      : `${filename}.xml`;
    try {
      const xmlUrl = fetchFullTextXmlUrl(pmcid);
      const tierSource: SourceRecord = { ...source, url: xmlUrl, accession: pmcid };
      const result = await acquire(tierSource, xmlFilename);
      if (result.asset !== null && result.attempt.status === "succeeded") {
        const head = await readAssetHead(result.asset, workdirRoot);
        if (looksLikeXml(head)) {
          return { result, attempts, tierFailures: failures };
        }
        failures.push(
          `tier3_epmc: EPMC returned non-XML body for PMC${digits} (first 80 bytes: ${pythonBytesRepr(head)})`,
        );
        await discardPublishedAsset(result.asset, workdirRoot);
      } else {
        failures.push(
          `tier3_epmc: attempt status=${result.attempt.status}, error=${result.attempt.error_message ?? "none"}`,
        );
      }
    } catch (error) {
      if (error instanceof AcquisitionError) failures.push(`tier3_epmc: ${error.message}`);
      else if (error instanceof EuropePmcError) {
        failures.push(`tier3_epmc: ${error.message}`);
      } else {
        throw error;
      }
    }
  } else {
    failures.push("tier3_epmc: skipped (no PMCID provided)");
  }

  throw new PublicationFallbackError(failures, attempts);
}
