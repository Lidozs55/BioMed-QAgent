import type { BioMedAgentTool } from "../contracts.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import { PublicHttpClient as DefaultPublicHttpClient } from "../../external/network/http-client.js";
import { HostRateLimiter, parseRetryAfter } from "../../external/ncbi/retry.js";
import { errorResult } from "./result.js";

export const LOOKUP_OPENFDA_DILI_COUNTS_TOOL_NAME = "lookup_openfda_dili_counts";
const OPENFDA_EVENT_URL = "https://api.fda.gov/drug/event.json";
const MAX_DRUGS = 20;
const MAX_REACTION_TERMS = 20;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const PROCESS_OPENFDA_LIMITER = new HostRateLimiter({ minInterval: 0.25 });

interface OpenFdaDeps {
  client?: PublicHttpClient;
  limiter?: Pick<HostRateLimiter, "wait">;
  maxRetries?: number;
  sleep?: (delayMs: number) => Promise<void>;
  jitter?: () => number;
  now?: () => number;
}

type ResolvedOpenFdaDeps = Required<Pick<
  OpenFdaDeps,
  "client" | "limiter" | "maxRetries" | "sleep" | "jitter" | "now"
>>;

export interface OpenFdaDiliCountResult {
  source: "openfda_faers";
  requested_count: number;
  succeeded_count: number;
  failed_count: number;
  requested_reaction_terms: string[];
  records: Array<{
    drug_name: string;
    source_url: string;
    status: "succeeded";
    reaction_counts: Array<{
      reaction_term: string;
      count: number;
      retrieval_method: "aggregate" | "exact_fallback";
      source_url: string;
    }>;
    unmatched_reaction_terms: string[];
    matched_report_count_sum: number;
  }>;
  failures: Array<{
    drug_name: string;
    source_url: string;
    status: "failed";
    status_code: number | null;
    error: string;
  }>;
}

class OpenFdaHttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function readBoundedJson(body: AsyncIterable<Buffer>): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) throw new Error("openFDA response exceeds 4 MiB");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function normalizedValues(values: readonly string[], field: string, max: number): string[] {
  if (values.length === 0 || values.length > max) {
    throw new TypeError(`${field} must contain between 1 and at most ${max} values`);
  }
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => value.length === 0 || value.length > 128 || /["\\\r\n]/.test(value))) {
    throw new TypeError(`${field} contains an invalid value`);
  }
  return [...new Set(normalized)];
}

function buildSourceUrl(drugName: string): string {
  const url = new URL(OPENFDA_EVENT_URL);
  url.searchParams.set("search", `patient.drug.openfda.generic_name:"${drugName}"`);
  url.searchParams.set("count", "patient.reaction.reactionmeddrapt.exact");
  url.searchParams.set("limit", "999");
  return url.toString();
}

function buildExactReactionSourceUrl(drugName: string, reactionTerm: string): string {
  const url = new URL(OPENFDA_EVENT_URL);
  url.searchParams.set(
    "search",
    `patient.drug.openfda.generic_name:"${drugName}" AND ` +
      `patient.reaction.reactionmeddrapt.exact:"${reactionTerm}"`,
  );
  url.searchParams.set("limit", "1");
  return url.toString();
}

function isNoMatchesPayload(payload: unknown): boolean {
  const error = asRecord(asRecord(payload)?.["error"]);
  return typeof error?.["message"] === "string" && /no matches found/i.test(error["message"]);
}

async function requestOpenFdaJson(
  url: string,
  deps: ResolvedOpenFdaDeps,
  signal: AbortSignal | undefined,
  noMatchAsNull = false,
): Promise<unknown | null> {
  for (let attempt = 0; attempt <= deps.maxRetries; attempt++) {
    await deps.limiter.wait(url);
    const response = await deps.client.request(url, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (response.status >= 200 && response.status < 300) {
      return readBoundedJson(response.body);
    }
    if (response.status === 404 && noMatchAsNull) {
      const payload = await readBoundedJson(response.body);
      if (isNoMatchesPayload(payload)) return null;
      throw new OpenFdaHttpError(404, "openFDA returned HTTP 404 without a no-match response");
    }
    const retryable = response.status === 429 || response.status >= 500;
    const retryAfter = parseRetryAfter(
      response.headers["retry-after"] ?? response.headers["Retry-After"],
      deps.now(),
    );
    const status = response.status;
    await response.discard();
    if (retryable && attempt < deps.maxRetries) {
      await deps.sleep(
        Math.min(30, Math.max(0.5 * 2 ** attempt + deps.jitter(), retryAfter)) * 1000,
      );
      continue;
    }
    throw new OpenFdaHttpError(status, `openFDA returned HTTP ${status}`);
  }
  throw new Error("openFDA retry loop ended without a response");
}

async function fetchExactReactionCount(
  url: string,
  deps: ResolvedOpenFdaDeps,
  signal?: AbortSignal,
): Promise<number | null> {
  const payload = await requestOpenFdaJson(url, deps, signal, true);
  if (payload === null) return null;
  const meta = asRecord(asRecord(payload)?.["meta"]);
  const results = asRecord(meta?.["results"]);
  const total = results?.["total"];
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
    throw new Error("openFDA returned an invalid exact reaction count");
  }
  return total;
}

