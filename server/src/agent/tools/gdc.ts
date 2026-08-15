/**
 * GDC acquisition tools: search_gdc, describe_gdc, download_gdc (Python
 * ``skills/builtin/acquisition/gdc.py`` parity, Phase 5 checkpoint P5-05).
 *
 * Downloads route exclusively through ``acquireSource`` (P5-D3): the files
 * query builds the manifest, then each file is fetched with the official GDC
 * md5sum / file size verified by the acquisition service and published as a
 * content-addressed SourceAsset. The manifest itself is tool metadata and is
 * written to ``agent_results`` (Python wrote it under the legacy ``raw``
 * alias of ``source_assets``; the TS layout reserves that directory for
 * content-addressed assets only).
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BioMedAgentTool } from "../contracts.js";
import { noopHooks, type ToolServiceDeps } from "./tool-hooks.js";
import {
  ContentCache,
  acquireSource,
  taskWorkDirs,
} from "../../external/acquisition/index.js";
import {
  GDC_API_BASE,
  buildGdcUrl,
  fetchGdcJson,
  matchGdcTerm,
  normalizeGdcDataType,
} from "../../external/gdc/index.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import { assertSafeFilename } from "../../external/acquisition/workdir.js";
import type { SourceRecord } from "../../dataset/contracts/source.js";
import { DATA_LEVEL, DATABASE } from "../../dataset/contracts/enums.js";

/** Python ``MAX_CRAWLER_DOWNLOAD_BYTES``: 4 GiB dataset-scale downloads. */
export const GDC_MAX_DOWNLOAD_BYTES = 4096 * 1024 * 1024;
/** Python ``DEFAULT_RATE_LIMIT_SECONDS`` (AGENTS.md: 2s between requests). */
export const GDC_RATE_LIMIT_MS = 2000;

