/**
 * PubChem source client (Python ``skills/builtin/acquisition/pubchem.py``
 * parity): search and fetch compound data through PUG-REST with the
 * three-tier fallback chain (api → html → crawl).
 *
 * ``download_pubchem`` routes through ``acquireSource`` (P5-D3): the SDF/MOL
 * structure record is published as an immutable content-addressed SourceAsset
 * with a DownloadAttempt record.
 */

import path from "node:path";

import type { DataLevel } from "../../dataset/contracts/enums.js";
import type { SourceRecord } from "../../dataset/contracts/source.js";
import { acquireSource } from "../acquisition/downloader.js";
import type { ContentCache } from "../acquisition/content-cache.js";
import { isAbortError } from "../network/errors.js";
import type { PublicHttpClient } from "../network/http-client.js";
import type { SourceQueryContext } from "./context.js";
import {
  DEFAULT_RATE_LIMIT_MS,
  FallbackFailure,
  MAX_BODY_CHARS,
  fallbackFetch,
  isRecord,
  makeSourceId,
  quoteQuery,
  rateLimit,
  visibleText,
  type FallbackAttempt,
  type FallbackFetchResult,
} from "./fallback.js";

const PUGREST_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug";
const PUBCHEM_PAGE_BASE = "https://pubchem.ncbi.nlm.nih.gov/compound";

export interface DownloadDeps {
  taskRoot: string;
  cache: ContentCache;
  client: PublicHttpClient;
  signal?: AbortSignal;
  rateLimitMs?: number;
  maxDownloadBytes?: number;
  timeoutMs?: number;
}

/** Python ``_pubchem_properties``: the PropertyTable.Properties list or null. */
export function pubchemProperties(content: string): unknown[] | null {
  try {
    const data = JSON.parse(content) as unknown;
    if (!isRecord(data)) return null;
    const table = data["PropertyTable"];
    const properties = isRecord(table) ? table["Properties"] : undefined;
    return Array.isArray(properties) ? properties : null;
  } catch {
    return null;
  }
}

function attemptAudit(attempts: readonly FallbackAttempt[]): Array<Record<string, unknown>> {
  return attempts.map((attempt) => ({
    method: attempt.method,
    url: attempt.url,
    status: attempt.status,
    status_code: attempt.status_code,
    reason: attempt.reason,
    fallback_reason: attempt.fallback_reason,
  }));
}

function pageFallback(
  source: string,
  pageUrl: string,
  fetched: FallbackFetchResult,
): Record<string, unknown> {
  return {
    status: "page_fallback",
    source,
    method_used: fetched.method_used,
    page_url: pageUrl,
    body_text_preview: visibleText(fetched.content).slice(0, MAX_BODY_CHARS),
    attempts: attemptAudit(fetched.attempts),
  };
}

function fallbackError(
  source: string,
  pageUrl: string,
  error: FallbackFailure,
): Record<string, unknown> {
  return {
    status: "error",
    source,
    page_url: pageUrl,
    attempted_methods: ["api", "httpx", "crawl"],
    attempts: attemptAudit(error.attempts),
    error: error.message,
  };
}

function searchPubchemProperties(
  term: string,
  fetched: FallbackFetchResult,
  context: SourceQueryContext,
): Record<string, unknown> | null {
  try {
    const data = JSON.parse(fetched.content) as unknown;
    const document = isRecord(data) ? data : {};
    const table = isRecord(document["PropertyTable"]) ? document["PropertyTable"] : {};
    const compoundsRaw = Array.isArray(table["Properties"]) ? table["Properties"] : [];
    const records = compoundsRaw.map((raw) => {
      const compound = isRecord(raw) ? raw : {};
      const cidValue = compound["CID"];
      return {
        cid: typeof cidValue === "number" ? cidValue : 0,
        molecular_formula:
          typeof compound["MolecularFormula"] === "string" ? compound["MolecularFormula"] : "",
        molecular_weight:
          typeof compound["MolecularWeight"] === "number" ? compound["MolecularWeight"] : 0,
        iupac_name: typeof compound["IUPACName"] === "string" ? compound["IUPACName"] : "",
        canonical_smiles:
          typeof compound["CanonicalSMILES"] === "string" ? compound["CanonicalSMILES"] : "",
        url: `${PUBCHEM_PAGE_BASE}/${cidValue ?? ""}`,
      };
    });
    context.onQuery?.(term, "pubchem", "success", records.length);
    return {
      source: "pubchem",
      term,
      count: records.length,
      records,
      method_used: "api",
      attempts: attemptAudit(fetched.attempts),
    };
  } catch (error) {
    if (isAbortError(error) || context.signal?.aborted === true) throw error;
    // Python logs a warning and falls through to the page fallback with the api result.
    return null;
  }
}

