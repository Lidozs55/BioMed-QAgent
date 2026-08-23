/**
 * GEO agent tools (P5-04; Python ``skills/builtin/acquisition/geo.py`` parity).
 *
 * Ports the five curated GEO tools — ``search_geo``, ``describe_geo``,
 * ``list_geo_supplementary_files``, ``download_geo`` and
 * ``download_geo_platform_annotation`` — over the shared external layer
 * (``src/external/geo``) and the sanctioned ``acquireSource`` download path.
 * Output keys and error payloads mirror the Python adapters exactly
 * (docs/migration/phase5-external-capabilities.md §2.2).
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";

import type { BioMedAgentTool } from "../contracts.js";
import type { ToolHooks } from "./tool-hooks.js";
import { createDownloadProgressReporter, noopHooks } from "./tool-hooks.js";
import { errorResult } from "./result.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import type { ContentCache } from "../../external/acquisition/content-cache.js";
import { acquireSource } from "../../external/acquisition/downloader.js";
import type { SourceRecord } from "../../dataset/contracts/source.js";
import {
  GeoEutilsClient,
  getGeoListing,
  type GeoEutilsConfig,
  type GeoDiscoveryClient,
} from "../../external/geo/client.js";
import {
  describeGeoSeries,
  searchGeoSeries,
} from "../../external/geo/discovery.js";
import {
  resolveGeoSupplementaryAssets,
  type GeoAssetCandidate,
  type GeoSeriesRecord,
} from "../../external/geo/parsers.js";
import {
  GEO_PLATFORM_FTP_ROOT,
  discoverAnnotationFile,
  geoPlatformDir,
} from "../../external/geo/annotation.js";

const GEO_FILE_TYPES = ["matrix", "soft", "suppl"] as const;
const GPL_PATTERN = /^GPL\d+$/;
const GEO_DOWNLOAD_HOST = "ftp.ncbi.nlm.nih.gov";
const ANNOTATION_UA = "Mozilla/5.0 (BioMedQAgent pipeline)";

/** Python ``_geo_record_json``: record fields + derived convenience keys. */
export function geoRecordJson(record: GeoSeriesRecord): Record<string, unknown> {
  return {
    uid: record.uid,
    accession: record.accession,
    title: record.title,
    summary: record.summary,
    organism: record.organism,
    experiment_type: record.experiment_type,
    sample_count: record.sample_count,
    samples: record.samples,
    platform_ids: record.platform_ids,
    pubmed_ids: record.pubmed_ids,
    bioproject: record.bioproject,
    ftp_root: record.ftp_root,
    platform_count: record.platform_ids.length,
    pubmed_id: record.pubmed_ids.join("; "),
  };
}

/** Python ``_https_ftp_root``: FTP -> HTTPS, uppercase-prefixed fallback. */
export function httpsFtpRoot(value: string, accession: string): string {
  let root = value.trim();
  if (root.startsWith("ftp://ftp.ncbi.nlm.nih.gov/")) {
    root = `https://${root.slice("ftp://".length)}`;
  }
  if (!root) {
    // NCBI FTP paths are case sensitive: force the uppercase prefix.
    const prefix = `${accession.slice(0, -3).toUpperCase()}nnn`;
    root = `https://ftp.ncbi.nlm.nih.gov/geo/series/${prefix}/${accession}/`;
  }
  return `${root.replace(/\/+$/, "")}/`;
}

/** Python ``_matrix_has_data_table``: expression-table content pre-check. */
export function matrixHasDataTable(filePath: string): boolean {
  try {
    const buffer = readFileSync(filePath);
    if (!(buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b)) {
      return false; // Python gzip.open fails on non-gzip input -> False
    }
    const text = gunzipSync(buffer).toString("utf8");
    return text.split(/\r\n|\n|\r/).some((line) =>
      line.startsWith("!series_matrix_table_begin"),
    );
  } catch {
    return false;
  }
}

interface GeoSearchPayload {
  source: string;
  term: string;
  query_translation?: string;
  total_count?: number;
  accessions?: string[];
  records?: Array<Record<string, unknown>>;
  error?: string;
}

