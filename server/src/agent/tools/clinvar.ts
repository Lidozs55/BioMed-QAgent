import type { BioMedAgentTool } from "../contracts.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import { PublicHttpClient as DefaultPublicHttpClient } from "../../external/network/http-client.js";
import { ToolHttpError } from "../../external/network/errors.js";
import { HostRateLimiter, parseRetryAfter } from "../../external/ncbi/retry.js";
import { readBoundedJson } from "./response-limit.js";
import { errorResult } from "./result.js";

export const LOOKUP_CLINVAR_COUNTS_TOOL_NAME = "lookup_clinvar_counts";
const CLINVAR_ESEARCH_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const MAX_GENE_SYMBOLS = 20;
const MAX_RESPONSE_BYTES = 1024 * 1024;
// HGNC current symbols legitimately contain '_' (e.g. GTF2H2C_2) and the '@'
// cluster suffix on snoRNA/scaRNA genes (e.g. SNORD116@); rejecting them here
// would fail-close real symbols the Y1-relaxed providers accept. Keep in sync
// with families/inherited-disease-evidence and acquisition/gold9-providers.
const GENE_SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,31}$/;
const PROCESS_CLINVAR_LIMITER = new HostRateLimiter({ minInterval: 1 / 3 });

interface ClinvarDeps {
  client?: PublicHttpClient;
  limiter?: Pick<HostRateLimiter, "wait">;
  /** Host setting may tighten, but never loosen, the tool's intrinsic cap. */
  maxResponseBytes?: number;
  maxRetries?: number;
  sleep?: (delayMs: number) => Promise<void>;
  jitter?: () => number;
  now?: () => number;
}

export interface ClinvarCountResult {
  source: "clinvar";
  requested_count: number;
  succeeded_count: number;
  failed_count: number;
  records: Array<{
    gene_symbol: string;
    total_variant_count: number;
    pathogenic_or_likely_pathogenic_count: number;
    total_query_url: string;
    pathogenic_query_url: string;
    status: "succeeded";
  }>;
  failures: Array<{
    gene_symbol: string;
    status: "failed";
    status_code: number | null;
    error: string;
  }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function queryUrl(term: string): string {
  const url = new URL(CLINVAR_ESEARCH_URL);
  url.searchParams.set("db", "clinvar");
  url.searchParams.set("retmode", "json");
  url.searchParams.set("retmax", "0");
  url.searchParams.set("term", term);
  return url.toString();
}

async function fetchCount(
  url: string,
  deps: Required<Pick<ClinvarDeps, "client" | "limiter" | "maxResponseBytes" | "maxRetries" | "sleep" | "jitter" | "now">>,
  signal?: AbortSignal,
): Promise<number> {
  for (let attempt = 0; attempt <= deps.maxRetries; attempt++) {
    await deps.limiter.wait(url);
    const response = await deps.client.request(url, { headers: { Accept: "application/json" }, signal });
    if (response.status >= 200 && response.status < 300) {
      const root = asRecord(await readBoundedJson(response.body, {
        source: "ClinVar",
        intrinsicMaxBytes: MAX_RESPONSE_BYTES,
        configuredMaxBytes: deps.maxResponseBytes,
      }));
      const esearch = asRecord(root?.["esearchresult"]);
      const rawCount = esearch?.["count"];
      if (typeof rawCount !== "string" || !/^\d+$/.test(rawCount)) {
        throw new Error("ClinVar returned an invalid esearch count");
      }
      return Number(rawCount);
    }
    const retryable = response.status === 429 || response.status >= 500;
    const retryAfter = parseRetryAfter(
      response.headers["retry-after"] ?? response.headers["Retry-After"],
      deps.now(),
    );
    const status = response.status;
    await response.discard();
    if (retryable && attempt < deps.maxRetries) {
      await deps.sleep(Math.min(30, Math.max(0.5 * 2 ** attempt + deps.jitter(), retryAfter)) * 1000);
      continue;
    }
    throw new ToolHttpError(url, status);
  }
  throw new Error("ClinVar retry loop ended without a response");
}

export async function lookupClinvarCounts(
  geneSymbols: readonly string[],
  deps: ClinvarDeps = {},
  signal?: AbortSignal,
): Promise<ClinvarCountResult> {
  if (geneSymbols.length === 0 || geneSymbols.length > MAX_GENE_SYMBOLS) {
    throw new TypeError(`gene_symbols must contain between 1 and at most ${MAX_GENE_SYMBOLS} symbols`);
  }
  const symbols = [...new Set(geneSymbols.map((value) => {
    const symbol = value.trim().toUpperCase();
    if (!GENE_SYMBOL.test(symbol)) throw new TypeError(`invalid gene symbol: ${value}`);
    return symbol;
  }))];
  const resolved = {
    client: deps.client ?? new DefaultPublicHttpClient(),
    limiter: deps.limiter ?? PROCESS_CLINVAR_LIMITER,
    maxResponseBytes: deps.maxResponseBytes ?? MAX_RESPONSE_BYTES,
    maxRetries: deps.maxRetries ?? 3,
    sleep: deps.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs))),
    jitter: deps.jitter ?? Math.random,
    now: deps.now ?? Date.now,
  };
  const result: ClinvarCountResult = {
    source: "clinvar",
    requested_count: symbols.length,
    succeeded_count: 0,
    failed_count: 0,
    records: [],
    failures: [],
  };

  for (const symbol of symbols) {
    const totalUrl = queryUrl(`${symbol}[SYM]`);
    const pathogenicUrl = queryUrl(`${symbol}[SYM] AND (pathogenic[CLNSIG] OR likely_pathogenic[CLNSIG])`);
    try {
      const total = await fetchCount(totalUrl, resolved, signal);
      const pathogenic = await fetchCount(pathogenicUrl, resolved, signal);
      result.records.push({
        gene_symbol: symbol,
        total_variant_count: total,
        pathogenic_or_likely_pathogenic_count: pathogenic,
        total_query_url: totalUrl,
        pathogenic_query_url: pathogenicUrl,
        status: "succeeded",
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      result.failures.push({
        gene_symbol: symbol,
        status: "failed",
        status_code: error instanceof ToolHttpError ? error.statusCode : null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  result.succeeded_count = result.records.length;
  result.failed_count = result.failures.length;
  return result;
}

export function createClinvarTools(deps: ClinvarDeps = {}): BioMedAgentTool[] {
  return [{
    name: LOOKUP_CLINVAR_COUNTS_TOOL_NAME,
    label: "Look up ClinVar gene counts",
    description:
      "Query official NCBI ClinVar E-utilities for total and pathogenic/likely-pathogenic variant counts " +
      "for one to 20 HGNC-style gene symbols. Partial query failures produce no record.",
    parameters: {
      type: "object",
      properties: {
        gene_symbols: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_GENE_SYMBOLS,
        },
      },
      required: ["gene_symbols"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      try {
        const record = argumentsValue as { gene_symbols?: unknown };
        if (!Array.isArray(record.gene_symbols) || !record.gene_symbols.every((value) => typeof value === "string")) {
          throw new TypeError("gene_symbols must be an array of strings");
        }
        const payload = await lookupClinvarCounts(record.gene_symbols, deps, signal);
        return { content: JSON.stringify(payload), isError: payload.succeeded_count === 0 };
      } catch (error) {
        return errorResult(error);
      }
    },
  }];
}
