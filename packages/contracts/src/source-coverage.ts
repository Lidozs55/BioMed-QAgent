/**
 * Source coverage evidence wire DTOs (TODO P1 "可验证的 QueryPlan / SourceCoverage
 * 证据").
 *
 * The Dataset Core deterministically derives a per-binding query plan from the
 * execution spec and, at publication time, emits a coverage report as an
 * ``audit_report`` manifest artifact. The report is audit evidence only: it
 * must never be read as row-level provenance or as primary data, and coverage
 * is only computed within the task's declared source bindings — it is never a
 * claim of exhaustive web coverage.
 */
import {
  APIError,
} from "./runtime/errors.js";
import {
  assertArray,
  assertFinite,
  assertHex64,
  assertJsonRecord,
  assertNonNegativeInt,
  assertNumber,
  assertObject,
  assertOptionalNull,
  assertString,
  assertStringOrNull,
} from "./runtime/primitives.js";
import type { JsonValue } from "./json.js";

export const SOURCE_COVERAGE_REPORT_SCHEMA_VERSION = "1.0" as const;
export const SOURCE_COVERAGE_UNIVERSE_SCOPE = "spec_source_bindings" as const;
export const SOURCE_COVERAGE_SCOPE_NOTE =
  "Coverage is computed only within the task's declared source bindings (spec_source_bindings); this report is not a claim of exhaustive web coverage.";

/**
 * Query-lifecycle status vocabulary, mirroring the server ToolHooks
 * ``QueryStatus`` union (Python run_ctx.log_query parity) so discovery
 * observations transfer losslessly.
 */
export type DiscoveryQueryStatus =
  | "success"
  | "not_found"
  | "failed"
  | "skipped"
  | "page_fallback";

export const DISCOVERY_QUERY_STATUSES: readonly DiscoveryQueryStatus[] = [
  "success",
  "not_found",
  "failed",
  "skipped",
  "page_fallback",
];

/** One deterministic retrieval plan entry, derived from a spec source binding. */
export interface QueryPlanEntry {
  binding_id: string;
  source: string;
  mode: "builtin" | "workflow_recipe";
  provider_id: string | null;
  /** ``recipe_id@version`` for workflow_recipe bindings, else null. */
  recipe_ref: string | null;
  adapter_id: string;
  accession: string | null;
  parameters: Record<string, JsonValue>;
}

/** Core-verified asset evidence attached to an acquired binding. */
export interface SourceCoverageAssetEvidence {
  asset_id: string;
  sha256: string;
  size_bytes: number;
  media_type: string;
  registered_at: string;
}

/** Per-binding row accounting through the deterministic pipeline. */
export interface SourceCoverageRowAccounting {
  /** Raw rows produced by the parser for this binding. */
  parsed: number;
  /** Rows kept by canonicalization. */
  canonical_kept: number;
  /** Rows rejected by canonicalization (each reason in exclusion_reasons). */
  canonical_rejected: number;
}

export type AcquisitionCoverageStatus = "acquired" | "failed" | "not_attempted";

export const ACQUISITION_COVERAGE_STATUSES: readonly AcquisitionCoverageStatus[] = [
  "acquired",
  "failed",
  "not_attempted",
];

export interface AcquisitionCoverageEntry {
  binding_id: string;
  source: string;
  status: AcquisitionCoverageStatus;
  asset: SourceCoverageAssetEvidence | null;
  rows: SourceCoverageRowAccounting | null;
  /** Why rows/binding content was excluded, when known. */
  exclusion_reasons: string[];
}

/**
 * One agent-side discovery query observation, captured by the runtime tool
 * hooks. These are observations about retrieval attempts, not Core-verified
 * acquisition outcomes; coverage accounting never derives from them.
 */
export interface DiscoveryQueryRecord {
  operation_id: string;
  source: string;
  query: string;
  status: DiscoveryQueryStatus;
  result_count: number;
  /** Requested result cap when the tool reports one, else null. */
  requested_limit: number | null;
  retrieved_at: string;
}

