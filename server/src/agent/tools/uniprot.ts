/**
 * `search_uniprot` tool (Python ``skills/builtin/discovery/uniprot.py``
 * parity). Registered under the SKILL_TOOL_MAP name "search_uniprot".
 * Thin spec over the shared ``createSearchApiTool`` factory.
 */

import type { BioMedAgentTool } from "../contracts.js";
import type { ToolServiceDeps } from "./tool-hooks.js";
import type { BrowserFallback } from "../../external/sources/fallback.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import { searchUniprot } from "../../external/sources/uniprot.js";
import { createSearchApiTool } from "./search-api.js";

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
  return [
    createSearchApiTool(deps, {
      name: SEARCH_UNIPROT_TOOL_NAME,
      label: "Search UniProt",
      description:
        "Search the UniProt knowledgebase for proteins matching a keyword. Queries " +
        "the UniProt REST API first; falls back to the rendered search page when the " +
        "API is unavailable or returns an unexpected shape. Returns JSON with source, " +
        "query, count, records (accession, protein_name, gene, organism, reviewed, " +
        "url), method_used, and attempts. UniProt is an Agent-only research source: " +
        "findings must never be routed into dataset builds.",
      source: "uniprot",
      queryHint: "'TP53', 'BRCA1', 'kinase inhibitor'",
      recordHint: "protein",
      search: searchUniprot,
    }),
  ];
}