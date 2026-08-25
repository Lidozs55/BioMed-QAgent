import { createHash } from "node:crypto";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseProductAssessment,
  type DatasetManifestV2,
  type HILReviewItem,
  type HILSubject,
  type HumanReviewRecord,
  type JsonValue,
  type ManifestArtifactEntry,
  type ProductAssessment,
  type PublicationCandidate,
} from "@biomed/contracts";

import type { ValidationResult } from "../contracts/validation.js";

import type { SubmitDynamicFamilyBuildResult } from "./submission.js";
import type { OperationResultManifest } from "@biomed/contracts";
import type { CoreAcquisitionProvenance } from "../../runtime/source-assets/registry.js";
import type { BrowserEvidenceAcceptance } from "../acquisition/browser-publication-handoff.js";
import { sha256FileStream } from "../adapters/hashing.js";
import { canonicalDigest } from "../adapters/identity.js";
import { computeHILEvidenceDigest } from "../contracts/hil-evidence.js";
import { packageDigest } from "../publish/manifest.js";
import { promotePublication, type PublishResult } from "../publish/publisher.js";
import { validateMultiTableCandidate } from "../validation/multitable.js";
import {
  PRODUCTION_B3_CONFIGURED_HEAP_BYTES,
  PRODUCTION_B3_CONFIGURED_TEMP_BYTES,
  PRODUCTION_B3_DISK_BATCH_SIZE,
  PRODUCTION_B3_DISK_QUOTA_BYTES_PER_INDEX,
  PRODUCTION_B3_PARITY_PROOF,
  PRODUCTION_B3_RESOURCE_POLICY,
  createProductionB3DiskFactory,
} from "../validation/b3-production-policy.js";
import type { B3CleanupCapability } from "../validation/b3-backend-decision/index.js";
import type { ResourceBaselinePolicy } from "../validation/resource-baseline.js";

interface DynamicPublicationHILInput {
  readonly build_id: string | null;
  readonly kind: "data_review";
  readonly review_type: "publication_acceptance";
  readonly blocking: true;
  readonly subject: HILSubject;
  readonly review_items: HILReviewItem[];
  readonly summary: string;
  readonly evidence: JsonValue;
  readonly policy_ref: "dynamic_family_hil_acceptance.v1";
  readonly idempotency_key: string;
}

export interface DynamicPublicationHILGate {
  requestHIL(input: DynamicPublicationHILInput, signal?: AbortSignal): Promise<HumanReviewRecord>;
}

export interface BrowserPublicationExecution {
  readonly kind: "browser";
  readonly materialization: SubmitDynamicFamilyBuildResult["materialization"];
  readonly integratedResults: readonly OperationResultManifest[];
  readonly trustedRoot: string;
  readonly generation: number;
  readonly sourceAcquisitionProvenance: readonly CoreAcquisitionProvenance[];
  readonly browserEvidenceDigests: readonly string[];
  readonly browserEvidenceAcceptance: BrowserEvidenceAcceptance;
}

export type DynamicPublicationExecution = SubmitDynamicFamilyBuildResult | BrowserPublicationExecution;

export interface PublishDynamicFamilyInput {
  readonly taskId: string;
  readonly taskRoot: string;
  readonly workspaceRoot: string;
  readonly buildId: string;
  readonly execution: DynamicPublicationExecution;
  readonly validationProfileRef: string;
  readonly signal?: AbortSignal;
  readonly publishedAt?: string;
  readonly hilGate?: DynamicPublicationHILGate | null;
  /** Live Host generation fence; checked before staged writes and promotion. */
  readonly isGenerationCurrent: () => boolean | Promise<boolean>;
  /** Optional hook immediately before the immutable rename fence (tests). */
  readonly beforeFinalFence?: () => Promise<void>;
  /**
   * Production B3 resource/disk lane overrides (tests). Omitted values use
   * the benchmark-backed production policy and configured budgets.
   */
  readonly b3Validation?: PublishDynamicFamilyB3Options;
}

