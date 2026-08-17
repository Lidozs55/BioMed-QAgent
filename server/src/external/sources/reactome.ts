/**
 * Reactome source client (Python ``skills/builtin/acquisition/reactome.py``
 * parity): search and fetch biological pathway data through the ContentService
 * REST API with the three-tier fallback chain (api → html → crawl).
 *
 * ``download_reactome`` routes through ``acquireSource`` (P5-D3): participant
 * TSV / SBGN diagram exports are published as immutable content-addressed
 * SourceAssets with DownloadAttempt records.
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
  apiFetch,
  fallbackFetch,
  isRecord,
  makeSourceId,
  quoteQuery,
  rateLimit,
  stripHtml,
  visibleText,
  type FallbackAttempt,
  type FallbackFetchResult,
} from "./fallback.js";

const REACTOME_API_BASE = "https://reactome.org/ContentService";
const REACTOME_PAGE_BASE = "https://reactome.org/content/detail";

/** search_reactome enriches the first N entries without a search-API summary. */
const SUMMATION_BATCH_LIMIT = 3;

export interface DownloadDeps {
  taskRoot: string;
  cache: ContentCache;
  client: PublicHttpClient;
  signal?: AbortSignal;
  rateLimitMs?: number;
  maxDownloadBytes?: number;
  timeoutMs?: number;
}

