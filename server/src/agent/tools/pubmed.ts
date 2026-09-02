/**
 * PubMed discovery skill tools (Python
 * ``skills/builtin/discovery/pubmed.py`` parity).
 *
 * ``search_pubmed`` mirrors ``search_pubmed_adapter``: esearch → efetch
 * through the rate-limited eutils client, auto-fallback to
 * ``simplify_ncbi_query`` for natural-language queries with zero hits, and
 * the stable wire shape (``summary``, ``records``, ``usage_hint``, ...).
 * Failures propagate so the tool result is marked ``isError`` (Python raises
 * through the Agents SDK).
 *
 * ``download_supplementary`` resolves a PMID to the Europe PMC supplementary
 * archive first, then uses the 3-tier publication fallback (direct PDF →
 * Unpaywall → Europe PMC fullTextXML) when no archive is available. All bytes use
 * ``acquireSource`` — the P5-D3 single sanctioned download path — and returns
 * the stable keys ``source/accession/source_url/local_files/source_assets/
 * download_attempts/format_hint/retrieved_at`` plus ``warnings`` when earlier
 * tiers failed. Error outcomes (no PMCID, efetch failure, all tiers failed)
 * are returned as JSON bodies with an ``error`` key, mirroring the Python
 * adapter's success-content error style.
 */

import path from "node:path";

import { DEFAULT_RUNTIME_LIMITS } from "@biomed/contracts";

import type { SourceRecord } from "../../dataset/contracts/source.js";
import { ContentCache } from "../../external/acquisition/content-cache.js";
import { acquireSource, CURATED_SOURCE_HOSTS } from "../../external/acquisition/downloader.js";
import { NcbiEutilsClient, defaultNcbiClientConfig, type NcbiClientConfig } from "../../external/ncbi/client.js";
import {
  searchPubmed,
  type NcbiDiscoveryClient,
  type PubMedSearchResult,
} from "../../external/ncbi/discovery.js";
import { extractArticleIdentifiers } from "../../external/ncbi/parsers.js";
import { simplifyNcbiQuery } from "../../external/ncbi/query-utils.js";
import { PublicHttpClient } from "../../external/network/http-client.js";
import {
  PublicationFallbackError,
  acquirePublicationWithFallback,
  makeSourceId,
} from "../../external/publication/publication-fallback.js";
import type { BioMedAgentTool } from "../contracts.js";
import { noopHooks, createDownloadProgressReporter, type ToolHooks } from "./tool-hooks.js";
import { errorResult } from "./result.js";

export const SEARCH_PUBMED_TOOL_NAME = "search_pubmed";
export const DOWNLOAD_SUPPLEMENTARY_TOOL_NAME = "download_supplementary";

const USAGE_HINT =
  "可将 records 中每条记录的 title 字段提取为列表，传给 analyze_papers " +
  "工具进行结构化分析（只传 title，不要传 abstract 或完整 records）。" +
  "不要在 assistant 文本中复述 records 内容——工具卡片已自动展示。";

/** Shared service surface the two tools need (Python ``NcbiServices`` parity). */
export interface PubmedServiceDeps {
  eutils: NcbiDiscoveryClient;
  http: PublicHttpClient;
  cache: ContentCache;
  taskRoot: string;
  hooks?: ToolHooks;
  /** Unpaywall contact email (defaults to the NCBI email/placeholder). */
  email?: string;
  /** Test seam replacing the Unpaywall lookup (Python monkeypatch parity). */
  lookupPdf?: (doi: string) => Promise<string>;
  maxDownloadBytes?: number;
  downloadTimeoutMs?: number;
  /** Global cache registrar (raw downloads → data/cache). */
  registrar?: import("../../persistence/cache-registrar.js").CacheRegistrar | null;
  /** Task id used as cache provenance. */
  taskId?: string | (() => string);
  /** Task-owned source-asset registry for immediate preview resolution. */
  sourceAssetRegistry?: import("../../runtime/source-assets/registry.js").SourceAssetRegistry | null;
}

/**
 * Python ``search_pubmed_adapter`` parity. Returns the wire payload object
 * (the tool stringifies it). Raises on failure after logging the failed
 * QueryStatus hook.
 */