export interface SourceCoverageSummary {
  universe_total: number;
  acquired: number;
  failed: number;
  not_attempted: number;
  /** Rows in the integrated product, when the route provides a total. */
  integrated_rows: number | null;
  discovery_total: number;
  discovery_failed: number;
}

export interface SourceCoverageReport {
  schema_version: typeof SOURCE_COVERAGE_REPORT_SCHEMA_VERSION;
  task_id: string;
  requirement_id: string;
  universe_scope: typeof SOURCE_COVERAGE_UNIVERSE_SCOPE;
  scope_note: string;
  query_plan: QueryPlanEntry[];
  acquisition_coverage: AcquisitionCoverageEntry[];
  /** Null when the runtime did not hand a discovery ledger to this build. */
  discovery_queries: DiscoveryQueryRecord[] | null;
  summary: SourceCoverageSummary;
}

function parseQueryPlanEntry(value: unknown, path: string): QueryPlanEntry {
  const obj = assertObject(value, path);
  return {
    binding_id: assertString(obj.binding_id, `${path}.binding_id`, true),
    source: assertString(obj.source, `${path}.source`, true),
    mode: assertFinite(obj.mode, `${path}.mode`, ["builtin", "workflow_recipe"] as const),
    provider_id: assertStringOrNull(obj.provider_id, `${path}.provider_id`),
    recipe_ref: assertStringOrNull(obj.recipe_ref, `${path}.recipe_ref`),
    adapter_id: assertString(obj.adapter_id, `${path}.adapter_id`, true),
    accession: assertStringOrNull(obj.accession, `${path}.accession`),
    parameters: assertJsonRecord(obj.parameters, `${path}.parameters`),
  };
}

function parseSourceCoverageAssetEvidence(
  value: unknown,
  path: string,
): SourceCoverageAssetEvidence {
  const obj = assertObject(value, path);
  return {
    asset_id: assertString(obj.asset_id, `${path}.asset_id`, true),
    sha256: assertHex64(obj.sha256, `${path}.sha256`),
    size_bytes: assertNonNegativeInt(obj.size_bytes, `${path}.size_bytes`),
    media_type: assertString(obj.media_type, `${path}.media_type`, true),
    registered_at: assertString(obj.registered_at, `${path}.registered_at`, true),
  };
}

function parseSourceCoverageRowAccounting(
  value: unknown,
  path: string,
): SourceCoverageRowAccounting {
  const obj = assertObject(value, path);
  return {
    parsed: assertNonNegativeInt(obj.parsed, `${path}.parsed`),
    canonical_kept: assertNonNegativeInt(obj.canonical_kept, `${path}.canonical_kept`),
    canonical_rejected: assertNonNegativeInt(obj.canonical_rejected, `${path}.canonical_rejected`),
  };
}

function parseAcquisitionCoverageEntry(
  value: unknown,
  path: string,
): AcquisitionCoverageEntry {
  const obj = assertObject(value, path);
  return {
    binding_id: assertString(obj.binding_id, `${path}.binding_id`, true),
    source: assertString(obj.source, `${path}.source`, true),
    status: assertFinite(obj.status, `${path}.status`, ACQUISITION_COVERAGE_STATUSES),
    asset: assertOptionalNull(obj.asset, `${path}.asset`, parseSourceCoverageAssetEvidence),
    rows: assertOptionalNull(obj.rows, `${path}.rows`, parseSourceCoverageRowAccounting),
    exclusion_reasons: assertArray(obj.exclusion_reasons, `${path}.exclusion_reasons`, (item, index) =>
      assertString(item, `${path}.exclusion_reasons[${index}]`),
    ),
  };
}

export function parseDiscoveryQueryRecord(
  value: unknown,
  path = "discovery_query_record",
): DiscoveryQueryRecord {
  const obj = assertObject(value, path);
  return {
    operation_id: assertString(obj.operation_id, `${path}.operation_id`, true),
    source: assertString(obj.source, `${path}.source`, true),
    query: assertString(obj.query, `${path}.query`),
    status: assertFinite(obj.status, `${path}.status`, DISCOVERY_QUERY_STATUSES),
    result_count: assertNonNegativeInt(obj.result_count, `${path}.result_count`),
    requested_limit: assertOptionalNull(obj.requested_limit, `${path}.requested_limit`, (input, inputPath) =>
      assertNumber(input, inputPath),
    ),
    retrieved_at: assertString(obj.retrieved_at, `${path}.retrieved_at`, true),
  };
}

