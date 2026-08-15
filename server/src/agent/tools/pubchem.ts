/**
 * PubChem tools (Python ``skills/builtin/acquisition/pubchem.py`` parity):
 * `search_pubchem`, `get_compound`, `download_pubchem`. Registered under the
 * SKILL_TOOL_MAP names.
 */

import path from "node:path";

import type { BioMedAgentTool } from "../contracts.js";
import { noopHooks, type ToolServiceDeps } from "./tool-hooks.js";
import { ContentCache } from "../../external/acquisition/content-cache.js";
import { PublicHttpClient } from "../../external/network/http-client.js";
import type { BrowserFallback } from "../../external/sources/fallback.js";
import {
  downloadPubchem,
  getCompound,
  searchPubchem,
} from "../../external/sources/pubchem.js";

export interface PubchemToolDeps extends ToolServiceDeps {
  /** Injectable rendered-browser fallback for the crawl tier (later checkpoint). */
  browserFallback?: BrowserFallback;
  /** Injectable HTTP client for fixture tests; defaults to the policy client. */
  client?: PublicHttpClient;
  /** Request pacing override for tests; default 2000ms. */
  rateLimitMs?: number;
}

export const SEARCH_PUBCHEM_TOOL_NAME = "search_pubchem";
export const GET_COMPOUND_TOOL_NAME = "get_compound";
export const DOWNLOAD_PUBCHEM_TOOL_NAME = "download_pubchem";

export function createPubchemTools(deps: PubchemToolDeps): BioMedAgentTool[] {
  const client = deps.client ?? new PublicHttpClient();
  const hooks = noopHooks(deps.hooks);
  const cache = new ContentCache(path.join(deps.taskRoot, "cache", "pubchem"));

  return [
    {
      name: SEARCH_PUBCHEM_TOOL_NAME,
      label: "Search PubChem",
      description:
        "Search PubChem for chemical compounds matching a name or keyword. Queries " +
        "the PUG-REST API first; if the API is unavailable or cannot be parsed, falls " +
        "back to rendered page text. Returns JSON with compound records (CID, name, " +
        "formula, MW, etc.). Use ``get_compound`` to get full details for a specific " +
        "CID.",
      parameters: {
        type: "object",
        properties: {
          term: {
            type: "string",
            description: "Compound name or keyword (e.g. 'aspirin', 'curcumin').",
          },
          max_results: {
            type: "integer",
            description: "Maximum number of compounds to return (default 20).",
          },
          strict_mode: {
            type: "boolean",
            default: false,
            description:
              "Python SDK schema-registration option with no runtime effect on the " +
              "request path (kept for contract parity).",
          },
        },
        required: ["term"],
        additionalProperties: false,
      },
      execute: async (argumentsValue, signal) => {
        const record = argumentsValue as {
          term?: unknown;
          max_results?: unknown;
          strict_mode?: unknown;
        };
        if (typeof record.term !== "string") {
          return {
            content: JSON.stringify({
              source: "pubchem",
              term: "",
              status: "error",
              error: "term must be a string",
            }),
            isError: true,
          };
        }
        // Python parity: max_results or 20 — strict_mode is a registration
        // option in Python and does not change the requested API path.
        const maxResults =
          typeof record.max_results === "number" &&
          Number.isInteger(record.max_results) &&
          record.max_results > 0
            ? record.max_results
            : 20;
        const result = await searchPubchem(record.term, maxResults, {
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
      name: GET_COMPOUND_TOOL_NAME,
      label: "Get PubChem compound",
      description:
        "Get detailed information about a specific PubChem compound by CID. Queries " +
        "the PUG-REST API for compound properties including molecular formula, weight, " +
        "IUPAC name, SMILES, and InChI key.",
      parameters: {
        type: "object",
        properties: {
          cid: {
            type: "integer",
            description: "PubChem Compound ID (e.g. 2244 for aspirin).",
          },
        },
        required: ["cid"],
        additionalProperties: false,
      },
      execute: async (argumentsValue, signal) => {
        const record = argumentsValue as { cid?: unknown };
        if (typeof record.cid !== "number" || !Number.isInteger(record.cid) || record.cid <= 0) {
          return {
            content: JSON.stringify({
              source: "pubchem",
              cid: typeof record.cid === "number" ? record.cid : 0,
              status: "error",
              error: "cid must be a positive integer",
            }),
            isError: true,
          };
        }
        const result = await getCompound(record.cid, {
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
      name: DOWNLOAD_PUBCHEM_TOOL_NAME,
      label: "Download PubChem compound",
      description:
        "Download a PubChem compound structure file (SDF or MOL). Uses the PUG-REST " +
        "record endpoint to fetch the full structure record in SDF (2D) or MOL (2D) " +
        "format, published as an immutable repository-processed SourceAsset. Returns " +
        "JSON with source, cid, source_url, local_files, format_hint, and retrieved_at.",
      parameters: {
        type: "object",
        properties: {
          cid: {
            type: "integer",
            description: "PubChem Compound ID (e.g. 2244 for aspirin).",
          },
          file_type: {
            type: "string",
            enum: ["sdf", "mol"],
            default: "sdf",
            description: "Structure file format: 'sdf' (default) or 'mol'.",
          },
        },
        required: ["cid"],
        additionalProperties: false,
      },
      execute: async (argumentsValue, signal) => {
        const record = argumentsValue as { cid?: unknown; file_type?: unknown };
        if (typeof record.cid !== "number" || !Number.isInteger(record.cid) || record.cid <= 0) {
          return {
            content: JSON.stringify({
              source: "pubchem",
              cid: typeof record.cid === "number" ? record.cid : 0,
              error: "cid must be a positive integer",
            }),
            isError: true,
          };
        }
        const fileType = typeof record.file_type === "string" ? record.file_type : "sdf";
        const result = await downloadPubchem(record.cid, fileType, {
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
