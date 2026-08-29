import type {
  JsonValue,
  OperationResultManifest,
  PublicationCandidate,
} from "@biomed/contracts";

import { canonicalDigest } from "../../../adapters/identity.js";
import {
  requireCoreResult,
  resultRefForHash,
  resultRefs,
} from "../../../assembly/helpers.js";
import { parsePublicationCandidate } from "../../../contracts/index.js";
import {
  assembleBioactivityCandidate,
  type BioactivityAssemblyInput,
} from "../assembler.js";
import {
  BIOACTIVITY_FAMILY_ID,
  type BioactivityRows,
} from "../types.js";
import {
  chartEvidenceRelations,
  chartEvidenceTables,
} from "./schemas.js";
import type { ChartEvidenceRows } from "./types.js";
import { assertChartEvidenceRows } from "./validation.js";

export const BIOACTIVITY_CHART_EVIDENCE_ASSEMBLER_ID =
  "bioactivity_measurement.chart_evidence.assembler.v1";

export interface ChartEvidenceTableAssemblyInput {
  tableId: "chart_series" | "chart_points" | "papers" | "sources";
  result: OperationResultManifest;
  provenanceResults: readonly OperationResultManifest[];
  confidenceResults: readonly OperationResultManifest[];
}

export interface BioactivityChartEvidenceAssemblyInput {
  bioactivity: BioactivityAssemblyInput;
  chartTables: readonly ChartEvidenceTableAssemblyInput[];
  chartRows: ChartEvidenceRows;
  bioactivityRows: BioactivityRows;
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
    throw new Error(`chart evidence integration summary requires ${key}`);
  }
  return value;
}

function summaryCount(
  summary: Readonly<Record<string, JsonValue>>,
  key: "row_count",
): number {
  const value = summary[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`chart evidence integration summary requires non-negative ${key}`);
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
    throw new Error("registered asset IDs must exactly match the chart candidate dependency closure");
  }
  return declared;
}

function chartTable(tableId: ChartEvidenceTableAssemblyInput["tableId"]) {
  const table = chartEvidenceTables.find((entry) => entry.definition.table_id === tableId);
  if (table === undefined) throw new Error(`unknown chart evidence table '${tableId}'`);
  return table;
}

export function assembleBioactivityChartEvidenceCandidate(
  input: BioactivityChartEvidenceAssemblyInput,
): PublicationCandidate {
  if (input.bioactivity.datasetFamily !== BIOACTIVITY_FAMILY_ID) {
    throw new Error("chart evidence can only extend bioactivity_measurement");
  }
  if (input.chartTables.length !== chartEvidenceTables.length) {
    throw new Error("chart evidence assembly requires chart_series, chart_points, papers, and sources");
  }
  const activityIds = new Set(input.bioactivityRows.activities.map((row) => row.activity_id));
  assertChartEvidenceRows(input.chartRows, activityIds);

  // The base bioactivity closure may be a strict subset of the combined
  // registered asset closure (chart carriers reference separate figure and
  // upstream assets), so the base candidate is validated against its own
  // exact closure while the combined candidate keeps the full closure.
  const baseAssetIds = [
    ...new Set(input.bioactivity.tables.flatMap((table) =>
      table.result.dependency_closure.input_asset_ids)),
  ].sort();

  const base = assembleBioactivityCandidate({
    ...input.bioactivity,
    registeredAssetIds: baseAssetIds,
    rows: input.bioactivityRows,
  });
  const byId = new Map<ChartEvidenceTableAssemblyInput["tableId"], ChartEvidenceTableAssemblyInput>();
  for (const table of input.chartTables) {
    if (byId.has(table.tableId)) throw new Error(`duplicate chart evidence table '${table.tableId}'`);
    byId.set(table.tableId, table);
  }

  const chartResults: OperationResultManifest[] = [];
  const chartCandidateTables = chartEvidenceTables.map((entry) => {
    const tableId = entry.definition.table_id as ChartEvidenceTableAssemblyInput["tableId"];
    const tableInput = byId.get(tableId);
    if (tableInput === undefined) throw new Error(`missing chart evidence table '${tableId}'`);
    const result = requireCoreResult({
      result: tableInput.result,
      taskId: base.task_id,
      requirementId: base.requirement_id,
      operationKind: "integrate",
      outputKind: "integrated_table",
    });
    const summary = parseSummary(result);
    if (summary.table_id !== tableId || summary.schema_ref !== chartTable(tableId).schema.schema_id) {
      throw new Error(`chart evidence table '${tableId}' summary does not match its schema`);
    }
    if (summary.row_count === 0 && !entry.definition.allow_empty) {
      throw new Error(`chart evidence table '${tableId}' must not be empty`);
    }
    if (tableInput.provenanceResults.length === 0 || tableInput.confidenceResults.length === 0) {
      throw new Error(`chart evidence table '${tableId}' requires provenance and confidence results`);
    }
    chartResults.push(result);
    return {
      definition: entry.definition,
      data_ref: resultRefForHash(result, summary.primary_file_sha256),
      row_count: summary.row_count,
      provenance_refs: resultRefs({
        results: tableInput.provenanceResults,
        taskId: base.task_id,
        requirementId: base.requirement_id,
      }),
      confidence_refs: resultRefs({
        results: tableInput.confidenceResults,
        taskId: base.task_id,
        requirementId: base.requirement_id,
      }),
    };
  });

  const allTableResults = [
    ...input.bioactivity.tables.map((table) => requireCoreResult({
      result: table.result,
      taskId: base.task_id,
      requirementId: base.requirement_id,
    })),
    ...chartResults,
  ];
  const assets = exactAssetClosure(allTableResults, input.registeredAssetIds);
  const candidateBody = {
    schema_version: "1.0" as const,
    task_id: base.task_id,
    requirement_id: base.requirement_id,
    dataset_family: base.dataset_family,
    row_granularity: base.row_granularity,
    tables: [
      ...base.tables,
      ...chartCandidateTables.map(({ definition, data_ref, row_count }) => ({ definition, data_ref, row_count })),
    ],
    relations: [...base.relations, ...chartEvidenceRelations],
    provenance_refs: [
      ...base.provenance_refs,
      ...chartCandidateTables.flatMap((table) => table.provenance_refs),
    ],
    confidence_refs: [
      ...base.confidence_refs,
      ...chartCandidateTables.flatMap((table) => table.confidence_refs),
    ],
    audit_refs: [
      ...base.audit_refs,
      ...resultRefs({
        results: input.auditResults ?? [],
        taskId: base.task_id,
        requirementId: base.requirement_id,
      }),
    ],
    registered_asset_ids: assets,
  };
  return parsePublicationCandidate({
    ...candidateBody,
    candidate_id: `candidate_${canonicalDigest(candidateBody).slice(0, 32)}`,
  });
}
