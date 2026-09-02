import type { BioMedAgentTool } from "../contracts.js";
import type { PublicHttpClient } from "../../external/network/http-client.js";
import { PublicHttpClient as DefaultPublicHttpClient } from "../../external/network/http-client.js";
import { HostRateLimiter, parseRetryAfter } from "../../external/ncbi/retry.js";
import { readBoundedJson } from "./response-limit.js";
import { errorResult } from "./result.js";

export const LOOKUP_DBSNP_TOOL_NAME = "lookup_dbsnp";
const DBSNP_API_ROOT = "https://api.ncbi.nlm.nih.gov/variation/v0/refsnp";
const MAX_RS_IDS = 20;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RS_ID = /^rs([0-9]+)$/i;

interface DbsnpDeps {
  client?: PublicHttpClient;
  limiter?: Pick<HostRateLimiter, "wait">;
  /** Host setting may tighten, but never loosen, the tool's intrinsic cap. */
  maxResponseBytes?: number;
  maxRetries?: number;
  sleep?: (delayMs: number) => Promise<void>;
  jitter?: () => number;
  now?: () => number;
}

const PROCESS_DBSNP_LIMITER = new HostRateLimiter({ minInterval: 1 / 3 });

interface RefSnpPlacement {
  is_ptlp: boolean | null;
  is_aln_opposite_orientation: boolean | null;
  seq_id: string | null;
  seq_type: string | null;
  assemblies: Array<{
    assembly_name: string | null;
    assembly_accession: string | null;
  }>;
  alleles: Array<{
    position: number | null;
    deleted_sequence: string | null;
    inserted_sequence: string | null;
    hgvs: string | null;
  }>;
}

