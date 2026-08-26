import type {
  DatasetSchemaV2,
  JsonValue,
  OperationResultManifest,
  PublicationCandidate,
  PublicationCandidateResultRef,
} from "@biomed/contracts";

import { canonicalDigest } from "../../adapters/identity.js";
import { parsePublicationCandidate } from "../../contracts/index.js";
import {
  requireCoreResult,
  resultRefForHash,
  resultRefs,
} from "../../assembly/helpers.js";
import type { FamilyAssemblerHandler, FamilyAssemblyInput } from "../../assembly/types.js";
import {
  inheritedDiseaseEvidenceTables,
  inheritedDiseaseEvidenceRelations,
} from "./schema.js";
import {
  INHERITED_DISEASE_EVIDENCE_FAMILY_ID,
  INHERITED_DISEASE_EVIDENCE_ROW_GRANULARITY,
} from "./types.js";
import type { InheritedDiseaseEvidenceTableId } from "./validation.js";

export const INHERITED_DISEASE_EVIDENCE_ASSEMBLER_ID =
  "inherited_disease_gene_evidence.assembler.v1";

export interface InheritedDiseaseEvidenceTableAssemblyInput {
  tableId: InheritedDiseaseEvidenceTableId;
  result: OperationResultManifest;
  provenanceResults: readonly OperationResultManifest[];
  confidenceResults: readonly OperationResultManifest[];
}

export interface InheritedDiseaseEvidenceAssemblyInput {
  taskId: string;
  buildId: string;
  datasetFamily: string;
  rowGranularity: string;
  schema: DatasetSchemaV2;
  tables: readonly InheritedDiseaseEvidenceTableAssemblyInput[];
  registeredAssetIds: readonly string[];
  auditResults?: readonly OperationResultManifest[];
}

interface TableSummary {
  table_id: string;
  dataset_family: string;
  row_granularity: string;
  schema_ref: string;
  row_count: number;
  column_count: number;
  primary_file_sha256: string;
}

const TABLE_ORDER: readonly InheritedDiseaseEvidenceTableId[] = [
  "gene_records",
  "disease_records",
  "gene_disease_records",
  "gene_evidence_crosswalk",
];

function summaryString(
  summary: Readonly<Record<string, JsonValue>>,
  key: keyof TableSummary,
  tableId: string,
): string {
  const value = summary[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`inherited disease table '${tableId}' result summary requires ${key}`);
  }
  return value;
}

function summaryCount(
  summary: Readonly<Record<string, JsonValue>>,
  key: "row_count" | "column_count",
  tableId: string,
): number {
  const value = summary[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`inherited disease table '${tableId}' result summary requires non-negative ${key}`);
  }
  return value;
}

