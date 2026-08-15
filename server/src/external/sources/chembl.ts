/**
 * ChEMBL discovery source client (Python
 * ``skills/builtin/discovery/chembl.py`` parity).
 *
 * ChEMBL is an Agent-only research source (B4): findings may inform
 * investigation but must never be routed into a dataset build as a verified
 * source. Queries the ChEMBL REST API first and falls back to the rendered
 * search page through the shared three-tier chain (api → html → crawl).
 */

import type { QueryStatus } from "../../agent/tools/tool-hooks.js";
import { isAbortError } from "../network/errors.js";
import type { PublicHttpClient } from "../network/http-client.js";
import {
  FallbackFailure,
  fallbackFetch,
  isRecord,
  quoteQuery,
  type BrowserFallback,
  type FallbackAttempt,
} from "./fallback.js";

const CHEMBL_API_BASE = "https://www.ebi.ac.uk/chembl/api/data";
const CHEMBL_PAGE_BASE = "https://www.ebi.ac.uk/chembl/g";
const MAX_BODY_CHARS = 5000;

export const CHEMBL_USAGE_HINT =
  "ChEMBL 是 Agent-only 研究来源（research_only）：检索结果可用于" +
  "调研与证据收集，但绝不能作为 DatasetBuildSpec 的 verified " +
  "source 进入数据构建——spec 校验会拒绝（source_not_pipeline_supported）。";

export interface SourceQueryContext {
  client: PublicHttpClient;
  browserFallback?: BrowserFallback;
  signal?: AbortSignal;
  /** Request pacing override for tests; default 2000ms. */
  rateLimitMs?: number;
  onQueryStarted?: (query: string, source: string) => void;
  onQuery?: (query: string, source: string, status: QueryStatus, recordsCount?: number) => void;
}

/** Python ``_accept_chembl_search_result``: dict with a ``molecules`` list. */
export function acceptChemblSearchResult(methodUsed: string, content: string): boolean {
  if (methodUsed === "api") {
    let document: unknown;
    try {
      document = JSON.parse(content);
    } catch {
      return false;
    }
    return isRecord(document) && Array.isArray(document["molecules"]);
  }
  return content.length > 0;
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
 * Search ChEMBL for molecules matching a keyword.
 *
 * Returns the Python-shaped JSON object: ``{source, query, count,
 * total_count, records, method_used, attempts, usage_hint}`` on API success,
 * ``{source, query, status:"page_fallback", page_url, method_used,
 * body_preview}`` on page fallback, or ``{source, query, status:"error",
 * error, attempted_methods}`` when every tier fails.
 */
export async function searchChembl(
  query: string,
  maxResults: number,
  context: SourceQueryContext,
): Promise<Record<string, unknown>> {
  context.onQueryStarted?.(query, "chembl");
  const apiUrl =
    `${CHEMBL_API_BASE}/molecule/search?q=${quoteQuery(query)}` +
    `&limit=${maxResults}&format=json`;
  const pageUrl = `${CHEMBL_PAGE_BASE}/#search_results/all/query/${quoteQuery(query)}`;

  let fetched: Awaited<ReturnType<typeof fallbackFetch>>;
  try {
    fetched = await fallbackFetch({
      sourceName: "chembl",
      apiUrl,
      pageUrl,
      acceptResult: acceptChemblSearchResult,
      client: context.client,
      browserFallback: context.browserFallback,
      signal: context.signal,
      rateLimitMs: context.rateLimitMs,
    });
  } catch (error) {
    if (isAbortError(error) || context.signal?.aborted === true) throw error;
    if (!(error instanceof FallbackFailure)) throw error;
    context.onQuery?.(query, "chembl", "failed", 0);
    return {
      source: "chembl",
      query,
      status: "error",
      error: error.message,
      attempted_methods: ["api", "html", "crawl"],
    };
  }

  if (fetched.method_used === "api") {
    const data = JSON.parse(fetched.content) as unknown;
    const document = isRecord(data) ? data : {};
    const moleculesRaw = Array.isArray(document["molecules"]) ? document["molecules"] : [];
    const molecules = moleculesRaw.slice(0, maxResults);
    const records = molecules.map((raw) => {
      const molecule = isRecord(raw) ? raw : {};
      const chemblId =
        typeof molecule["molecule_chembl_id"] === "string" ? molecule["molecule_chembl_id"] : "";
      return {
        chembl_id: chemblId,
        preferred_name: typeof molecule["pref_name"] === "string" ? molecule["pref_name"] : null,
        molecule_type: typeof molecule["molecule_type"] === "string" ? molecule["molecule_type"] : null,
        max_phase: typeof molecule["max_phase"] === "number" ? molecule["max_phase"] : null,
        url: `https://www.ebi.ac.uk/chembl/compound_report_card/${chemblId}`,
      };
    });
    const pageMeta = isRecord(document["page_meta"]) ? document["page_meta"] : {};
    const totalCount =
      typeof pageMeta["total_count"] === "number" ? pageMeta["total_count"] : records.length;
    context.onQuery?.(query, "chembl", "success", records.length);
    return {
      source: "chembl",
      query,
      count: records.length,
      total_count: totalCount,
      records,
      method_used: "api",
      attempts: attemptAudit(fetched.attempts),
      usage_hint: CHEMBL_USAGE_HINT,
    };
  }

  context.onQuery?.(query, "chembl", "success", 0);
  return {
    source: "chembl",
    query,
    status: "page_fallback",
    page_url: pageUrl,
    method_used: fetched.method_used,
    body_preview: fetched.content.slice(0, MAX_BODY_CHARS),
  };
}