export interface DbsnpLookupResult {
  source: "dbsnp";
  requested_count: number;
  succeeded_count: number;
  failed_count: number;
  records: Array<{
    rs_id: string;
    refsnp_id: string;
    source_url: string;
    status: "succeeded";
    last_update_date: string | null;
    variant_type: string | null;
    placements: RefSnpPlacement[];
  }>;
  failures: Array<{
    rs_id: string;
    source_url: string;
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

function compactPlacements(payload: Record<string, unknown>): RefSnpPlacement[] {
  const snapshot = asRecord(payload["primary_snapshot_data"]);
  const placements = Array.isArray(snapshot?.["placements_with_allele"])
    ? snapshot["placements_with_allele"]
    : [];
  const compact: RefSnpPlacement[] = [];
  for (const placementValue of placements.slice(0, 10)) {
    const placement = asRecord(placementValue);
    const annotation = asRecord(placement?.["placement_annot"]);
    const assemblyTraits = Array.isArray(annotation?.["seq_id_traits_by_assembly"])
      ? annotation["seq_id_traits_by_assembly"]
      : [];
    const alleles = Array.isArray(placement?.["alleles"]) ? placement["alleles"] : [];
    const compactAlleles: RefSnpPlacement["alleles"] = [];
    for (const alleleValue of alleles.slice(0, 20)) {
      const allele = asRecord(alleleValue);
      const spdi = asRecord(asRecord(allele?.["allele"])?.["spdi"]);
      compactAlleles.push({
        position: typeof spdi?.["position"] === "number" ? spdi["position"] : null,
        deleted_sequence:
          typeof spdi?.["deleted_sequence"] === "string" ? spdi["deleted_sequence"] : null,
        inserted_sequence:
          typeof spdi?.["inserted_sequence"] === "string" ? spdi["inserted_sequence"] : null,
        hgvs: typeof allele?.["hgvs"] === "string" ? allele["hgvs"] : null,
      });
    }
    compact.push({
      is_ptlp: typeof placement?.["is_ptlp"] === "boolean" ? placement["is_ptlp"] : null,
      is_aln_opposite_orientation:
        typeof annotation?.["is_aln_opposite_orientation"] === "boolean"
          ? annotation["is_aln_opposite_orientation"]
          : null,
      seq_id: typeof placement?.["seq_id"] === "string" ? placement["seq_id"] : null,
      seq_type: typeof annotation?.["seq_type"] === "string" ? annotation["seq_type"] : null,
      assemblies: assemblyTraits.slice(0, 10).map((traitValue) => {
        const trait = asRecord(traitValue);
        return {
          assembly_name: typeof trait?.["assembly_name"] === "string" ? trait["assembly_name"] : null,
          assembly_accession:
            typeof trait?.["assembly_accession"] === "string" ? trait["assembly_accession"] : null,
        };
      }),
      alleles: compactAlleles,
    });
  }
  return compact;
}

export async function lookupDbsnp(
  rsIds: readonly string[],
  deps: DbsnpDeps = {},
  signal?: AbortSignal,
): Promise<DbsnpLookupResult> {
  if (rsIds.length === 0 || rsIds.length > MAX_RS_IDS) {
    throw new TypeError(`rs_ids must contain between 1 and at most ${MAX_RS_IDS} rsIDs`);
  }
  const normalized = rsIds.map((value) => {
    const match = RS_ID.exec(value.trim());
    if (match === null) throw new TypeError(`invalid rsID: ${value}`);
    return { rsId: `rs${match[1]}`, numericId: match[1] as string };
  });
  const client = deps.client ?? new DefaultPublicHttpClient();
  const limiter = deps.limiter ?? PROCESS_DBSNP_LIMITER;
  const maxRetries = deps.maxRetries ?? 3;
  const sleep = deps.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const jitter = deps.jitter ?? Math.random;
  const now = deps.now ?? Date.now;
  const result: DbsnpLookupResult = {
    source: "dbsnp",
    requested_count: normalized.length,
    succeeded_count: 0,
    failed_count: 0,
    records: [],
    failures: [],
  };

  for (const item of normalized) {
    const sourceUrl = `${DBSNP_API_ROOT}/${item.numericId}`;
    try {
      let completed = false;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        await limiter.wait(sourceUrl);
        const response = await client.request(sourceUrl, {
          headers: { Accept: "application/json" },
          signal,
        });
        if (response.status < 200 || response.status >= 300) {
          const retryable = response.status === 429 || (response.status >= 500 && response.status < 600);
          const retryAfter = parseRetryAfter(
            response.headers["retry-after"] ?? response.headers["Retry-After"],
            now(),
          );
          await response.discard();
          if (retryable && attempt < maxRetries) {
            const backoffSeconds = Math.min(30, Math.max(0.5 * 2 ** attempt + jitter(), retryAfter));
            await sleep(backoffSeconds * 1000);
            continue;
          }
          result.failures.push({
            rs_id: item.rsId,
            source_url: sourceUrl,
            status: "failed",
            status_code: response.status,
            error: `dbSNP returned HTTP ${response.status}`,
          });
          completed = true;
          break;
        }
        const parsed = asRecord(await readBoundedJson(response.body, {
          source: "dbSNP",
          intrinsicMaxBytes: MAX_RESPONSE_BYTES,
          configuredMaxBytes: deps.maxResponseBytes,
        }));
        if (parsed === null || String(parsed["refsnp_id"] ?? "") !== item.numericId) {
          throw new Error("dbSNP returned an invalid or mismatched RefSNP record");
        }
        const snapshot = asRecord(parsed["primary_snapshot_data"]);
        result.records.push({
          rs_id: item.rsId,
          refsnp_id: item.numericId,
          source_url: sourceUrl,
          status: "succeeded",
          last_update_date: typeof parsed["last_update_date"] === "string" ? parsed["last_update_date"] : null,
          variant_type: typeof snapshot?.["variant_type"] === "string" ? snapshot["variant_type"] : null,
          placements: compactPlacements(parsed),
        });
        completed = true;
        break;
      }
      if (!completed) throw new Error("dbSNP retry loop ended without an outcome");
    } catch (error) {
      if (signal?.aborted === true) throw error;
      result.failures.push({
        rs_id: item.rsId,
        source_url: sourceUrl,
        status: "failed",
        status_code: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  result.succeeded_count = result.records.length;
  result.failed_count = result.failures.length;
  return result;
}

export function createDbsnpTools(deps: DbsnpDeps = {}): BioMedAgentTool[] {
  return [{
    name: LOOKUP_DBSNP_TOOL_NAME,
    label: "Look up dbSNP RefSNP records",
    description:
      "Look up one or more rsIDs through the official NCBI RefSNP API. The tool normalizes " +
      "rs-prefixed identifiers to numeric API paths and reports each unavailable record explicitly.",
    parameters: {
      type: "object",
      properties: {
        rs_ids: {
          type: "array",
          items: { type: "string", pattern: "^rs[0-9]+$" },
          minItems: 1,
          maxItems: MAX_RS_IDS,
          description: "One to 20 rs-prefixed dbSNP identifiers, for example rs429358.",
        },
      },
      required: ["rs_ids"],
      additionalProperties: false,
    },
    execute: async (argumentsValue, signal) => {
      try {
        const record = argumentsValue as { rs_ids?: unknown };
        if (!Array.isArray(record.rs_ids) || !record.rs_ids.every((value) => typeof value === "string")) {
          throw new TypeError("rs_ids must be an array of rsID strings");
        }
        const payload = await lookupDbsnp(record.rs_ids, deps, signal);
        return {
          content: JSON.stringify(payload),
          isError: payload.succeeded_count === 0,
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  }];
}