export interface GeoToolsOptions {
  /** Absolute task root (TaskWorkDir root) for acquired source assets. */
  taskRoot: string;
  cache: ContentCache;
  client: PublicHttpClient;
  /** E-utilities request identity (tool/email/optional API key). */
  eutils: Omit<GeoEutilsConfig, "baseUrl" | "maxRetries">;
  hooks?: ToolHooks;
  /** Global cache registrar (raw downloads → data/cache). */
  registrar?: import("../../persistence/cache-registrar.js").CacheRegistrar | null;
  /** Task id used as cache provenance. */
  taskId?: string | (() => string);
  /** Injectable retry/backoff sleeper (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** E-utilities discovery client override (tests). */
  discovery?: GeoDiscoveryClient;
  maxDownloadBytes?: number;
  downloadTimeoutMs?: number;
}

interface GeoResolvedDownload {
  source: SourceRecord;
  selectedFilename: string;
  record: GeoSeriesRecord;
}

/** Python ``_resolve_download`` shared by download_geo. */
export async function resolveGeoDownload(
  options: GeoToolsOptions,
  accession: string,
  fileType: string,
  filename: string | null,
  signal?: AbortSignal,
): Promise<GeoResolvedDownload> {
  const { client, discovery, sleep } = options;
  const eutils = discovery ?? new GeoEutilsClient({
    http: client,
    config: options.eutils,
    sleeper: sleep,
  });
  const record = await describeGeoSeries(eutils, accession, signal);
  const root = httpsFtpRoot(record.ftp_root, record.accession);
  const normalizedType = fileType.toLowerCase().trim();
  let selectedFilename: string;
  let url: string;

  if (normalizedType === "matrix") {
    selectedFilename = filename || `${record.accession}_series_matrix.txt.gz`;
    url = `${root}matrix/${selectedFilename}`;
  } else if (normalizedType === "soft") {
    selectedFilename = filename || `${record.accession}_family.soft.gz`;
    url = `${root}soft/${selectedFilename}`;
  } else if (normalizedType === "suppl") {
    const listingUrl = `${root}suppl/`;
    const response = await getGeoListing(client, listingUrl, {
      sleeper: sleep,
      signal,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`supplementary listing returned HTTP ${response.status}`);
    }
    const candidates = resolveGeoSupplementaryAssets(response.body, listingUrl);
    let filtered = candidates;
    if (filename !== null && filename !== undefined) {
      filtered = candidates.filter((item) => item.filename === filename);
      if (filtered.length === 0) {
        const available = candidates.map((item) => item.filename);
        throw new Error(
          `no matching GEO supplementary file found for filename=${JSON.stringify(filename)}; available files: ${JSON.stringify(available)}`,
        );
      }
    }
    if (filtered.length === 0) {
      throw new Error("no matching GEO supplementary file found");
    }
    if (filtered.length > 1 && filename === null) {
      const available = filtered.map((item) => item.filename);
      throw new Error(
        `multiple supplementary files found; specify filename. available files: ${JSON.stringify(available)}`,
      );
    }
    selectedFilename = filtered[0].filename;
    url = filtered[0].url;
  } else {
    throw new Error(
      `unsupported file_type: ${JSON.stringify(fileType)}; expected one of ${GEO_FILE_TYPES.join(", ")}`,
    );
  }

  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.hostname !== GEO_DOWNLOAD_HOST) {
    throw new Error("GEO download must resolve to official NCBI HTTPS");
  }
  const source: SourceRecord = {
    schema_version: "1.0",
    source_id: `src_geo_${record.accession.toLowerCase()}_${normalizedType}`,
    database: "geo",
    accession: record.accession,
    url,
    title: record.title,
    retrieved_at: new Date().toISOString(),
  };
  return { source, selectedFilename, record };
}

/** Python ``list_geo_supplementary_files_adapter`` result shape. */
export interface GeoSupplementaryFile {
  filename: string;
  url: string;
  media_type: string;
  data_level: string;
}