export async function searchPubmedAdapter(
  query: string,
  maxResults: number,
  deps: PubmedServiceDeps,
  signal?: AbortSignal,
): Promise<unknown> {
  const hooks = noopHooks(deps.hooks);
  const queryCallToken = hooks.onQueryStarted(query, "pubmed");
  let result: PubMedSearchResult;
  try {
    result = await searchPubmed(deps.eutils, query, maxResults, signal);
  } catch (error) {
    hooks.onQuery(query, "pubmed", "failed", 0, queryCallToken);
    throw error;
  }

  // Auto-fallback: when the raw query returns 0 results and looks like a
  // natural-language sentence, retry with a simplified structured query.
  const wordCount = query.trim() === "" ? 0 : query.trim().split(/\s+/).length;
  if (result.records.length === 0 && (query.length > 50 || wordCount > 8)) {
    const simplified = simplifyNcbiQuery(query);
    if (simplified !== query) {
      result = await searchPubmed(deps.eutils, simplified, maxResults, signal);
    }
  }

  hooks.onQuery(query, "pubmed", "success", result.records.length, queryCallToken);
  hooks.onProgress("discovery", "discovered_records", {
    current: result.records.length,
    total: result.total_count,
    detail: { source: "pubmed", query },
  });

  const records = result.records;
  const summaryLines = [`找到 ${records.length} 篇相关文献（共 ${result.total_count} 篇匹配）`];
  const topTitles = records
    .slice(0, 3)
    .map((record) => record.title)
    .filter((title) => title !== "");
  if (topTitles.length > 0) {
    summaryLines.push(`前 ${topTitles.length} 篇标题：`);
    topTitles.forEach((title, index) => summaryLines.push(`${index + 1}. ${title}`));
  }

  return {
    summary: summaryLines.join("\n"),
    source: "pubmed",
    query: result.query,
    query_translation: result.query_translation,
    total_count: result.total_count,
    records_count: records.length,
    records,
    usage_hint: USAGE_HINT,
  };
}

/**
 * Python ``download_supplementary_adapter`` error style + the 3-tier fallback
 * chain. Returns the wire payload object; throws only on unexpected errors.
 */
