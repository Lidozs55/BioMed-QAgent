import type {
  JsonValue,
  OperationResultManifest,
  PublicationCandidate,
  PublicationCandidateResultRef,
} from "@biomed/contracts";

import { canonicalDigest } from "../../../adapters/identity.js";
import {
  requireCoreResult,
  resultRefForHash,
  resultRefs,
} from "../../../assembly/helpers.js";
import { parsePublicationCandidate } from "../../../contracts/index.js";
import {
  assembleBioactivityChartEvidenceCandidate,
  type BioactivityChartEvidenceAssemblyInput,
  type ChartEvidenceTableAssemblyInput,
} from "../chart-evidence/index.js";
import type { ChartEvidenceRows } from "../chart-evidence/index.js";
import type { BioactivityAssemblyInput } from "../assembler.js";
import {
  BIOACTIVITY_FAMILY_ID,
  type BioactivityRows,
} from "../types.js";
import { paperEvidenceRelations, paperEvidenceTables } from "./schemas.js";
import {
  assertPaperEvidenceRows,
  derivePaperCanonicalIdentities,
} from "./validation.js";
import type { PaperEvidenceRows, PaperEvidenceTableId } from "./types.js";

export const BIOACTIVITY_PAPER_EVIDENCE_ASSEMBLER_ID =
  "bioactivity_measurement.paper_evidence.assembler.v1";

export interface PaperEvidenceTableAssemblyInput {
  tableId: PaperEvidenceTableId;
  result: OperationResultManifest;
  provenanceResults: readonly OperationResultManifest[];
  confidenceResults: readonly OperationResultManifest[];
}

export interface BioactivityPaperEvidenceAssemblyInput {
  bioactivity: BioactivityAssemblyInput;
  chartTables: readonly ChartEvidenceTableAssemblyInput[];
  chartRows: ChartEvidenceRows;
  bioactivityRows: BioactivityRows;
  paperTables: readonly PaperEvidenceTableAssemblyInput[];
  paperRows: PaperEvidenceRows;
  registeredAssetIds: readonly string[];
  auditResults?: readonly OperationResultManifest[];
}

interface TableSummary {
  table_id: string;
  schema_ref: string;
  row_count: number;
  primary_file_sha256: string;
}

function summaryString(
  summary: Readonly<Record<string, JsonValue>>,
  key: keyof TableSummary,
): string {
  const value = summary[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`paper evidence integration summary requires ${key}`);
  }
  return value;
}

function summaryCount(
  summary: Readonly<Record<string, JsonValue>>,
  key: "row_count",
): number {
  const value = summary[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`paper evidence integration summary requires non-negative ${key}`);
  }
  return value;
}

function parseSummary(result: OperationResultManifest): TableSummary {
  return {
    table_id: summaryString(result.output_summary, "table_id"),
    schema_ref: summaryString(result.output_summary, "schema_ref"),
    row_count: summaryCount(result.output_summary, "row_count"),
    primary_file_sha256: summaryString(result.output_summary, "primary_file_sha256"),
  };
}

function exactAssetClosure(
  results: readonly OperationResultManifest[],
  registeredAssetIds: readonly string[],
): string[] {
  const declared = [...new Set(registeredAssetIds)].sort();
  if (declared.length !== registeredAssetIds.length) {
    throw new Error("registered asset IDs must not contain duplicates");
  }
  const closure = [
    ...new Set(results.flatMap((result) => result.dependency_closure.input_asset_ids)),
  ].sort();
  if (declared.length !== closure.length || declared.some((assetId, index) => assetId !== closure[index])) {
    throw new Error("registered asset IDs must exactly match the paper evidence candidate dependency closure");
  }
  return declared;
}

/**
 * Unions derived canonical identities into the canonical rows. The union is
 * idempotent: runtimes that already rewrote their canonical table bytes with
 * the derived rows pass the merged rows, while direct callers pass the base
 * rows; both end up with exactly one row per canonical identity.
 */
function unionBy<T>(base: readonly T[], derived: readonly T[], key: (row: T) => string): T[] {
  const seen = new Set(base.map((row) => key(row)));
  return [...base, ...derived.filter((row) => !seen.has(key(row)))];
}

/**
 * Assembles the richer bioactivity publication: the canonical base tables and
 * chart evidence plus the four paper evidence tables. Admitted paper evidence
 * deterministically derives canonical activity/compound/assay/target
 * identities that are merged into the canonical tables, so chart points can
 * reference real primary activity IDs. The frozen gold6 six-table projection
 * (paper_records, experiment_records, activity_value_records, chart_series,
 * chart_points, supplementary_asset_records) is a subset of the returned
 * candidate, not an evaluation-only alias.
 */
