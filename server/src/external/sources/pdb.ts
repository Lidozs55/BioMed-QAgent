/**
 * RCSB PDB source client (Python ``skills/builtin/acquisition/pdb.py``
 * parity): search, describe, and download protein structures.
 *
 * ``search_pdb`` POSTs the RCSB Search API v2 and enriches the top
 * ``min(result_count, 3)`` entries with Data API metadata (the remaining
 * entries carry only ``pdb_id``; callers use ``describe_pdb`` for details).
 * ``download_pdb`` routes through ``acquireSource`` — the single sanctioned
 * verified download path (P5-D3) — so the asset is published as an immutable
 * content-addressed SourceAsset with a DownloadAttempt record.
 */

import path from "node:path";

import type { ToolHooks } from "../../agent/tools/tool-hooks.js";
import type { DataLevel } from "../../dataset/contracts/enums.js";
import type { SourceRecord } from "../../dataset/contracts/source.js";
import { acquireSource } from "../acquisition/downloader.js";
import type { ContentCache } from "../acquisition/content-cache.js";
import { isAbortError } from "../network/errors.js";
import type { PublicHttpClient } from "../network/http-client.js";
import type { SourceQueryContext } from "./context.js";
import {
  DEFAULT_RATE_LIMIT_MS,
  apiFetch,
  isRecord,
  makeSourceId,
  rateLimit,
} from "./fallback.js";

const SEARCH_API = "https://search.rcsb.org/rcsbsearch/v2/query";
const DATA_API = "https://data.rcsb.org/rest/v1/core/entry/";
const FILES_BASE = "https://files.rcsb.org/download/";

/** search_pdb enriches the first N results to avoid N+1 queries (Python parity). */
const DESCRIBE_BATCH_LIMIT = 3;