/** Python ``_reactome_api_document``: parsed JSON dict or null. */
export function reactomeApiDocument(content: string): Record<string, unknown> | null {
  try {
    const document = JSON.parse(content) as unknown;
    return isRecord(document) ? document : null;
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

/**
 * Python ``_fetch_pathway_summation``: fetch the summation endpoint for one
 * pathway; returns "" on any failure so callers keep the record unchanged.
 */
async function fetchPathwaySummation(
  pathwayId: string,
  context: SourceQueryContext,
): Promise<string> {
  if (pathwayId.length === 0) return "";
  const url = `${REACTOME_API_BASE}/data/pathways/${pathwayId}/summation`;
  try {
    const fetched = await apiFetch(context.client, url, {
      signal: context.signal,
      rateLimitMs: context.rateLimitMs,
    });
    if (fetched.status_code < 200 || fetched.status_code >= 300) return "";
    const data = JSON.parse(fetched.content) as unknown;
    if (!Array.isArray(data)) return "";
    const texts: string[] = [];
    for (const item of data) {
      if (isRecord(item)) {
        const text = item["text"];
        if (typeof text === "string" && text.length > 0) texts.push(stripHtml(text));
      }
    }
    return texts.join("\n");
  } catch (error) {
    if (isAbortError(error) || context.signal?.aborted === true) throw error;
    return "";
  }
}

/** Search Reactome for biological pathways matching a keyword. */
export async function searchReactome(
  term: string,
  maxResults: number,
  context: SourceQueryContext,
): Promise<Record<string, unknown>> {
  context.onQueryStarted?.(term, "reactome");
  const encoded = quoteQuery(term);
  const apiUrl =
    `${REACTOME_API_BASE}/search/query?query=${encoded}` +
    `&species=Homo+sapiens&startIndex=0&pageSize=${maxResults}`;
  const pageUrl = `https://reactome.org/content/query?q=${encoded}`;

  let fetched: Awaited<ReturnType<typeof fallbackFetch>>;
  try {
    fetched = await fallbackFetch({
      sourceName: "reactome",
      apiUrl,
      pageUrl,
      acceptResult: (methodUsed, content) => {
        if (methodUsed === "api") {
          const document = reactomeApiDocument(content);
          return document !== null && Array.isArray(document["results"]);
        }
        return visibleText(content).length > 0;
      },
      client: context.client,
      browserFallback: context.browserFallback,
      signal: context.signal,
      rateLimitMs: context.rateLimitMs,
    });
  } catch (error) {
    if (isAbortError(error) || context.signal?.aborted === true) throw error;
    if (!(error instanceof FallbackFailure)) throw error;
    context.onQuery?.(term, "reactome", "failed", 0);
    return fallbackError("reactome", pageUrl, error);
  }

  if (fetched.method_used === "api") {
    try {
      const data = JSON.parse(fetched.content) as unknown;
      const document = isRecord(data) ? data : {};
      const groups = Array.isArray(document["results"]) ? document["results"] : [];
      const entries: unknown[] = [];
      for (const group of groups) {
        const entryList = isRecord(group) ? group["entries"] : undefined;
        if (Array.isArray(entryList)) entries.push(...entryList);
      }
      const truncated = entries.slice(0, maxResults);
      const enrichLimit = Math.min(truncated.length, SUMMATION_BATCH_LIMIT);
      const records: Array<Record<string, unknown>> = [];
      for (let index = 0; index < truncated.length; index += 1) {
        const rawEntry = truncated[index];
        const entry = isRecord(rawEntry) ? rawEntry : {};
        let summary = stripHtml(typeof entry["summation"] === "string" ? entry["summation"] : "");
        const stId = typeof entry["stId"] === "string" ? entry["stId"] : "";
        if (summary.length === 0 && index < enrichLimit) {
          summary = await fetchPathwaySummation(stId, context);
        }
        const speciesRaw = entry["species"];
        const species = Array.isArray(speciesRaw)
          ? speciesRaw.join(", ")
          : String(speciesRaw ?? "");
        const typeValue = Object.prototype.hasOwnProperty.call(entry, "exactType")
          ? entry["exactType"]
          : entry["type"];
        records.push({
          pathway_id: stId,
          name: stripHtml(typeof entry["name"] === "string" ? entry["name"] : ""),
          species,
          summary,
          type: typeValue ?? "",
          url: `${REACTOME_PAGE_BASE}/${stId}`,
        });
      }
      context.onQuery?.(term, "reactome", "success", records.length);
      return {
        source: "reactome",
        term,
        count: records.length,
        total_matches:
          typeof document["numberOfMatches"] === "number"
            ? document["numberOfMatches"]
            : records.length,
        records,
        enriched_count: enrichLimit,
        method_used: "api",
        attempts: attemptAudit(fetched.attempts),
      };
    } catch (error) {
      if (isAbortError(error) || context.signal?.aborted === true) throw error;
      // Python logs a warning and falls through to the page fallback.
    }
  }
  context.onQuery?.(term, "reactome", "page_fallback", 0);
  return pageFallback("reactome", pageUrl, fetched);
}

/** Get detailed information about a specific Reactome pathway. */
export async function getPathway(
  pathwayId: string,
  context: SourceQueryContext,
): Promise<Record<string, unknown>> {
  context.onQueryStarted?.(pathwayId, "reactome");
  const apiUrl = `${REACTOME_API_BASE}/data/query/${pathwayId}`;
  const pageUrl = `${REACTOME_PAGE_BASE}/${pathwayId}`;

  let fetched: Awaited<ReturnType<typeof fallbackFetch>>;
  try {
    fetched = await fallbackFetch({
      sourceName: "reactome",
      apiUrl,
      pageUrl,
      acceptResult: (methodUsed, content) => {
        if (methodUsed === "api") {
          const document = reactomeApiDocument(content);
          return document !== null && typeof document["stId"] === "string";
        }
        return visibleText(content).length > 0;
      },
      client: context.client,
      browserFallback: context.browserFallback,
      signal: context.signal,
      rateLimitMs: context.rateLimitMs,
    });
  } catch (error) {
    if (isAbortError(error) || context.signal?.aborted === true) throw error;
    if (!(error instanceof FallbackFailure)) throw error;
    context.onQuery?.(pathwayId, "reactome", "failed", 0);
    return fallbackError("reactome", pageUrl, error);
  }

  if (fetched.method_used === "api") {
    try {
      const data = JSON.parse(fetched.content) as unknown;
      const document = isRecord(data) ? data : {};
      const stId = typeof document["stId"] === "string" ? document["stId"] : pathwayId;
      const rawName = document["name"];
      let name: string;
      if (Array.isArray(rawName)) {
        name = rawName.length > 0 ? String(rawName[0]) : "";
      } else {
        name = String(rawName ?? "");
      }
      const record = {
        pathway_id: stId,
        name: stripHtml(name),
        species: typeof document["speciesName"] === "string" ? document["speciesName"] : "",
        has_diagram: document["hasDiagram"] === true,
        url: `${REACTOME_PAGE_BASE}/${stId}`,
        summation: stripHtml(typeof document["summation"] === "string" ? document["summation"] : ""),
        release_date: typeof document["releaseDate"] === "string" ? document["releaseDate"] : "",
      };
      context.onQuery?.(pathwayId, "reactome", "success", 1);
      return {
        source: "reactome",
        pathway_id: pathwayId,
        record,
        method_used: "api",
        attempts: attemptAudit(fetched.attempts),
      };
    } catch (error) {
      if (isAbortError(error) || context.signal?.aborted === true) throw error;
      // Python logs a warning and falls through to the page fallback.
    }
  }
  context.onQuery?.(pathwayId, "reactome", "page_fallback", 0);
  return pageFallback("reactome", pageUrl, fetched);
}

/** Download a Reactome pathway file (participants TSV or SBGN) via acquireSource. */
export async function downloadReactome(
  pathwayId: string,
  fileType: string,
  deps: DownloadDeps,
): Promise<Record<string, unknown>> {
  const normalizedId = pathwayId.trim();
  const normalizedType = fileType.toLowerCase().trim().replace(/^\./, "");

  let url: string;
  let filename: string;
  let formatHint: string;
  if (normalizedType === "tsv") {
    url = `${REACTOME_API_BASE}/exporter/participants/${normalizedId}.tsv`;
    filename = `${normalizedId}_participants.tsv`;
    formatHint = "reactome_participants_tsv";
  } else if (normalizedType === "sbgn") {
    url = `${REACTOME_API_BASE}/exporter/diagram/${normalizedId}.sbgn`;
    filename = `${normalizedId}.sbgn`;
    formatHint = "reactome_sbgn";
  } else {
    return {
      source: "reactome",
      pathway_id: normalizedId,
      error: `unsupported file_type: ${normalizedType}. Use 'tsv' or 'sbgn'.`,
    };
  }

  const retrievedAt = new Date().toISOString();
  const source: SourceRecord = {
    schema_version: "1.0",
    source_id: makeSourceId("reactome", normalizedId, url),
    database: "reactome",
    accession: normalizedId,
    url,
    title: `Reactome pathway ${normalizedId} ${normalizedType.toUpperCase()}`,
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
        source: "reactome",
        pathway_id: normalizedId,
        source_url: url,
        error: `download failed: ${result.attempt.error_message ?? "unknown error"}`,
      };
    }
    return {
      source: "reactome",
      pathway_id: normalizedId,
      source_url: url,
      local_files: [path.join(deps.taskRoot, result.asset.relative_path)],
      format_hint: formatHint,
      retrieved_at: retrievedAt,
    };
  } catch (error) {
    if (isAbortError(error) || deps.signal?.aborted === true) throw error;
    return {
      source: "reactome",
      pathway_id: normalizedId,
      source_url: url,
      error: `download failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
