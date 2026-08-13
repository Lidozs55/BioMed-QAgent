/**
 * PDB tools (Python ``skills/builtin/acquisition/pdb.py`` parity):
 * `search_pdb`, `describe_pdb`, `download_pdb`. Registered under the
 * SKILL_TOOL_MAP names.
 */

import path from "node:path";

import type { BioMedAgentTool } from "../contracts.js";
import { noopHooks, type ToolServiceDeps } from "./tool-hooks.js";
import { ContentCache } from "../../external/acquisition/content-cache.js";
import { PublicHttpClient } from "../../external/network/http-client.js";
import {
  describePdb,
  downloadPdb,
  searchPdb,
} from "../../external/sources/pdb.js";

export interface PdbToolDeps extends ToolServiceDeps {
  /** Injectable HTTP client for fixture tests; defaults to the policy client. */
  client?: PublicHttpClient;
  /** Request pacing override for tests; default 2000ms. */
  rateLimitMs?: number;
}

export const SEARCH_PDB_TOOL_NAME = "search_pdb";
export const DESCRIBE_PDB_TOOL_NAME = "describe_pdb";
export const DOWNLOAD_PDB_TOOL_NAME = "download_pdb";

export function createPdbTools(deps: PdbToolDeps): BioMedAgentTool[] {
  const client = deps.client ?? new PublicHttpClient();
  const hooks = noopHooks(deps.hooks);
  const cache = new ContentCache(path.join(deps.taskRoot, "cache", "pdb"));

  const context = {
    client,
    rateLimitMs: deps.rateLimitMs,
    onQuery: hooks.onQuery,
  };

  return [
    {
      name: SEARCH_PDB_TOOL_NAME,
      label: "Search PDB structures",
      description:
        "Search RCSB PDB by keyword (protein name, gene, organism, etc.). Uses the " +
        "RCSB Search API v2 with full_text search. Returns JSON with PDB IDs, titles, " +
        "organism, and method metadata; the top 3 entries are enriched with full " +
        "metadata from the Data API. Use ``describe_pdb`` to get full metadata for a " +
        "specific PDB ID.",
      parameters: {
        type: "object",
        properties: {
          term: {
            type: "string",
            description: "Search keyword like 'TP53' or 'hemoglobin'.",
          },
          max_results: {
            type: "integer",
            default: 20,
            description: "Maximum number of PDB entries to return (default 20).",
          },
        },
        required: ["term"],
        additionalProperties: false,
      },
      execute: async (argumentsValue, signal) => {
        const record = argumentsValue as { term?: unknown; max_results?: unknown };
        if (typeof record.term !== "string") {
          return {
            content: JSON.stringify({
              source: "pdb",
              term: "",
              pdb_ids: [],
              records: [],
              error: "term must be a string",
            }),
            isError: true,
          };
        }
        const maxResults =
          typeof record.max_results === "number" &&
          Number.isInteger(record.max_results) &&
          record.max_results > 0
            ? record.max_results
            : 20;
        const result = await searchPdb(record.term, maxResults, { ...context, signal });
        return { content: JSON.stringify(result) };
      },
    },
    {
      name: DESCRIBE_PDB_TOOL_NAME,
      label: "Describe PDB structure",
      description:
        "Get detailed metadata about a PDB structure from the RCSB Data API: title, " +
        "deposition date, resolution, experimental method, authors, citation info, " +
        "polymer entities, and ligand/non-polymer info.",
      parameters: {
        type: "object",
        properties: {
          pdb_id: {
            type: "string",
            description: "PDB entry identifier (e.g. '1cbs').",
          },
        },
        required: ["pdb_id"],
        additionalProperties: false,
      },
      execute: async (argumentsValue, signal) => {
        const record = argumentsValue as { pdb_id?: unknown };
        if (typeof record.pdb_id !== "string") {
          return {
            content: JSON.stringify({ source: "pdb", pdb_id: "", error: "pdb_id must be a string" }),
            isError: true,
          };
        }
        const result = await describePdb(record.pdb_id, { ...context, signal });
        return { content: JSON.stringify(result) };
      },
    },
    {
      name: DOWNLOAD_PDB_TOOL_NAME,
      label: "Download PDB structure",
      description:
        "Download a PDB or mmCIF file from RCSB PDB as an immutable " +
        "repository-processed SourceAsset (verified HTTPS channel with checksum + " +
        "content cache). Returns local_files, source_asset, and the download attempt " +
        "record.",
      parameters: {
        type: "object",
        properties: {
          pdb_id: {
            type: "string",
            description: "PDB entry identifier (e.g. '1cbs').",
          },
          file_type: {
            type: "string",
            enum: ["pdb", "cif"],
            default: "pdb",
            description: "File format: 'pdb' (legacy PDB) or 'cif' (mmCIF). Default 'pdb'.",
          },
        },
        required: ["pdb_id"],
        additionalProperties: false,
      },
      execute: async (argumentsValue, signal) => {
        const record = argumentsValue as { pdb_id?: unknown; file_type?: unknown };
        if (typeof record.pdb_id !== "string") {
          return {
            content: JSON.stringify({ source: "pdb", pdb_id: "", error: "pdb_id must be a string" }),
            isError: true,
          };
        }
        const fileType = typeof record.file_type === "string" ? record.file_type : "pdb";
        const result = await downloadPdb(record.pdb_id, fileType, {
          taskRoot: deps.taskRoot,
          cache,
          client,
          signal,
          rateLimitMs: deps.rateLimitMs,
          onQuery: hooks.onQuery,
        });
        return { content: JSON.stringify(result) };
      },
    },
  ];
}