export interface GdcToolDeps extends ToolServiceDeps {
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

export interface GdcSearchRecord {
  project_id: string;
  name: string;
  disease_type: string[];
  primary_site: string[];
  case_count: number;
  file_count: number;
  data_categories: string[];
}

export interface GdcSearchResult {
  source: "gdc";
  term: string;
  project_ids: string[];
  records: GdcSearchRecord[];
  error?: string;
}

export interface GdcDataCategoryCount {
  category: string;
  file_count: number;
}

export type GdcDescribeResult =
  | {
      source: "gdc";
      project_id: string;
      name: string;
      disease_type: string[];
      primary_site: string[];
      program: string;
      case_count: number;
      file_count: number;
      data_categories: GdcDataCategoryCount[];
      experimental_strategies: string[];
      dbgap_accession: string;
      state: string;
    }
  | { source: "gdc"; project_id: string; error: string };

export interface GdcDownloadResult {
  source: "gdc";
  accession: string;
  data_type?: string;
  source_url?: string;
  local_files?: string[];
  format_hint?: string;
  file_count?: number;
  downloaded?: number;
  retrieved_at?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

export const GDC_PROJECTS_EXPAND =
  "summary,summary.case_count,summary.file_count,summary.data_categories";

/** search_gdc (Python ``search_gdc``). */
export async function searchGdc(
  argumentsValue: unknown,
  deps: GdcToolDeps,
  signal?: AbortSignal,
): Promise<GdcSearchResult> {
  const args = objectArgument(argumentsValue);
  const query = expectString(args, "query", "");
  const maxResults = expectInt(args, "max_results", 20);
  const term = expectString(args, "term", "");
  const effectiveTerm = query || term;
  const hooks = noopHooks(deps.hooks);
  hooks.onQueryStarted(effectiveTerm, "gdc");

  const url = buildGdcUrl("/projects", {
    format: "json",
    size: "200",
    expand: GDC_PROJECTS_EXPAND,
  });
  let payload: unknown;
  try {
    payload = await fetchGdcJson(deps.client, url, {
      signal,
      rateLimit: () => rateLimit(deps.rateLimitMs ?? GDC_RATE_LIMIT_MS),
    });
  } catch (error) {
    hooks.onQuery(effectiveTerm, "gdc", "failed", 0);
    return {
      source: "gdc",
      term: effectiveTerm,
      project_ids: [],
      records: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const hits = gdcHits(payload);
  const records: GdcSearchRecord[] = [];
  for (const hit of hits) {
    if (!isRecord(hit)) continue;
    const projectId = String(hit["project_id"] ?? "");
    const name = String(hit["name"] ?? "");
    const disease = stringList(hit["disease_type"]);
    const primarySite = stringList(hit["primary_site"]);
    const summary = isRecord(hit["summary"]) ? hit["summary"] : {};

    const searchText = [projectId, name, ...disease, ...primarySite].join(" ");
    if (!matchGdcTerm(effectiveTerm, searchText)) continue;

    records.push({
      project_id: projectId,
      name,
      disease_type: disease,
      primary_site: primarySite,
      case_count: numberOrZero(summary["case_count"]),
      file_count: numberOrZero(summary["file_count"]),
      data_categories: isRecord(hit["summary"]) ? dataCategories(hit["summary"]) : [],
    });
    if (records.length >= maxResults) break;
  }

  hooks.onQuery(effectiveTerm, "gdc", "success", records.length);
  return {
    source: "gdc",
    term: effectiveTerm,
    project_ids: records.map((record) => record.project_id),
    records,
  };
}

/** describe_gdc (Python ``describe_gdc``). */
export async function describeGdc(
  argumentsValue: unknown,
  deps: GdcToolDeps,
  signal?: AbortSignal,
): Promise<GdcDescribeResult> {
  const args = objectArgument(argumentsValue);
  const projectId = expectString(args, "project_id", "");
  const dataCategory = expectOptionalString(args, "data_category");
  const hooks = noopHooks(deps.hooks);
  hooks.onQueryStarted(projectId, "gdc");

  const url = buildGdcUrl(`/projects/${projectId}`, {
    format: "json",
    expand:
      "summary,summary.case_count,summary.file_count,summary.data_categories,summary.experimental_strategies",
  });
  let payload: unknown;
  try {
    payload = await fetchGdcJson(deps.client, url, {
      signal,
      rateLimit: () => rateLimit(deps.rateLimitMs ?? GDC_RATE_LIMIT_MS),
    });
  } catch (error) {
    hooks.onQuery(projectId, "gdc", "failed", 0);
    return {
      source: "gdc",
      project_id: projectId,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const data = isRecord(payload) && isRecord(payload["data"]) ? payload["data"] : undefined;
  if (data === undefined || typeof data["project_id"] !== "string") {
    hooks.onQuery(projectId, "gdc", "failed", 0);
    return {
      source: "gdc",
      project_id: projectId,
      error: `project '${projectId}' not found`,
    };
  }

  const summary = isRecord(data["summary"]) ? data["summary"] : {};
  let categories = describeCategories(summary);
  if (dataCategory) {
    const needle = dataCategory.toLowerCase();
    categories = categories.filter((entry) => entry.category.toLowerCase().includes(needle));
  }

  hooks.onQuery(projectId, "gdc", "success", 1);
  return {
    source: "gdc",
    project_id: String(data["project_id"]),
    name: String(data["name"] ?? ""),
    disease_type: stringList(data["disease_type"]),
    primary_site: stringList(data["primary_site"]),
    program: isRecord(data["program"]) ? String(data["program"]["name"] ?? "") : "",
    case_count: numberOrZero(summary["case_count"]),
    file_count: numberOrZero(summary["file_count"]),
    data_categories: categories,
    experimental_strategies: describeStrategies(summary),
    dbgap_accession: String(data["dbgap_accession_number"] ?? ""),
    state: String(data["state"] ?? ""),
  };
}

/** download_gdc (Python ``download_gdc``). */
export async function downloadGdc(
  argumentsValue: unknown,
  deps: GdcToolDeps,
  signal?: AbortSignal,
): Promise<GdcDownloadResult> {
  const args = objectArgument(argumentsValue);
  const projectId = expectString(args, "project_id", "");
  const dataType = expectString(args, "data_type", "RNA-Seq");
  const dataCategory = expectOptionalString(args, "data_category");
  const workflowType = expectOptionalString(args, "workflow_type");
  const gdcDataType = normalizeGdcDataType(dataType);
  const maxBytes = deps.maxDownloadBytes ?? GDC_MAX_DOWNLOAD_BYTES;
  const pace = (): Promise<void> => rateLimit(deps.rateLimitMs ?? GDC_RATE_LIMIT_MS);
  const dirs = taskWorkDirs(deps.taskRoot);
  const hooks = noopHooks(deps.hooks);

  // ------------------------------------------------------------------
  // Step 1 — query /files for matching file metadata
  // ------------------------------------------------------------------
  const content: Array<Record<string, unknown>> = [
    {
      op: "=",
      content: {
        field: "cases.project.project_id",
        value: [projectId],
      },
    },
    {
      op: "=",
      content: {
        field: "files.data_type",
        value: [gdcDataType],
      },
    },
  ];
  if (dataCategory) {
    content.push({
      op: "=",
      content: { field: "files.data_category", value: [dataCategory] },
    });
  }
  if (workflowType) {
    content.push({
      op: "=",
      content: { field: "files.analysis.workflow_type", value: [workflowType] },
    });
  }
  const encodedFilters = JSON.stringify({ op: "and", content });
  const url = buildGdcUrl("/files", {
    filters: encodedFilters,
    format: "json",
    size: "200",
  });

  let payload: unknown;
  try {
    payload = await fetchGdcJson(deps.client, url, { signal, rateLimit: pace });
  } catch (error) {
    return {
      source: "gdc",
      accession: projectId,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const fileHits = gdcHits(payload);
  const totalFiles = gdcTotalFiles(payload, fileHits.length);
  if (fileHits.length === 0) {
    return {
      source: "gdc",
      accession: projectId,
      data_type: dataType,
      error: `no files found for project '${projectId}' with data_type '${dataType}'`,
      file_count: 0,
    };
  }

  // ------------------------------------------------------------------
  // Step 2 — build manifest
  // ------------------------------------------------------------------
  const manifest = fileHits.filter(isRecord).map((hit) => ({
    file_id: String(hit["file_id"] ?? ""),
    file_name: String(hit["file_name"] ?? ""),
    data_type: String(hit["data_type"] ?? ""),
    data_format: String(hit["data_format"] ?? ""),
    data_category: String(hit["data_category"] ?? ""),
    file_size: numberOrZero(hit["file_size"]),
    md5sum: String(hit["md5sum"] ?? ""),
  }));

  const safeDt = dataType.replace(/ /g, "_").replace(/-/g, "_");
  const manifestFilename = `gdc_${projectId}_${safeDt}_manifest.json`;
  await mkdir(dirs.agentResults, { recursive: true });
  const manifestPath = path.join(dirs.agentResults, manifestFilename);
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        project_id: projectId,
        data_type: dataType,
        gdc_data_type: gdcDataType,
        total_files: totalFiles,
        returned_files: manifest.length,
        files: manifest,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // ------------------------------------------------------------------
  // Step 3 — download a representative subset (up to 5 files)
  // ------------------------------------------------------------------
  const localFiles: string[] = [manifestPath];
  const downloadLimit = Math.min(fileHits.length, 5);
  const now = new Date().toISOString();
  for (const rawHit of fileHits.slice(0, downloadLimit)) {
    if (!isRecord(rawHit)) continue;
    const fileUuid = String(rawHit["file_id"] ?? "");
    const fileName = String(rawHit["file_name"] ?? "") || `${fileUuid}.tsv`;
    const downloadUrl = `${GDC_API_BASE}/data/${fileUuid}`;

    // Python skips unsafe GDC filenames with a warning.
    if (
      path.posix.basename(fileName) !== fileName ||
      fileName === "" ||
      fileName === "." ||
      fileName === ".."
    ) {
      hooks.onProgress("download_gdc", "warning", {
        message: `Skipped unsafe GDC filename ${JSON.stringify(fileName)}`,
      });
      continue;
    }
    const fileSize = numberOrZero(rawHit["file_size"]);
    const md5sum = String(rawHit["md5sum"] ?? "");

    const source: SourceRecord = {
      schema_version: "1.0",
      source_id: makeSourceId(DATABASE.GDC, projectId, downloadUrl),
      database: DATABASE.GDC,
      accession: projectId,
      url: downloadUrl,
      title: `GDC project ${projectId} (${dataType})`,
      retrieved_at: now,
    };

    try {
      assertSafeFilename(fileName);
      await pace();
      const result = await acquireSource({
        source,
        filename: fileName,
        workdirRoot: deps.taskRoot,
        cache: deps.cache,
        client: deps.client,
        dataLevel: DATA_LEVEL.REPOSITORY_PROCESSED,
        maxBytes,
        expectedSize: fileSize > 0 ? fileSize : undefined,
        expectedMd5: md5sum !== "" ? md5sum : undefined,
        accept: "application/octet-stream",
        signal,
      });
      if (result.attempt.status === "failed" || result.asset === null) {
        hooks.onProgress("download_gdc", "warning", {
          message: `Failed to download GDC file ${fileUuid}: ${result.attempt.error_message ?? result.attempt.error_code}`,
        });
        continue;
      }
      localFiles.push(path.join(dirs.root, ...result.asset.relative_path.split("/")));
    } catch (error) {
      if (signal?.aborted === true) throw error;
      hooks.onProgress("download_gdc", "warning", {
        message: `Failed to download GDC file ${fileUuid}: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  // ------------------------------------------------------------------
  // Step 4 — build the result
  // ------------------------------------------------------------------
  const formatHint = `gdc_${safeDt.toLowerCase()}`;
  const downloadedCount = localFiles.length - 1;
  const response: GdcDownloadResult = {
    source: "gdc",
    accession: projectId,
    data_type: dataType,
    source_url: url,
    local_files: localFiles,
    format_hint: formatHint,
    file_count: totalFiles,
    downloaded: downloadedCount,
    retrieved_at: now,
  };
  if (downloadedCount === 0) {
    response.error = "failed to download any matching GDC data files";
  }
  return response;
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const SEARCH_GDC_TOOL_NAME = "search_gdc";
export const DESCRIBE_GDC_TOOL_NAME = "describe_gdc";
export const DOWNLOAD_GDC_TOOL_NAME = "download_gdc";

export function createSearchGdcTool(deps: GdcToolDeps): BioMedAgentTool {
  return {
    name: SEARCH_GDC_TOOL_NAME,
    label: "Search GDC projects",
    description:
      "Search the NCI Genomic Data Commons for projects matching a keyword. " +
      "Parameters: ``query`` (search keyword like 'lung cancer' or 'TCGA-BRCA') " +
      "— ``term`` is accepted as a legacy alias; ``max_results`` (optional, " +
      "default 20). Returns JSON with project_id, name, disease_type, and " +
      "primary_site. Use ``describe_gdc`` to get detailed metadata for a project.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search keyword or phrase (e.g. 'lung', 'TCGA-LUAD', 'breast cancer')." },
        max_results: { type: "integer", description: "Maximum number of project records to return (default 20).", default: 20 },
        term: { type: "string", description: "Legacy alias for query. Ignored when query is non-empty." },
      },
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      try {
        return { content: JSON.stringify(await searchGdc(argumentsValue, deps, signal)) };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

export function createDescribeGdcTool(deps: GdcToolDeps): BioMedAgentTool {
  return {
    name: DESCRIBE_GDC_TOOL_NAME,
    label: "Describe GDC project",
    description:
      "Get detailed metadata about a GDC project. " +
      "Parameters: ``project_id`` (required, e.g. 'TCGA-BRCA'), " +
      "``data_category`` (optional, filters the returned data categories " +
      "e.g. 'Transcriptome Profiling'). Returns project metadata including " +
      "data categories and file counts.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "GDC project identifier (e.g. 'TCGA-LUAD', 'TARGET-AML', 'CPTAC-3')." },
        data_category: { type: "string", description: "Optional filter: only data categories whose name contains this value (case-insensitive) are returned." },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      try {
        return { content: JSON.stringify(await describeGdc(argumentsValue, deps, signal)) };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

export function createDownloadGdcTool(deps: GdcToolDeps): BioMedAgentTool {
  return {
    name: DOWNLOAD_GDC_TOOL_NAME,
    label: "Download GDC data files",
    description:
      "Download data files from a GDC project. " +
      "Parameters: ``project_id`` (required, e.g. 'TCGA-PAAD'), " +
      "``data_type`` (optional, default 'RNA-Seq'), ``data_category`` " +
      "(optional, e.g. 'Transcriptome Profiling'), ``workflow_type`` " +
      "(optional, e.g. 'STAR - Counts'). Downloads up to 5 matching files " +
      "and writes a manifest.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "GDC project identifier (e.g. 'TCGA-LUAD')." },
        data_type: { type: "string", description: "Shorthand data type — supports 'RNA-Seq', 'miRNA-Seq', 'CNA' / 'CNV', 'Methylation', 'Somatic' / 'Mutation', 'Clinical', 'Slide', 'Biospecimen', or any raw GDC data_type value. Defaults to 'RNA-Seq'.", default: "RNA-Seq" },
        data_category: { type: "string", description: "Optional filter restricting results to a GDC data category (e.g. 'Transcriptome Profiling')." },
        workflow_type: { type: "string", description: "Optional filter restricting results to a GDC workflow type (e.g. 'STAR - Counts')." },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      try {
        return { content: JSON.stringify(await downloadGdc(argumentsValue, deps, signal)) };
      } catch (error) {
        return errorResult(error);
      }
    },
  };
}

/** All three GDC tools in SKILL_TOOL_MAP order. */
export function createGdcTools(deps: GdcToolDeps): readonly BioMedAgentTool[] {
  return [
    createSearchGdcTool(deps),
    createDescribeGdcTool(deps),
    createDownloadGdcTool(deps),
  ];
}

// ---------------------------------------------------------------------------
// Internal parsing helpers (Python dict access parity)
// ---------------------------------------------------------------------------

function gdcHits(payload: unknown): Array<Record<string, unknown>> {
  if (!isRecord(payload) || !isRecord(payload["data"])) return [];
  const hits = payload["data"]["hits"];
  if (!Array.isArray(hits)) return [];
  return hits.filter(isRecord);
}

function gdcTotalFiles(payload: unknown, fallback: number): number {
  if (!isRecord(payload) || !isRecord(payload["data"])) return fallback;
  const pagination = payload["data"]["pagination"];
  if (!isRecord(pagination)) return fallback;
  return numberOrZero(pagination["total"]);
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function dataCategories(summary: Record<string, unknown>): string[] {
  const raw = summary["data_categories"];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((entry) => String(entry["data_category"] ?? ""));
}

function describeCategories(summary: Record<string, unknown>): GdcDataCategoryCount[] {
  const raw = summary["data_categories"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).map((entry) => ({
    category: String(entry["data_category"] ?? ""),
    file_count: numberOrZero(entry["file_count"]),
  }));
}

function describeStrategies(summary: Record<string, unknown>): string[] {
  const raw = summary["experimental_strategies"];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(isRecord)
    .map((entry) => String(entry["experimental_strategy"] ?? ""));
}
