import type {
  JsonValue,
  OperationResultManifest,
  PublicationCandidate,
  PublicationCandidateResultRef,
} from "@biomed/contracts";
import { canonicalDigest } from "../../adapters/identity.js";
import {
  parsePublicationCandidate,
  parseTableDefinition,
} from "../../contracts/index.js";
import {
  requireCoreResult,
  resultRefs,
} from "../../assembly/helpers.js";
import {
  TARGET_EVIDENCE_FAMILY_ID,
  TARGET_EVIDENCE_ROW_GRANULARITY,
  targetEvidenceRelations,
  targetEvidenceSchemas,
  targetEvidenceTableDefinitions,
} from "./schemas.js";

export const TARGET_EVIDENCE_ASSEMBLER_ID = "target_evidence.assembler.v1";

export type TargetEvidenceTableId = "targets" | "evidence" | "sources" | "supporting";

export interface TargetEvidenceTableAssemblyInput {
  tableId: TargetEvidenceTableId;
  result: OperationResultManifest;
  provenanceResults: readonly OperationResultManifest[];
  confidenceResults: readonly OperationResultManifest[];
}

export interface TargetEvidenceAssemblyInput {
  taskId: string;
  requirementId: string;
  datasetFamily: string;
  rowGranularity: string;
  tables: readonly TargetEvidenceTableAssemblyInput[];
  registeredAssetIds: readonly string[];
  auditResults?: readonly OperationResultManifest[];
}

interface TargetEvidenceTableSummary {
  table_id: string;
  schema_ref: string;
  row_count: number;
  column_count: number;
  primary_file_sha256: string;
}

const TABLE_ORDER: readonly TargetEvidenceTableId[] = [
  "targets",
  "evidence",
  "sources",
  "supporting",
];

function summaryString(
  summary: Readonly<Record<string, JsonValue>>,
  key: keyof TargetEvidenceTableSummary,
): string {
  const value = summary[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`target evidence integration summary requires ${key}`);
  }
  return value;
}

function summaryCount(
  summary: Readonly<Record<string, JsonValue>>,
  key: "row_count" | "column_count",
): number {
  const value = summary[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`target evidence integration summary requires non-negative ${key}`);
  }
  return value;
}

function parseSummary(result: OperationResultManifest): TargetEvidenceTableSummary {
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
  const closure = [...new Set(results.flatMap((result) => result.dependency_closure.input_asset_ids))].sort();
  const declared = [...new Set(registeredAssetIds)].sort();
  if (declared.length !== registeredAssetIds.length) {
    throw new Error("registered asset IDs must not contain duplicates");
  }
  if (declared.length !== closure.length || declared.some((assetId, index) => assetId !== closure[index])) {
    throw new Error("registered asset IDs must exactly match the integration dependency closure");
  }
  return declared;
}

function tableResultRef(
  result: OperationResultManifest,
  summary: TargetEvidenceTableSummary,
): PublicationCandidateResultRef {
  const index = result.output_files.findIndex((file) => file.sha256 === summary.primary_file_sha256);
  if (index < 0) {
    throw new Error(
      `Core result '${result.result_manifest_id}' has no receipt for ${summary.primary_file_sha256}`,
    );
  }
  return {
    result_manifest_id: result.result_manifest_id,
    output_kind: result.output_kind,
    output_file_index: index,
    output_file_sha256: summary.primary_file_sha256,
  };
}

function tableDefinition(tableId: TargetEvidenceTableId) {
  const definition = targetEvidenceTableDefinitions()[TABLE_ORDER.indexOf(tableId)];
  if (definition === undefined) throw new Error(`unknown target evidence table '${tableId}'`);
  return parseTableDefinition(definition);
}

function tableSchema(tableId: TargetEvidenceTableId) {
  const schema = targetEvidenceSchemas[TABLE_ORDER.indexOf(tableId)];
  if (schema === undefined) throw new Error(`unknown target evidence table '${tableId}'`);
  return schema;
}

