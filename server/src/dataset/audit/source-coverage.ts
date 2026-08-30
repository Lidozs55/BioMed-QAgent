/**
 * Deterministic QueryPlan / SourceCoverage report builder (TODO P1 "可验证的
 * QueryPlan / SourceCoverage 证据").
 *
 * The report is Core-derived only: the query plan is projected from the
 * execution spec's source bindings, and acquisition coverage from assets and
 * canonicalization results the Core itself verified. Runtime discovery
 * observations are carried verbatim (parsed fail-closed) and never feed the
 * coverage accounting. The report is audit evidence — never row-level
 * provenance and never primary data.
 */

import { writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseSourceCoverageReport,
  SOURCE_COVERAGE_REPORT_SCHEMA_VERSION,
  SOURCE_COVERAGE_SCOPE_NOTE,
  SOURCE_COVERAGE_UNIVERSE_SCOPE,
  type AcquisitionCoverageEntry,
  type DatasetExecutionSpec,
  type DiscoveryQueryRecord,
  type QueryPlanEntry,
  type SourceAssetRegistrationReceipt,
  type SourceCoverageReport,
  type SourceCoverageSummary,
} from "@biomed/contracts";

import { parseDiscoveryQueryLedger } from "../contracts/index.js";
import type { SourceAsset } from "../contracts/source.js";
import type { CanonicalizationResult } from "../canonicalizer/canonicalizer.js";

export const SOURCE_COVERAGE_ARTIFACT_FILE = "source_coverage_report.json";

/** Per-binding asset evidence resolved from task-owned registration receipts. */
export interface CoverageAssetEvidence {
  asset_id: string;
  sha256: string;
  size_bytes: number;
  media_type: string;
  registered_at: string;
}

export interface SourceCoverageBuildInput {
  taskId: string;
  spec: DatasetExecutionSpec;
  /**
   * binding_id → Core-verified source asset evidence. A full ``SourceAsset``
   * satisfies this shape; routes without asset objects may pass the four
   * evidence fields resolved from registration receipts.
   */
  sourceAssets: Readonly<Record<string, Pick<SourceAsset, "asset_id" | "sha256" | "size_bytes" | "media_type">>>;
  /** Task-owned registration receipts for this build's inputs. */
  registrationReceipts: readonly SourceAssetRegistrationReceipt[];
  /** V1 static-route canonicalization outcomes (absent on other routes). */
  canonicalResults?: readonly CanonicalizationResult[];
  /** Rows in the integrated product, when the route provides a total. */
  integratedRows?: number | null;
  /** binding_id → known acquisition failure reason, when the caller has one. */
  bindingFailures?: ReadonlyMap<string, string>;
  /** Runtime discovery observations; null when the runtime handed none over. */
  discoveryQueries?: readonly DiscoveryQueryRecord[] | null;
}

/** Deterministic per-binding retrieval plan projected from the spec bindings. */
export function buildQueryPlanEntries(spec: DatasetExecutionSpec): QueryPlanEntry[] {
  return [...spec.source_bindings]
    .map((binding): QueryPlanEntry => ({
      binding_id: binding.binding_id,
      source: binding.source,
      mode: binding.acquisition.mode,
      provider_id: binding.acquisition.provider_id,
      recipe_ref:
        binding.acquisition.mode === "workflow_recipe"
          && binding.acquisition.recipe_id !== null
          && binding.acquisition.recipe_version !== null
          ? `${binding.acquisition.recipe_id}@${binding.acquisition.recipe_version}`
          : null,
      adapter_id: binding.adapter_id,
      accession: binding.accession,
      parameters: binding.parameters,
    }))
    .sort((left, right) => left.binding_id.localeCompare(right.binding_id));
}

function receiptByAssetId(
  receipts: readonly SourceAssetRegistrationReceipt[],
): Map<string, SourceAssetRegistrationReceipt> {
  return new Map(receipts.map((receipt) => [receipt.asset_ref.asset_id, receipt]));
}

