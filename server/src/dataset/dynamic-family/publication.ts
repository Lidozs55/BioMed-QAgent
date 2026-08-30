import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseProductAssessment,
  type CoreDerivedAssetProvenance,
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
import { parsePublicationCandidate } from "../contracts/index.js";

import type { DynamicFamilyExecutionResult } from "./submission.js";
import type { OperationResultManifest } from "@biomed/contracts";
import type { CoreAcquisitionProvenance } from "../../runtime/source-assets/registry.js";
import type { BrowserEvidenceAcceptance } from "../acquisition/browser-publication-handoff.js";
import { sha256FileStream } from "../adapters/hashing.js";
import { canonicalDigest } from "../adapters/identity.js";
import { computeHILEvidenceDigest } from "../contracts/hil-evidence.js";
import { packageDigest } from "../publish/manifest.js";
import { promotePublication, type PublishResult } from "../publish/publisher.js";
import { validateMultiTableCandidate } from "../validation/multitable.js";
import { validateLiteratureExperimentChartProfile } from "../families/index.js";
import {
  readPublicationAcceptanceContinuation,
  savePublicationAcceptanceContinuation,
  type PublicationAcceptanceContinuationV1,
} from "../../runtime/execution-continuation.js";
import { deterministicHILRequestId } from "../../runtime/hil-store.js";
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
import {
  assertProductTopology,
  coreProductTopologyDigest,
  type CoreProductTopologyRequirements,
} from "./product-requirements.js";

interface DynamicPublicationHILInput {
  readonly requirement_id: string | null;
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
  readonly materialization: DynamicFamilyExecutionResult["materialization"];
  readonly integratedResults: readonly OperationResultManifest[];
  readonly trustedRoot: string;
  readonly generation: number;
  readonly sourceAcquisitionProvenance: readonly CoreAcquisitionProvenance[];
  readonly browserEvidenceDigests: readonly string[];
  readonly browserEvidenceAcceptance: BrowserEvidenceAcceptance;
}

export type DynamicPublicationExecution = DynamicFamilyExecutionResult | BrowserPublicationExecution;