function validateTableInput(
  input: TargetEvidenceAssemblyInput,
  table: TargetEvidenceTableAssemblyInput,
): {
  result: OperationResultManifest;
  summary: TargetEvidenceTableSummary;
  provenance: PublicationCandidateResultRef[];
  confidence: PublicationCandidateResultRef[];
} {
  const schema = tableSchema(table.tableId);
  const definition = tableDefinition(table.tableId);
  const result = requireCoreResult({
    result: table.result,
    taskId: input.taskId,
    requirementId: input.requirementId,
    operationKind: "integrate",
    outputKind: "integrated_table",
  });
  const summary = parseSummary(result);
  if (summary.table_id !== table.tableId || summary.schema_ref !== schema.schema_id) {
    throw new Error(`target evidence table '${table.tableId}' integration summary does not match its schema`);
  }
  if (summary.column_count !== definition.field_names.length) {
    throw new Error(`target evidence table '${table.tableId}' integration column count does not match schema`);
  }
  const emptyAllowed = definition.role !== "primary" && definition.allow_empty;
  if (summary.row_count === 0 && !emptyAllowed) {
    throw new Error(`target evidence table '${table.tableId}' must not be empty`);
  }
  if (table.provenanceResults.length === 0) {
    throw new Error(`target evidence table '${table.tableId}' requires provenance results`);
  }
  if (table.confidenceResults.length === 0) {
    throw new Error(`target evidence table '${table.tableId}' requires confidence results`);
  }
  return {
    result,
    summary,
    provenance: resultRefs({ results: table.provenanceResults, taskId: input.taskId, requirementId: input.requirementId }),
    confidence: resultRefs({ results: table.confidenceResults, taskId: input.taskId, requirementId: input.requirementId }),
  };
}

export function assembleTargetEvidenceCandidate(
  input: TargetEvidenceAssemblyInput,
): PublicationCandidate {
  if (input.datasetFamily !== TARGET_EVIDENCE_FAMILY_ID) {
    throw new Error("target evidence assembler only accepts target_evidence");
  }
  if (input.rowGranularity !== TARGET_EVIDENCE_ROW_GRANULARITY) {
    throw new Error("target evidence row granularity does not match assembly input");
  }
  if (input.tables.length !== TABLE_ORDER.length) {
    throw new Error("target evidence assembly requires targets, evidence, sources, and supporting tables");
  }
  const tableInputs = new Map<TargetEvidenceTableId, TargetEvidenceTableAssemblyInput>();
  for (const table of input.tables) {
    if (tableInputs.has(table.tableId)) throw new Error(`duplicate target evidence table '${table.tableId}'`);
    tableInputs.set(table.tableId, table);
  }
  if (TABLE_ORDER.some((tableId) => !tableInputs.has(tableId))) {
    throw new Error("target evidence assembly requires every declared table");
  }

  const validated = TABLE_ORDER.map((tableId) => validateTableInput(input, tableInputs.get(tableId)!));
  const integrationResults = validated.map((item) => item.result);
  const assets = exactAssetClosure(integrationResults, input.registeredAssetIds);
  const tables = TABLE_ORDER.map((tableId, index) => {
    const item = validated[index]!;
    const definition = tableDefinition(tableId);
    return {
      definition,
      data_ref: tableResultRef(item.result, item.summary),
      row_count: item.summary.row_count,
    };
  });
  const provenanceRefs = validated.flatMap((item) => item.provenance);
  const confidenceRefs = validated.flatMap((item) => item.confidence);
  const candidateBody = {
    schema_version: "1.0" as const,
    task_id: input.taskId,
    requirement_id: input.requirementId,
    dataset_family: TARGET_EVIDENCE_FAMILY_ID,
    row_granularity: TARGET_EVIDENCE_ROW_GRANULARITY,
    tables,
    relations: targetEvidenceRelations.map((relation) => ({ ...relation })),
    provenance_refs: provenanceRefs,
    confidence_refs: confidenceRefs,
    audit_refs: resultRefs({
      results: input.auditResults ?? [],
      taskId: input.taskId,
      requirementId: input.requirementId,
    }),
    registered_asset_ids: assets,
  };
  return parsePublicationCandidate({
    ...candidateBody,
    candidate_id: `candidate_${canonicalDigest(candidateBody).slice(0, 32)}`,
  });
}

export const targetEvidenceAssembler = Object.freeze({
  familyId: TARGET_EVIDENCE_FAMILY_ID,
  handlerId: TARGET_EVIDENCE_ASSEMBLER_ID,
  assemble: assembleTargetEvidenceCandidate,
});