function parseSourceCoverageSummary(
  value: unknown,
  path: string,
  entries: readonly AcquisitionCoverageEntry[],
  discoveryQueries: readonly DiscoveryQueryRecord[] | null,
): SourceCoverageSummary {
  const obj = assertObject(value, path);
  // The summary is a projection of the entries, so a summary that disagrees
  // with them is hostile wire: recompute and reject instead of trusting it.
  const expected = {
    universe_total: entries.length,
    acquired: entries.filter((entry) => entry.status === "acquired").length,
    failed: entries.filter((entry) => entry.status === "failed").length,
    not_attempted: entries.filter((entry) => entry.status === "not_attempted").length,
    discovery_total: discoveryQueries === null ? 0 : discoveryQueries.length,
    discovery_failed:
      discoveryQueries === null
        ? 0
        : discoveryQueries.filter((record) => record.status === "failed").length,
  };
  const summary: SourceCoverageSummary = {
    universe_total: assertNonNegativeInt(obj.universe_total, `${path}.universe_total`),
    acquired: assertNonNegativeInt(obj.acquired, `${path}.acquired`),
    failed: assertNonNegativeInt(obj.failed, `${path}.failed`),
    not_attempted: assertNonNegativeInt(obj.not_attempted, `${path}.not_attempted`),
    integrated_rows: assertOptionalNull(obj.integrated_rows, `${path}.integrated_rows`, (input, inputPath) =>
      assertNonNegativeInt(input, inputPath),
    ),
    discovery_total: assertNonNegativeInt(obj.discovery_total, `${path}.discovery_total`),
    discovery_failed: assertNonNegativeInt(obj.discovery_failed, `${path}.discovery_failed`),
  };
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (summary[key] !== expected[key]) {
      throw new APIError(
        502,
        `summary.${key} (${String(summary[key])}) does not match the coverage entries (${String(expected[key])}) at ${path}`,
      );
    }
  }
  return summary;
}

export function parseSourceCoverageReport(
  value: unknown,
  path = "source_coverage_report",
): SourceCoverageReport {
  const obj = assertObject(value, path);
  const queryPlan = assertArray(obj.query_plan, `${path}.query_plan`, (item, index) =>
    parseQueryPlanEntry(item, `${path}.query_plan[${index}]`),
  );
  const acquisitionCoverage = assertArray(
    obj.acquisition_coverage,
    `${path}.acquisition_coverage`,
    (item, index) => parseAcquisitionCoverageEntry(item, `${path}.acquisition_coverage[${index}]`),
  );
  const discoveryQueries = assertOptionalNull(
    obj.discovery_queries,
    `${path}.discovery_queries`,
    (input, inputPath) =>
      assertArray(input, inputPath, (item, index) =>
        parseDiscoveryQueryRecord(item, `${inputPath}[${index}]`),
      ),
  );
  return {
    schema_version: assertFinite(obj.schema_version, `${path}.schema_version`, [
      SOURCE_COVERAGE_REPORT_SCHEMA_VERSION,
    ] as const),
    task_id: assertString(obj.task_id, `${path}.task_id`, true),
    requirement_id: assertString(obj.requirement_id, `${path}.requirement_id`, true),
    universe_scope: assertFinite(obj.universe_scope, `${path}.universe_scope`, [
      SOURCE_COVERAGE_UNIVERSE_SCOPE,
    ] as const),
    scope_note: assertString(obj.scope_note, `${path}.scope_note`, true),
    query_plan: queryPlan,
    acquisition_coverage: acquisitionCoverage,
    discovery_queries: discoveryQueries,
    summary: parseSourceCoverageSummary(obj.summary, `${path}.summary`, acquisitionCoverage, discoveryQueries),
  };
}
