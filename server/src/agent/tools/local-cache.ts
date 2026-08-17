/**
 * `search_local_cache` / `describe_local_cache` / `get_cache_dataset` tools
 * (Python ``skills/builtin/acquisition/local_cache.py`` parity).
 *
 * P5-D7: the only sanctioned path is Tool → TS DatabaseClient → named-op
 * Python DB bridge → SQLite/records. The tools never touch Python business
 * modules and never issue arbitrary SQL.
 */

import type { BioMedAgentTool } from "../contracts.js";
import type { DatabaseClient } from "../../persistence/db-client.js";
import { DatabaseBridgeUnavailableError } from "../../persistence/db-client.js";
import { noopHooks, type ToolHooks } from "./tool-hooks.js";

export interface CacheDatasetManifest {
  dataset_id: string;
  source_namespace: string;
  topic: string;
  description: string;
  row_count: number;
  column_count: number;
  created_at: string;
  created_by_task_id: string;
  source_files: string[];
  extra: Record<string, unknown>;
  keywords: string[];
  /** Phase 8 schema-neutral cache: each record owns its column schema. */
  columns?: string[];
}

export interface LocalCacheToolDeps {
  db: DatabaseClient;
  hooks?: ToolHooks;
  timeoutMs?: number;
}

export function createLocalCacheTools(deps: LocalCacheToolDeps): BioMedAgentTool[] {
  const hooks = noopHooks(deps.hooks);
  const db = deps.db;

  const searchLocalCache: BioMedAgentTool = {
    name: "search_local_cache",
    label: "Search local cache",
    description:
      "Search the local cache for previously imported or cached datasets. " +
      "Returns dataset manifests matching the query via FTS5 full-text " +
      "search (matches topic, description, and keywords). Use this BEFORE " +
      "searching external databases (PubMed/GEO/...) to reuse already-" +
      "cleaned data. The cache is populated by IMPORT tasks or by previous " +
      "research runs. Query by any entity: gene names, drug names, " +
      "diseases, pathways, sample types, etc.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "搜索关键词（FTS5 全文匹配 topic/description/keywords）" },
        max_results: { type: "integer", description: "最多返回的结果数", default: 10 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (argumentsValue) => {
      const record = argumentsValue as { query?: unknown; max_results?: unknown };
      const query = typeof record.query === "string" ? record.query : "";
      const maxResults = typeof record.max_results === "number" ? record.max_results : 10;
      hooks.onQueryStarted(query, "local_cache");
      let manifests: CacheDatasetManifest[];
      try {
        manifests = await db.call<CacheDatasetManifest[]>("cache.search", { query, limit: maxResults }, deps.timeoutMs);
      } catch (error) {
        hooks.onQuery(query, "local_cache", "failed", 0);
        return {
          content: `本地缓存未初始化: ${error instanceof Error ? error.message : String(error)}`,
          isError: error instanceof DatabaseBridgeUnavailableError ? undefined : true,
        };
      }
      if (manifests.length > 0) {
        hooks.onQuery(query, "local_cache", "success", manifests.length);
      } else {
        hooks.onQuery(query, "local_cache", "not_found", 0);
      }
      if (manifests.length === 0) {
        return { content: JSON.stringify({ source: "local_cache", query, results: [] }) };
      }
      const results = manifests.map((m) => ({
        dataset_id: m.dataset_id,
        source_namespace: m.source_namespace,
        topic: m.topic,
        description: m.description,
        keywords: m.keywords ?? [],
        row_count: m.row_count,
        created_at: m.created_at,
        created_by_task_id: m.created_by_task_id,
        source_files: m.source_files,
      }));
      return { content: JSON.stringify({ source: "local_cache", query, results }, null, 2) };
    },
  };

  const describeLocalCache: BioMedAgentTool = {
    name: "describe_local_cache",
    label: "Describe cached dataset",
    description:
      "Describe one cached dataset's manifest (without reading its data rows). " +
      "Use after search_local_cache to inspect a dataset's metadata before " +
      "deciding whether to load its full content via get_cache_dataset.",
    parameters: {
      type: "object",
      properties: {
        source_namespace: { type: "string" },
        dataset_id: { type: "string" },
      },
      required: ["source_namespace", "dataset_id"],
      additionalProperties: false,
    },
    execute: async (argumentsValue) => {
      const record = argumentsValue as { source_namespace?: unknown; dataset_id?: unknown };
      const sourceNamespace = typeof record.source_namespace === "string" ? record.source_namespace : "";
      const datasetId = typeof record.dataset_id === "string" ? record.dataset_id : "";
      let manifest: CacheDatasetManifest | null;
      try {
        manifest = await db.call<CacheDatasetManifest | null>("cache.describe", {
          source_namespace: sourceNamespace,
          dataset_id: datasetId,
        }, deps.timeoutMs);
      } catch (error) {
        return { content: `本地缓存未初始化: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (manifest === null) {
        return {
          content: JSON.stringify({
            source: "local_cache",
            source_namespace: sourceNamespace,
            dataset_id: datasetId,
            error: "dataset not found",
          }),
        };
      }
      return {
        content: JSON.stringify({
          source: "local_cache",
          dataset_id: manifest.dataset_id,
          source_namespace: manifest.source_namespace,
          topic: manifest.topic,
          description: manifest.description,
          keywords: manifest.keywords ?? [],
          row_count: manifest.row_count,
          column_count: manifest.column_count,
          created_at: manifest.created_at,
          created_by_task_id: manifest.created_by_task_id,
          source_files: manifest.source_files,
          extra: manifest.extra,
        }, null, 2),
      };
    },
  };

  const getCacheDataset: BioMedAgentTool = {
    name: "get_cache_dataset",
    label: "Load cached dataset rows",
    description:
      "Load the full main_data.csv rows of one cached dataset. " +
      "Returns rows with the dataset's own column schema (recorded in its " +
      "manifest). Use after describe_local_cache to confirm the dataset is " +
      "what you need.",
    parameters: {
      type: "object",
      properties: {
        source_namespace: { type: "string" },
        dataset_id: { type: "string" },
        max_rows: { type: "integer", default: 1000, description: "最多返回的行数" },
      },
      required: ["source_namespace", "dataset_id"],
      additionalProperties: false,
    },
    execute: async (argumentsValue) => {
      const record = argumentsValue as { source_namespace?: unknown; dataset_id?: unknown; max_rows?: unknown };
      const sourceNamespace = typeof record.source_namespace === "string" ? record.source_namespace : "";
      const datasetId = typeof record.dataset_id === "string" ? record.dataset_id : "";
      const maxRows = typeof record.max_rows === "number" ? record.max_rows : 1000;
      let result: { manifest: CacheDatasetManifest; rows: Array<Record<string, string>> } | null;
      try {
        result = await db.call("cache.get", {
          source_namespace: sourceNamespace,
          dataset_id: datasetId,
        }, deps.timeoutMs);
      } catch (error) {
        return { content: `本地缓存未初始化: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (result === null) {
        return {
          content: JSON.stringify({
            source: "local_cache",
            source_namespace: sourceNamespace,
            dataset_id: datasetId,
            error: "dataset not found",
          }),
        };
      }
      const { manifest, rows } = result;
      const truncated = rows.length > maxRows;
      const returnedRows = rows.slice(0, maxRows);
      // Phase 8: the record's own manifest declares the column schema; fall
      // back to the CSV header (rows keys) for pre-migration records.
      const columns = manifest.columns !== undefined && manifest.columns.length > 0
        ? manifest.columns
        : (rows[0] !== undefined ? Object.keys(rows[0]) : []);
      hooks.onProgress("acquisition", "cache_dataset_loaded", {
        source_namespace: sourceNamespace,
        dataset_id: datasetId,
        truncated,
        current: returnedRows.length,
        total: rows.length,
      });
      return {
        content: JSON.stringify({
          source: "local_cache",
          dataset_id: manifest.dataset_id,
          source_namespace: manifest.source_namespace,
          topic: manifest.topic,
          row_count: manifest.row_count,
          returned_rows: returnedRows.length,
          truncated,
          columns: [...columns],
          rows: returnedRows,
        }),
      };
    },
  };

  return [searchLocalCache, describeLocalCache, getCacheDataset];
}
