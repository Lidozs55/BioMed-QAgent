import type { JsonValue } from "@biomed/contracts";
import type {
  OperationResultManifest,
  PublicationCandidate,
} from "@biomed/contracts";
import { canonicalDigest } from "../adapters/identity.js";
import { parsePublicationCandidate } from "../contracts/index.js";
import {
  requireCoreResult,
  resultRefForHash,
  resultRefs,
} from "./helpers.js";
import type {
  FamilyAssemblerHandler,
  FamilyAssemblyInput,
} from "./types.js";

export const EXPRESSION_ASSEMBLER_ID = "gene_expression.assembler.v1";

interface ExpressionIntegrationSummary {
  dataset_family: string;
  row_granularity: string;
  schema_ref: string;
  row_count: number;
  column_count: number;
  primary_file_sha256: string;
}

function summaryString(
  summary: Readonly<Record<string, JsonValue>>,
  key: keyof ExpressionIntegrationSummary,
): string {
  const value = summary[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`expression integration summary requires ${key}`);
  }
  return value;
}

function summaryCount(
  summary: Readonly<Record<string, JsonValue>>,
  key: "row_count" | "column_count",
): number {
  const value = summary[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`expression integration summary requires non-negative ${key}`);
  }
  return value;
}

function parseIntegrationSummary(
  result: OperationResultManifest,
): ExpressionIntegrationSummary {
  return {
    dataset_family: summaryString(result.output_summary, "dataset_family"),
    row_granularity: summaryString(result.output_summary, "row_granularity"),
    schema_ref: summaryString(result.output_summary, "schema_ref"),
    row_count: summaryCount(result.output_summary, "row_count"),
    column_count: summaryCount(result.output_summary, "column_count"),
    primary_file_sha256: summaryString(result.output_summary, "primary_file_sha256"),
  };
}

function registeredAssetIds(input: FamilyAssemblyInput): string[] {
  const declared = [...new Set(input.registeredAssetIds)].sort();
  const declaredSuccessful = input.integrationResult.output_summary.successful_asset_ids;
  const closure = (Array.isArray(declaredSuccessful)
    ? declaredSuccessful.filter((value): value is string => typeof value === "string")
    : input.integrationResult.dependency_closure.input_asset_ids).sort();
  if (declared.length !== closure.length || declared.some((assetId, index) => assetId !== closure[index])) {
    throw new Error("registered asset IDs must exactly match the integration dependency closure");
  }
  return declared;
}

export function assembleExpressionCandidate(
  input: FamilyAssemblyInput,
): PublicationCandidate {
  if (input.datasetFamily !== "gene_expression") {
    throw new Error("expression assembler only accepts gene_expression");
  }
  if (input.schema.dataset_family !== input.datasetFamily) {
    throw new Error("expression schema belongs to a different family");
  }
  if (input.schema.row_granularity !== input.rowGranularity) {
    throw new Error("expression schema row granularity does not match assembly input");
  }
  const result = requireCoreResult({
    result: input.integrationResult,
    taskId: input.taskId,
    buildId: input.buildId,
    operationKind: "integrate",
    outputKind: "integrated_table",
  });
  const summary = parseIntegrationSummary(result);
  if (
    summary.dataset_family !== input.datasetFamily ||
    summary.row_granularity !== input.rowGranularity ||
    summary.schema_ref !== input.schema.schema_id
  ) {
    throw new Error("expression integration summary does not match assembly input");
  }
  const fields = input.schema.fields.map((field) => field.name);
  if (summary.column_count !== fields.length) {
    throw new Error("expression integration column count does not match schema");
  }
  const dataRef = resultRefForHash(result, summary.primary_file_sha256);
  const assets = registeredAssetIds({ ...input, integrationResult: result });
  const candidateBody = {
    schema_version: "1.0" as const,
    task_id: input.taskId,
    build_id: input.buildId,
    dataset_family: input.datasetFamily,
    row_granularity: input.rowGranularity,
    tables: [{
      definition: {
        table_id: "primary",
        schema_ref: input.schema.schema_id,
        role: "primary",
        required: true,
        allow_empty: false,
        primary_key: [...input.schema.primary_key],
        field_names: fields,
      },
      data_ref: dataRef,
      row_count: summary.row_count,
    }],
    relations: [],
    provenance_refs: resultRefs({
      results: input.provenanceResults ?? [],
      taskId: input.taskId,
      buildId: input.buildId,
    }),
    confidence_refs: resultRefs({
      results: input.confidenceResults ?? [],
      taskId: input.taskId,
      buildId: input.buildId,
    }),
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

export const geneExpressionAssembler: FamilyAssemblerHandler = {
  familyId: "gene_expression",
  handlerId: EXPRESSION_ASSEMBLER_ID,
  assemble: assembleExpressionCandidate,
};
