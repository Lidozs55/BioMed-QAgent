/**
 * `search_chembl` tool (Python ``skills/builtin/discovery/chembl.py``
 * parity). Registered under the SKILL_TOOL_MAP name "search_chembl".
 * Thin spec over the shared ``createSearchApiTool`` factory.
 */

import type { BioMedAgentTool } from "../contracts.js";
import type { ToolServiceDeps } from "./tool-hooks.js";
import type { BrowserFallback } from "../../external/sources/fallback.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import { searchChembl } from "../../external/sources/chembl.js";
import { createSearchApiTool } from "./search-api.js";

export interface ChemblToolDeps extends ToolServiceDeps {
  /** Injectable rendered-browser fallback for the crawl tier (later checkpoint). */
  browserFallback?: BrowserFallback;
  /** Injectable HTTP client for fixture tests; defaults to the policy client. */
  client?: PublicHttpClient;
  /** Request pacing override for tests; default 2000ms. */
  rateLimitMs?: number;
}

export const SEARCH_CHEMBL_TOOL_NAME = "search_chembl";

export function createChemblTools(deps: ChemblToolDeps): BioMedAgentTool[] {
  return [
    createSearchApiTool(deps, {
      name: SEARCH_CHEMBL_TOOL_NAME,
      label: "Search ChEMBL",
      description:
        "Search ChEMBL for molecules matching a keyword. Queries the ChEMBL REST API " +
        "first; falls back to the rendered search page when the API is unavailable or " +
        "returns an unexpected shape. Returns JSON with source, query, count, records " +
        "(chembl_id, preferred_name, molecule_type, max_phase, url), method_used, and " +
        "attempts. ChEMBL is an Agent-only research source: findings must never be " +
        "routed into dataset builds.",
      source: "chembl",
      queryHint: "'aspirin', 'EGFR inhibitor', 'kinase'",
      recordHint: "molecule",
      search: searchChembl,
    }),
  ];
}