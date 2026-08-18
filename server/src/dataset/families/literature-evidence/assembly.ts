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
import type {
  FamilyAssemblerHandler,
  FamilyAssemblyInput,
} from "../../assembly/types.js";
import {
  LITERATURE_EVIDENCE_FAMILY_ID,
  LITERATURE_EVIDENCE_ROW_GRANULARITY,
  literatureEvidenceRelations,
  literatureEvidenceTables,
} from "./schema.js";

export const LITERATURE_EVIDENCE_ASSEMBLER_ID =
  "literature_evidence.assembler.v1";

interface TableSummary {
  schema_ref: string;
  row_count: number;
  file_sha256: string;
}

function summaryRecord(
  summary: Readonly<Record<string, JsonValue>>,
  key: string,
): Readonly<Record<string, JsonValue>> {
  const value = summary[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`literature integration summary requires object ${key}`);
  }
  return value;
}

function summaryString(
  summary: Readonly<Record<string, JsonValue>>,
  key: string,
): string {
  const value = summary[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`literature integration summary requires ${key}`);
  }
  return value;
}

function summaryCount(
  summary: Readonly<Record<string, JsonValue>>,
  key: string,
): number {
  const value = summary[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`literature integration summary requires non-negative ${key}`);
  }
  return value;
}

function parseTableSummary(
  summary: Readonly<Record<string, JsonValue>>,
  tableId: string,
): TableSummary {
  const tables = summaryRecord(summary, "tables");
  const table = summaryRecord(tables, tableId);
  return {
    schema_ref: summaryString(table, "schema_ref"),
    row_count: summaryCount(table, "row_count"),
    file_sha256: summaryString(table, "file_sha256"),
  };
}

type AssemblyContext = Omit<FamilyAssemblyInput, "schema">;

function registeredAssetIds(input: AssemblyContext): string[] {
  const declared = [...new Set(input.registeredAssetIds)].sort();
  const closure = [
    ...new Set(input.integrationResult.dependency_closure.input_asset_ids),
  ].sort();
  if (
    declared.length !== closure.length ||
    declared.some((assetId, index) => assetId !== closure[index])
  ) {
    throw new Error(
      "registered asset IDs must exactly match the integration dependency closure",
    );
  }
  return declared;
}

function evidenceRefs(
  results: readonly OperationResultManifest[] | undefined,
  input: AssemblyContext,
  kind: "provenance" | "confidence",
): PublicationCandidateResultRef[] {
  const values = results ?? [];
  const tableIds = new Set(literatureEvidenceTables.map(({ definition }) => definition.table_id));
  const covered = new Set<string>();
  for (const value of values) {
    const result = requireCoreResult({
      result: value,
      taskId: input.taskId,
      buildId: input.buildId,
    });
    const tableId = result.output_summary.table_id;
    if (typeof tableId !== "string" || !tableIds.has(tableId)) {
      throw new Error(`${kind} result must identify a literature table_id`);
    }
    if (covered.has(tableId) || result.output_files.length !== 1) {
      throw new Error(`${kind} requires exactly one result file per literature table`);
    }
    covered.add(tableId);
  }
  if (covered.size !== tableIds.size) {
    throw new Error(`${kind} requires exactly one result for every literature table`);
  }
  return resultRefs({ results: values, taskId: input.taskId, buildId: input.buildId });
}

export type LiteratureEvidenceAssemblyInput = Omit<FamilyAssemblyInput, "schema"> & {
  schema: DatasetSchemaV2;
};

export function assembleLiteratureEvidenceCandidate(
  input: LiteratureEvidenceAssemblyInput,
): PublicationCandidate;
export function assembleLiteratureEvidenceCandidate(
  input: FamilyAssemblyInput,
): PublicationCandidate;
export function assembleLiteratureEvidenceCandidate(
  input: FamilyAssemblyInput | LiteratureEvidenceAssemblyInput,
): PublicationCandidate {
  if (input.datasetFamily !== LITERATURE_EVIDENCE_FAMILY_ID) {
    throw new Error("literature evidence assembler only accepts literature_evidence");
  }
  if (
    input.rowGranularity !== LITERATURE_EVIDENCE_ROW_GRANULARITY ||
    input.schema.dataset_family !== input.datasetFamily ||
    input.schema.schema_id !== literatureEvidenceTables[0].schema.schema_id ||
    input.schema.row_granularity !== input.rowGranularity
  ) {
    throw new Error("literature evidence schema or row granularity does not match assembly input");
  }

  const integrationResult = requireCoreResult({
    result: input.integrationResult,
    taskId: input.taskId,
    buildId: input.buildId,
    operationKind: "integrate",
    outputKind: "integrated_table",
  });
  if (
    integrationResult.output_summary.dataset_family !== input.datasetFamily ||
    integrationResult.output_summary.row_granularity !== input.rowGranularity
  ) {
    throw new Error("literature integration summary does not match assembly input");
  }

  const tables = literatureEvidenceTables.map(({ schema, definition }) => {
    const summary = parseTableSummary(integrationResult.output_summary, definition.table_id);
    if (summary.schema_ref !== schema.schema_id) {
      throw new Error(`literature table '${definition.table_id}' schema summary mismatch`);
    }
    return {
      definition,
      data_ref: resultRefForHash(integrationResult, summary.file_sha256),
      row_count: summary.row_count,
    };
  });
  const provenanceRefs = evidenceRefs(input.provenanceResults, input, "provenance");
  const confidenceRefs = evidenceRefs(input.confidenceResults, input, "confidence");
  const assets = registeredAssetIds({ ...input, integrationResult });
  const candidateBody = {
    schema_version: "1.0" as const,
    task_id: input.taskId,
    build_id: input.buildId,
    dataset_family: input.datasetFamily,
    row_granularity: input.rowGranularity,
    tables,
    relations: [...literatureEvidenceRelations],
    provenance_refs: provenanceRefs,
    confidence_refs: confidenceRefs,
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

export const literatureEvidenceAssembler: FamilyAssemblerHandler = {
  familyId: LITERATURE_EVIDENCE_FAMILY_ID,
  handlerId: LITERATURE_EVIDENCE_ASSEMBLER_ID,
  assemble: assembleLiteratureEvidenceCandidate,
};
