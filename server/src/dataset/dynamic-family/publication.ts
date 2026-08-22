import { createHash } from "node:crypto";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  DatasetManifestV2,
  ManifestArtifactEntry,
  ProductAssessment,
  PublicationCandidate,
} from "@biomed/contracts";

import type { ValidationResult } from "../contracts/validation.js";

import type { SubmitDynamicFamilyBuildResult } from "./submission.js";
import { sha256FileStream } from "../adapters/hashing.js";
import { packageDigest } from "../publish/manifest.js";
import { promotePublication, type PublishResult } from "../publish/publisher.js";
import { validateMultiTableCandidate } from "../validation/multitable.js";

export interface PublishDynamicFamilyInput {
  readonly taskId: string;
  readonly taskRoot: string;
  readonly workspaceRoot: string;
  readonly buildId: string;
  readonly execution: SubmitDynamicFamilyBuildResult;
  readonly validationProfileRef: string;
  readonly signal?: AbortSignal;
  readonly publishedAt?: string;
}

export interface PublishDynamicFamilyResult {
  readonly candidate: PublicationCandidate;
  readonly manifest: DatasetManifestV2;
  readonly validation: ValidationResult;
  readonly assessment: ProductAssessment;
  readonly publication: PublishResult;
}

/** Core-owned B3/assessment/publication stage; no Agent path can enter it. */
export async function publishDynamicFamily(
  input: PublishDynamicFamilyInput,
): Promise<PublishDynamicFamilyResult> {
  const candidate = input.execution.materialization.candidate;
  if (candidate.task_id !== input.taskId || candidate.build_id !== input.buildId) {
    throw new TypeError("dynamic publication identity does not match the Core task/build");
  }
  const outputDir = path.join(input.taskRoot, "datasets_build", input.buildId);
  await mkdir(outputDir, { recursive: true });
  await rm(path.join(outputDir, "tables"), { recursive: true, force: true });
  for (const mutableFile of [
    "schema.json", "provenance.json", "product_assessment.json",
    "validation_report.json", "dataset_manifest.json",
  ]) {
    await rm(path.join(outputDir, mutableFile), { force: true });
  }
  await mkdir(path.join(outputDir, "tables"), { recursive: true });

  const schemaByRef = new Map(input.execution.materialization.schemas.map((schema) => [schema.schema_id, schema]));
  const operation = input.execution.operationResult;
  const validationTables = [];
  for (const [tableIndex, table] of candidate.tables.entries()) {
    const output = operation.output_files[table.data_ref.output_file_index];
    const schema = schemaByRef.get(table.definition.schema_ref);
    if (
      output === undefined
      || schema === undefined
      || output.sha256 !== table.data_ref.output_file_sha256
    ) throw new Error(`dynamic candidate table '${table.definition.table_id}' lacks its admitted result/schema`);
    const source = path.join(input.execution.trustedRoot, ...output.relative_path.split("/"));
    const destination = path.join(outputDir, ...output.relative_path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
    if ((await sha256FileStream(destination)) !== output.sha256) {
      throw new Error(`dynamic product copy drifted for '${table.definition.table_id}'`);
    }
    const provenanceRef = candidate.provenance_refs[tableIndex];
    const confidenceRef = candidate.confidence_refs[tableIndex];
    if (provenanceRef === undefined || confidenceRef === undefined) {
      throw new Error(`dynamic candidate table '${table.definition.table_id}' lacks evidence closure`);
    }
    const key = (ref: typeof provenanceRef) => [ref.result_manifest_id, ref.output_kind,
      ref.output_file_index, ref.output_file_sha256].join(":");
    validationTables.push({
      definition: table.definition,
      schema,
      file: {
        origin: "core_operation_result" as const,
        relative_path: output.relative_path,
        delimiter: "," as const,
        operation_result: operation,
      },
      provenance_refs: [key(provenanceRef)],
      confidence_refs: [key(confidenceRef)],
    });
  }
  await mkdir(input.workspaceRoot, { recursive: true });
  const b3 = await validateMultiTableCandidate({
    task_id: input.taskId,
    build_id: input.buildId,
    candidate: candidateReference(candidate),
    tables: validationTables,
    relations: candidate.relations,
    trusted_root: outputDir,
    forbidden_roots: [input.workspaceRoot],
    policy: { token_preservation_rules: [], profile_relation_missing_policies: {} },
  }, input.signal);
  const failed = b3.checks.filter((check) => !check.passed);
  const requiresHilAcceptance = input.execution.materialization.schemas.some((schema) =>
    schema.fields.some((field) => field.name === "review_status" || field.name === "human_review_status"),
  );
  const assessment = structuralAssessment(candidate, failed.length === 0, requiresHilAcceptance);

  await writeFile(path.join(outputDir, "schema.json"), `${JSON.stringify(input.execution.materialization.schemas, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputDir, "provenance.json"), `${JSON.stringify({
    schema_version: "1.0",
    task_id: input.taskId,
    build_id: input.buildId,
    registered_asset_ids: candidate.registered_asset_ids,
    transform_digest: input.execution.receipt.transform_digest,
    implementation_digest: input.execution.receipt.host_implementation_digest,
    operation_result_manifest_id: operation.result_manifest_id,
    sources: input.execution.receipt.input_asset_receipts.map((receipt) => ({
      asset_id: receipt.asset_id,
      locator_ref: receipt.locator_ref,
      sha256: receipt.sha256,
      size_bytes: receipt.size_bytes,
    })),
    source_receipts: input.execution.receipt.input_asset_receipts,
    core_acquisition_provenance: input.execution.sourceAcquisitionProvenance,
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(outputDir, "product_assessment.json"), `${JSON.stringify(assessment, null, 2)}\n`, "utf8");

  const artifacts: ManifestArtifactEntry[] = [];
  for (const table of candidate.tables) {
    const output = operation.output_files[table.data_ref.output_file_index]!;
    artifacts.push(await artifact(outputDir, output.relative_path,
      table.definition.role === "primary" ? "primary_dataset" : "supporting_dataset", "text/csv"));
  }
  artifacts.push(await artifact(outputDir, "schema.json", "schema", "application/json"));
  artifacts.push(await artifact(outputDir, "provenance.json", "provenance", "application/json"));
  artifacts.push(await artifact(outputDir, "product_assessment.json", "audit_report", "application/json"));
  const packageSha = packageDigest(artifacts);
  const validation: ValidationResult = {
    schema_version: "1.0",
    manifest_digest: packageSha,
    profile_ref: input.validationProfileRef,
    status: failed.length === 0 && assessment.product_status === "publishable" ? "passed" : "failed",
    checked_count: b3.checks.length,
    failed_count: failed.length + (assessment.product_status === "publishable" ? 0 : 1),
    report_path: "validation_report.json",
  };
  await writeFile(path.join(outputDir, "validation_report.json"), `${JSON.stringify({
    profile_ref: validation.profile_ref,
    checks: b3.checks,
    product_assessment: assessment,
  }, null, 2)}\n`, "utf8");
  if (validation.status !== "passed") {
    throw new Error(`dynamic multi-table product is not publishable: ${failed.map((check) => `${check.scope}:${check.check_id}`).join(", ")}`);
  }
  const primary = candidate.tables.find((table) => table.definition.role === "primary");
  if (primary === undefined) throw new Error("dynamic product has no primary table");
  const manifest: DatasetManifestV2 = {
    schema_version: "2.0",
    manifest_id: `manifest_${packageSha.slice(0, 16)}`,
    task_id: input.taskId,
    build_id: input.buildId,
    dataset_family: candidate.dataset_family,
    row_granularity: candidate.row_granularity,
    schema_ref: primary.definition.schema_ref,
    primary_key: [...primary.definition.primary_key],
    row_count: primary.row_count,
    sha256: packageSha,
    artifacts,
    source_summary: Object.fromEntries(candidate.registered_asset_ids.map((assetId) => [assetId, { asset_id: assetId }])),
    validation_summary: {
      profile_ref: validation.profile_ref,
      status: validation.status,
      checked_count: validation.checked_count,
      failed_count: validation.failed_count,
      report_path: validation.report_path,
    },
    confidence_summary: {
      source: "dynamic_string_preserving_b3",
      product_status: assessment.product_status,
      product_scores: JSON.parse(JSON.stringify(assessment.scores)) as import("@biomed/contracts").JsonValue,
      product_blockers: JSON.parse(JSON.stringify(assessment.blockers)) as import("@biomed/contracts").JsonValue,
    },
    provenance_summary: {
      source_count: candidate.registered_asset_ids.length,
      coverage: { traced_rows: primary.row_count, untraced_rows: 0, coverage_ratio: 1 },
    },
    tables: candidate.tables.map((table) => table.definition),
    relations: candidate.relations,
    candidate_refs: [candidateReference(candidate)],
  };
  await writeFile(path.join(outputDir, "dataset_manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  const publication = await promotePublication({
    outputDir,
    manifest,
    validation,
    publicationCandidate: candidate,
    expectedSourceAssetIds: new Set(candidate.registered_asset_ids),
    publishedAt: input.publishedAt,
    signal: input.signal,
  });
  return { candidate, manifest, validation, assessment, publication };
}

function structuralAssessment(
  candidate: PublicationCandidate,
  passed: boolean,
  requiresHilAcceptance: boolean,
): ProductAssessment {
  const tableCount = candidate.tables.length;
  const relationCount = candidate.relations.length;
  const score = (dimension: "schema" | "relations" | "provenance" | "reproducibility", satisfied: number, required: number) => ({
    dimension, score: required === 0 ? 1 : satisfied / required, satisfied, required,
  });
  return {
    schema_version: "1.0",
    requirement_id: "dynamic_family_structural_b3.v1",
    package_id: candidate.candidate_id,
    package_version: "1.0",
    product_status: passed && !requiresHilAcceptance ? "publishable" : "incomplete",
    scores: [
      score("schema", passed ? tableCount : 0, tableCount),
      score("relations", passed ? relationCount : 0, relationCount),
      score("provenance", passed ? candidate.registered_asset_ids.length : 0, candidate.registered_asset_ids.length),
      score("reproducibility", passed ? 1 : 0, 1),
    ],
    missing_requirements: [
      ...(passed ? [] : ["dynamic_family_structural_b3.v1"]),
      ...(requiresHilAcceptance ? ["dynamic_family_hil_acceptance.v1"] : []),
    ],
    blockers: [
      ...(passed ? [] : [{
        requirement_id: "dynamic_family_structural_b3.v1",
        dimension: "schema" as const,
        code: "artifact_incomplete" as const,
        message: "generic multi-table validation did not pass",
      }]),
      ...(requiresHilAcceptance ? [{
        requirement_id: "dynamic_family_hil_acceptance.v1",
        dimension: "confidence" as const,
        code: "human_review_pending" as const,
        message: "review-status fields require genuine HIL acceptance evidence before publication",
      }] : []),
    ],
  };
}

function candidateReference(candidate: PublicationCandidate) {
  const ref = (value: PublicationCandidate["provenance_refs"][number]) =>
    [value.result_manifest_id, value.output_kind, value.output_file_index, value.output_file_sha256].join(":");
  return {
    candidate_id: candidate.candidate_id,
    table_ids: candidate.tables.map((table) => table.definition.table_id),
    relation_ids: candidate.relations.map((relation) => relation.relation_id),
    provenance_refs: candidate.provenance_refs.map(ref),
    confidence_refs: candidate.confidence_refs.map(ref),
    audit_refs: candidate.audit_refs.map(ref),
  };
}

async function artifact(
  root: string,
  relativePath: string,
  role: ManifestArtifactEntry["role"],
  mediaType: string,
): Promise<ManifestArtifactEntry> {
  const absolute = path.join(root, ...relativePath.split("/"));
  const info = await stat(absolute);
  const sha256 = await sha256FileStream(absolute);
  return {
    schema_version: "1.0",
    artifact_id: `artifact_${createHash("sha256").update(`${relativePath}\0${sha256}`).digest("hex").slice(0, 32)}`,
    role,
    relative_path: relativePath,
    media_type: mediaType,
    size_bytes: info.size,
    sha256,
  };
}