function parseSummary(result: OperationResultManifest, tableId: string): TableSummary {
  const summary = result.output_summary;
  return {
    table_id: summaryString(summary, "table_id", tableId),
    dataset_family: summaryString(summary, "dataset_family", tableId),
    row_granularity: summaryString(summary, "row_granularity", tableId),
    schema_ref: summaryString(summary, "schema_ref", tableId),
    row_count: summaryCount(summary, "row_count", tableId),
    column_count: summaryCount(summary, "column_count", tableId),
    primary_file_sha256: summaryString(summary, "primary_file_sha256", tableId),
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
  if (
    declared.length !== closure.length ||
    declared.some((assetId, index) => assetId !== closure[index])
  ) {
    throw new Error(
      "registered asset IDs must exactly match all inherited disease evidence result dependency closures",
    );
  }
  return declared;
}

function resultReference(
  result: OperationResultManifest,
  summary: TableSummary,
): PublicationCandidateResultRef {
  return resultRefForHash(result, summary.primary_file_sha256);
}

function tableEntry(tableId: InheritedDiseaseEvidenceTableId) {
  const entry = inheritedDiseaseEvidenceTables.find((candidate) => candidate.tableId === tableId);
  if (entry === undefined) throw new Error(`unknown inherited disease table '${tableId}'`);
  return entry;
}

function validateEvidenceRefs(
  input: InheritedDiseaseEvidenceAssemblyInput,
  table: InheritedDiseaseEvidenceTableAssemblyInput,
  kind: "provenance" | "confidence",
): PublicationCandidateResultRef[] {
  const results = kind === "provenance" ? table.provenanceResults : table.confidenceResults;
  if (results.length === 0) {
    throw new Error(`inherited disease table '${table.tableId}' requires ${kind} results`);
  }
  return resultRefs({ results, taskId: input.taskId, buildId: input.buildId });
}

export function assembleInheritedDiseaseEvidenceCandidate(
  input: InheritedDiseaseEvidenceAssemblyInput,
): PublicationCandidate {
  if (input.datasetFamily !== INHERITED_DISEASE_EVIDENCE_FAMILY_ID) {
    throw new Error("inherited disease evidence assembler only accepts inherited_disease_gene_evidence");
  }
  if (input.rowGranularity !== INHERITED_DISEASE_EVIDENCE_ROW_GRANULARITY) {
    throw new Error("inherited disease evidence row granularity does not match assembly input");
  }
  if (
    input.schema.dataset_family !== INHERITED_DISEASE_EVIDENCE_FAMILY_ID ||
    input.schema.schema_id !== tableEntry("gene_disease_records").schema.schema_id ||
    input.schema.row_granularity !== input.rowGranularity
  ) {
    throw new Error("inherited disease evidence assembly requires the gene_disease_records Schema 2.0");
  }
  if (input.tables.length !== TABLE_ORDER.length) {
    throw new Error("inherited disease evidence assembly requires all four declared tables");
  }
  const inputs = new Map<InheritedDiseaseEvidenceTableId, InheritedDiseaseEvidenceTableAssemblyInput>();
  for (const table of input.tables) {
    if (inputs.has(table.tableId)) {
      throw new Error(`duplicate inherited disease table '${table.tableId}'`);
    }
    inputs.set(table.tableId, table);
  }
  if (TABLE_ORDER.some((tableId) => !inputs.has(tableId))) {
    throw new Error("inherited disease evidence assembly requires gene, disease, association, and crosswalk tables");
  }

  const validated = TABLE_ORDER.map((tableId) => {
    const tableInput = inputs.get(tableId)!;
    const entry = tableEntry(tableId);
    const result = requireCoreResult({
      result: tableInput.result,
      taskId: input.taskId,
      buildId: input.buildId,
      operationKind: "integrate",
      outputKind: "integrated_table",
    });
    const summary = parseSummary(result, tableId);
    if (
      summary.table_id !== tableId ||
      summary.dataset_family !== INHERITED_DISEASE_EVIDENCE_FAMILY_ID ||
      summary.row_granularity !== INHERITED_DISEASE_EVIDENCE_ROW_GRANULARITY ||
      summary.schema_ref !== entry.schema.schema_id
    ) {
      throw new Error(`inherited disease table '${tableId}' result summary does not match its schema`);
    }
    if (summary.column_count !== entry.definition.field_names.length) {
      throw new Error(`inherited disease table '${tableId}' column count does not match schema`);
    }
    if (summary.row_count === 0) {
      throw new Error(`inherited disease table '${tableId}' must not be empty`);
    }
    return {
      tableId,
      result,
      summary,
      definition: entry.definition,
      provenance: validateEvidenceRefs(input, tableInput, "provenance"),
      confidence: validateEvidenceRefs(input, tableInput, "confidence"),
    };
  });

  const assets = exactAssetClosure(
    validated.map((item) => item.result),
    input.registeredAssetIds,
  );
  const candidateBody = {
    schema_version: "1.0" as const,
    task_id: input.taskId,
    build_id: input.buildId,
    dataset_family: INHERITED_DISEASE_EVIDENCE_FAMILY_ID,
    row_granularity: INHERITED_DISEASE_EVIDENCE_ROW_GRANULARITY,
    tables: validated.map((item) => ({
      definition: item.definition,
      data_ref: resultReference(item.result, item.summary),
      row_count: item.summary.row_count,
    })),
    relations: [...inheritedDiseaseEvidenceRelations],
    provenance_refs: validated.flatMap((item) => item.provenance),
    confidence_refs: validated.flatMap((item) => item.confidence),
    audit_refs: resultRefs({
      results: input.auditResults ?? [],
      taskId: input.taskId,
      buildId: input.buildId,
    }),
    registered_asset_ids: assets,
  };
  return parsePublicationCandidate({
    ...candidateBody,
    candidate_id: `candidate_${canonicalDigest(candidateBody).slice(0, 32)}`,
  });
}

export const inheritedDiseaseEvidenceAssembler: FamilyAssemblerHandler = Object.freeze({
  familyId: INHERITED_DISEASE_EVIDENCE_FAMILY_ID,
  handlerId: INHERITED_DISEASE_EVIDENCE_ASSEMBLER_ID,
  assemble(input: FamilyAssemblyInput) {
    const tableResults = input.integrationResults;
    if (tableResults === undefined) {
      throw new Error("inherited disease evidence assembler requires table results");
    }
    const schema = tableEntry("gene_disease_records").schema;
    return assembleInheritedDiseaseEvidenceCandidate({
      taskId: input.taskId,
      buildId: input.buildId,
      datasetFamily: input.datasetFamily,
      rowGranularity: input.rowGranularity,
      schema,
      tables: TABLE_ORDER.map((tableId) => {
        const result = tableResults[tableId];
        if (result === undefined) {
          throw new Error(`inherited disease evidence assembler requires table '${tableId}'`);
        }
        return {
          tableId,
          result,
          provenanceResults: [result],
          confidenceResults: [result],
        };
      }),
      registeredAssetIds: input.registeredAssetIds,
      auditResults: input.auditResults,
    });
  },
});