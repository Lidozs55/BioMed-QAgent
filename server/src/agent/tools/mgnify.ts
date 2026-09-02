import type { BioMedAgentTool } from "../contracts.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import { PublicHttpClient as DefaultPublicHttpClient } from "../../external/network/http-client.js";
import { readBoundedJson } from "./response-limit.js";
import { errorResult } from "./result.js";

export const SEARCH_MGNIFY_STUDIES_TOOL_NAME = "search_mgnify_studies";
const MGNIFY_STUDIES_URL = "https://www.ebi.ac.uk/metagenomics/api/v1/studies";
const MAX_RESULTS = 50;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

interface MgnifyDeps {
  client?: PublicHttpClient;
  /** Host setting may tighten, but never loosen, the tool's intrinsic cap. */
  maxResponseBytes?: number;
}

export interface MgnifyStudySearchResult {
  source: "mgnify";
  query: string;
  total_count: number;
  records_count: number;
  source_url: string;
  records: Array<{
    study_accession: string;
    study_name: string | null;
    study_abstract: string | null;
    sample_count: number | null;
    bioproject_id: string | null;
    source_url: string;
    publications_url: string;
  }>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(record: Record<string, unknown> | null, key: string): string | null {
  return typeof record?.[key] === "string" ? record[key] : null;
}

function optionalNumber(record: Record<string, unknown> | null, key: string): number | null {
  return typeof record?.[key] === "number" ? record[key] : null;
}

export async function searchMgnifyStudies(
  query: string,
  maxResults = 20,
  deps: MgnifyDeps = {},
  signal?: AbortSignal,
): Promise<MgnifyStudySearchResult> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0 || normalizedQuery.length > 200) {
    throw new TypeError("query must contain between 1 and 200 characters");
  }
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    throw new TypeError(`max_results must be between 1 and ${MAX_RESULTS}`);
  }
  const source = new URL(MGNIFY_STUDIES_URL);
  source.searchParams.set("search", normalizedQuery);
  source.searchParams.set("page_size", String(maxResults));
  const sourceUrl = source.toString();
  const client = deps.client ?? new DefaultPublicHttpClient();
  const response = await client.request(sourceUrl, { headers: { Accept: "application/json" }, signal });
  if (response.status < 200 || response.status >= 300) {
    const status = response.status;
    await response.discard();
    throw Object.assign(new Error(`MGnify returned HTTP ${status}`), { statusCode: status });
  }
  const root = asRecord(await readBoundedJson(response.body, {
    source: "MGnify",
    intrinsicMaxBytes: MAX_RESPONSE_BYTES,
    configuredMaxBytes: deps.maxResponseBytes,
  }));
  const data = Array.isArray(root?.["data"]) ? root["data"] : null;
  if (data === null) throw new Error("MGnify returned an invalid JSON:API response");
  const meta = asRecord(root?.["meta"]);
  const pagination = asRecord(meta?.["pagination"]);
  const rawTotal = pagination?.["count"];
  const totalCount = typeof rawTotal === "number" ? rawTotal : data.length;
  const records = data.slice(0, maxResults).flatMap((value) => {
    const row = asRecord(value);
    const accession = typeof row?.["id"] === "string" ? row["id"] : null;
    if (accession === null) return [];
    const attributes = asRecord(row?.["attributes"]);
    return [{
      study_accession: accession,
      study_name: optionalString(attributes, "study-name"),
      study_abstract: optionalString(attributes, "study-abstract"),
      sample_count: optionalNumber(attributes, "samples-count"),
      bioproject_id: optionalString(attributes, "bioproject"),
      source_url: `${MGNIFY_STUDIES_URL}/${encodeURIComponent(accession)}`,
      publications_url: `${MGNIFY_STUDIES_URL}/${encodeURIComponent(accession)}/publications`,
    }];
  });
  return {
    source: "mgnify",
    query: normalizedQuery,
    total_count: totalCount,
    records_count: records.length,
    source_url: sourceUrl,
    records,
  };
}

export function createMgnifyTools(deps: MgnifyDeps = {}): BioMedAgentTool[] {
  return [{
    name: SEARCH_MGNIFY_STUDIES_TOOL_NAME,
    label: "Search MGnify studies",
    description:
      "Search the official MGnify JSON API for metagenomics studies. Returns accessions, " +
      "source-linked metadata, sample counts, BioProject IDs, publication links, and abstracts " +
      "without browser rendering.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Disease, phenotype, biome, or study keyword." },
        max_results: { type: "integer", minimum: 1, maximum: MAX_RESULTS, default: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      try {
        const record = argumentsValue as { query?: unknown; max_results?: unknown };
        if (typeof record.query !== "string") throw new TypeError("query must be a string");
        const maxResults = record.max_results === undefined ? 20 : record.max_results;
        if (typeof maxResults !== "number") throw new TypeError("max_results must be an integer");
        const payload = await searchMgnifyStudies(record.query, maxResults, deps, signal);
        return { content: JSON.stringify(payload) };
      } catch (error) {
        return errorResult(error);
      }
    },
  }];
}
