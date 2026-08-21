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
import {
  bioactivityCompoundCrosswalkSchema,
  bioactivityCompoundCrosswalkTable,
  bioactivityIdentityRelations,
  bioactivityRelations,
  bioactivityTableEntries,
} from "./schemas.js";
import { assertBioactivityRelations, assertBioactivityRows } from "./validation.js";
import {
  BIOACTIVITY_FAMILY_ID,
  BIOACTIVITY_ROW_GRANULARITY,
  type BioactivityRows,
  type BioactivityTableId,
} from "./types.js";

export const BIOACTIVITY_ASSEMBLER_ID = "bioactivity_measurement.assembler.v1";

export interface BioactivityTableAssemblyInput {
  tableId: BioactivityTableId;
  result: OperationResultManifest;
  provenanceResults: readonly OperationResultManifest[];
  confidenceResults: readonly OperationResultManifest[];
}

export interface BioactivityAssemblyInput {
  taskId: string;
  buildId: string;
  datasetFamily: string;
  rowGranularity: string;
  tables: readonly BioactivityTableAssemblyInput[];
  registeredAssetIds: readonly string[];
  rows?: BioactivityRows;
  auditResults?: readonly OperationResultManifest[];
}

interface TableSummary {
  table_id: string;
  schema_ref: string;
  row_count: number;
  column_count: number;
  primary_file_sha256: string;
}

const REQUIRED_TABLE_ORDER: readonly BioactivityTableId[] = [
  "activities",
  "compounds",
  "assays",
  "targets",
];
const OPTIONAL_IDENTITY_TABLE: BioactivityTableId = "compound_crosswalks";

function summaryString(
  summary: Readonly<Record<string, JsonValue>>,
  key: keyof TableSummary,
): string {
  const value = summary[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`bioactivity integration summary requires ${key}`);
  }
  return value;
}

function summaryCount(
  summary: Readonly<Record<string, JsonValue>>,
  key: "row_count" | "column_count",
): number {
  const value = summary[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`bioactivity integration summary requires non-negative ${key}`);
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
    throw new Error("registered asset IDs must exactly match all bioactivity result dependency closures");
  }
  return declared;
}

function tableById(tableId: BioactivityTableId) {
  if (tableId === OPTIONAL_IDENTITY_TABLE) {
    return {
      tableId,
      schema: bioactivityCompoundCrosswalkSchema,
      definition: bioactivityCompoundCrosswalkTable,
    };
  }
  const entry = bioactivityTableEntries().find((item) => item.tableId === tableId);
  if (entry === undefined) throw new Error(`unknown bioactivity table '${tableId}'`);
  return entry;
}

function evidenceRefs(
  results: readonly OperationResultManifest[],
  input: BioactivityAssemblyInput,
  tableId: BioactivityTableId,
  kind: "provenance" | "confidence",
): PublicationCandidateResultRef[] {
  if (results.length === 0) throw new Error(`bioactivity table '${tableId}' requires ${kind} results`);
  return resultRefs({ results, taskId: input.taskId, buildId: input.buildId });
}

export function assembleBioactivityCandidate(
  input: BioactivityAssemblyInput,
): PublicationCandidate {
  if (input.datasetFamily !== BIOACTIVITY_FAMILY_ID) {
    throw new Error("bioactivity assembler only accepts bioactivity_measurement");
  }
  if (input.rowGranularity !== BIOACTIVITY_ROW_GRANULARITY) {
    throw new Error("bioactivity row granularity does not match assembly input");
  }
  if (input.tables.length !== REQUIRED_TABLE_ORDER.length &&
      input.tables.length !== REQUIRED_TABLE_ORDER.length + 1) {
    throw new Error("bioactivity assembly requires four base tables and at most one compound crosswalk table");
  }
  if (input.rows !== undefined) assertBioactivityRows(input.rows);
  assertBioactivityRelations(bioactivityRelations);

  const byId = new Map<BioactivityTableId, BioactivityTableAssemblyInput>();
  for (const table of input.tables) {
    if (byId.has(table.tableId)) throw new Error(`duplicate bioactivity table '${table.tableId}'`);
    byId.set(table.tableId, table);
  }
  if (REQUIRED_TABLE_ORDER.some((tableId) => !byId.has(tableId))) {
    throw new Error("bioactivity assembly requires activities, compounds, assays, and targets tables");
  }
  const hasIdentity = byId.has(OPTIONAL_IDENTITY_TABLE);
  if (byId.size !== REQUIRED_TABLE_ORDER.length + (hasIdentity ? 1 : 0)) {
    throw new Error("bioactivity assembly contains an unknown table");
  }
  const tableOrder = hasIdentity
    ? [...REQUIRED_TABLE_ORDER, OPTIONAL_IDENTITY_TABLE]
    : [...REQUIRED_TABLE_ORDER];

  const validated = tableOrder.map((tableId) => {
    const entry = tableById(tableId);
    const tableInput = byId.get(tableId)!;
    const result = requireCoreResult({
      result: tableInput.result,
      taskId: input.taskId,
      buildId: input.buildId,
      operationKind: "integrate",
      outputKind: "integrated_table",
    });
    const summary = parseSummary(result);
    if (summary.table_id !== tableId || summary.schema_ref !== entry.schema.schema_id) {
      throw new Error(`bioactivity table '${tableId}' summary does not match its schema`);
    }
    if (summary.column_count !== entry.definition.field_names.length) {
      throw new Error(`bioactivity table '${tableId}' column count does not match schema`);
    }
    if (summary.row_count === 0) throw new Error(`bioactivity table '${tableId}' must not be empty`);
    return {
      tableId,
      result,
      summary,
      definition: entry.definition,
      provenance: evidenceRefs(tableInput.provenanceResults, input, tableId, "provenance"),
      confidence: evidenceRefs(tableInput.confidenceResults, input, tableId, "confidence"),
    };
  });

  const assets = exactAssetClosure(validated.map((item) => item.result), input.registeredAssetIds);
  const candidateBody = {
    schema_version: "1.0" as const,
    task_id: input.taskId,
    build_id: input.buildId,
    dataset_family: BIOACTIVITY_FAMILY_ID,
    row_granularity: BIOACTIVITY_ROW_GRANULARITY,
    tables: validated.map((item) => ({
      definition: item.definition,
      data_ref: resultRefForHash(item.result, item.summary.primary_file_sha256),
      row_count: item.summary.row_count,
    })),
    relations: hasIdentity
      ? [...bioactivityRelations, ...bioactivityIdentityRelations]
      : [...bioactivityRelations],
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

export interface BioactivityAssemblerCapability {
  readonly familyId: typeof BIOACTIVITY_FAMILY_ID;
  readonly handlerId: typeof BIOACTIVITY_ASSEMBLER_ID;
  assemble(input: BioactivityAssemblyInput): PublicationCandidate;
}

export function createBioactivityAssemblerCapability(): BioactivityAssemblerCapability {
  return Object.freeze({
    familyId: BIOACTIVITY_FAMILY_ID,
    handlerId: BIOACTIVITY_ASSEMBLER_ID,
    assemble: assembleBioactivityCandidate,
  });
}

export const bioactivityAssembler = Object.freeze({
  familyId: BIOACTIVITY_FAMILY_ID,
  handlerId: BIOACTIVITY_ASSEMBLER_ID,
  assemble: assembleBioactivityCandidate,
});