function buildAcquisitionCoverage(input: SourceCoverageBuildInput): {
  entries: AcquisitionCoverageEntry[];
} {
  const rowsByBinding = new Map<string, { parsed: number; canonical_kept: number; canonical_rejected: number }>();
  for (const result of input.canonicalResults ?? []) {
    const bindingId = result.batch.binding_id ?? "";
    if (bindingId === "") continue;
    rowsByBinding.set(bindingId, {
      parsed: result.batch.row_count,
      canonical_kept: result.rowCount,
      canonical_rejected: result.rejectedCount,
    });
  }
  const receipts = receiptByAssetId(input.registrationReceipts);
  const entries = [...input.spec.source_bindings]
    .sort((left, right) => left.binding_id.localeCompare(right.binding_id))
    .map((binding): AcquisitionCoverageEntry => {
      const asset = input.sourceAssets[binding.binding_id] ?? null;
      const receipt = asset === null ? undefined : receipts.get(asset.asset_id);
      const rows = rowsByBinding.get(binding.binding_id) ?? null;
      const exclusionReasons: string[] = [];
      const failure = input.bindingFailures?.get(binding.binding_id);
      if (failure !== undefined) exclusionReasons.push(failure);
      if (asset !== null && receipt === undefined) {
        exclusionReasons.push("registration_receipt_missing");
      }
      if (rows !== null && rows.canonical_rejected > 0) {
        exclusionReasons.push(`canonicalization_rejected_rows:${rows.canonical_rejected}`);
      }
      return {
        binding_id: binding.binding_id,
        source: binding.source,
        status: asset !== null ? "acquired" : failure !== undefined ? "failed" : "not_attempted",
        asset:
          asset === null || receipt === undefined
            ? null
            : {
                asset_id: asset.asset_id,
                sha256: asset.sha256,
                size_bytes: asset.size_bytes,
                media_type: asset.media_type,
                registered_at: receipt.registered_at,
              },
        rows,
        exclusion_reasons: exclusionReasons,
      };
    });
  return { entries };
}

function buildSummary(
  entries: readonly AcquisitionCoverageEntry[],
  discoveryQueries: readonly DiscoveryQueryRecord[] | null,
  integratedRows: number | null,
): SourceCoverageSummary {
  return {
    universe_total: entries.length,
    acquired: entries.filter((entry) => entry.status === "acquired").length,
    failed: entries.filter((entry) => entry.status === "failed").length,
    not_attempted: entries.filter((entry) => entry.status === "not_attempted").length,
    integrated_rows: integratedRows,
    discovery_total: discoveryQueries === null ? 0 : discoveryQueries.length,
    discovery_failed:
      discoveryQueries === null
        ? 0
        : discoveryQueries.filter((record) => record.status === "failed").length,
  };
}

/**
 * Build the report. Inputs are deterministic; bindings are sorted by
 * binding_id and discovery records by operation_id so the same build state
 * yields byte-identical artifacts (checkpoint reuse and event replay safe).
 * Discovery observations are parsed fail-closed: a malformed ledger aborts
 * the build instead of silently narrowing the evidence.
 */
export function buildSourceCoverageReport(input: SourceCoverageBuildInput): SourceCoverageReport {
  const queryPlan = buildQueryPlanEntries(input.spec);
  const { entries: acquisitionCoverage } = buildAcquisitionCoverage(input);
  const planIds = queryPlan.map((entry) => entry.binding_id).sort();
  const coverageIds = acquisitionCoverage.map((entry) => entry.binding_id).sort();
  if (JSON.stringify(planIds) !== JSON.stringify(coverageIds)) {
    throw new Error("source coverage query plan and acquisition entries have different bindings");
  }
  for (const entry of acquisitionCoverage) {
    if (entry.asset === null) continue;
    const sourceAsset = input.sourceAssets[entry.binding_id];
    const receipt = input.registrationReceipts.find(
      (candidate) => candidate.asset_ref.asset_id === entry.asset?.asset_id,
    );
    if (
      sourceAsset === undefined ||
      receipt === undefined ||
      sourceAsset.sha256 !== entry.asset.sha256 ||
      sourceAsset.size_bytes !== entry.asset.size_bytes ||
      sourceAsset.media_type !== entry.asset.media_type
    ) {
      throw new Error(`source coverage asset receipt mismatch for binding '${entry.binding_id}'`);
    }
  }
  const discoveryQueries =
    input.discoveryQueries === undefined || input.discoveryQueries === null
      ? null
      : parseDiscoveryQueryLedger([...input.discoveryQueries]).sort((left, right) =>
          left.operation_id.localeCompare(right.operation_id),
        );
  const summary = buildSummary(acquisitionCoverage, discoveryQueries, input.integratedRows ?? null);
  return parseSourceCoverageReport({
    schema_version: SOURCE_COVERAGE_REPORT_SCHEMA_VERSION,
    task_id: input.taskId,
    requirement_id: input.spec.requirement_id,
    universe_scope: SOURCE_COVERAGE_UNIVERSE_SCOPE,
    scope_note: SOURCE_COVERAGE_SCOPE_NOTE,
    query_plan: queryPlan,
    acquisition_coverage: acquisitionCoverage,
    discovery_queries: discoveryQueries,
    summary,
  });
}

/** Stable artifact write: normalize through the parser, then 2-space JSON. */
export async function writeSourceCoverageReport(
  outputDir: string,
  report: SourceCoverageReport,
): Promise<string> {
  const target = path.join(outputDir, SOURCE_COVERAGE_ARTIFACT_FILE);
  await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return target;
}
