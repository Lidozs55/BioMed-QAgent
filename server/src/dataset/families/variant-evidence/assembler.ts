import type {
  DatasetSchemaV2,
  OperationResultManifest,
  PublicationCandidate,
} from "@biomed/contracts";
import { canonicalDigest } from "../../adapters/identity.js";
import { parsePublicationCandidate } from "../../contracts/index.js";
import {
  requireCoreResult,
  resultRefForHash,
  resultRefs,
} from "../../assembly/helpers.js";
import type { FamilyAssemblyInput } from "../../assembly/types.js";
import { buildVariantEvidenceTables } from "./schema.js";
import { assertVariantEvidenceRows } from "./validation.js";
import type {
  VariantAssertionEvidenceInput,
  VariantEvidenceRecordInput,
  VariantEvidenceSourceInput,
} from "./types.js";
import {
  VARIANT_EVIDENCE_FAMILY_ID,
  VARIANT_EVIDENCE_ROW_GRANULARITY,
} from "./types.js";

export const VARIANT_EVIDENCE_ASSEMBLER_ID = "variant_evidence.assembler.v1";

export interface VariantEvidenceAssemblyInput extends Omit<FamilyAssemblyInput, "schema"> {
  schema: DatasetSchemaV2;
  evidenceResult: OperationResultManifest;
  sourceResult: OperationResultManifest;
  rows?: {
    assertions: readonly VariantAssertionEvidenceInput[];
    evidence: readonly VariantEvidenceRecordInput[];
    sources: readonly VariantEvidenceSourceInput[];
  };
}

interface TableSummary {
  dataset_family: string;
  row_granularity: string;
  schema_ref: string;
  row_count: number;
  column_count: number;
  primary_file_sha256: string;
}

function summary(result: OperationResultManifest, label: string): TableSummary {
  const value = result.output_summary;
  const strings = ["dataset_family", "row_granularity", "schema_ref", "primary_file_sha256"] as const;
  for (const key of strings) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      throw new Error(`${label} result summary requires ${key}`);
    }
  }
  for (const key of ["row_count", "column_count"] as const) {
    if (typeof value[key] !== "number" || !Number.isSafeInteger(value[key]) || value[key] < 0) {
      throw new Error(`${label} result summary requires non-negative ${key}`);
    }
  }
  return {
    dataset_family: value.dataset_family as string,
    row_granularity: value.row_granularity as string,
    schema_ref: value.schema_ref as string,
    row_count: value.row_count as number,
    column_count: value.column_count as number,
    primary_file_sha256: value.primary_file_sha256 as string,
  };
}

function registeredAssetIds(
  declaredIds: readonly string[],
  results: readonly OperationResultManifest[],
): string[] {
  const declared = [...new Set(declaredIds)].sort();
  const closure = [...new Set(results.flatMap((result) => result.dependency_closure.input_asset_ids))].sort();
  if (declared.length !== closure.length || declared.some((assetId, index) => assetId !== closure[index])) {
    throw new Error("registered asset IDs must exactly match all variant evidence result dependency closures");
  }
  return declared;
}

function requireTableResult(
  result: OperationResultManifest,
  input: VariantEvidenceAssemblyInput,
): OperationResultManifest {
  return requireCoreResult({
    result,
    taskId: input.taskId,
    requirementId: input.requirementId,
    operationKind: "integrate",
    outputKind: "integrated_table",
  });
}

export function assembleVariantEvidenceCandidate(
  input: VariantEvidenceAssemblyInput,
): PublicationCandidate {
  if (input.datasetFamily !== VARIANT_EVIDENCE_FAMILY_ID) {
    throw new Error("variant evidence assembler only accepts variant_evidence");
  }
  if (input.rowGranularity !== VARIANT_EVIDENCE_ROW_GRANULARITY) {
    throw new Error("variant evidence assembly requires the declared assertion granularity");
  }
  const schemas = buildVariantEvidenceTables();
  if (input.schema.schema_id !== schemas.variant.schema_id) {
    throw new Error("variant evidence assembly requires the variant assertion schema");
  }
  const primary = requireTableResult(input.integrationResult, input);
  const evidence = requireTableResult(input.evidenceResult, input);
  const source = requireTableResult(input.sourceResult, input);
  const primarySummary = summary(primary, "variant assertion");
  const evidenceSummary = summary(evidence, "evidence");
  const sourceSummary = summary(source, "source");
  for (const [label, item, expectedSchema, expectedGranularity] of [
    ["variant assertion", primarySummary, schemas.variant, VARIANT_EVIDENCE_ROW_GRANULARITY],
    ["evidence", evidenceSummary, schemas.evidence, "one evidence item supporting one variant assertion"],
    ["source", sourceSummary, schemas.source, "one source carrier record"],
  ] as const) {
    if (item.dataset_family !== VARIANT_EVIDENCE_FAMILY_ID || item.schema_ref !== expectedSchema.schema_id || item.row_granularity !== expectedGranularity) {
      throw new Error(`${label} result summary does not match its variant evidence schema`);
    }
  }
  if (primarySummary.row_count === 0 || evidenceSummary.row_count === 0 || sourceSummary.row_count === 0) {
    throw new Error("variant evidence primary and supporting tables must not be empty");
  }
  if (primarySummary.column_count !== schemas.variant.fields.length || evidenceSummary.column_count !== schemas.evidence.fields.length || sourceSummary.column_count !== schemas.source.fields.length) {
    throw new Error("variant evidence result column count does not match schema");
  }
  if (input.rows !== undefined) assertVariantEvidenceRows(input.rows, schemas);

  const results = [primary, evidence, source];
  const assets = registeredAssetIds(input.registeredAssetIds, results);
  const candidateBody = {
    schema_version: "1.0" as const,
    task_id: input.taskId,
    requirement_id: input.requirementId,
    dataset_family: VARIANT_EVIDENCE_FAMILY_ID,
    row_granularity: VARIANT_EVIDENCE_ROW_GRANULARITY,
    tables: [
      {
        definition: schemas.variantTable,
        data_ref: resultRefForHash(primary, primarySummary.primary_file_sha256),
        row_count: primarySummary.row_count,
      },
      {
        definition: schemas.evidenceTable,
        data_ref: resultRefForHash(evidence, evidenceSummary.primary_file_sha256),
        row_count: evidenceSummary.row_count,
      },
      {
        definition: schemas.sourceTable,
        data_ref: resultRefForHash(source, sourceSummary.primary_file_sha256),
        row_count: sourceSummary.row_count,
      },
    ],
    relations: [...schemas.relations],
    provenance_refs: resultRefs({
      results: input.provenanceResults ?? [],
      taskId: input.taskId,
      requirementId: input.requirementId,
    }),
    confidence_refs: resultRefs({
      results: input.confidenceResults ?? [],
      taskId: input.taskId,
      requirementId: input.requirementId,
    }),
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

export interface VariantEvidenceAssemblerCapability {
  readonly familyId: typeof VARIANT_EVIDENCE_FAMILY_ID;
  readonly handlerId: typeof VARIANT_EVIDENCE_ASSEMBLER_ID;
  assemble(input: VariantEvidenceAssemblyInput): PublicationCandidate;
}

export function createVariantEvidenceAssemblerCapability(): VariantEvidenceAssemblerCapability {
  return Object.freeze({
    familyId: VARIANT_EVIDENCE_FAMILY_ID,
    handlerId: VARIANT_EVIDENCE_ASSEMBLER_ID,
    assemble: assembleVariantEvidenceCandidate,
  });
}
