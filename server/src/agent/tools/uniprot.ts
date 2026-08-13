/**
 * `search_uniprot` tool (Python ``skills/builtin/discovery/uniprot.py``
 * parity). Registered under the SKILL_TOOL_MAP name "search_uniprot".
 */

import type { BioMedAgentTool } from "../contracts.js";
import { noopHooks, type ToolServiceDeps } from "./tool-hooks.js";
import type { BrowserFallback } from "../../external/sources/fallback.js";
import { searchUniprot } from "../../external/sources/uniprot.js";
import { PublicHttpClient } from "../../external/network/http-client.js";

export interface UniprotToolDeps extends ToolServiceDeps {
  /** Injectable rendered-browser fallback for the crawl tier (later checkpoint). */
  browserFallback?: BrowserFallback;
  /** Injectable HTTP client for fixture tests; defaults to the policy client. */
  client?: PublicHttpClient;
  /** Request pacing override for tests; default 2000ms. */
  rateLimitMs?: number;
}

export const SEARCH_UNIPROT_TOOL_NAME = "search_uniprot";

export function createUniprotTools(deps: UniprotToolDeps): BioMedAgentTool[] {
  const client = deps.client ?? new PublicHttpClient();
  const hooks = noopHooks(deps.hooks);
  return [
    {
      name: SEARCH_UNIPROT_TOOL_NAME,
      label: "Search UniProt",
      description:
        "Search the UniProt knowledgebase for proteins matching a keyword. Queries " +
        "the UniProt REST API first; falls back to the rendered search page when the " +
        "API is unavailable or returns an unexpected shape. Returns JSON with source, " +
        "query, count, records (accession, protein_name, gene, organism, reviewed, " +
        "url), method_used, and attempts. UniProt is an Agent-only research source: " +
        "findings must never be routed into dataset builds.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keyword (e.g. 'TP53', 'BRCA1', 'kinase inhibitor').",
          },
          max_results: {
            type: "integer",
            default: 20,
            description: "Maximum number of protein records to return (default 20).",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (argumentsValue, signal) => {
        const record = argumentsValue as { query?: unknown; max_results?: unknown };
        if (typeof record.query !== "string") {
          return {
            content: JSON.stringify({
              source: "uniprot",
              query: "",
              status: "error",
              error: "query must be a string",
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
        const result = await searchUniprot(record.query, maxResults, {
          client,
          browserFallback: deps.browserFallback,
          signal,
          rateLimitMs: deps.rateLimitMs,
          onQuery: hooks.onQuery,
        });
        return { content: JSON.stringify(result) };
      },
    },
  ];
}
