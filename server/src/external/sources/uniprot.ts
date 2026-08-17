/**
 * UniProt discovery source client (Python
 * ``skills/builtin/discovery/uniprot.py`` parity).
 *
 * UniProt is an Agent-only research source (B4): findings may inform
 * investigation but must never be routed into a dataset build as a verified
 * source. Queries the UniProt REST API first and falls back to the rendered
 * knowledgebase search page through the shared three-tier chain.
 */

import { isAbortError } from "../network/errors.js";
import {
  FallbackFailure,
  fallbackFetch,
  isRecord,
  quoteQuery,
  type FallbackAttempt,
} from "./fallback.js";
import type { SourceQueryContext } from "./context.js";

const UNIPROT_API_BASE = "https://rest.uniprot.org/uniprotkb";
const UNIPROT_PAGE_BASE = "https://www.uniprot.org/uniprotkb";
const MAX_BODY_CHARS = 5000;

export const UNIPROT_USAGE_HINT =
  "UniProt 是 Agent-only 研究来源（research_only）：检索结果可用于" +
  "调研与证据收集，但绝不能作为 DatasetBuildSpec 的 verified " +
  "source 进入数据构建——spec 校验会拒绝（source_not_pipeline_supported）。";

/** Python ``_accept_uniprot_search_result``: dict with a ``results`` list. */
export function acceptUniprotSearchResult(methodUsed: string, content: string): boolean {
  if (methodUsed === "api") {
    let document: unknown;
    try {
      document = JSON.parse(content);
    } catch {
      return false;
    }
    return isRecord(document) && Array.isArray(document["results"]);
  }
  return content.length > 0;
}

function proteinName(entry: Record<string, unknown>): string {
  const description = isRecord(entry["proteinDescription"]) ? entry["proteinDescription"] : {};
  const recommended = isRecord(description["recommendedName"]) ? description["recommendedName"] : {};
  const fullName = isRecord(recommended["fullName"]) ? recommended["fullName"] : {};
  const value = fullName["value"];
  return typeof value === "string" ? value : "";
}

function organismName(entry: Record<string, unknown>): string {
  const organism = isRecord(entry["organism"]) ? entry["organism"] : {};
  const value = organism["scientificName"];
  return typeof value === "string" ? value : "";
}

function geneName(entry: Record<string, unknown>): string {
  const genes = entry["genes"];
  if (!Array.isArray(genes) || genes.length === 0) return "";
  const first = isRecord(genes[0]) ? genes[0] : {};
  const geneName = isRecord(first["geneName"]) ? first["geneName"] : {};
  const value = geneName["value"];
  return typeof value === "string" ? value : "";
}

function attemptAudit(attempts: readonly FallbackAttempt[]): Array<Record<string, unknown>> {
  return attempts.map((attempt) => ({
    method: attempt.method,
    url: attempt.url,
    status: attempt.status,
    status_code: attempt.status_code,
  }));
}

/**
 * Search the UniProt knowledgebase for proteins matching a keyword.
 *
 * Returns the Python-shaped JSON object: ``{source, query, count,
 * total_count, records, method_used, attempts, usage_hint}`` on API success,
 * ``{source, query, status:"page_fallback", page_url, method_used,
 * body_preview}`` on page fallback, or ``{source, query, status:"error",
 * error, attempted_methods}`` when every tier fails.
 */
export async function searchUniprot(
  query: string,
  maxResults: number,
  context: SourceQueryContext,
): Promise<Record<string, unknown>> {
  context.onQueryStarted?.(query, "uniprot");
  const apiUrl =
    `${UNIPROT_API_BASE}/search?query=${quoteQuery(query)}` +
    `&format=json&size=${maxResults}`;
  const pageUrl = `${UNIPROT_PAGE_BASE}?query=${quoteQuery(query)}`;

  let fetched: Awaited<ReturnType<typeof fallbackFetch>>;
  try {
    fetched = await fallbackFetch({
      sourceName: "uniprot",
      apiUrl,
      pageUrl,
      acceptResult: acceptUniprotSearchResult,
      client: context.client,
      browserFallback: context.browserFallback,
      signal: context.signal,
      rateLimitMs: context.rateLimitMs,
    });
  } catch (error) {
    if (isAbortError(error) || context.signal?.aborted === true) throw error;
    if (!(error instanceof FallbackFailure)) throw error;
    context.onQuery?.(query, "uniprot", "failed", 0);
    return {
      source: "uniprot",
      query,
      status: "error",
      error: error.message,
      attempted_methods: ["api", "html", "crawl"],
    };
  }

  if (fetched.method_used === "api") {
    const data = JSON.parse(fetched.content) as unknown;
    const document = isRecord(data) ? data : {};
    const entriesRaw = Array.isArray(document["results"]) ? document["results"] : [];
    const entries = entriesRaw.slice(0, maxResults);
    const records = entries.map((raw) => {
      const entry = isRecord(raw) ? raw : {};
      const accession =
        typeof entry["primaryAccession"] === "string" ? entry["primaryAccession"] : "";
      return {
        accession,
        protein_name: proteinName(entry),
        gene: geneName(entry),
        organism: organismName(entry),
        reviewed: entry["reviewed"] === true,
        url: `https://www.uniprot.org/uniprotkb/${accession}`,
      };
    });
    const totalCount =
      typeof document["totalResults"] === "number" ? document["totalResults"] : records.length;
    context.onQuery?.(query, "uniprot", "success", records.length);
    return {
      source: "uniprot",
      query,
      count: records.length,
      total_count: totalCount,
      records,
      method_used: "api",
      attempts: attemptAudit(fetched.attempts),
      usage_hint: UNIPROT_USAGE_HINT,
    };
  }

  context.onQuery?.(query, "uniprot", "success", 0);
  return {
    source: "uniprot",
    query,
    status: "page_fallback",
    page_url: pageUrl,
    method_used: fetched.method_used,
    body_preview: fetched.content.slice(0, MAX_BODY_CHARS),
  };
}
