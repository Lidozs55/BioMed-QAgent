/**
 * UCSC Xena acquisition tools: search_xena, download_xena (Python
 * ``skills/builtin/acquisition/xena.py`` parity, Phase 5 checkpoint P5-05).
 *
 * The dataset index comes from the official hub query API (S3 listing
 * fallback); downloads route exclusively through ``acquireSource`` (P5-D3)
 * with the curated S3 host allowlist, then the .gz file is decompressed next
 * to the published asset (Python non-managed path parity).
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import path from "node:path";

import type { BioMedAgentTool } from "../contracts.js";
import { noopHooks, type ToolServiceDeps } from "./tool-hooks.js";
import {
  ContentCache,
  acquireSource,
  taskWorkDirs,
} from "../../external/acquisition/index.js";
import {
  buildXenaDownloadUrl,
  fetchXenaHubIndex,
  matchXenaRecord,
  xenaDecompressedPath,
  xenaLocalFilename,
  type XenaHubRecord,
} from "../../external/xena/index.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import type { SourceRecord } from "../../dataset/contracts/source.js";
import { DATA_LEVEL, DATABASE } from "../../dataset/contracts/enums.js";

/** Python ``MAX_CRAWLER_DOWNLOAD_BYTES``: 4 GiB dataset-scale downloads. */
export const XENA_MAX_DOWNLOAD_BYTES = 4096 * 1024 * 1024;
/** Python ``DEFAULT_RATE_LIMIT_SECONDS`` (AGENTS.md: 2s between requests). */
export const XENA_RATE_LIMIT_MS = 2000;

export interface XenaToolDeps extends ToolServiceDeps {
  client: PublicHttpClient;
  cache: ContentCache;
  maxDownloadBytes?: number;
  /** Minimum interval between external requests; 0 disables (tests). */
  rateLimitMs?: number;
}

/**
 * Module-global request spacing (Python ``rate_limit`` parity: a single
 * shared timestamp per source, enforced before every external request).
 */
let lastRequestAt = 0;

function rateLimit(minIntervalMs: number): Promise<void> {
  if (minIntervalMs <= 0) return Promise.resolve();
  const wait = minIntervalMs - (Date.now() - lastRequestAt);
  const resume = (): void => {
    lastRequestAt = Date.now();
  };
  if (wait <= 0) {
    resume();
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(() => { resume(); resolve(); }, wait));
}

/** Python ``make_source_id``: ``src_<canonical sha256 digest[:32]>``. */
function makeSourceId(database: string, accession: string, url: string): string {
  const canonical = JSON.stringify({
    accession: accession.trim().toLowerCase(),
    database,
    url: url.trim(),
  });
  return `src_${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 32)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectArgument(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("arguments must be an object");
  return value;
}

function expectString(record: Record<string, unknown>, field: string, fallback: string): string {
  const value = record[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

function expectOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

function expectInt(record: Record<string, unknown>, field: string, fallback: number): number {
  const value = record[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${field} must be an integer`);
  }
  return value;
}