/** Measured resource policy and configured budgets for the production B3 lane. */
export interface PublishDynamicFamilyB3Options {
  readonly policy: ResourceBaselinePolicy;
  readonly configuredHeapBytes: number;
  readonly configuredTempBytes: number;
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
  const assertGenerationCurrent = async (): Promise<void> => {
    if (!(await input.isGenerationCurrent())) {
      throw new Error("dynamic family preflight generation is stale");
    }
  };
  const candidate = input.execution.materialization.candidate;
  const isBrowserExecution = (execution: DynamicPublicationExecution): execution is BrowserPublicationExecution => "kind" in execution && execution.kind === "browser";
  const browserExecution = isBrowserExecution(input.execution) ? input.execution : null;
  const transformExecution = browserExecution === null ? input.execution as SubmitDynamicFamilyBuildResult : null;
  if (browserExecution === null && transformExecution === null) throw new Error("dynamic publication execution variant is missing");
  const executionGeneration = browserExecution === null ? transformExecution!.receipt.generation : browserExecution.generation;
  const integratedResults: readonly OperationResultManifest[] = browserExecution === null ? [transformExecution!.operationResult] : browserExecution.integratedResults;
  const operationById = new Map<string, OperationResultManifest>(integratedResults.map((result) => [result.result_manifest_id, result]));
  const sourceAcquisitionProvenance = input.execution.sourceAcquisitionProvenance;
  if (browserExecution !== null) {
    if (browserExecution.browserEvidenceAcceptance.hilEvidenceDigest.length !== 64 || browserExecution.browserEvidenceAcceptance.acceptedBrowserEvidenceDigests.length === 0) {
      throw new Error("browser publication requires one accepted evidence-bound review");
    }
    const accepted = [...browserExecution.browserEvidenceAcceptance.acceptedBrowserEvidenceDigests].sort();
    const published = [...browserExecution.browserEvidenceDigests].sort();
    if (accepted.length !== published.length || accepted.some((digest, index) => digest !== published[index])) {
      throw new Error("browser publication evidence is outside the accepted browser evidence closure");
    }
  }
  if (candidate.task_id !== input.taskId || candidate.build_id !== input.buildId) {
    throw new TypeError("dynamic publication identity does not match the Core task/build");
  }
  await assertGenerationCurrent();
  const outputDir = path.join(input.taskRoot, "datasets_build", input.buildId);
  await mkdir(outputDir, { recursive: true });
  await assertGenerationCurrent();
  await rm(path.join(outputDir, "tables"), { recursive: true, force: true });
  for (const mutableFile of [
    "schema.json", "provenance.json", "product_assessment.json",
    "validation_report.json", "resource_report.json", "dataset_manifest.json",
  ]) {
    await assertGenerationCurrent();
    await rm(path.join(outputDir, mutableFile), { force: true });
  }
  await assertGenerationCurrent();
  await mkdir(path.join(outputDir, "tables"), { recursive: true });