export interface PublishDynamicFamilyInput {
  readonly taskId: string;
  readonly taskRoot: string;
  readonly workspaceRoot: string;
  readonly runId: string;
  readonly requirementId: string;
  readonly execution: DynamicPublicationExecution;
  readonly validationProfileRef: string;
  /** Core-owned requested-product closure; Agent FamilySpec cannot define it. */
  readonly productRequirements: CoreProductTopologyRequirements;
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
  const runId = input.runId;
  const assertGenerationCurrent = async (): Promise<void> => {
    if (!(await input.isGenerationCurrent())) {
      throw new Error("dynamic family preflight generation is stale");
    }
  };
  const candidate = input.execution.materialization.candidate;
  const isBrowserExecution = (execution: DynamicPublicationExecution): execution is BrowserPublicationExecution => "kind" in execution && execution.kind === "browser";
  const browserExecution = isBrowserExecution(input.execution) ? input.execution : null;
  const transformExecution = browserExecution === null ? input.execution as DynamicFamilyExecutionResult : null;
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
  if (candidate.task_id !== input.taskId || candidate.requirement_id !== input.requirementId) {
    throw new TypeError("dynamic publication identity does not match the Core task/requirement");
  }
  if (input.productRequirements === undefined) {
    throw new TypeError("dynamic publication requires Core-owned product requirements");
  }
  assertProductTopology(candidate, input.productRequirements);
  await assertGenerationCurrent();
  const outputDir = path.join(input.taskRoot, "dataset_runs", runId, input.requirementId);
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
  const stagedTablePaths = new Map<string, string>();
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
    stagedTablePaths.set(table.definition.table_id, destination);
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
  await validateLiteratureExperimentChartProfile({
    profileRef: input.productRequirements.profile_ref,
    stagedTablePaths,
    sourceInputProvenance: transformExecution?.sourceInputProvenance ?? [],
    signal: input.signal,
  });
  await assertGenerationCurrent();
  await mkdir(input.workspaceRoot, { recursive: true });
  const b3Policy = input.b3Validation?.policy ?? PRODUCTION_B3_RESOURCE_POLICY;
  const b3ConfiguredHeapBytes = input.b3Validation?.configuredHeapBytes
    ?? PRODUCTION_B3_CONFIGURED_HEAP_BYTES;
  const b3ConfiguredTempBytes = input.b3Validation?.configuredTempBytes
    ?? PRODUCTION_B3_CONFIGURED_TEMP_BYTES;
  const b3IndexRoot = path.join(input.taskRoot, "dataset_runs", runId, input.requirementId, "b3-index");
  await assertGenerationCurrent();
  await mkdir(b3IndexRoot, { recursive: true });
  const b3Cleanup: B3CleanupCapability = {
    ownerId: `${input.taskId}:${input.requirementId}`,
    cleanup: async () => {
      await rm(b3IndexRoot, { recursive: true, force: true });
    },
  };
  let validationFailed = false;
  const b3 = await validateMultiTableCandidate({
      task_id: input.taskId,
      requirement_id: input.requirementId,
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
          requirementId: input.requirementId,
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
          requirementId: input.requirementId,
          generation: executionGeneration,
        });
      } catch (cleanupError) {
        if (!validationFailed) throw cleanupError;
      }
    });
  await assertGenerationCurrent();
  const failed = b3.checks.filter((check) => !check.passed);
  const reviewFieldNames = new Set([
    "review_status",
    "human_review_status",
    "confidence",
    "confidence_level",
    "extraction_confidence",
  ]);
  const requiresHilAcceptance = input.execution.materialization.schemas.some((schema) =>
    schema.fields.some((field) => reviewFieldNames.has(field.name.replaceAll("-", "_"))),
  );
  let assessment = parseProductAssessment(
    structuralAssessment(
      candidate,
      input.productRequirements,
      failed.length === 0,
      requiresHilAcceptance,
      browserExecution !== null,
    ),
  );
  let hilAcceptance: Record<string, JsonValue> | null = null;
  // Durable restart continuation for the acceptance review (HIL path only).
  let savedContinuation: PublicationAcceptanceContinuationV1 | null = null;
  let continuationReviewRequestId: string | null = null;

  await assertGenerationCurrent();
  await writeFile(path.join(outputDir, "schema.json"), `${JSON.stringify(input.execution.materialization.schemas, null, 2)}\n`, "utf8");
  const assessmentPath = path.join(outputDir, "product_assessment.json");
  await assertGenerationCurrent();
  await writeFile(assessmentPath, `${JSON.stringify(assessment, null, 2)}\n`, "utf8");
  const acquisitionByAsset = new Map(
    sourceAcquisitionProvenance.map((item) => [item.asset_id, item]),
  );
  const derivedByAsset = new Map(
    (transformExecution?.sourceInputProvenance ?? [])
      .filter((item): item is CoreDerivedAssetProvenance => "operation_kind" in item)
      .map((item) => [item.asset_id, item]),
  );
  const inputReceiptByAsset = new Map(
    (transformExecution?.receipt.input_asset_receipts ?? [])
      .map((item) => [item.asset_id, item]),
  );
  const provenanceSources = candidate.registered_asset_ids.map((assetId) => {
    const acquisition = acquisitionByAsset.get(assetId);
    const derived = derivedByAsset.get(assetId);
    const receipt = inputReceiptByAsset.get(assetId);
    return {
      asset_id: assetId,
      locator_ref:
        acquisition?.canonical_accession
        ?? acquisition?.provider_id
        ?? derived?.operation_result_id
        ?? assetId,
      sha256: receipt?.sha256 ?? assetId.slice("asset_".length),
      size_bytes: receipt?.size_bytes ?? null,
    };
  });
  // Built before the acceptance review so the durable publication
  // continuation can carry the exact provenance base; ``hil_acceptance`` is
  // appended after the review (or on its post-restart resume).
  const provenanceDocument = JSON.parse(JSON.stringify({
    schema_version: "1.0",
    task_id: input.taskId,
    requirement_id: input.requirementId,
    registered_asset_ids: candidate.registered_asset_ids,
    execution_kind: browserExecution === null ? "transform" : "browser",
    ...(browserExecution === null ? {
      transform_digest: transformExecution!.receipt.transform_digest,
      implementation_digest: transformExecution!.receipt.host_implementation_digest,
      input_asset_receipts: transformExecution!.receipt.input_asset_receipts,
    } : {}),
    operation_result_manifest_ids: integratedResults.map((result) => result.result_manifest_id),
    sources: provenanceSources,
    source_receipts: [],
    core_acquisition_provenance: sourceAcquisitionProvenance,
    ...(browserExecution === null ? {
      core_input_provenance: transformExecution!.sourceInputProvenance,
    } : {}),
    ...(browserExecution === null ? {} : { browser_evidence_acceptance: browserExecution.browserEvidenceAcceptance }),
  })) as Record<string, unknown>;

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
        requirement_id: candidate.requirement_id,
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
      product_requirements: {
        profile_ref: input.productRequirements.profile_ref,
        digest: coreProductTopologyDigest(input.productRequirements),
        table_ids: input.productRequirements.tables.map((table) => table.table_id),
        relation_ids: input.productRequirements.relations,
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
      requirement_id: input.requirementId,
      kind: "data_review" as const,
      review_type: "publication_acceptance" as const,
      blocking: true as const,
      subject,
      review_items: reviewItems,
      summary: "Accept the evidence-bound dynamic publication candidate",
      evidence: reviewedSnapshot,
      policy_ref: "dynamic_family_hil_acceptance.v1" as const,
      idempotency_key: `dynamic-family-publication:${input.requirementId}:${candidate.candidate_id}:${provisionalAssessment.sha256}`,
    };
    const expectedEvidenceDigest = computeHILEvidenceDigest(request);
    // Persist the deterministic publication continuation BEFORE the blocking
    // acceptance request exists, so an Application Host restart while the
    // review is pending can still complete the publication exactly once.
    const requestedReviewId = deterministicHILRequestId({
      task_id: input.taskId,
      run_id: input.runId,
      policy_ref: request.policy_ref,
      idempotency_key: request.idempotency_key,
      review: request,
    });
    const submissionReceipt = toJsonValue({
      kind: "transform",
      generation: transformExecution!.receipt.generation,
      transform_digest: transformExecution!.receipt.transform_digest,
      host_implementation_digest: transformExecution!.receipt.host_implementation_digest,
    });
    const savedContinuationValue: PublicationAcceptanceContinuationV1 = {
      schema_version: 1,
      continuation_kind: "publication_acceptance",
      task_id: input.taskId,
      run_id: input.runId,
      requirement_id: input.requirementId,
      candidate_digest: canonicalDigest(candidate),
      candidate: toJsonValue(candidate),
      registered_input_asset_ids: [...candidate.registered_asset_ids],
      assessment_digest: provisionalAssessment.sha256,
      assessment_size_bytes: provisionalAssessment.size_bytes,
      expected_evidence_digest: expectedEvidenceDigest,
      requested_review_id: requestedReviewId,
      submission_receipt_digest: canonicalDigest(submissionReceipt),
      reviewed_snapshot: reviewedSnapshot,
      validation_profile_ref: input.validationProfileRef,
      b3_checked_count: b3.checks.length,
      b3_checks_sha256: canonicalDigest(b3.checks),
      b3_checks: toArray(toJsonValue(b3.checks)),
      provenance_base: provenanceDocument,
      tables: tables.map((table) => ({
        table_id: table.table_id,
        schema_ref: table.schema_ref,
        role: table.role,
        relative_path: table.relative_path,
        row_count: table.row_count,
        sha256: table.sha256,
        size_bytes: table.size_bytes,
      })),
      published_publication_id: null,
      created_at: new Date().toISOString(),
    };
    savedContinuation = savedContinuationValue;
    await savePublicationAcceptanceContinuation(input.taskRoot, savedContinuationValue);
    await assertGenerationCurrent();
    const review = await input.hilGate.requestHIL(request, input.signal);
    await assertGenerationCurrent();
    if (review.request_id !== requestedReviewId) {
      // The store replayed onto a fresh request generation: re-bind the
      // continuation to the request id the durable review actually carries.
      continuationReviewRequestId = review.request_id;
      await savePublicationAcceptanceContinuation(input.taskRoot, {
        ...savedContinuationValue,
        requested_review_id: review.request_id,
      });
    }
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
      ...structuralAssessment(candidate, input.productRequirements, true, true, true),
      human_review_evidence: [reviewEvidence],
    });
    hilAcceptance = toJsonValue({ ...reviewEvidence, reviewed_snapshot: reviewedSnapshot }) as Record<string, JsonValue>;
    await assertGenerationCurrent();
    await writeFile(assessmentPath, `${JSON.stringify(assessment, null, 2)}\n`, "utf8");
  }

  await assertGenerationCurrent();
  await writeFile(path.join(outputDir, "provenance.json"), `${JSON.stringify(
    hilAcceptance === null
      ? provenanceDocument
      : { ...provenanceDocument, hil_acceptance: hilAcceptance },
    null,
    2,
  )}\n`, "utf8");

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
      ...failed.map((check) => `${check.scope}:${check.check_id}${check.detail ? ` (${check.detail})` : ""}`),
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
    requirement_id: input.requirementId,
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
  // The in-process acceptance path completed: consume the continuation so a
  // later restart can never resume an already-promoted publication.
  if (savedContinuation !== null) {
    await savePublicationAcceptanceContinuation(input.taskRoot, {
      ...savedContinuation,
      requested_review_id: continuationReviewRequestId ?? savedContinuation.requested_review_id,
      published_publication_id: publication.publication.publication_id,
    });
  }
  return { candidate, manifest, validation, assessment, publication };
}