export interface DownloadDeps {
  taskRoot: string;
  cache: ContentCache;
  client: PublicHttpClient;
  signal?: AbortSignal;
  rateLimitMs?: number;
  maxDownloadBytes?: number;
  timeoutMs?: number;
  onQueryStarted?: ToolHooks["onQueryStarted"];
  onQuery?: ToolHooks["onQuery"];
  /** Global cache registrar (raw downloads → data/cache). */
  registrar?: import("../../persistence/cache-registrar.js").CacheRegistrar | null;
  /** Task id used as cache provenance. */
  taskId?: string | (() => string);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Python ``_build_search_body``: RCSB Search API v2 full_text query. */
export function buildSearchBody(term: string, maxResults: number): Record<string, unknown> {
  return {
    query: {
      type: "group",
      logical_operator: "and",
      nodes: [
        {
          type: "terminal",
          service: "full_text",
          parameters: { value: term },
        },
      ],
    },
    return_type: "entry",
    request_options: {
      paginate: { start: 0, rows: maxResults },
      results_content_type: ["experimental"],
      sort: [{ sort_by: "score", direction: "desc" }],
    },
  };
}

/** Python ``_fetch_entry_detail``: enriched metadata with empty-safe defaults. */
export async function fetchEntryDetail(
  pdbId: string,
  context: SourceQueryContext,
): Promise<Record<string, unknown>> {
  const url = `${DATA_API}${pdbId.toLowerCase()}`;
  try {
    const fetched = await apiFetch(context.client, url, {
      signal: context.signal,
      rateLimitMs: context.rateLimitMs,
    });
    if (fetched.status_code < 200 || fetched.status_code >= 300) {
      throw new Error(`HTTP ${fetched.status_code}`);
    }
    const data = JSON.parse(fetched.content) as unknown;
    const document = isRecord(data) ? data : {};
    const struct = isRecord(document["struct"]) ? document["struct"] : {};
    const rcsb = isRecord(document["rcsb_entry_info"]) ? document["rcsb_entry_info"] : {};
    const exptl = Array.isArray(document["exptl"]) ? document["exptl"] : [];
    const accession = isRecord(document["rcsb_accession_info"]) ? document["rcsb_accession_info"] : {};

    const organisms: string[] = [];
    const polymers = Array.isArray(document["polymer_entities"]) ? document["polymer_entities"] : [];
    for (const entityRaw of polymers) {
      const entity = isRecord(entityRaw) ? entityRaw : {};
      const sources = Array.isArray(entity["rcsb_entity_source_organism"])
        ? entity["rcsb_entity_source_organism"]
        : [];
      for (const sourceRaw of sources) {
        const source = isRecord(sourceRaw) ? sourceRaw : {};
        const name = source["scientific_name"];
        if (typeof name === "string" && name.length > 0 && !organisms.includes(name)) {
          organisms.push(name);
        }
      }
    }

    const resolutions = Array.isArray(rcsb["resolution_combined"]) ? rcsb["resolution_combined"] : [];
    return {
      title: typeof struct["title"] === "string" ? struct["title"] : "",
      organism: organisms.length > 0 ? organisms.join("; ") : "",
      method: isRecord(exptl[0]) && typeof exptl[0]["method"] === "string" ? exptl[0]["method"] : "",
      resolution: resolutions.length > 0 ? resolutions[0] : null,
      deposit_date: typeof accession["deposit_date"] === "string" ? accession["deposit_date"] : "",
    };
  } catch (error) {
    if (isAbortError(error) || context.signal?.aborted === true) throw error;
    // Python logs a warning and callers merge the empty defaults.
    return {};
  }
}

/** Search RCSB PDB by keyword; top entries enriched via the Data API. */
export async function searchPdb(
  term: string,
  maxResults: number,
  context: SourceQueryContext,
): Promise<Record<string, unknown>> {
  const queryCallToken = context.onQueryStarted?.(term, "pdb");
  let data: unknown;
  try {
    const fetched = await apiFetch(context.client, SEARCH_API, {
      method: "POST",
      jsonBody: buildSearchBody(term, maxResults),
      signal: context.signal,
      rateLimitMs: context.rateLimitMs,
    });
    if (fetched.status_code < 200 || fetched.status_code >= 300) {
      throw new Error(`HTTP ${fetched.status_code}`);
    }
    data = JSON.parse(fetched.content) as unknown;
  } catch (error) {
    if (isAbortError(error) || context.signal?.aborted === true) throw error;
    context.onQuery?.(term, "pdb", "failed", 0, queryCallToken);
    return {
      source: "pdb",
      term,
      pdb_ids: [],
      records: [],
      error: errorMessage(error),
    };
  }

  const document = isRecord(data) ? data : {};
  const resultSet = Array.isArray(document["result_set"]) ? document["result_set"] : [];
  context.onQuery?.(term, "pdb", "success", resultSet.length, queryCallToken);

  const records: Array<Record<string, unknown>> = [];
  const enrichLimit = Math.min(resultSet.length, DESCRIBE_BATCH_LIMIT);
  for (let index = 0; index < resultSet.length; index += 1) {
    const rawEntry = resultSet[index];
    const entry = isRecord(rawEntry) ? rawEntry : {};
    const pdbId = typeof entry["identifier"] === "string" ? entry["identifier"] : "";
    const record: Record<string, unknown> = {
      pdb_id: pdbId,
      title: "",
      organism: "",
      method: "",
      resolution: null,
      deposit_date: "",
    };
    if (index < enrichLimit && pdbId.length > 0) {
      Object.assign(record, await fetchEntryDetail(pdbId, context));
    }
    records.push(record);
  }

  return {
    source: "pdb",
    term,
    pdb_ids: records.map((record) => record["pdb_id"]),
    records,
    enriched_count: enrichLimit,
  };
}

/** Get detailed metadata about a PDB structure from the Data API. */
export async function describePdb(
  pdbId: string,
  context: SourceQueryContext,
): Promise<Record<string, unknown>> {
  const normalized = pdbId.trim().toLowerCase();
  const queryCallToken = context.onQueryStarted?.(normalized, "pdb");
  const url = `${DATA_API}${normalized}`;
  let data: unknown;
  try {
    const fetched = await apiFetch(context.client, url, {
      signal: context.signal,
      rateLimitMs: context.rateLimitMs,
    });
    if (fetched.status_code < 200 || fetched.status_code >= 300) {
      throw new Error(`HTTP ${fetched.status_code}`);
    }
    data = JSON.parse(fetched.content) as unknown;
  } catch (error) {
    if (isAbortError(error) || context.signal?.aborted === true) throw error;
    context.onQuery?.(normalized, "pdb", "failed", 0, queryCallToken);
    return {
      source: "pdb",
      pdb_id: normalized,
      error: errorMessage(error),
    };
  }

  const document = isRecord(data) ? data : {};
  const struct = isRecord(document["struct"]) ? document["struct"] : {};
  const rcsb = isRecord(document["rcsb_entry_info"]) ? document["rcsb_entry_info"] : {};
  const exptl = Array.isArray(document["exptl"]) ? document["exptl"] : [];
  const audit = Array.isArray(document["audit_author"]) ? document["audit_author"] : [];
  const citation = Array.isArray(document["citation"]) ? document["citation"] : [];
  const polymers = Array.isArray(document["polymer_entities"]) ? document["polymer_entities"] : [];
  const nonPolymers = Array.isArray(document["nonpolymer_entities"]) ? document["nonpolymer_entities"] : [];
  const accession = isRecord(document["rcsb_accession_info"]) ? document["rcsb_accession_info"] : {};
  const resolutions = Array.isArray(rcsb["resolution_combined"]) ? rcsb["resolution_combined"] : [];

  context.onQuery?.(normalized, "pdb", "success", 1, queryCallToken);
  return {
    source: "pdb",
    pdb_id: normalized.toUpperCase(),
    title: typeof struct["title"] === "string" ? struct["title"] : "",
    deposit_date: typeof accession["deposit_date"] === "string" ? accession["deposit_date"] : "",
    resolution: resolutions.length > 0 ? resolutions[0] : null,
    method: isRecord(exptl[0]) && typeof exptl[0]["method"] === "string" ? exptl[0]["method"] : "",
    molecular_weight: typeof rcsb["molecular_weight"] === "number" ? rcsb["molecular_weight"] : null,
    polymer_count: typeof rcsb["polymer_entity_count"] === "number" ? rcsb["polymer_entity_count"] : 0,
    authors: audit.map((raw) => (isRecord(raw) && typeof raw["name"] === "string" ? raw["name"] : "")),
    citation: citation.length > 0 ? citation[0] : null,
    polymer_entities: polymers,
    nonpolymer_entities: nonPolymers,
    url,
  };
}

/** Download a PDB/mmCIF file through the verified acquisition channel. */
export async function downloadPdb(
  pdbId: string,
  fileType: string,
  deps: DownloadDeps,
): Promise<Record<string, unknown>> {
  const normalizedId = pdbId.trim().toLowerCase();
  const normalizedType = fileType.toLowerCase().trim();
  const queryCallToken = deps.onQueryStarted?.(normalizedId, "pdb");

  let url: string;
  let filename: string;
  let formatHint: string;
  if (normalizedType === "pdb") {
    url = `${FILES_BASE}${normalizedId}.pdb`;
    filename = `${normalizedId}.pdb`;
    formatHint = "pdb_legacy";
  } else if (normalizedType === "cif") {
    url = `${FILES_BASE}${normalizedId}.cif`;
    filename = `${normalizedId}.cif`;
    formatHint = "mmcif";
  } else {
    return {
      source: "pdb",
      pdb_id: normalizedId,
      error: `unsupported file_type: ${normalizedType}. Use 'pdb' or 'cif'.`,
    };
  }

  const accession = normalizedId.toUpperCase();
  const retrievedAt = new Date().toISOString();
  const source: SourceRecord = {
    schema_version: "1.0",
    source_id: makeSourceId("pdb", accession, url),
    database: "pdb",
    accession,
    url,
    title: `PDB structure ${accession}`,
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
      accept: "application/octet-stream,*/*;q=0.9",
      signal: deps.signal,
      timeoutMs: deps.timeoutMs,
      onPublished: (published) => deps.registrar?.register("pdb", published, deps.taskId),
    });
    const payload: Record<string, unknown> = {
      source: "pdb",
      pdb_id: accession,
      source_url: source.url,
      attempt: result.attempt,
      asset: result.asset,
    };
    if (result.asset !== null) {
      deps.onQuery?.(filename, "pdb", "success", 1, queryCallToken);
      payload["local_files"] = [path.join(deps.taskRoot, result.asset.relative_path)];
      payload["format_hint"] = formatHint;
      payload["retrieved_at"] = retrievedAt;
    } else {
      deps.onQuery?.(filename, "pdb", "failed", 0, queryCallToken);
      payload["error"] = result.attempt.error_message;
    }
    return payload;
  } catch (error) {
    if (isAbortError(error) || deps.signal?.aborted === true) throw error;
    return {
      source: "pdb",
      pdb_id: normalizedId,
      error: errorMessage(error),
    };
  }
}
