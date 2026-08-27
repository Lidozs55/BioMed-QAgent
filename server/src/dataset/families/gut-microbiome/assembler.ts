import type {
  JsonValue,
  OperationResultManifest,
  PublicationCandidate,
} from "@biomed/contracts";
import { canonicalDigest } from "../../adapters/identity.js";
import { requireCoreResult, resultRefForHash, resultRefs } from "../../assembly/helpers.js";
import { parsePublicationCandidate } from "../../contracts/index.js";
import {
  GUT_MICROBIOME_FAMILY_ID,
  GUT_MICROBIOME_ROW_GRANULARITY,
  gutMicrobiomeRelations,
  gutMicrobiomeTableDefinitions,
} from "./schemas.js";
import type { GutMicrobiomeTableId } from "./types.js";

export const GUT_MICROBIOME_ASSEMBLER_ID = "gut_microbiome.assembler.v1";

export interface GutMicrobiomeTableAssemblyInput {
  tableId: GutMicrobiomeTableId;
  result: OperationResultManifest;
  provenanceResults: readonly OperationResultManifest[];
  confidenceResults: readonly OperationResultManifest[];
}

export interface GutMicrobiomeAssemblyInput {
  taskId: string;
  requirementId: string;
  datasetFamily: string;
  rowGranularity: string;
  tables: readonly GutMicrobiomeTableAssemblyInput[];
  registeredAssetIds: readonly string[];
  auditResults?: readonly OperationResultManifest[];
}

interface TableSummary {
  table_id: string;
  schema_ref: string;
  row_count: number;
  column_count: number;
  primary_file_sha256: string;
}

const TABLE_ORDER: readonly GutMicrobiomeTableId[] = [
  "study_records",
  "taxon_records",
  "differential_abundance_records",
  "reference_prevalence_records",
];

function summaryString(summary: Readonly<Record<string, JsonValue>>, key: keyof TableSummary): string {
  const value = summary[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`gut microbiome integration summary requires ${key}`);
  }
  return value;
}

function summaryCount(summary: Readonly<Record<string, JsonValue>>, key: "row_count" | "column_count"): number {
  const value = summary[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`gut microbiome integration summary requires non-negative ${key}`);
  }
  return value;
}

function parseSummary(result: OperationResultManifest): TableSummary {
  return {
    table_id: summaryString(result.output_summary, "table_id"),
    schema_ref: summaryString(result.output_summary, "schema_ref"),
    row_count: summaryCount(result.output_summary, "row_count"),
    column_count: summaryCount(result.output_summary, "column_count"),
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
  const closure = [...new Set(results.flatMap((result) => result.dependency_closure.input_asset_ids))].sort();
  if (declared.length !== closure.length || declared.some((assetId, index) => assetId !== closure[index])) {
    throw new Error("registered asset IDs must exactly match all gut microbiome result dependency closures");
  }
  return declared;
}

function tableDefinition(tableId: GutMicrobiomeTableId) {
  const definition = gutMicrobiomeTableDefinitions().find((item) => item.table_id === tableId);
  if (definition === undefined) throw new Error(`unknown gut microbiome table '${tableId}'`);
  return definition;
}

function evidenceRefs(
  results: readonly OperationResultManifest[],
  input: GutMicrobiomeAssemblyInput,
  tableId: GutMicrobiomeTableId,
  kind: "provenance" | "confidence",
) {
  if (results.length === 0) throw new Error(`gut microbiome table '${tableId}' requires ${kind} results`);
  return resultRefs({ results, taskId: input.taskId, requirementId: input.requirementId });
}

export function assembleGutMicrobiomeCandidate(input: GutMicrobiomeAssemblyInput): PublicationCandidate {
  if (input.datasetFamily !== GUT_MICROBIOME_FAMILY_ID) {
    throw new Error("gut microbiome assembler only accepts gut_microbiome");
  }
  if (input.rowGranularity !== GUT_MICROBIOME_ROW_GRANULARITY) {
    throw new Error("gut microbiome row granularity does not match assembly input");
  }
  if (input.tables.length !== TABLE_ORDER.length) {
    throw new Error("gut microbiome assembly requires all four declared tables");
  }
  const byId = new Map<GutMicrobiomeTableId, GutMicrobiomeTableAssemblyInput>();
  for (const table of input.tables) {
    if (byId.has(table.tableId)) throw new Error(`duplicate gut microbiome table '${table.tableId}'`);
    byId.set(table.tableId, table);
  }
  if (TABLE_ORDER.some((tableId) => !byId.has(tableId))) {
    throw new Error("gut microbiome assembly requires every declared table");
  }
  const validated = TABLE_ORDER.map((tableId) => {
    const tableInput = byId.get(tableId)!;
    const result = requireCoreResult({
      result: tableInput.result,
      taskId: input.taskId,
      requirementId: input.requirementId,
      operationKind: "integrate",
      outputKind: "integrated_table",
    });
    const summary = parseSummary(result);
    const definition = tableDefinition(tableId);
    if (summary.table_id !== tableId || summary.schema_ref !== definition.schema_ref) {
      throw new Error(`gut microbiome table '${tableId}' summary does not match its schema`);
    }
    if (summary.column_count !== definition.field_names.length) {
      throw new Error(`gut microbiome table '${tableId}' column count does not match schema`);
    }
    if (summary.row_count === 0) throw new Error(`gut microbiome table '${tableId}' must not be empty`);
    return {
      tableId,
      result,
      summary,
      definition,
      provenance: evidenceRefs(tableInput.provenanceResults, input, tableId, "provenance"),
      confidence: evidenceRefs(tableInput.confidenceResults, input, tableId, "confidence"),
    };
  });
  const assets = exactAssetClosure(validated.map((item) => item.result), input.registeredAssetIds);
  const candidateBody = {
    schema_version: "1.0" as const,
    task_id: input.taskId,
    requirement_id: input.requirementId,
    dataset_family: GUT_MICROBIOME_FAMILY_ID,
    row_granularity: GUT_MICROBIOME_ROW_GRANULARITY,
    tables: validated.map((item) => ({
      definition: item.definition,
      data_ref: resultRefForHash(item.result, item.summary.primary_file_sha256),
      row_count: item.summary.row_count,
    })),
    relations: [...gutMicrobiomeRelations],
    provenance_refs: validated.flatMap((item) => item.provenance),
    confidence_refs: validated.flatMap((item) => item.confidence),
    audit_refs: resultRefs({ results: input.auditResults ?? [], taskId: input.taskId, requirementId: input.requirementId }),
    registered_asset_ids: assets,
  };
  return parsePublicationCandidate({
    ...candidateBody,
    candidate_id: `candidate_${canonicalDigest(candidateBody).slice(0, 32)}`,
  });
}

export const gutMicrobiomeAssembler = Object.freeze({
  familyId: GUT_MICROBIOME_FAMILY_ID,
  handlerId: GUT_MICROBIOME_ASSEMBLER_ID,
  assemble: assembleGutMicrobiomeCandidate,
});