function errorResult(error: unknown): { content: string; isError: true } {
  return {
    content: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Shared types (Python result JSON shapes)
// ---------------------------------------------------------------------------

export interface XenaSearchResult {
  source: "xena";
  term: string;
  count: number;
  records: XenaHubRecord[];
  error?: string;
}

export interface XenaDownloadResult {
  source: "xena";
  dataset_id: string;
  cohort?: string | null;
  source_url: string;
  local_files?: string[];
  format_hint?: string;
  retrieved_at?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

/** search_xena (Python ``search_xena``). */
export async function searchXena(
  argumentsValue: unknown,
  deps: XenaToolDeps,
  signal?: AbortSignal,
): Promise<XenaSearchResult> {
  const args = objectArgument(argumentsValue);
  const query = expectString(args, "query", "");
  const maxResults = expectInt(args, "max_results", 20);
  const term = expectString(args, "term", "");
  const effectiveTerm = query || term;
  const hooks = noopHooks(deps.hooks);
  const pace = (): Promise<void> => rateLimit(deps.rateLimitMs ?? XENA_RATE_LIMIT_MS);

  let allDatasets: XenaHubRecord[];
  try {
    allDatasets = await fetchXenaHubIndex(deps.client, { signal, rateLimit: pace });
  } catch (error) {
    hooks.onQuery(effectiveTerm, "xena", "failed", 0);
    return {
      source: "xena",
      term: effectiveTerm,
      count: 0,
      records: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const matched = effectiveTerm.trim()
    ? allDatasets.filter((record) => matchXenaRecord(record, effectiveTerm.trim()))
    : allDatasets;

  hooks.onQuery(effectiveTerm, "xena", "success", matched.length);
  return {
    source: "xena",
    term: effectiveTerm,
    count: matched.length,
    records: matched.slice(0, maxResults),
  };
}

/** download_xena (Python ``download_xena``). */
export async function downloadXena(
  argumentsValue: unknown,
  deps: XenaToolDeps,
  signal?: AbortSignal,
): Promise<XenaDownloadResult> {
  const args = objectArgument(argumentsValue);
  const datasetId = expectString(args, "dataset_id", "");
  const rawFileType = expectString(args, "file_type", "tsv");
  const cohort = expectOptionalString(args, "cohort");
  const fileType = rawFileType.toLowerCase().trim().replace(/^\.+/, "");
  const maxBytes = deps.maxDownloadBytes ?? XENA_MAX_DOWNLOAD_BYTES;
  const pace = (): Promise<void> => rateLimit(deps.rateLimitMs ?? XENA_RATE_LIMIT_MS);
  const dirs = taskWorkDirs(deps.taskRoot);

  const url = buildXenaDownloadUrl(datasetId);
  const remoteFilename = url.slice(url.lastIndexOf("/") + 1);
  const localName = xenaLocalFilename(remoteFilename);
  const retrievedAt = new Date().toISOString();
  const source: SourceRecord = {
    schema_version: "1.0",
    source_id: makeSourceId(DATABASE.UCSC_XENA, datasetId, url),
    database: DATABASE.UCSC_XENA,
    accession: datasetId,
    url,
    title: `UCSC Xena dataset ${datasetId}`,
    retrieved_at: retrievedAt,
  };

  await pace();
  const result = await acquireSource({
    source,
    filename: localName,
    workdirRoot: deps.taskRoot,
    cache: deps.cache,
    client: deps.client,
    dataLevel: DATA_LEVEL.REPOSITORY_PROCESSED,
    maxBytes,
    accept: "application/gzip",
    signal,
  });
  if (result.attempt.status === "failed" || result.asset === null) {
    return {
      source: "xena",
      dataset_id: datasetId,
      source_url: url,
      error: `download failed: ${result.attempt.error_message ?? result.attempt.error_code ?? "unknown error"}`,
    };
  }

  const localGz = path.join(dirs.root, ...result.asset.relative_path.split("/"));
  const decompressed = xenaDecompressedPath(localGz);
  try {
    await pipeline(
      createReadStream(localGz),
      createGunzip(),
      createWriteStream(decompressed, { flags: "w" }),
    );
  } catch (error) {
    return {
      source: "xena",
      dataset_id: datasetId,
      source_url: url,
      local_files: [localGz],
      error: `decompression failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return {
    source: "xena",
    dataset_id: datasetId,
    cohort,
    source_url: url,
    local_files: [localGz, decompressed],
    format_hint: `xena_${fileType}`,
    retrieved_at: retrievedAt,
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const SEARCH_XENA_TOOL_NAME = "search_xena";
export const DOWNLOAD_XENA_TOOL_NAME = "download_xena";

export function createSearchXenaTool(deps: XenaToolDeps): BioMedAgentTool {
  return {
    name: SEARCH_XENA_TOOL_NAME,
    label: "Search UCSC Xena datasets",
    description:
      "Search UCSC Xena public hub datasets by keyword. " +
      "Parameters: ``query`` (search keyword like 'breast cancer' or 'TCGA') " +
      "— ``term`` is accepted as a legacy alias; ``max_results`` (optional, " +
      "default 20). Returns JSON with dataset name, type, cohort, and " +
      "dataset_id. Use ``download_xena`` to fetch data files for a specific " +
      "dataset_id.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword or phrase (e.g. 'BRCA', 'mutation', 'clinical')." },
        max_results: { type: "integer", description: "Maximum number of matching datasets to return (default 20).", default: 20 },
        term: { type: "string", description: "Legacy alias for query. Ignored when query is non-empty." },
      },
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      try {
        return { content: JSON.stringify(await searchXena(argumentsValue, deps, signal)) };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

export function createDownloadXenaTool(deps: XenaToolDeps): BioMedAgentTool {
  return {
    name: DOWNLOAD_XENA_TOOL_NAME,
    label: "Download Xena dataset file",
    description:
      "Download a specific UCSC Xena dataset file by dataset_id " +
      "(e.g. 'TCGA.PAAD.sampleMap/HiSeqV2'). " +
      "Parameters: ``dataset_id`` (required), ``file_type`` (optional, " +
      "'tsv'), ``cohort`` (optional, informational cohort label). " +
      "Writes the decompressed file into the task raw directory.",
    parameters: {
      type: "object",
      properties: {
        dataset_id: { type: "string", description: "Dataset identifier as returned by search_xena (e.g. 'TCGA.BRCA.sampleMap/HiSeqV2' or 'probeMap%2Fhugo_gencode_good_hg19_V24lift37')." },
        file_type: { type: "string", description: "Hint for the file format ('tsv' or 'json'). Used only for the format_hint field; the URL is always {dataset_id}.gz.", default: "tsv" },
        cohort: { type: "string", description: "Optional informational cohort label (e.g. 'TCGA Pancreatic Cancer (PAAD)'). Echoed back in the response." },
      },
      required: ["dataset_id"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      try {
        return { content: JSON.stringify(await downloadXena(argumentsValue, deps, signal)) };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

/** Both Xena tools in SKILL_TOOL_MAP order. */
export function createXenaTools(deps: XenaToolDeps): readonly BioMedAgentTool[] {
  return [createSearchXenaTool(deps), createDownloadXenaTool(deps)];
}