export function assembleBioactivityPaperEvidenceCandidate(
  input: BioactivityPaperEvidenceAssemblyInput,
): PublicationCandidate {
  if (input.bioactivity.datasetFamily !== BIOACTIVITY_FAMILY_ID) {
    throw new Error("paper evidence can only extend bioactivity_measurement");
  }
  if (input.paperTables.length !== paperEvidenceTables.length) {
    throw new Error(
      "paper evidence assembly requires paper_records, experiment_records, activity_value_records, and supplementary_asset_records",
    );
  }
  assertPaperEvidenceRows(input.paperRows, new Set(input.registeredAssetIds));
  const derived = derivePaperCanonicalIdentities(input.paperRows);
  const mergedRows: BioactivityRows = {
    activities: unionBy(
      input.bioactivityRows.activities,
      derived.activities,
      (row) => row.activity_id,
    ),
    compounds: unionBy(
      input.bioactivityRows.compounds,
      derived.compounds,
      (row) => `${row.compound_id}\u001f${row.compound_id_namespace}`,
    ),
    assays: unionBy(
      input.bioactivityRows.assays,
      derived.assays,
      (row) => `${row.assay_id}\u001f${row.assay_id_namespace}`,
    ),
    targets: unionBy(
      input.bioactivityRows.targets,
      derived.targets,
      (row) => `${row.entity_id}\u001f${row.entity_namespace}`,
    ),
  };

  // The base bioactivity closure may be a strict subset of the combined
  // registered asset closure (paper evidence lives on separate carriers), so
  // the nested candidates are validated against their own exact closures
  // while the combined candidate keeps the full closure.
  const baseAssetIds = [
    ...new Set(input.bioactivity.tables.flatMap((table) =>
      table.result.dependency_closure.input_asset_ids)),
  ].sort();
  const chartInput: BioactivityChartEvidenceAssemblyInput = {
    bioactivity: { ...input.bioactivity, registeredAssetIds: baseAssetIds, rows: mergedRows },
    chartTables: input.chartTables,
    chartRows: input.chartRows,
    bioactivityRows: mergedRows,
    registeredAssetIds: input.registeredAssetIds,
    auditResults: input.auditResults,
  };
  const chartCandidate = assembleBioactivityChartEvidenceCandidate(chartInput);

  const byId = new Map<PaperEvidenceTableId, PaperEvidenceTableAssemblyInput>();
  for (const table of input.paperTables) {
    if (byId.has(table.tableId)) throw new Error(`duplicate paper evidence table '${table.tableId}'`);
    byId.set(table.tableId, table);
  }

  const paperResults: OperationResultManifest[] = [];
  const paperProvenanceRefs: PublicationCandidateResultRef[] = [];
  const paperConfidenceRefs: PublicationCandidateResultRef[] = [];
  const paperCandidateTables = paperEvidenceTables.map((entry) => {
    const tableId = entry.definition.table_id as PaperEvidenceTableId;
    const tableInput = byId.get(tableId);
    if (tableInput === undefined) throw new Error(`missing paper evidence table '${tableId}'`);
    const result = requireCoreResult({
      result: tableInput.result,
      taskId: chartCandidate.task_id,
      requirementId: chartCandidate.requirement_id,
      operationKind: "integrate",
      outputKind: "integrated_table",
    });
    const summary = parseSummary(result);
    if (summary.table_id !== tableId || summary.schema_ref !== entry.schema.schema_id) {
      throw new Error(`paper evidence table '${tableId}' summary does not match its schema`);
    }
    if (summary.row_count === 0) {
      throw new Error(`paper evidence table '${tableId}' must not be empty`);
    }
    if (tableInput.provenanceResults.length === 0 || tableInput.confidenceResults.length === 0) {
      throw new Error(`paper evidence table '${tableId}' requires provenance and confidence results`);
    }
    paperResults.push(result);
    paperProvenanceRefs.push(...resultRefs({
      results: tableInput.provenanceResults,
      taskId: chartCandidate.task_id,
      requirementId: chartCandidate.requirement_id,
    }));
    paperConfidenceRefs.push(...resultRefs({
      results: tableInput.confidenceResults,
      taskId: chartCandidate.task_id,
      requirementId: chartCandidate.requirement_id,
    }));
    return {
      definition: entry.definition,
      data_ref: resultRefForHash(result, summary.primary_file_sha256),
      row_count: summary.row_count,
    };
  });

  const allTableResults = [
    ...input.bioactivity.tables.map((table) => requireCoreResult({
      result: table.result,
      taskId: chartCandidate.task_id,
      requirementId: chartCandidate.requirement_id,
    })),
    ...input.chartTables.map((table) => requireCoreResult({
      result: table.result,
      taskId: chartCandidate.task_id,
      requirementId: chartCandidate.requirement_id,
      operationKind: "integrate",
      outputKind: "integrated_table",
    })),
    ...paperResults,
  ];
  const assets = exactAssetClosure(allTableResults, input.registeredAssetIds);
  const candidateBody = {
    schema_version: "1.0" as const,
    task_id: chartCandidate.task_id,
    requirement_id: chartCandidate.requirement_id,
    dataset_family: chartCandidate.dataset_family,
    row_granularity: chartCandidate.row_granularity,
    tables: [...chartCandidate.tables, ...paperCandidateTables],
    relations: [...chartCandidate.relations, ...paperEvidenceRelations],
    provenance_refs: [...chartCandidate.provenance_refs, ...paperProvenanceRefs],
    confidence_refs: [...chartCandidate.confidence_refs, ...paperConfidenceRefs],
    audit_refs: [...chartCandidate.audit_refs],
    registered_asset_ids: assets,
  };
  return parsePublicationCandidate({
    ...candidateBody,
    candidate_id: `candidate_${canonicalDigest(candidateBody).slice(0, 32)}`,
  });
}
