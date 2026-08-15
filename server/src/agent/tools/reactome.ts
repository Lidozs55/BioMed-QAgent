/**
 * Reactome tools (Python ``skills/builtin/acquisition/reactome.py`` parity):
 * `search_reactome`, `get_pathway`, `download_reactome`. Registered under the
 * SKILL_TOOL_MAP names.
 */

import path from "node:path";

import type { BioMedAgentTool } from "../contracts.js";
import { noopHooks, type ToolServiceDeps } from "./tool-hooks.js";
import { ContentCache } from "../../external/acquisition/content-cache.js";
import { PublicHttpClient } from "../../external/network/http-client.js";
import type { BrowserFallback } from "../../external/sources/fallback.js";
import {
  downloadReactome,
  getPathway,
  searchReactome,
} from "../../external/sources/reactome.js";

export interface ReactomeToolDeps extends ToolServiceDeps {
  /** Injectable rendered-browser fallback for the crawl tier (later checkpoint). */
  browserFallback?: BrowserFallback;
  /** Injectable HTTP client for fixture tests; defaults to the policy client. */
  client?: PublicHttpClient;
  /** Request pacing override for tests; default 2000ms. */
  rateLimitMs?: number;
}

export const SEARCH_REACTOME_TOOL_NAME = "search_reactome";
export const GET_PATHWAY_TOOL_NAME = "get_pathway";
export const DOWNLOAD_REACTOME_TOOL_NAME = "download_reactome";

export function createReactomeTools(deps: ReactomeToolDeps): BioMedAgentTool[] {
  const client = deps.client ?? new PublicHttpClient();
  const hooks = noopHooks(deps.hooks);
  const cache = new ContentCache(path.join(deps.taskRoot, "cache", "reactome"));

  return [
    {
      name: SEARCH_REACTOME_TOOL_NAME,
      label: "Search Reactome",
      description:
        "Search Reactome for biological pathways matching a keyword. Queries the " +
        "Reactome ContentService REST API first; falls back to rendered page text when " +
        "the API is unavailable or cannot be parsed. Returns JSON with source, count, " +
        "and pathway records (pathway_id, name, species, summary, type, url). Use " +
        "``get_pathway`` to fetch detailed molecule lists for a specific pathway_id.",
      parameters: {
        type: "object",
        properties: {
          term: {
            type: "string",
            description: "Search keyword (e.g. 'BRCA', 'apoptosis', 'cell cycle').",
          },
          max_results: {
            type: "integer",
            default: 20,
            description: "Maximum number of pathways to return (default 20).",
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
              source: "reactome",
              term: "",
              status: "error",
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
        const result = await searchReactome(record.term, maxResults, {
          client,
          browserFallback: deps.browserFallback,
          signal,
          rateLimitMs: deps.rateLimitMs,
          onQueryStarted: hooks.onQueryStarted,
          onQuery: hooks.onQuery,
        });
        return { content: JSON.stringify(result) };
      },
    },
    {
      name: GET_PATHWAY_TOOL_NAME,
      label: "Get Reactome pathway",
      description:
        "Get detailed information about a specific Reactome pathway. Queries the " +
        "Reactome ContentService REST API for pathway details, including name, species, " +
        "diagram availability, summation text, and release date.",
      parameters: {
        type: "object",
        properties: {
          pathway_id: {
            type: "string",
            description: "Reactome stable ID (e.g. 'R-HSA-169893').",
          },
        },
        required: ["pathway_id"],
        additionalProperties: false,
      },
      execute: async (argumentsValue, signal) => {
        const record = argumentsValue as { pathway_id?: unknown };
        if (typeof record.pathway_id !== "string") {
          return {
            content: JSON.stringify({
              source: "reactome",
              pathway_id: "",
              status: "error",
              error: "pathway_id must be a string",
            }),
            isError: true,
          };
        }
        const result = await getPathway(record.pathway_id, {
          client,
          browserFallback: deps.browserFallback,
          signal,
          rateLimitMs: deps.rateLimitMs,
          onQueryStarted: hooks.onQueryStarted,
          onQuery: hooks.onQuery,
        });
        return { content: JSON.stringify(result) };
      },
    },
    {
      name: DOWNLOAD_REACTOME_TOOL_NAME,
      label: "Download Reactome pathway",
      description:
        "Download a Reactome pathway file (participants TSV or SBGN diagram). Uses " +
        "the Reactome ContentService exporter endpoints, published as an immutable " +
        "repository-processed SourceAsset. Returns JSON with source, pathway_id, " +
        "source_url, local_files, format_hint, and retrieved_at.",
      parameters: {
        type: "object",
        properties: {
          pathway_id: {
            type: "string",
            description: "Reactome stable ID (e.g. 'R-HSA-169893').",
          },
          file_type: {
            type: "string",
            enum: ["tsv", "sbgn"],
            default: "tsv",
            description: "File format: 'tsv' (participants, default) or 'sbgn' (diagram).",
          },
        },
        required: ["pathway_id"],
        additionalProperties: false,
      },
      execute: async (argumentsValue, signal) => {
        const record = argumentsValue as { pathway_id?: unknown; file_type?: unknown };
        if (typeof record.pathway_id !== "string") {
          return {
            content: JSON.stringify({
              source: "reactome",
              pathway_id: "",
              error: "pathway_id must be a string",
            }),
            isError: true,
          };
        }
        const fileType = typeof record.file_type === "string" ? record.file_type : "tsv";
        const result = await downloadReactome(record.pathway_id, fileType, {
          taskRoot: deps.taskRoot,
          cache,
          client,
          signal,
          rateLimitMs: deps.rateLimitMs,
        });
        return { content: JSON.stringify(result) };
      },
    },
  ];
}