/**
 * Structural (B3-passed, acceptance-applied) product assessment. Shared with
 * the post-restart publication continuation resume so the resumed assessment
 * is byte-identical to the in-process one.
 */
export function structuralAssessment(
  candidate: PublicationCandidate,
  productRequirements: CoreProductTopologyRequirements,
  passed: boolean,
  requiresHilAcceptance: boolean,
  hilAccepted: boolean,
): ProductAssessment {
  const tableCount = productRequirements.tables.length;
  const relationCount = productRequirements.relations.length;
  const score = (dimension: ProductAssessment["scores"][number]["dimension"], satisfied: number, required: number) => ({
    dimension, score: required === 0 ? 1 : satisfied / required, satisfied, required,
  });
  return {
    schema_version: "1.0",
    requirement_id: productRequirements.profile_ref,
    package_id: productRequirements.dataset_family,
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
      ...(passed ? [] : [productRequirements.profile_ref]),
      ...(requiresHilAcceptance && !hilAccepted ? ["dynamic_family_hil_acceptance.v1"] : []),
    ],
    blockers: [
      ...(passed ? [] : [{
        requirement_id: productRequirements.profile_ref,
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

function toArray(value: JsonValue): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function fileReceipt(absolutePath: string): Promise<{ sha256: string; size_bytes: number }> {
  const info = await stat(absolutePath);
  return { sha256: await sha256FileStream(absolutePath), size_bytes: info.size };
}

/** Receipt for one staged build artifact (relative to ``outputDir``). */
export async function artifact(
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

export interface CompletePublicationAcceptanceInput {
  continuation: PublicationAcceptanceContinuationV1;
  taskRoot: string;
  /** The run the caller believes owns this continuation (drift fence). */
  runId: string;
  /** The resolved ``publication_acceptance`` review record. */
  review: HumanReviewRecord;
  publishedAt?: string;
  signal?: AbortSignal | null;
}

export interface CompletedPublicationAcceptance {
  publication: PublishResult["publication"];
  manifest: DatasetManifestV2;
  versionDir: string;
}

/**
 * Deterministically complete a dynamic-family publication whose
 * ``publication_acceptance`` review was resolved (possibly after an
 * Application Host restart). Re-verifies every persisted binding — run
 * identity, candidate digest, staged assessment/table receipts, requested
 * review id, evidence digest — rebuilds the accepted assessment, provenance,
 * validation report, and manifest from the staged bytes, and promotes exactly
 * once (an existing immutable version is returned instead of re-promoted, and
 * the continuation is consumed).
 */
export async function completePublicationAcceptanceContinuation(
  input: CompletePublicationAcceptanceInput,
): Promise<CompletedPublicationAcceptance> {
  const record = input.continuation;
  if (record.run_id !== input.runId) {
    throw new Error(
      `publication continuation belongs to run ${record.run_id}, not ${input.runId}`,
    );
  }
  if (record.published_publication_id !== null) {
    throw new Error(
      `publication continuation was already consumed by ${record.published_publication_id}`,
    );
  }
  const candidate = parsePublicationCandidate(record.candidate);
  if (canonicalDigest(candidate) !== record.candidate_digest) {
    throw new Error("publication continuation candidate digest drift");
  }
  const outputDir = path.join(
    input.taskRoot, "dataset_runs", record.run_id, record.requirement_id,
  );
  const assessmentReceipt = await fileReceipt(
    path.join(outputDir, "product_assessment.json"),
  );
  if (
    assessmentReceipt.sha256 !== record.assessment_digest ||
    assessmentReceipt.size_bytes !== record.assessment_size_bytes
  ) {
    throw new Error("publication continuation staged assessment drift");
  }
  for (const table of record.tables) {
    const receipt = await fileReceipt(
      path.join(outputDir, ...table.relative_path.split("/")),
    );
    if (receipt.sha256 !== table.sha256 || receipt.size_bytes !== table.size_bytes) {
      throw new Error(`publication continuation staged table '${table.table_id}' drift`);
    }
  }
  if (input.review.request_id !== record.requested_review_id) {
    throw new Error(
      "publication continuation was resolved by a different review request",
    );
  }
  if (input.review.evidence_digest !== record.expected_evidence_digest) {
    throw new Error(
      "publication continuation review evidence digest does not match the reviewed candidate",
    );
  }
  if (input.review.decision.action !== "accept") {
    throw new Error(
      `publication continuation review was not accepted: ${input.review.decision.action}`,
    );
  }

  const reviewEvidence = {
    policy_ref: "dynamic_family_hil_acceptance.v1",
    request_id: input.review.request_id,
    review_id: input.review.review_id,
    evidence_digest: input.review.evidence_digest,
    decision: "accept" as const,
    reviewer: input.review.reviewer,
    reviewed_at: input.review.reviewed_at,
    reason: input.review.reason,
  };
  const productRequirements: CoreProductTopologyRequirements = {
    schema_version: "1.0",
    profile_ref: record.validation_profile_ref,
    dataset_family: candidate.dataset_family,
    tables: candidate.tables.map((table) => ({
      table_id: table.definition.table_id,
      role: table.definition.role,
      schema_ref: table.definition.schema_ref,
      min_rows: table.definition.allow_empty ? 0 : 1,
    })),
    relations: candidate.relations.map((relation) => relation.relation_id),
  };
  const assessment = parseProductAssessment({
    ...structuralAssessment(candidate, productRequirements, true, true, true),
    human_review_evidence: [reviewEvidence],
  });
  await writeFile(
    path.join(outputDir, "product_assessment.json"),
    `${JSON.stringify(assessment, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "provenance.json"),
    `${JSON.stringify({
      ...record.provenance_base,
      hil_acceptance: toJsonValue({
        ...reviewEvidence,
        reviewed_snapshot: record.reviewed_snapshot,
      }),
    }, null, 2)}\n`,
    "utf8",
  );

  const artifacts: ManifestArtifactEntry[] = [];
  for (const table of record.tables) {
    artifacts.push(await artifact(
      outputDir,
      table.relative_path,
      table.role === "primary" ? "primary_dataset" : "supporting_dataset",
      "text/csv",
    ));
  }
  artifacts.push(await artifact(outputDir, "schema.json", "schema", "application/json"));
  artifacts.push(await artifact(outputDir, "provenance.json", "provenance", "application/json"));
  artifacts.push(await artifact(outputDir, "product_assessment.json", "audit_report", "application/json"));
  const packageSha = packageDigest(artifacts);
  const validation: ValidationResult = {
    schema_version: "1.0",
    manifest_digest: packageSha,
    profile_ref: record.validation_profile_ref,
    status: "passed",
    checked_count: record.b3_checked_count,
    failed_count: 0,
    report_path: "validation_report.json",
  };
  await writeFile(
    path.join(outputDir, "validation_report.json"),
    `${JSON.stringify({
      profile_ref: validation.profile_ref,
      checks: record.b3_checks,
      product_assessment: assessment,
    }, null, 2)}\n`,
    "utf8",
  );
  const primary = candidate.tables.find((table) => table.definition.role === "primary");
  if (primary === undefined) throw new Error("dynamic product has no primary table");
  const manifest: DatasetManifestV2 = {
    schema_version: "2.0",
    manifest_id: `manifest_${packageSha.slice(0, 16)}`,
    task_id: candidate.task_id,
    requirement_id: candidate.requirement_id,
    dataset_family: candidate.dataset_family,
    row_granularity: candidate.row_granularity,
    schema_ref: primary.definition.schema_ref,
    primary_key: [...primary.definition.primary_key],
    row_count: primary.row_count,
    sha256: packageSha,
    artifacts,
    source_summary: Object.fromEntries(
      candidate.registered_asset_ids.map((assetId) => [assetId, { asset_id: assetId }]),
    ),
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
      product_scores: JSON.parse(JSON.stringify(assessment.scores)) as JsonValue,
      product_blockers: JSON.parse(JSON.stringify(assessment.blockers)) as JsonValue,
    },
    provenance_summary: {
      source_count: candidate.registered_asset_ids.length,
      coverage: { traced_rows: primary.row_count, untraced_rows: 0, coverage_ratio: 1 },
    },
    tables: candidate.tables.map((table) => table.definition),
    relations: candidate.relations,
    candidate_refs: [candidateReference(candidate)],
  };
  await writeFile(
    path.join(outputDir, "dataset_manifest.json"),
    `${JSON.stringify(manifest)}\n`,
    "utf8",
  );

  const consume = async (publicationId: string): Promise<void> => {
    await savePublicationAcceptanceContinuation(input.taskRoot, {
      ...record,
      published_publication_id: publicationId,
    });
  };
  // Exactly-once fence: a previous attempt may have promoted but crashed
  // before consuming the continuation — return the existing immutable
  // version instead of promoting twice.
  const existingVersionDir = path.join(
    outputDir,
    "publish",
    `${manifest.requirement_id}_${manifest.sha256.slice(0, 16)}`,
  );
  if (existsSync(existingVersionDir)) {
    const existing = JSON.parse(
      await readFile(path.join(existingVersionDir, "publication.json"), "utf8"),
    ) as PublishResult["publication"];
    await consume(existing.publication_id);
    return {
      publication: existing,
      manifest,
      versionDir: `publish/${manifest.requirement_id}_${manifest.sha256.slice(0, 16)}`,
    };
  }
  const publication = await promotePublication({
    outputDir,
    manifest,
    validation,
    publicationCandidate: candidate,
    expectedSourceAssetIds: new Set(record.registered_input_asset_ids),
    publishedAt: input.publishedAt,
    signal: input.signal ?? null,
  });
  await consume(publication.publication.publication_id);
  return {
    publication: publication.publication,
    manifest,
    versionDir: publication.versionDir,
  };
}

/**
 * Load the publication continuation for a requirement, rejecting a task or
 * requirement identity mismatch (returns null when no record exists).
 */
export async function loadBoundPublicationAcceptanceContinuation(
  taskRoot: string,
  taskId: string,
  requirementId: string,
): Promise<PublicationAcceptanceContinuationV1 | null> {
  const record = await readPublicationAcceptanceContinuation(taskRoot, requirementId);
  if (record === null) return null;
  if (record.task_id !== taskId || record.requirement_id !== requirementId) return null;
  return record;
}