  const schemaByRef = new Map(input.execution.materialization.schemas.map((schema) => [schema.schema_id, schema]));
  const resultForRef = (ref: { result_manifest_id: string }): OperationResultManifest => {
    const result = operationById.get(ref.result_manifest_id);
    if (result === undefined) throw new Error(`dynamic candidate result is missing: ${ref.result_manifest_id}`);
    return result;
  };
  const outputForRef = (ref: { result_manifest_id: string; output_file_index: number }) =>
    resultForRef(ref).output_files[ref.output_file_index];
  const validationTables = [];
  for (const [tableIndex, table] of candidate.tables.entries()) {
    await assertGenerationCurrent();
    const output = outputForRef(table.data_ref);
    const schema = schemaByRef.get(table.definition.schema_ref);
    if (
      output === undefined
      || schema === undefined
      || output.sha256 !== table.data_ref.output_file_sha256
    ) throw new Error(`dynamic candidate table '${table.definition.table_id}' lacks its admitted result/schema`);
    const source = path.join(input.execution.trustedRoot, ...output.relative_path.split("/"));
    const destination = path.join(outputDir, ...output.relative_path.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await assertGenerationCurrent();
    await copyFile(source, destination);
    await assertGenerationCurrent();
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
        operation_result: resultForRef(table.data_ref),
      },
      provenance_refs: [key(provenanceRef)],
      confidence_refs: [key(confidenceRef)],
    });
  }
  await assertGenerationCurrent();
  await mkdir(input.workspaceRoot, { recursive: true });
  const b3Policy = input.b3Validation?.policy ?? PRODUCTION_B3_RESOURCE_POLICY;
  const b3ConfiguredHeapBytes = input.b3Validation?.configuredHeapBytes
    ?? PRODUCTION_B3_CONFIGURED_HEAP_BYTES;
  const b3ConfiguredTempBytes = input.b3Validation?.configuredTempBytes
    ?? PRODUCTION_B3_CONFIGURED_TEMP_BYTES;
  const b3IndexRoot = path.join(input.taskRoot, "builds", input.buildId, "b3-index");
  await assertGenerationCurrent();
  await mkdir(b3IndexRoot, { recursive: true });
  const b3Cleanup: B3CleanupCapability = {
    ownerId: `${input.taskId}:${input.buildId}`,
    cleanup: async () => {
      await rm(b3IndexRoot, { recursive: true, force: true });
    },
  };
  let validationFailed = false;
  const b3 = await validateMultiTableCandidate({
      task_id: input.taskId,
      build_id: input.buildId,
      candidate: candidateReference(candidate),
      tables: validationTables,
      relations: candidate.relations,
      trusted_root: outputDir,
      forbidden_roots: [input.workspaceRoot],
      policy: { token_preservation_rules: [], profile_relation_missing_policies: {} },
    }, input.signal, {
      resourceBaseline: {
        policy: b3Policy,
        configuredHeapBytes: b3ConfiguredHeapBytes,
        configuredTempBytes: b3ConfiguredTempBytes,
        telemetrySink: async (telemetry) => {
          await assertGenerationCurrent();
          await writeFile(
            path.join(outputDir, "resource_report.json"),
            `${JSON.stringify(telemetry, null, 2)}\n`,
            "utf8",
          );
        },
      },
      b3Backend: {
        owner: {
          taskId: input.taskId,
          buildId: input.buildId,
          generation: executionGeneration,
        },
        factory: createProductionB3DiskFactory(),
        snapshotImmutable: true,
        parityProof: PRODUCTION_B3_PARITY_PROOF,
        cleanup: b3Cleanup,
        directory: b3IndexRoot,
        quotaBytesPerIndex: PRODUCTION_B3_DISK_QUOTA_BYTES_PER_INDEX,
        batchSize: PRODUCTION_B3_DISK_BATCH_SIZE,
      },
    }).catch((error: unknown) => {
      validationFailed = true;
      throw error;
    }).finally(async () => {
      // The validator cleans individual indexes, but task ownership also
      // requires removing the parent directory on every validation path. Do
      // not let owner cleanup replace an error from validation itself.
      try {
        await b3Cleanup.cleanup({
          taskId: input.taskId,
          buildId: input.buildId,
          generation: executionGeneration,
        });
      } catch (cleanupError) {
        if (!validationFailed) throw cleanupError;
      }
    });
  await assertGenerationCurrent();
  const failed = b3.checks.filter((check) => !check.passed);
  const requiresHilAcceptance = input.execution.materialization.schemas.some((schema) =>
    schema.fields.some((field) => field.name === "review_status" || field.name === "human_review_status"),
  );
  let assessment = parseProductAssessment(
    structuralAssessment(candidate, failed.length === 0, requiresHilAcceptance, browserExecution !== null),
  );
  let hilAcceptance: Record<string, JsonValue> | null = null;

  await assertGenerationCurrent();
  await writeFile(path.join(outputDir, "schema.json"), `${JSON.stringify(input.execution.materialization.schemas, null, 2)}\n`, "utf8");
  const assessmentPath = path.join(outputDir, "product_assessment.json");
  await assertGenerationCurrent();
  await writeFile(assessmentPath, `${JSON.stringify(assessment, null, 2)}\n`, "utf8");

  if (failed.length === 0 && requiresHilAcceptance && browserExecution === null) {
    if (input.hilGate === undefined || input.hilGate === null) {
      throw new Error("dynamic publication requires a durable HIL gate");
    }
    const provisionalAssessment = await fileReceipt(assessmentPath);
    const tables = await Promise.all(candidate.tables.map(async (table) => {
      const output = outputForRef(table.data_ref);
      if (output === undefined) throw new Error(`dynamic review table output is missing: ${table.definition.table_id}`);
      const receipt = await fileReceipt(path.join(outputDir, ...output.relative_path.split("/")));
      if (receipt.sha256 !== output.sha256 || receipt.size_bytes !== output.size_bytes) {
        throw new Error(`dynamic review staging drifted for '${table.definition.table_id}'`);
      }
      return {
        table_id: table.definition.table_id,
        role: table.definition.role,
        schema_ref: table.definition.schema_ref,
        relative_path: output.relative_path,
        row_count: table.row_count,
        sha256: receipt.sha256,
        size_bytes: receipt.size_bytes,
      };
    }));
    const reviewedSnapshot = toJsonValue({
      candidate: {
        ...candidateReference(candidate),
        canonical_sha256: canonicalDigest(candidate),
        task_id: candidate.task_id,
        build_id: candidate.build_id,
        dataset_family: candidate.dataset_family,
        row_granularity: candidate.row_granularity,
        registered_asset_ids: candidate.registered_asset_ids,
      },
      provisional_assessment: {
        requirement_id: assessment.requirement_id,
        relative_path: "product_assessment.json",
        sha256: provisionalAssessment.sha256,
        size_bytes: provisionalAssessment.size_bytes,
        product_status: assessment.product_status,
        missing_requirements: assessment.missing_requirements,
      },
      b3: {
        profile_ref: input.validationProfileRef,
        checks_sha256: canonicalDigest(b3.checks),
        checked_count: b3.checks.length,
        failed_count: 0,
      },
      tables,
    });
    const subject: HILSubject = {
      candidate_ids: [candidate.candidate_id],
      table_ids: candidate.tables.map((table) => table.definition.table_id),
    };
    const reviewItems: HILReviewItem[] = [{
      item_id: candidate.candidate_id,
      summary: "Review the evidence-bound dynamic publication candidate",
      subject,
      evidence: { reviewed_snapshot: reviewedSnapshot },
      proposed_value: { action: "publish" },
      confidence_level: null,
    }];
    const request = {
      build_id: input.buildId,
      kind: "data_review" as const,
      review_type: "publication_acceptance" as const,
      blocking: true as const,
      subject,
      review_items: reviewItems,
      summary: "Accept the evidence-bound dynamic publication candidate",
      evidence: reviewedSnapshot,
      policy_ref: "dynamic_family_hil_acceptance.v1" as const,
      idempotency_key: `dynamic-family-publication:${input.buildId}:${candidate.candidate_id}:${provisionalAssessment.sha256}`,
    };
    await assertGenerationCurrent();
    const expectedEvidenceDigest = computeHILEvidenceDigest(request);
    const review = await input.hilGate.requestHIL(request, input.signal);
    await assertGenerationCurrent();
    if (review.evidence_digest !== expectedEvidenceDigest) {
      throw new Error("dynamic publication review evidence digest does not match the reviewed candidate");
    }
    if (review.decision.action !== "accept") {
      throw new Error(`dynamic publication review was not accepted: ${review.decision.action}`);
    }
    const currentAssessment = await fileReceipt(assessmentPath);
    if (currentAssessment.sha256 !== provisionalAssessment.sha256 || currentAssessment.size_bytes !== provisionalAssessment.size_bytes) {
      throw new Error("dynamic publication provisional assessment drifted after review");
    }
    for (const table of tables) {
      const current = await fileReceipt(path.join(outputDir, ...table.relative_path.split("/")));
      if (current.sha256 !== table.sha256 || current.size_bytes !== table.size_bytes) {
        throw new Error(`dynamic publication table '${table.table_id}' drifted after review`);
      }
    }
    const reviewEvidence = {
      policy_ref: request.policy_ref,
      request_id: review.request_id,
      review_id: review.review_id,
      evidence_digest: review.evidence_digest,
      decision: "accept" as const,
      reviewer: review.reviewer,
      reviewed_at: review.reviewed_at,
      reason: review.reason,
    };
    assessment = parseProductAssessment({
      ...structuralAssessment(candidate, true, true, true),
      human_review_evidence: [reviewEvidence],
    });
    hilAcceptance = toJsonValue({ ...reviewEvidence, reviewed_snapshot: reviewedSnapshot }) as Record<string, JsonValue>;
    await assertGenerationCurrent();
    await writeFile(assessmentPath, `${JSON.stringify(assessment, null, 2)}\n`, "utf8");
  }

  await assertGenerationCurrent();
  await writeFile(path.join(outputDir, "provenance.json"), `${JSON.stringify({
    schema_version: "1.0",
    task_id: input.taskId,
    build_id: input.buildId,
    registered_asset_ids: candidate.registered_asset_ids,
    execution_kind: browserExecution === null ? "transform" : "browser",
    ...(browserExecution === null ? {
      transform_digest: transformExecution!.receipt.transform_digest,
      implementation_digest: transformExecution!.receipt.host_implementation_digest,
      input_asset_receipts: transformExecution!.receipt.input_asset_receipts,
    } : {}),
    operation_result_manifest_ids: integratedResults.map((result) => result.result_manifest_id),
    sources: sourceAcquisitionProvenance.map((provenance) => ({
      asset_id: provenance.asset_id,
      locator_ref: provenance.canonical_accession ?? provenance.provider_id,
      sha256: null,
      size_bytes: null,
    })),
    source_receipts: [],
    core_acquisition_provenance: sourceAcquisitionProvenance,
    ...(hilAcceptance === null ? {} : { hil_acceptance: hilAcceptance }),
    ...(browserExecution === null ? {} : { browser_evidence_acceptance: browserExecution.browserEvidenceAcceptance }),
  }, null, 2)}\n`, "utf8");

  const artifacts: ManifestArtifactEntry[] = [];
  for (const table of candidate.tables) {
    await assertGenerationCurrent();
    const output = outputForRef(table.data_ref);
    if (output === undefined) throw new Error(`dynamic artifact output is missing: ${table.definition.table_id}`);
    artifacts.push(await artifact(outputDir, output.relative_path,
      table.definition.role === "primary" ? "primary_dataset" : "supporting_dataset", "text/csv"));
  }
  artifacts.push(await artifact(outputDir, "schema.json", "schema", "application/json"));
  artifacts.push(await artifact(outputDir, "provenance.json", "provenance", "application/json"));
  artifacts.push(await artifact(outputDir, "product_assessment.json", "audit_report", "application/json"));
  await assertGenerationCurrent();
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
  await assertGenerationCurrent();
  await writeFile(path.join(outputDir, "validation_report.json"), `${JSON.stringify({
    profile_ref: validation.profile_ref,
    checks: b3.checks,
    product_assessment: assessment,
  }, null, 2)}\n`, "utf8");
  if (validation.status !== "passed") {
    const reasons = [
      ...failed.map((check) => `${check.scope}:${check.check_id}`),
      ...assessment.blockers.map((blocker) => `${blocker.requirement_id}:${blocker.code}`),
    ];
    throw new Error(`dynamic multi-table product is not publishable: ${reasons.join(", ")}`);
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
  await assertGenerationCurrent();
  await writeFile(path.join(outputDir, "dataset_manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
  await assertGenerationCurrent();
  const publication = await promotePublication({
    outputDir,
    manifest,
    validation,
    publicationCandidate: candidate,
    expectedSourceAssetIds: new Set(candidate.registered_asset_ids),
    publishedAt: input.publishedAt,
    signal: input.signal,
    beforeFinalFence: input.beforeFinalFence,
    fence: async () => {
      await assertGenerationCurrent();
      return true;
    },
  });
  return { candidate, manifest, validation, assessment, publication };
}

function structuralAssessment(
  candidate: PublicationCandidate,
  passed: boolean,
  requiresHilAcceptance: boolean,
  hilAccepted: boolean,
): ProductAssessment {
  const tableCount = candidate.tables.length;
  const relationCount = candidate.relations.length;
  const score = (dimension: ProductAssessment["scores"][number]["dimension"], satisfied: number, required: number) => ({
    dimension, score: required === 0 ? 1 : satisfied / required, satisfied, required,
  });
  return {
    schema_version: "1.0",
    requirement_id: "dynamic_family_structural_b3.v1",
    package_id: candidate.candidate_id,
    package_version: "1.0",
    product_status: passed && (!requiresHilAcceptance || hilAccepted) ? "publishable" : "incomplete",
    scores: [
      score("schema", passed ? tableCount : 0, tableCount),
      score("relations", passed ? relationCount : 0, relationCount),
      score("identifiers", 0, 0),
      score("provenance", passed ? candidate.registered_asset_ids.length : 0, candidate.registered_asset_ids.length),
      score("confidence", requiresHilAcceptance ? (hilAccepted ? 1 : 0) : 0, requiresHilAcceptance ? 1 : 0),
      score("reproducibility", passed ? 1 : 0, 1),
    ],
    missing_requirements: [
      ...(passed ? [] : ["dynamic_family_structural_b3.v1"]),
      ...(requiresHilAcceptance && !hilAccepted ? ["dynamic_family_hil_acceptance.v1"] : []),
    ],
    blockers: [
      ...(passed ? [] : [{
        requirement_id: "dynamic_family_structural_b3.v1",
        dimension: "schema" as const,
        code: "artifact_incomplete" as const,
        message: "generic multi-table validation did not pass",
      }]),
      ...(requiresHilAcceptance && !hilAccepted ? [{
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

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

async function fileReceipt(absolutePath: string): Promise<{ sha256: string; size_bytes: number }> {
  const info = await stat(absolutePath);
  return { sha256: await sha256FileStream(absolutePath), size_bytes: info.size };
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
