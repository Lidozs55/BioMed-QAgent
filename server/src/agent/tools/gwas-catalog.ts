import type { BioMedAgentTool } from "../contracts.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import { PublicHttpClient as DefaultPublicHttpClient } from "../../external/network/http-client.js";
import { HostRateLimiter, parseRetryAfter } from "../../external/ncbi/retry.js";
import { readBoundedJson } from "./response-limit.js";
import { errorResult } from "./result.js";

export const LOOKUP_GWAS_CATALOG_TOOL_NAME = "lookup_gwas_catalog";
const GWAS_API_ROOT = "https://www.ebi.ac.uk/gwas/rest/api";
const MAX_RESULTS = 100;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const PROCESS_GWAS_LIMITER = new HostRateLimiter({ minInterval: 0.2 });

export type GwasCatalogQueryType = "pubmed_id" | "study_accession" | "rs_id";

interface GwasCatalogDeps {
  client?: PublicHttpClient;
  limiter?: Pick<HostRateLimiter, "wait">;
  /** Host setting may tighten, but never loosen, the tool's intrinsic cap. */
  maxResponseBytes?: number;
  maxRetries?: number;
  sleep?: (delayMs: number) => Promise<void>;
  jitter?: () => number;
  now?: () => number;
}

interface GwasCatalogStudyRecord {
  study_accession: string;
  pubmed_id: string | null;
  title: string | null;
  trait: string | null;
  initial_sample_size: string | null;
  replication_sample_size: string | null;
  source_url: string;
}

interface GwasCatalogAssociationRecord {
  association_id: string | null;
  study_accession: string | null;
  p_value: number | null;
  p_value_relation: "=" | null;
  p_value_mantissa: number | null;
  p_value_exponent: number | null;
  beta: number | null;
  beta_unit: string | null;
  beta_direction: string | null;
  odds_ratio: number | null;
  standard_error: number | null;
  confidence_interval: string | null;
  risk_frequency: string | null;
  strongest_risk_alleles: string[];
  reported_genes: string[];
  mapped_genes: string[];
  source_url: string | null;
  study_url: string | null;
}

export interface GwasCatalogLookupResult {
  source: "gwas_catalog";
  query_type: GwasCatalogQueryType;
  query: string;
  result_type: "studies" | "associations";
  total_count: number | null;
  records_count: number;
  source_url: string;
  records: Array<GwasCatalogStudyRecord | GwasCatalogAssociationRecord>;
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
  return typeof record?.[key] === "number" && Number.isFinite(record[key]) ? record[key] : null;
}

function link(record: Record<string, unknown> | null, relation: string): string | null {
  return optionalString(asRecord(asRecord(record?.["_links"])?.[relation]), "href");
}

function lastPathSegment(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? null;
  } catch {
    return null;
  }
}

function uniqueStrings(values: unknown[], key: string): string[] {
  const found = values.flatMap((value) => {
    const item = asRecord(value);
    const text = optionalString(item, key)?.trim();
    return text === undefined || text === null || text === "" ? [] : [text];
  });
  return [...new Set(found)];
}

function normalizeQuery(queryType: GwasCatalogQueryType, query: string): string {
  const trimmed = query.trim();
  if (queryType === "pubmed_id") {
    if (!/^[1-9][0-9]*$/.test(trimmed)) throw new TypeError("PubMed ID must be a positive numeric identifier");
    return trimmed;
  }
  if (queryType === "study_accession") {
    const normalized = trimmed.toUpperCase();
    if (!/^GCST[0-9]+$/.test(normalized)) throw new TypeError("GWAS Catalog study accession must match GCST followed by digits");
    return normalized;
  }
  const normalized = trimmed.toLowerCase();
  if (!/^rs[1-9][0-9]*$/.test(normalized)) throw new TypeError("rsID must be rs-prefixed and contain a positive numeric identifier");
  return normalized;
}

function requestUrl(queryType: GwasCatalogQueryType, query: string, maxResults: number): string {
  const url = queryType === "pubmed_id"
    ? new URL(`${GWAS_API_ROOT}/studies/search/findByPublicationIdPubmedId`)
    : new URL(queryType === "study_accession"
      ? `${GWAS_API_ROOT}/studies/${encodeURIComponent(query)}/associations`
      : `${GWAS_API_ROOT}/singleNucleotidePolymorphisms/${encodeURIComponent(query)}/associations`);
  if (queryType === "pubmed_id") url.searchParams.set("pubmedId", query);
  url.searchParams.set("size", String(maxResults));
  return url.toString();
}