export async function lookupOpenFdaDiliCounts(
  drugNames: readonly string[],
  reactionTerms: readonly string[],
  deps: OpenFdaDeps = {},
  signal?: AbortSignal,
): Promise<OpenFdaDiliCountResult> {
  const drugs = normalizedValues(drugNames, "drug_names", MAX_DRUGS);
  const requestedTerms = normalizedValues(reactionTerms, "reaction_terms", MAX_REACTION_TERMS);
  const requestedByUpper = new Map(requestedTerms.map((term) => [term.toUpperCase(), term]));
  const resolved: ResolvedOpenFdaDeps = {
    client: deps.client ?? new DefaultPublicHttpClient(),
    limiter: deps.limiter ?? PROCESS_OPENFDA_LIMITER,
    maxRetries: deps.maxRetries ?? 2,
    sleep: deps.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs))),
    jitter: deps.jitter ?? Math.random,
    now: deps.now ?? Date.now,
  };
  const result: OpenFdaDiliCountResult = {
    source: "openfda_faers",
    requested_count: drugs.length,
    succeeded_count: 0,
    failed_count: 0,
    requested_reaction_terms: requestedTerms,
    records: [],
    failures: [],
  };

  for (const drugName of drugs) {
    const sourceUrl = buildSourceUrl(drugName);
    try {
      const payload = await requestOpenFdaJson(sourceUrl, resolved, signal);
      const root = asRecord(payload);
      const rows = Array.isArray(root?.["results"]) ? root["results"] : null;
      if (rows === null) throw new Error("openFDA returned an invalid count response");
      const reactionCounts: OpenFdaDiliCountResult["records"][number]["reaction_counts"] = [];
      for (const value of rows) {
        const row = asRecord(value);
        const term = typeof row?.["term"] === "string" ? row["term"] : null;
        const count = typeof row?.["count"] === "number" ? row["count"] : null;
        if (
          term === null || count === null || !Number.isSafeInteger(count) || count < 0 ||
          !requestedByUpper.has(term.toUpperCase())
        ) continue;
        reactionCounts.push({
          reaction_term: term,
          count,
          retrieval_method: "aggregate",
          source_url: sourceUrl,
        });
      }
      const matched = new Set(reactionCounts.map((row) => row.reaction_term.toUpperCase()));
      for (const reactionTerm of requestedTerms) {
        if (matched.has(reactionTerm.toUpperCase())) continue;
        const exactSourceUrl = buildExactReactionSourceUrl(drugName, reactionTerm);
        const count = await fetchExactReactionCount(exactSourceUrl, resolved, signal);
        if (count === null) continue;
        reactionCounts.push({
          reaction_term: reactionTerm,
          count,
          retrieval_method: "exact_fallback",
          source_url: exactSourceUrl,
        });
        matched.add(reactionTerm.toUpperCase());
      }
      result.records.push({
        drug_name: drugName,
        source_url: sourceUrl,
        status: "succeeded",
        reaction_counts: reactionCounts,
        unmatched_reaction_terms: requestedTerms.filter((term) => !matched.has(term.toUpperCase())),
        matched_report_count_sum: reactionCounts.reduce((sum, row) => sum + row.count, 0),
      });
    } catch (error) {
      if (signal?.aborted === true) throw error;
      result.failures.push({
        drug_name: drugName,
        source_url: sourceUrl,
        status: "failed",
        status_code: error instanceof OpenFdaHttpError ? error.statusCode : null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  result.succeeded_count = result.records.length;
  result.failed_count = result.failures.length;
  return result;
}

export function createOpenFdaTools(deps: OpenFdaDeps = {}): BioMedAgentTool[] {
  return [{
    name: LOOKUP_OPENFDA_DILI_COUNTS_TOOL_NAME,
    label: "Look up openFDA DILI reaction counts",
    description:
      "Query official openFDA FAERS drug-event aggregates for exact MedDRA reaction terms. " +
      "One aggregate request is made per drug; unavailable queries are reported without zero-filling.",
    parameters: {
      type: "object",
      properties: {
        drug_names: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_DRUGS },
        reaction_terms: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: MAX_REACTION_TERMS,
          description: "Exact MedDRA preferred terms to retain from the aggregate response.",
        },
      },
      required: ["drug_names", "reaction_terms"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      try {
        const record = argumentsValue as { drug_names?: unknown; reaction_terms?: unknown };
        if (!Array.isArray(record.drug_names) || !record.drug_names.every((value) => typeof value === "string")) {
          throw new TypeError("drug_names must be an array of strings");
        }
        if (!Array.isArray(record.reaction_terms) || !record.reaction_terms.every((value) => typeof value === "string")) {
          throw new TypeError("reaction_terms must be an array of strings");
        }
        const payload = await lookupOpenFdaDiliCounts(record.drug_names, record.reaction_terms, deps, signal);
        return { content: JSON.stringify(payload), isError: payload.succeeded_count === 0 };
      } catch (error) {
        return errorResult(error);
      }
    },
  }];
}
