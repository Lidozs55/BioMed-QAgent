/**
 * Shared query context for discovery sources (deduplicated from the five
 * per-source copies in ``chembl.ts`` / ``uniprot.ts`` / ``pdb.ts`` /
 * ``pubchem.ts`` / ``reactome.ts``).
 */
import type { QueryStatus } from "../../agent/tools/tool-hooks.js";
import type { PublicHttpClient } from "../network/http-client.js";
import type { BrowserFallback } from "./fallback.js";

export interface SourceQueryContext {
  client: PublicHttpClient;
  browserFallback?: BrowserFallback;
  signal?: AbortSignal;
  /** Request pacing override for tests; default 2000ms. */
  rateLimitMs?: number;
  onQueryStarted?: (query: string, source: string) => void;
  onQuery?: (query: string, source: string, status: QueryStatus, recordsCount?: number) => void;
}