async function fetchJson(
  sourceUrl: string,
  deps: GwasCatalogDeps,
  signal?: AbortSignal,
): Promise<unknown> {
  const client = deps.client ?? new DefaultPublicHttpClient();
  const limiter = deps.limiter ?? PROCESS_GWAS_LIMITER;
  const maxRetries = deps.maxRetries ?? 3;
  const sleep = deps.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const jitter = deps.jitter ?? Math.random;
  const now = deps.now ?? Date.now;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await limiter.wait(sourceUrl);
    const response = await client.request(sourceUrl, {
      headers: { Accept: "application/hal+json,application/json;q=0.9" },
      signal,
    });
    if (response.status >= 200 && response.status < 300) {
      return readBoundedJson(response.body, {
        source: "GWAS Catalog",
        intrinsicMaxBytes: MAX_RESPONSE_BYTES,
        configuredMaxBytes: deps.maxResponseBytes,
      });
    }
    const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
    const retryAfter = parseRetryAfter(
      response.headers["retry-after"] ?? response.headers["Retry-After"],
      now(),
    );
    const status = response.status;
    await response.discard();
    if (retryable && attempt < maxRetries) {
      const backoffSeconds = Math.min(30, Math.max(0.5 * 2 ** attempt + jitter(), retryAfter));
      await sleep(backoffSeconds * 1000);
      continue;
    }
    throw Object.assign(new Error(`GWAS Catalog returned HTTP ${status}`), { statusCode: status });
  }
  throw new Error("GWAS Catalog retry loop ended without an outcome");
}

function parseStudies(root: Record<string, unknown>, maxResults: number): GwasCatalogStudyRecord[] {
  const studies = asRecord(root["_embedded"])?.["studies"];
  if (!Array.isArray(studies)) throw new Error("GWAS Catalog returned an invalid studies response");
  return studies.slice(0, maxResults).flatMap((value) => {
    const study = asRecord(value);
    const accession = optionalString(study, "accessionId");
    if (accession === null) return [];
    const publication = asRecord(study?.["publicationInfo"]);
    return [{
      study_accession: accession,
      pubmed_id: optionalString(publication, "pubmedId"),
      title: optionalString(publication, "title"),
      trait: optionalString(asRecord(study?.["diseaseTrait"]), "trait"),
      initial_sample_size: optionalString(study, "initialSampleSize"),
      replication_sample_size: optionalString(study, "replicationSampleSize"),
      source_url: link(study, "self") ?? `${GWAS_API_ROOT}/studies/${encodeURIComponent(accession)}`,
    }];
  });
}

function parseAssociations(
  root: Record<string, unknown>,
  maxResults: number,
  knownStudyAccession: string | null,
): GwasCatalogAssociationRecord[] {
  const associations = asRecord(root["_embedded"])?.["associations"];
  if (!Array.isArray(associations)) throw new Error("GWAS Catalog returned an invalid associations response");
  return associations.slice(0, maxResults).flatMap((value) => {
    const association = asRecord(value);
    if (association === null) return [];
    const embeddedLoci = asRecord(association["_embedded"])?.["loci"];
    const loci = Array.isArray(association["loci"]) ? association["loci"] : embeddedLoci;
    const locusRecords = Array.isArray(loci) ? loci.map(asRecord).filter((item) => item !== null) : [];
    const strongestRiskAlleles = locusRecords.flatMap((locus) =>
      Array.isArray(locus["strongestRiskAlleles"])
        ? uniqueStrings(locus["strongestRiskAlleles"], "riskAlleleName")
        : []);
    const reportedGenes = locusRecords.flatMap((locus) =>
      Array.isArray(locus["authorReportedGenes"])
        ? uniqueStrings(locus["authorReportedGenes"], "geneName")
        : []);
    const mappedGenes = locusRecords.flatMap((locus) =>
      Array.isArray(locus["mappedGenes"])
        ? uniqueStrings(locus["mappedGenes"], "geneName")
        : []);
    const sourceUrl = link(association, "self");
    const studyUrl = link(association, "study");
    const pValue = optionalNumber(association, "pvalue");
    return [{
      association_id: lastPathSegment(sourceUrl),
      study_accession: knownStudyAccession ?? (/\/studies\/(GCST[0-9]+)/.exec(studyUrl ?? "")?.[1] ?? null),
      p_value: pValue,
      p_value_relation: pValue === null ? null : "=",
      p_value_mantissa: optionalNumber(association, "pvalueMantissa"),
      p_value_exponent: optionalNumber(association, "pvalueExponent"),
      beta: optionalNumber(association, "betaNum"),
      beta_unit: optionalString(association, "betaUnit"),
      beta_direction: optionalString(association, "betaDirection"),
      odds_ratio: optionalNumber(association, "orPerCopyNum"),
      standard_error: optionalNumber(association, "standardError"),
      confidence_interval: optionalString(association, "range"),
      risk_frequency: optionalString(association, "riskFrequency"),
      strongest_risk_alleles: [...new Set(strongestRiskAlleles)],
      reported_genes: [...new Set(reportedGenes)],
      mapped_genes: [...new Set(mappedGenes)],
      source_url: sourceUrl,
      study_url: studyUrl,
    }];
  });
}

