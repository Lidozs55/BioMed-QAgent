import type {
  JsonValue,
  OperationResultManifest,
  PublicationCandidate,
  PublicationCandidateResultRef,
} from "@biomed/contracts";

import { canonicalDigest } from "../../adapters/identity.js";
import {
  requireCoreResult,
  resultRefForHash,
  resultRefs,
} from "../../assembly/helpers.js";
import { parsePublicationCandidate } from "../../contracts/index.js";
import { buildProteinStructureTables } from "./schemas.js";
import type {
  ProteinStructureRows,
  ProteinStructureTableId,
} from "./types.js";
import {
  PROTEIN_STRUCTURE_FAMILY_ID,
  PROTEIN_STRUCTURE_ROW_GRANULARITY,
} from "./types.js";
import {
  assertProteinStructureRelations,
  assertProteinStructureRows,
} from "./validation.js";

export const PROTEIN_STRUCTURE_ASSEMBLER_ID = "protein_structure.assembler.v1";

export interface ProteinStructureTableAssemblyInput {
  tableId: ProteinStructureTableId;
  result: OperationResultManifest;
  provenanceResults: readonly OperationResultManifest[];
  confidenceResults: readonly OperationResultManifest[];
}

export interface ProteinStructureAssemblyInput {
  taskId: string;
  buildId: string;
  datasetFamily: string;
  rowGranularity: string;
  tables: readonly ProteinStructureTableAssemblyInput[];
  registeredAssetIds: readonly string[];
  rows: ProteinStructureRows;
  auditResults?: readonly OperationResultManifest[];
}

interface TableSummary {
  table_id: string;
  schema_ref: string;
  row_count: number;
  column_count: number;
  primary_file_sha256: string;
}

const TABLE_ORDER: readonly ProteinStructureTableId[] = [
  "structures",
  "chains",
  "ligands",
  "sources",
];

function summaryString(
  summary: Readonly<Record<string, JsonValue>>,
  key: keyof TableSummary,
): string {
  const value = summary[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`protein structure integration summary requires ${key}`);
  }
  return value;
}

function summaryCount(
  summary: Readonly<Record<string, JsonValue>>,
  key: "row_count" | "column_count",
): number {
  const value = summary[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`protein structure integration summary requires non-negative ${key}`);
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
  const closure = [
    ...new Set(results.flatMap((result) => result.dependency_closure.input_asset_ids)),
  ].sort();
  if (declared.length !== closure.length ||
      declared.some((assetId, index) => assetId !== closure[index])) {
    throw new Error(
      "registered asset IDs must exactly match all protein structure result dependency closures",
    );
  }
  return declared;
}

function schemaSet() {
  const schemas = buildProteinStructureTables();
  return {
    schemas,
    byId: {
      structures: { schema: schemas.structure, definition: schemas.structureTable },
      chains: { schema: schemas.chain, definition: schemas.chainTable },
      ligands: { schema: schemas.ligand, definition: schemas.ligandTable },
      sources: { schema: schemas.source, definition: schemas.sourceTable },
    },
  };
}

function evidenceRefs(
  results: readonly OperationResultManifest[],
  input: ProteinStructureAssemblyInput,
  tableId: ProteinStructureTableId,
  evidenceKind: "provenance" | "confidence",
): PublicationCandidateResultRef[] {
  if (results.length === 0) {
    throw new Error(`protein structure table '${tableId}' requires ${evidenceKind} results`);
  }
  return resultRefs({
    results,
    taskId: input.taskId,
    buildId: input.buildId,
  });
}

export function assembleProteinStructureCandidate(
  input: ProteinStructureAssemblyInput,
): PublicationCandidate {
  if (input.datasetFamily !== PROTEIN_STRUCTURE_FAMILY_ID) {
    throw new Error("protein structure assembler only accepts protein_structure");
  }
  if (input.rowGranularity !== PROTEIN_STRUCTURE_ROW_GRANULARITY) {
    throw new Error("protein structure row granularity does not match assembly input");
  }
  if (input.tables.length !== TABLE_ORDER.length) {
    throw new Error("protein structure assembly requires structures, chains, ligands, and sources tables");
  }
  const inputById = new Map<ProteinStructureTableId, ProteinStructureTableAssemblyInput>();
  for (const table of input.tables) {
    if (inputById.has(table.tableId)) {
      throw new Error(`duplicate protein structure table '${table.tableId}'`);
    }
    inputById.set(table.tableId, table);
  }
  if (TABLE_ORDER.some((tableId) => !inputById.has(tableId))) {
    throw new Error("protein structure assembly requires every declared table");
  }
  const { schemas, byId } = schemaSet();
  assertProteinStructureRelations(schemas.relations);
  assertProteinStructureRows(input.rows);
  const validated = TABLE_ORDER.map((tableId) => {
    const tableInput = inputById.get(tableId)!;
    const expected = byId[tableId];
    const result = requireCoreResult({
      result: tableInput.result,
      taskId: input.taskId,
      buildId: input.buildId,
      operationKind: "integrate",
      outputKind: "integrated_table",
    });
    const summary = parseSummary(result);
    if (summary.table_id !== tableId || summary.schema_ref !== expected.schema.schema_id) {
      throw new Error(`protein structure table '${tableId}' summary does not match its schema`);
    }
    if (summary.column_count !== expected.definition.field_names.length) {
      throw new Error(`protein structure table '${tableId}' column count does not match schema`);
    }
    if (summary.row_count === 0) {
      throw new Error(`protein structure table '${tableId}' must not be empty`);
    }
    return {
      tableId,
      result,
      summary,
      definition: expected.definition,
      provenance: evidenceRefs(tableInput.provenanceResults, input, tableId, "provenance"),
      confidence: evidenceRefs(tableInput.confidenceResults, input, tableId, "confidence"),
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
    dataset_family: PROTEIN_STRUCTURE_FAMILY_ID,
    row_granularity: PROTEIN_STRUCTURE_ROW_GRANULARITY,
    tables: validated.map((item) => ({
      definition: item.definition,
      data_ref: resultRefForHash(item.result, item.summary.primary_file_sha256),
      row_count: item.summary.row_count,
    })),
    relations: [...schemas.relations],
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

export const proteinStructureAssembler = Object.freeze({
  familyId: PROTEIN_STRUCTURE_FAMILY_ID,
  handlerId: PROTEIN_STRUCTURE_ASSEMBLER_ID,
  assemble: assembleProteinStructureCandidate,
});