export async function downloadSupplementaryAdapter(
  pmid: string,
  maxSizeMb: number,
  deps: PubmedServiceDeps,
  signal?: AbortSignal,
): Promise<unknown> {
  const maxBytes = maxSizeMb * 1024 * 1024;

  // 1. Fetch PubMed record & extract PMCID (+ DOI for the Unpaywall tier).
  let xmlData: Buffer;
  try {
    xmlData = await deps.eutils.efetch({ db: "pubmed", ids: [pmid], retmode: "xml" }, signal);
  } catch (error) {
    return {
      source: "pubmed",
      accession: pmid,
      error: `Failed to fetch PubMed record: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const { pmcid, doi } = extractArticleIdentifiers(xmlData);
  if (!pmcid) {
    return {
      source: "pubmed",
      accession: pmid,
      error: "No PMCID found — article is not in the PMC open-access subset",
    };
  }

  const pmcUrl = `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`;
  const retrievedAt = new Date().toISOString();
  const source: SourceRecord = {
    schema_version: "1.0",
    source_id: makeSourceId("pubmed", pmid, pmcUrl),
    database: "pubmed",
    accession: pmid,
    url: pmcUrl,
    title: `PubMed supplementary materials for ${pmid}`,
    retrieved_at: retrievedAt,
  };
  const filename = `pubmed_${pmid}.pdf`;
  const supplementaryFilename = `pubmed_${pmid}_supplementary.zip`;

  // Throttle to whole-megabyte steps (Python _report_progress parity).
  const supplementaryProgress = createDownloadProgressReporter(
    deps.hooks,
    { source: "pubmed", accession: pmid, filename: supplementaryFilename },
    { bytesStep: 1024 * 1024 },
  );
  const fallbackProgress = createDownloadProgressReporter(
    deps.hooks,
    { source: "pubmed", accession: pmid, filename },
    { bytesStep: 1024 * 1024 },
  );

  const supplementaryUrl =
    `https://www.ebi.ac.uk/europepmc/webservices/rest/${pmcid.toUpperCase()}/supplementaryFiles`;
  const supplementarySource: SourceRecord = {
    ...source,
    source_id: makeSourceId("pubmed", `${pmid}:supplementary`, supplementaryUrl),
    url: supplementaryUrl,
  };
  const supplementary = await acquireSource({
    source: supplementarySource,
    filename: supplementaryFilename,
    workdirRoot: deps.taskRoot,
    cache: deps.cache,
    client: deps.http,
    dataLevel: "metadata",
    maxBytes,
    expectedMediaTypes: new Set(["application/zip"]),
    accept: "application/zip",
    signal,
    timeoutMs: deps.downloadTimeoutMs,
    allowedHosts: CURATED_SOURCE_HOSTS,
    progress: supplementaryProgress,
    onPublished: (published) => deps.registrar?.register("publication", published, deps.taskId),
  });
  if (supplementary.asset !== null && supplementary.attempt.status === "succeeded") {
    if (deps.sourceAssetRegistry !== undefined && deps.sourceAssetRegistry !== null) {
      await deps.sourceAssetRegistry.register({
        sourceId: `pubmed_supplementary_${pmid}`,
        relativePath: supplementary.asset.relative_path,
        mediaType: "application/zip",
      });
    }
    return {
      source: "pubmed",
      accession: pmid,
      source_url: supplementaryUrl,
      local_files: [path.join(deps.taskRoot, supplementary.asset.relative_path)],
      source_assets: [supplementary.asset],
      download_attempts: [supplementary.attempt],
      format_hint: "supplementary_archive",
      retrieved_at: retrievedAt,
    };
  }

  const supplementaryWarning =
    `supplementary_archive: attempt status=${supplementary.attempt.status}, ` +
    `error=${supplementary.attempt.error_message ?? "none"}`;

  try {
    const outcome = await acquirePublicationWithFallback({
      source,
      filename,
      workdirRoot: deps.taskRoot,
      cache: deps.cache,
      client: deps.http,
      dataLevel: "metadata",
      maxBytes,
      doi: doi || undefined,
      pmcid,
      signal,
      timeoutMs: deps.downloadTimeoutMs,
      email: deps.email,
      lookupPdf: deps.lookupPdf,
      progress: fallbackProgress,
      registrar: deps.registrar,
      taskId: deps.taskId,
    });
    const asset = outcome.result.asset;
    const payload: Record<string, unknown> = {
      source: "pubmed",
      accession: pmid,
      source_url: pmcUrl,
      local_files: asset === null ? [] : [path.join(deps.taskRoot, asset.relative_path)],
      source_assets: asset === null ? [] : [asset],
      download_attempts: [supplementary.attempt, ...outcome.attempts],
      format_hint:
        asset?.media_type.includes("xml") === true || asset?.relative_path.toLowerCase().endsWith(".xml") === true
          ? "full_text_xml"
          : "publication_pdf",
      retrieved_at: retrievedAt,
    };
    payload["warnings"] = [supplementaryWarning, ...outcome.tierFailures];
    return payload;
  } catch (error) {
    if (error instanceof PublicationFallbackError) {
      return {
        source: "pubmed",
        accession: pmid,
        source_url: pmcUrl,
        error: error.message,
        details: [supplementaryWarning, ...error.failures],
        download_attempts: [supplementary.attempt, ...error.attempts],
      };
    }
    throw error;
  }
}

export interface PubmedToolDeps {
  taskRoot: string;
  hooks?: ToolHooks;
  /** Test/ops seams (Python ``open_ncbi_services`` fixture parity). */
  eutils?: NcbiEutilsClient;
  http?: PublicHttpClient;
  cacheRoot?: string;
  config?: Partial<NcbiClientConfig>;
  email?: string;
  lookupPdf?: (doi: string) => Promise<string>;
  maxDownloadBytes?: number;
  downloadTimeoutMs?: number;
  /** Global cache registrar (raw downloads → data/cache). */
  registrar?: import("../../persistence/cache-registrar.js").CacheRegistrar | null;
  /** Task id used as cache provenance. */
  taskId?: string | (() => string);
  /**
   * Task-owned source-asset registry. When present, successful downloads are
   * registered here right after publication so ``preview_core_asset`` can
   * immediately resolve them (the D3/H4/I3 "registered asset was not found"
   * gap: downloads previously reached only the global cache).
   */
  sourceAssetRegistry?: import("../../runtime/source-assets/registry.js").SourceAssetRegistry | null;
}

function searchPubmedTool(deps: PubmedServiceDeps): BioMedAgentTool {
  return {
    name: SEARCH_PUBMED_TOOL_NAME,
    label: "Search PubMed",
    description:
      "Search PubMed for biomedical literature. Returns JSON with a top-level " +
      "`summary` field (brief overview + top 3 titles) and a `records` field " +
      "(full structured records: title, abstract, authors, journal, pub_date, " +
      "doi, pmid, pmcid, is_open_access, source_url). Use the summary to brief " +
      "the user. To extract structured clues, pass only the `title` field from " +
      "each record (as a list of strings) to `analyze_papers` — do NOT pass " +
      "the full records or abstracts. Do NOT restate records in assistant text " +
      "— the frontend tool card already displays them.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Free-text search query for PubMed.",
        },
        max_results: {
          type: "integer",
          description: "Maximum number of records to fetch (default 20).",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      const record = argumentsValue as { query?: unknown; max_results?: unknown };
      try {
        if (typeof record.query !== "string") throw new TypeError("query must be a string");
        const maxResults = record.max_results === undefined ? 20 : Number(record.max_results);
        if (!Number.isInteger(maxResults)) throw new TypeError("max_results must be an integer");
        const payload = await searchPubmedAdapter(record.query, maxResults, deps, signal);
        return { content: JSON.stringify(payload) };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

function downloadSupplementaryTool(deps: PubmedServiceDeps): BioMedAgentTool {
  return {
    name: DOWNLOAD_SUPPLEMENTARY_TOOL_NAME,
    label: "Download PubMed supplementary materials",
    description:
      "Download open-access supplementary materials for a PubMed article " +
      "given its PMID. Downloads the official Europe PMC supplementary ZIP " +
      "when available, then falls back to the publication PDF/fullTextXML, and writes it to the " +
      "task work directory via the acquisition service, and returns metadata JSON.",
    parameters: {
      type: "object",
      properties: {
        pmid: {
          type: "string",
          description: "PubMed ID (PMID) of the article.",
        },
        max_size_mb: {
          type: "integer",
          description:
            `Maximum download size in MiB (default ${DEFAULT_RUNTIME_LIMITS.max_download_mib}).`,
        },
      },
      required: ["pmid"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      const record = argumentsValue as { pmid?: unknown; max_size_mb?: unknown };
      try {
        if (typeof record.pmid !== "string") throw new TypeError("pmid must be a string");
        // Fallback derives from the RuntimeLimits default so it cannot drift from
    // the settings default (2026-09-02 audit P0-8); business-tools passes the
    // live settings value.
    const configuredMaxMb =
      (deps.maxDownloadBytes ?? DEFAULT_RUNTIME_LIMITS.max_download_mib * 1024 * 1024) /
      (1024 * 1024);
        const requestedMaxMb = record.max_size_mb === undefined ? configuredMaxMb : Number(record.max_size_mb);
        const maxSizeMb = Math.min(requestedMaxMb, configuredMaxMb);
        if (!Number.isFinite(maxSizeMb) || maxSizeMb <= 0) {
          throw new TypeError("max_size_mb must be a positive number");
        }
        const payload = await downloadSupplementaryAdapter(record.pmid, maxSizeMb, deps, signal);
        return { content: JSON.stringify(payload) };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

/**
 * Create the two PubMed tools under their ``SKILL_TOOL_MAP`` names.
 * Production defaults mirror Python ``open_ncbi_services`` (environment-based
 * eutils identity, process-shared quota limiter, task-scoped content cache);
 * tests inject fixture-built services.
 */
export function createPubmedTools(deps: PubmedToolDeps): BioMedAgentTool[] {
  const http = deps.http ?? new PublicHttpClient();
  const config = { ...defaultNcbiClientConfig(), ...deps.config };
  const eutils = deps.eutils ?? new NcbiEutilsClient({ http, config });
  const cache = new ContentCache(deps.cacheRoot ?? path.join(deps.taskRoot, "cache", "ncbi"));
  const services: PubmedServiceDeps = {
    eutils,
    http,
    cache,
    taskRoot: deps.taskRoot,
    hooks: deps.hooks,
    email: deps.email,
    lookupPdf: deps.lookupPdf,
    maxDownloadBytes: deps.maxDownloadBytes,
    downloadTimeoutMs: deps.downloadTimeoutMs,
    registrar: deps.registrar,
    taskId: deps.taskId,
  };
  return [searchPubmedTool(services), downloadSupplementaryTool(services)];
}