export async function lookupGwasCatalog(
  queryType: GwasCatalogQueryType,
  query: string,
  maxResults = 20,
  deps: GwasCatalogDeps = {},
  signal?: AbortSignal,
): Promise<GwasCatalogLookupResult> {
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > MAX_RESULTS) {
    throw new TypeError(`max_results must be between 1 and ${MAX_RESULTS}`);
  }
  const normalizedQuery = normalizeQuery(queryType, query);
  const sourceUrl = requestUrl(queryType, normalizedQuery, maxResults);
  const root = asRecord(await fetchJson(sourceUrl, deps, signal));
  if (root === null) throw new Error("GWAS Catalog returned an invalid HAL response");
  const records = queryType === "pubmed_id"
    ? parseStudies(root, maxResults)
    : parseAssociations(root, maxResults, queryType === "study_accession" ? normalizedQuery : null);
  const total = asRecord(root["page"])?.["totalElements"];
  return {
    source: "gwas_catalog",
    query_type: queryType,
    query: normalizedQuery,
    result_type: queryType === "pubmed_id" ? "studies" : "associations",
    total_count: typeof total === "number" ? total : null,
    records_count: records.length,
    source_url: sourceUrl,
    records,
  };
}

export function createGwasCatalogTools(deps: GwasCatalogDeps = {}): BioMedAgentTool[] {
  return [{
    name: LOOKUP_GWAS_CATALOG_TOOL_NAME,
    label: "Look up GWAS Catalog records",
    description:
      "Query the official EMBL-EBI GWAS Catalog API by PubMed ID, GCST study accession, " +
      "or rsID. Returns bounded, source-linked study or association records without inferring missing fields.",
    parameters: {
      type: "object",
      properties: {
        query_type: {
          type: "string",
          enum: ["pubmed_id", "study_accession", "rs_id"],
          description: "Choose pubmed_id to discover studies, or study_accession/rs_id to retrieve associations.",
        },
        query: {
          type: "string",
          description: "A numeric PubMed ID, GCST accession, or rs-prefixed identifier matching query_type.",
        },
        max_results: { type: "integer", minimum: 1, maximum: MAX_RESULTS, default: 20 },
      },
      required: ["query_type", "query"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      try {
        const record = argumentsValue as { query_type?: unknown; query?: unknown; max_results?: unknown };
        if (record.query_type !== "pubmed_id" && record.query_type !== "study_accession" && record.query_type !== "rs_id") {
          throw new TypeError("query_type must be pubmed_id, study_accession, or rs_id");
        }
        if (typeof record.query !== "string") throw new TypeError("query must be a string");
        const maxResults = record.max_results === undefined ? 20 : record.max_results;
        if (typeof maxResults !== "number") throw new TypeError("max_results must be an integer");
        const payload = await lookupGwasCatalog(record.query_type, record.query, maxResults, deps, signal);
        return { content: JSON.stringify(payload) };
      } catch (error) {
        return errorResult(error);
      }
    },
  }];
}
