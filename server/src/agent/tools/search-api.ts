/**
 * Shared factory for single-keyword REST search tools (deduplicated from the
 * near-identical ``chembl.ts`` / ``uniprot.ts`` tool clones; Python discovery
 * skill parity). The curated spec drives the name/label/description, the
 * source key, and the search implementation; the parameter schema, argument
 * validation and error envelope are shared.
 */
import type { BioMedAgentTool } from "../contracts.js";
import { noopHooks, type ToolServiceDeps } from "./tool-hooks.js";
import type { BrowserFallback } from "../../external/sources/fallback.js";
import { PublicHttpClient } from "../../external/network/http-client.js";
import type { SourceQueryContext } from "../../external/sources/context.js";

export interface SearchApiToolDeps extends ToolServiceDeps {
  /** Injectable rendered-browser fallback for the crawl tier (later checkpoint). */
  browserFallback?: BrowserFallback;
  /** Injectable HTTP client for fixture tests; defaults to the policy client. */
  client?: PublicHttpClient;
  /** Request pacing override for tests; default 2000ms. */
  rateLimitMs?: number;
}

export interface SearchApiSpec {
  /** Tool name (must be registered in SKILL_TOOL_MAP). */
  name: string;
  /** User-facing label. */
  label: string;
  /** Tool description (Python ``_DOC`` parity). */
  description: string;
  /** Source key echoed into error/audit results. */
  source: string;
  /** Query property hint (e.g. 'aspirin', 'EGFR inhibitor', 'kinase'). */
  queryHint: string;
  /** Result records hint (e.g. 'molecule', 'protein'). */
  recordHint: string;
  /** Backing search implementation (API → HTML → crawl three-tier chain). */
  search: (
    query: string,
    maxResults: number,
    context: SourceQueryContext,
  ) => Promise<Record<string, unknown>>;
}

export function createSearchApiTool(deps: SearchApiToolDeps, spec: SearchApiSpec): BioMedAgentTool {
  const client = deps.client ?? new PublicHttpClient();
  const hooks = noopHooks(deps.hooks);
  return {
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: `Search keyword (e.g. ${spec.queryHint}).`,
        },
        max_results: {
          type: "integer",
          default: 20,
          description: `Maximum number of ${spec.recordHint} records to return (default 20).`,
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
            source: spec.source,
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
      const result = await spec.search(record.query, maxResults, {
        client,
        browserFallback: deps.browserFallback,
        signal,
        rateLimitMs: deps.rateLimitMs,
        onQueryStarted: hooks.onQueryStarted,
        onQuery: hooks.onQuery,
      });
      return { content: JSON.stringify(result) };
    },
  };
}