function supplementaryFileJson(item: GeoAssetCandidate): GeoSupplementaryFile {
  return {
    filename: item.filename,
    url: item.url,
    media_type: item.media_type,
    data_level: item.data_level,
  };
}

export function createSearchGeoTool(options: GeoToolsOptions): BioMedAgentTool {
  const hooks = noopHooks(options.hooks);
  return {
    name: "search_geo",
    label: "Search GEO",
    description:
      "Search NCBI GEO for GSE series records. " +
      "Parameters: ``query`` (required, search keyword like 'METTL5' or " +
      "'pancreatic cancer') — ``term`` is accepted as a legacy alias; " +
      "``max_results`` (optional, default 20). " +
      "Returns JSON with source, count, and structured GSE records " +
      "(accession, title, summary, sample_count, platform, etc.).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "GEO search keyword, e.g. 'METTL5' or 'pancreatic cancer'.",
        },
        max_results: {
          type: "number",
          description: "Maximum number of series records to return (default 20).",
        },
        term: {
          type: "string",
          description: "Legacy alias for query.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      const record = argumentsValue as {
        query?: unknown;
        max_results?: unknown;
        term?: unknown;
      };
      const query = typeof record.query === "string" ? record.query : "";
      const term = typeof record.term === "string" ? record.term : "";
      const maxResults =
        typeof record.max_results === "number" ? record.max_results : 20;
      const effectiveTerm = query || term;
      if (!effectiveTerm) {
        return {
          content: JSON.stringify({
            source: "geo",
            error: "either 'query' or 'term' must be provided",
            code: "invalid_input",
            retryable: false,
          }),
          isError: true,
        };
      }
      const queryCallToken = hooks.onQueryStarted(effectiveTerm, "geo");
      const discovery =
        options.discovery ??
        new GeoEutilsClient({
          http: options.client,
          config: options.eutils,
          sleeper: options.sleep,
        });
      try {
        const result = await searchGeoSeries(discovery, effectiveTerm, maxResults, signal);
        const records = result.records.map((item) => geoRecordJson(item));
        hooks.onQuery(effectiveTerm, "geo", "success", records.length, queryCallToken);
        hooks.onProgress("discovery", "discovered_records", {
          current: records.length,
          total: result.total_count,
          source: "geo",
          term: effectiveTerm,
        });
        const payload: GeoSearchPayload = {
          source: "geo",
          term: effectiveTerm,
          query_translation: result.query_translation,
          total_count: result.total_count,
          accessions: records.map((item) => String(item.accession)),
          records,
        };
        return { content: JSON.stringify(payload) };
      } catch (error) {
        hooks.onQuery(effectiveTerm, "geo", "failed", 0, queryCallToken);
        const failure = errorResult(error);
        const details = failure.details as { code: string; retryable: boolean };
        const payload: GeoSearchPayload & { code: string; retryable: boolean } = {
          source: "geo",
          term: effectiveTerm,
          accessions: [],
          records: [],
          error: error instanceof Error ? error.message : String(error),
          code: details.code,
          retryable: details.retryable,
        };
        return { content: JSON.stringify(payload), details: failure.details, isError: true };
      }
    },
  };
}