/** Search PubChem for chemical compounds matching a name or keyword. */
export async function searchPubchem(
  term: string,
  maxResults: number,
  context: SourceQueryContext,
): Promise<Record<string, unknown>> {
  const encoded = quoteQuery(term);
  context.onQueryStarted?.(term, "pubchem");
  const apiUrl =
    `${PUGREST_BASE}/compound/name/${encoded}/property/` +
    `MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES/` +
    `JSON?MaxRecords=${maxResults}`;
  const pageUrl = `https://pubchem.ncbi.nlm.nih.gov/#query=${encoded}`;

  let fetched: Awaited<ReturnType<typeof fallbackFetch>>;
  try {
    fetched = await fallbackFetch({
      sourceName: "pubchem",
      apiUrl,
      pageUrl,
      // Python parity: the static html tier is always rejected for PubChem —
      // only the api tier and the rendered crawl tier can be accepted.
      acceptResult: (methodUsed, content) => {
        if (methodUsed === "api") return pubchemProperties(content) !== null;
        return methodUsed === "crawl" && visibleText(content).length > 0;
      },
      client: context.client,
      browserFallback: context.browserFallback,
      signal: context.signal,
      rateLimitMs: context.rateLimitMs,
    });
  } catch (error) {
    if (isAbortError(error) || context.signal?.aborted === true) throw error;
    if (!(error instanceof FallbackFailure)) throw error;
    context.onQuery?.(term, "pubchem", "failed", 0);
    return fallbackError("pubchem", pageUrl, error);
  }

  if (fetched.method_used === "api") {
    const parsed = searchPubchemProperties(term, fetched, context);
    if (parsed !== null) return parsed;
  }
  context.onQuery?.(term, "pubchem", "page_fallback", 0);
  return pageFallback("pubchem", pageUrl, fetched);
}

/** Get detailed information about a specific PubChem compound by CID. */
export async function getCompound(
  cid: number,
  context: SourceQueryContext,
): Promise<Record<string, unknown>> {
  context.onQueryStarted?.(String(cid), "pubchem");
  const apiUrl =
    `${PUGREST_BASE}/compound/cid/${cid}/property/` +
    `MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,InChIKey,InChI/JSON`;
  const pageUrl = `${PUBCHEM_PAGE_BASE}/${cid}`;

  let fetched: Awaited<ReturnType<typeof fallbackFetch>>;
  try {
    fetched = await fallbackFetch({
      sourceName: "pubchem",
      apiUrl,
      pageUrl,
      // Python parity: an empty PropertyTable list is rejected for the
      // compound endpoint (bool(properties)), unlike the search endpoint.
      acceptResult: (methodUsed, content) => {
        if (methodUsed === "api") {
          const properties = pubchemProperties(content);
          return properties !== null && properties.length > 0;
        }
        return methodUsed === "crawl" && visibleText(content).length > 0;
      },
      client: context.client,
      browserFallback: context.browserFallback,
      signal: context.signal,
      rateLimitMs: context.rateLimitMs,
    });
  } catch (error) {
    if (isAbortError(error) || context.signal?.aborted === true) throw error;
    if (!(error instanceof FallbackFailure)) throw error;
    context.onQuery?.(String(cid), "pubchem", "failed", 0);
    return fallbackError("pubchem", pageUrl, error);
  }

  if (fetched.method_used === "api") {
    try {
      const properties = pubchemProperties(fetched.content);
      const first = properties !== null && properties.length > 0 ? properties[0] : undefined;
      if (isRecord(first)) {
        const record = {
          cid: typeof first["CID"] === "number" ? first["CID"] : cid,
          molecular_formula:
            typeof first["MolecularFormula"] === "string" ? first["MolecularFormula"] : "",
          molecular_weight: typeof first["MolecularWeight"] === "number" ? first["MolecularWeight"] : 0,
          iupac_name: typeof first["IUPACName"] === "string" ? first["IUPACName"] : "",
          canonical_smiles:
            typeof first["CanonicalSMILES"] === "string" ? first["CanonicalSMILES"] : "",
          inchi_key: typeof first["InChIKey"] === "string" ? first["InChIKey"] : "",
          inchi: typeof first["InChI"] === "string" ? first["InChI"] : "",
          url: `${PUBCHEM_PAGE_BASE}/${cid}`,
        };
        context.onQuery?.(String(cid), "pubchem", "success", 1);
        return {
          source: "pubchem",
          cid,
          record,
          method_used: "api",
          attempts: attemptAudit(fetched.attempts),
        };
      }
    } catch (error) {
      if (isAbortError(error) || context.signal?.aborted === true) throw error;
      // Python logs a warning and falls through to the page fallback.
    }
  }
  context.onQuery?.(String(cid), "pubchem", "page_fallback", 0);
  return pageFallback("pubchem", pageUrl, fetched);
}

/** Download a PubChem compound structure file (SDF or MOL) via acquireSource. */
export async function downloadPubchem(
  cid: number,
  fileType: string,
  deps: DownloadDeps,
): Promise<Record<string, unknown>> {
  const normalizedType = fileType.toLowerCase().trim().replace(/^\./, "");
  if (normalizedType !== "sdf" && normalizedType !== "mol") {
    return {
      source: "pubchem",
      cid,
      error: `unsupported file_type: ${normalizedType}. Use 'sdf' or 'mol'.`,
    };
  }
  const ext = normalizedType.toUpperCase();
  const url = `${PUGREST_BASE}/compound/cid/${cid}/record/${ext}?record_type=2d`;
  const filename = `CID${cid}.${normalizedType}`;
  const formatHint = `pubchem_${normalizedType}`;

  const retrievedAt = new Date().toISOString();
  const source: SourceRecord = {
    schema_version: "1.0",
    source_id: makeSourceId("pubchem", String(cid), url),
    database: "pubchem",
    accession: String(cid),
    url,
    title: `PubChem compound ${cid} ${ext} structure`,
    retrieved_at: retrievedAt,
  };

  try {
    await rateLimit(deps.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS);
    const result = await acquireSource({
      source,
      filename,
      workdirRoot: deps.taskRoot,
      cache: deps.cache,
      client: deps.client,
      dataLevel: "repository_processed" satisfies DataLevel,
      maxBytes: deps.maxDownloadBytes ?? 4096 * 1024 * 1024,
      accept: "*/*",
      signal: deps.signal,
      timeoutMs: deps.timeoutMs,
    });
    if (result.asset === null) {
      return {
        source: "pubchem",
        cid,
        source_url: url,
        error: `download failed: ${result.attempt.error_message ?? "unknown error"}`,
      };
    }
    return {
      source: "pubchem",
      cid,
      source_url: url,
      local_files: [path.join(deps.taskRoot, result.asset.relative_path)],
      format_hint: formatHint,
      retrieved_at: retrievedAt,
    };
  } catch (error) {
    if (isAbortError(error) || deps.signal?.aborted === true) throw error;
    return {
      source: "pubchem",
      cid,
      source_url: url,
      error: `download failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