export function createDescribeGeoTool(options: GeoToolsOptions): BioMedAgentTool {
  return {
    name: "describe_geo",
    label: "Describe GEO series",
    description: "Describe one GEO series accession using NCBI metadata.",
    parameters: {
      type: "object",
      properties: {
        accession: {
          type: "string",
          description: "GEO series accession, e.g. 'GSE178352'.",
        },
      },
      required: ["accession"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      const record = argumentsValue as { accession?: unknown };
      const accession = typeof record.accession === "string" ? record.accession : "";
      const discovery =
        options.discovery ??
        new GeoEutilsClient({
          http: options.client,
          config: options.eutils,
          sleeper: options.sleep,
        });
      try {
        const series = await describeGeoSeries(discovery, accession, signal);
        const payload = geoRecordJson(series);
        let supplementaryFileListingUrl = "";
        if (series.ftp_root) {
          supplementaryFileListingUrl =
            httpsFtpRoot(series.ftp_root, series.accession) + "suppl/";
        }
        return {
          content: JSON.stringify({
            source: "geo",
            ...payload,
            supplementary_file_listing_url: supplementaryFileListingUrl,
            note:
              "NCBI E-utilities esummary does not expose overall_design, " +
              "per-platform title/organism, or supplementary file URLs. " +
              "Use platform_ids for GPL lookups and " +
              "supplementary_file_listing_url (or download_geo with " +
              "file_type='suppl') to enumerate supplementary files.",
          }),
        };
      } catch (error) {
        const failure = errorResult(error);
        return {
          content: JSON.stringify({
            source: "geo",
            accession,
            error: error instanceof Error ? error.message : String(error),
            ...(failure.details as object),
          }),
          details: failure.details,
          isError: true,
        };
      }
    },
  };
}

export function createListGeoSupplementaryFilesTool(
  options: GeoToolsOptions,
): BioMedAgentTool {
  return {
    name: "list_geo_supplementary_files",
    label: "List GEO supplementary files",
    description:
      "List downloadable supplementary files for a GEO series accession. " +
      "Use this BEFORE download_geo(file_type='suppl') so you can pass an " +
      "explicit filename instead of guessing. Returns JSON with " +
      "supplementary_files (filename, url, media_type, data_level).",
    parameters: {
      type: "object",
      properties: {
        accession: {
          type: "string",
          description: "GEO series accession, e.g. 'GSE178352'.",
        },
      },
      required: ["accession"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      const record = argumentsValue as { accession?: unknown };
      const accession = typeof record.accession === "string" ? record.accession : "";
      const discovery =
        options.discovery ??
        new GeoEutilsClient({
          http: options.client,
          config: options.eutils,
          sleeper: options.sleep,
        });
      try {
        const series = await describeGeoSeries(discovery, accession, signal);
        const root = httpsFtpRoot(series.ftp_root, series.accession);
        const listingUrl = `${root}suppl/`;
        const response = await getGeoListing(options.client, listingUrl, {
          sleeper: options.sleep,
          signal,
        });
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`supplementary listing returned HTTP ${response.status}`);
        }
        const candidates = resolveGeoSupplementaryAssets(response.body, listingUrl);
        const files = candidates.map(supplementaryFileJson);
        return {
          content: JSON.stringify({
            source: "geo",
            accession: series.accession,
            supplementary_file_count: files.length,
            supplementary_files: files,
            listing_url: listingUrl,
          }),
        };
      } catch (error) {
        const failure = errorResult(error);
        return {
          content: JSON.stringify({
            source: "geo",
            accession,
            error: error instanceof Error ? error.message : String(error),
            ...(failure.details as object),
          }),
          details: failure.details,
          isError: true,
        };
      }
    },
  };
}

export function createDownloadGeoTool(options: GeoToolsOptions): BioMedAgentTool {
  return {
    name: "download_geo",
    label: "Download GEO file",
    description:
      "Download a GEO matrix, SOFT, or supplementary file as an immutable " +
      "repository-processed SourceAsset. Compressed files remain compressed. " +
      "max_size_mb caps the download size (default 4096 MiB — large enough " +
      "for real series matrices like GSE33000's 107 MiB file); raise it " +
      "explicitly for very large supplementary files. " +
      "For file_type='suppl', call list_geo_supplementary_files first to get " +
      "the exact filename.",
    parameters: {
      type: "object",
      properties: {
        accession: {
          type: "string",
          description: "GEO series accession, e.g. 'GSE178352'.",
        },
        file_type: {
          type: "string",
          description: "One of 'matrix', 'soft', or 'suppl' (default 'matrix').",
        },
        filename: {
          type: "string",
          description:
            "Optional explicit filename (required when the suppl listing has multiple files).",
        },
        max_size_mb: {
          type: "number",
          description: "Maximum download size in MiB (default 4096).",
        },
      },
      required: ["accession"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      const record = argumentsValue as {
        accession?: unknown;
        file_type?: unknown;
        filename?: unknown;
        max_size_mb?: unknown;
      };
      const accession = typeof record.accession === "string" ? record.accession : "";
      const fileType = typeof record.file_type === "string" ? record.file_type : "matrix";
      const filename =
        typeof record.filename === "string" ? record.filename : null;
      const configuredMaxMb = (options.maxDownloadBytes ?? 8192 * 1024 * 1024) / (1024 * 1024);
      const requestedMaxMb = typeof record.max_size_mb === "number" ? record.max_size_mb : configuredMaxMb;
      const maxSizeMb = Math.min(requestedMaxMb, configuredMaxMb);
      try {
        const resolved = await resolveGeoDownload(
          options,
          accession,
          fileType,
          filename,
          signal,
        );
        const reportProgress = createDownloadProgressReporter(
          options.hooks,
          {
            source: "geo",
            accession: resolved.source.accession,
            filename: resolved.selectedFilename,
            records: 1,
          },
        );
        const result = await acquireSource({
          source: resolved.source,
          filename: resolved.selectedFilename,
          workdirRoot: options.taskRoot,
          cache: options.cache,
          client: options.client,
          dataLevel: "repository_processed",
          maxBytes: maxSizeMb * 1024 * 1024,
          signal,
          timeoutMs: options.downloadTimeoutMs,
          progress: reportProgress,
          onPublished: (published) => options.registrar?.register("geo", published, options.taskId),
        });
        const payload: Record<string, unknown> = {
          source: "geo",
          accession: resolved.source.accession,
          source_url: resolved.source.url,
          attempt: result.attempt,
          asset: result.asset,
        };
        if (result.asset !== null) {
          const localPath = path.join(
            options.taskRoot,
            ...result.asset.relative_path.split("/"),
          );
          if (
            fileType.toLowerCase().trim() === "matrix" &&
            !matrixHasDataTable(localPath)
          ) {
            return {
              content: JSON.stringify({
                source: "geo",
                accession: resolved.source.accession,
                source_url: resolved.source.url,
                error:
                  "series matrix contains no expression table " +
                  "(metadata-only). The expression data for this " +
                  "series lives in soft/ or suppl/ — try " +
                  "download_geo(file_type='soft') or " +
                  "download_geo(file_type='suppl') after " +
                  "list_geo_supplementary_files.",
                reason_code: "empty_series_matrix",
              }),
            };
          }
          payload.local_files = [localPath];
          payload.format_hint = fileType.toLowerCase().trim();
        } else {
          payload.error = result.attempt.error_message;
        }
        return { content: JSON.stringify(payload) };
      } catch (error) {
        const failure = errorResult(error);
        return {
          content: JSON.stringify({
            source: "geo",
            accession,
            error: error instanceof Error ? error.message : String(error),
            ...(failure.details as object),
          }),
          details: failure.details,
          isError: true,
        };
      }
    },
  };
}

export function createDownloadGeoPlatformAnnotationTool(
  options: GeoToolsOptions,
): BioMedAgentTool {
  return {
    name: "download_geo_platform_annotation",
    label: "Download GEO platform annotation",
    description:
      "Download the NCBI GEO platform annotation table (SOFT) for a GPL " +
      "platform as an immutable SourceAsset. The annotation maps probe IDs " +
      "to gene identifiers and is required for a probe-platform (microarray) " +
      "GEO build to produce gene-level rows — pass the returned file via " +
      "the ``mapping_files`` parameter of execute_dataset_build " +
      "(binding_id -> annotation path). Parameters: ``gpl`` (required, " +
      "e.g. 'GPL570'), ``max_size_mb`` (optional, default 4096). Returns JSON " +
      "with platform, asset and local_files. Fails cleanly when the " +
      "platform ships no downloadable annotation table.",
    parameters: {
      type: "object",
      properties: {
        gpl: {
          type: "string",
          description: "GEO platform accession, e.g. 'GPL570'.",
        },
        max_size_mb: {
          type: "number",
          description: "Maximum download size in MiB (default 4096).",
        },
      },
      required: ["gpl"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      const record = argumentsValue as { gpl?: unknown; max_size_mb?: unknown };
      const gpl = typeof record.gpl === "string" ? record.gpl : "";
      const configuredMaxMb = (options.maxDownloadBytes ?? 8192 * 1024 * 1024) / (1024 * 1024);
      const requestedMaxMb = typeof record.max_size_mb === "number" ? record.max_size_mb : configuredMaxMb;
      const maxSizeMb = Math.min(requestedMaxMb, configuredMaxMb);
      if (!GPL_PATTERN.test(gpl || "")) {
        return {
          content: JSON.stringify({
            source: "geo",
            platform: gpl,
            error: "gpl must match ^GPL\\d+$ (e.g. 'GPL570')",
          }),
        };
      }
      try {
        const located = await discoverAnnotationFile(options.client, gpl);
        if (located === null) {
          return {
            content: JSON.stringify({
              source: "geo",
              platform: gpl,
              error:
                `no downloadable annotation table for ${gpl}; the ` +
                "platform ships no SOFT annotation (some custom/Agilent " +
                "platforms ship only sequence columns)",
            }),
          };
        }
        const { subdir, filename } = located;
        const url =
          `${GEO_PLATFORM_FTP_ROOT}/${geoPlatformDir(gpl)}` +
          `/${gpl}/${subdir}/${filename}`;
        const source: SourceRecord = {
          schema_version: "1.0",
          source_id: `src_geo_${gpl.toLowerCase()}_annotation`,
          database: "geo",
          accession: gpl,
          url,
          title: `GEO platform annotation ${gpl}`,
          retrieved_at: new Date().toISOString(),
        };
        const reportProgress = createDownloadProgressReporter(
          options.hooks,
          { source: "geo", accession: gpl, platform: gpl, filename, records: 1 },
        );
        const result = await acquireSource({
          source,
          filename,
          workdirRoot: options.taskRoot,
          cache: options.cache,
          client: options.client,
          dataLevel: "repository_processed",
          maxBytes: maxSizeMb * 1024 * 1024,
          accept: "application/gzip, text/plain",
          requestHeaders: { "User-Agent": ANNOTATION_UA },
          signal,
          timeoutMs: options.downloadTimeoutMs,
          progress: reportProgress,
          onPublished: (published) => options.registrar?.register("geo", published, options.taskId),
        });
        const payload: Record<string, unknown> = {
          source: "geo",
          platform: gpl,
          source_url: source.url,
          attempt: result.attempt,
          asset: result.asset,
        };
        if (result.asset !== null) {
          const localPath = path.join(
            options.taskRoot,
            ...result.asset.relative_path.split("/"),
          );
          payload.local_files = [localPath];
          payload.format_hint = "platform_annotation";
        } else {
          payload.error = result.attempt.error_message;
        }
        return { content: JSON.stringify(payload) };
      } catch (error) {
        const failure = errorResult(error);
        return {
          content: JSON.stringify({
            source: "geo",
            platform: gpl,
            error: error instanceof Error ? error.message : String(error),
            ...(failure.details as object),
          }),
          details: failure.details,
          isError: true,
        };
      }
    },
  };
}

export const GEO_TOOL_NAMES = [
  "search_geo",
  "describe_geo",
  "list_geo_supplementary_files",
  "download_geo",
  "download_geo_platform_annotation",
] as const;

/**
 * Build the five curated GEO tools.  Registration into the formal tool
 * bundle lands with the P5-12 runtime composition (see
 * ``business-tools.ts``); the names must match SKILL_TOOL_MAP exactly.
 */
export function createGeoTools(options: GeoToolsOptions): BioMedAgentTool[] {
  return [
    createSearchGeoTool(options),
    createDescribeGeoTool(options),
    createListGeoSupplementaryFilesTool(options),
    createDownloadGeoTool(options),
    createDownloadGeoPlatformAnnotationTool(options),
  ];
}
