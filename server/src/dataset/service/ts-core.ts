/**
 * TypeScript Deterministic Dataset Core service (M2, I-02/I-03/I-05).
 *
 * Wires the Phase 4 ported components into a runnable core behind the
 * ``DatasetCoreService`` interface:
 *
 * ```text
 * validate spec (SpecValidator)
 * → acquire[*] → parse[*] (adapters) → canonicalize[*] → compatibility gate
 * → integrate → validate profile → publish (release invariants + atomic promotion)
 * ```
 *
 * Runtime infrastructure added by M2: per-operation wall-clock timeout,
 * cooperative cancellation, build lock (one publisher per task+build), and
 * the core operation event sink. Publication layout stays
 * ``<taskRoot>/datasets_build/<buildId>/publish/<pubId>/...`` so the durable
 * artifact API keeps serving files without changes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type {
  JsonValue,
  PublicationCandidate,
} from "@biomed/contracts";

import type {
  DataBatch,
  DatasetBuildSpec,
  DatasetManifest,
  SourceAsset,
  ValidationResult,
} from "../contracts/index.js";
import { parsePublicationCandidate } from "../contracts/index.js";
import { BuildError } from "../adapters/errors.js";
import { throwIfAborted } from "../cooperative.js";
import { adapterParamsForBinding, getAdapter } from "../adapters/adapters.js";
import { sha256FileStream } from "../adapters/hashing.js";
import { createDefaultFamilyAssemblerRegistry } from "../assembly/index.js";
import { buildProbeMapping } from "../adapters/geo/probe-mapping.js";
import type { ProbeIndex } from "../adapters/geo/probe-index.js";
import type { CanonicalizationResult } from "../canonicalizer/index.js";
import { canonicalize, expressionNormalizationV1 } from "../canonicalizer/index.js";
import { checkExpressionCompatibility } from "../compat/compat_gate.js";
import type { IntegrationResult } from "../integrator/integrator.js";
import { integrate } from "../integrator/integrator.js";
import { assembleManifest, buildProvenanceDocument, writeManifest } from "../publish/manifest.js";
import { promotePublication } from "../publish/publisher.js";
import {
  buildOperationPlan,
  DatasetBuildExecutor,
  makeOperationOutput,
  type CoreEventSink,
  type OperationOutput,
  type OperationRunner,
} from "../runtime/index.js";
import {
  getValidationProfile,
  SpecValidator,
  type SpecValidationResult,
} from "../validation/index.js";
import { createDefaultDatasetFamilyRegistry } from "../families/index.js";
import { acquireBuildLock, type BuildLockLease } from "./build-lock.js";
import type { DatasetHILGate } from "../review/hil-policy.js";
import { reviewBatchForHIL } from "../review/hil-policy.js";
import { evaluateConfidence, mappingConfidence } from "../confidence/evaluator.js";
import { writeConfidenceArtifact } from "../confidence/artifact.js";
import { delimitedRowsFromFileAsync } from "../adapters/text.js";
import type { HumanReviewState } from "../contracts/data.js";

export interface TypeScriptDatasetCoreOptions {
  taskId: string;
  taskRoot: string;
  /** Optional per-operation wall-clock timeout (ms). */
  operationTimeoutMs?: number;
  /** Core operation lifecycle sink, receiving the owning build id (M2 I-05). */
  eventSink?: ((event: CoreEventSinkEvent, buildId: string) => void | Promise<void>) | null;
  /** Runtime-owned durable review primitive; Dataset Core only supplies policy. */
  hilGate?: DatasetHILGate | null;
}

export type CoreEventSinkEvent = Parameters<NonNullable<CoreEventSink>>[0];

export interface ExecuteContext {
  runId: string;
  /** binding_id → SourceAsset (downloaded by the acquisition service/tools). */
  sourceAssets?: Readonly<Record<string, SourceAsset>>;
  /** binding_id → platform annotation SourceAsset (probe builds). */
  mappingAssets?: Readonly<Record<string, SourceAsset>>;
  /** binding_id → explicit metadata SourceAsset (e.g. GEO SOFT metadata). */
  metadataAssets?: Readonly<Record<string, SourceAsset>>;
  signal?: AbortSignal;
}

export interface BuildRecord {
  build_id: string;
  status: string;
  error: string | null;
  publication_id: string | null;
  manifest: DatasetManifest | null;
  validation: ValidationResult | null;
  completed_operations: string[];
  /** Phase-A rejected binding ids (partial/no-data builds). */
  rejected_sources: string[];
}

interface RunnerState {
  batches: Map<string, DataBatch>;
  canonicalResults: Array<CanonicalizationResult>;
  integration: IntegrationResult | null;
  candidate: PublicationCandidate | null;
  manifest: DatasetManifest | null;
  validation: ValidationResult | null;
  publicationId: string | null;
}

const EMPTY_MERGED_BATCH: DataBatch = {
  batch_id: "",
  binding_id: "",
  dataset_family: "",
  row_granularity: "",
  schema_ref: "",
  file_asset: null,
  row_count: 0,
  column_count: 0,
  parser_id: "",
  parser_version: "",
  statistics: {},
  warnings: [],
  declared_mappings: [],
};

function placeholderValidation(profileRef: string): ValidationResult {
  return {
    schema_version: "1.0",
    manifest_digest: "",
    profile_ref: profileRef,
    status: "failed",
    checked_count: 0,
    failed_count: 0,
    report_path: null,
  };
}

function sourceSummary(
  bindings: readonly string[],
  runner: RunnerState,
): Record<string, JsonValue> {
  const summary: Record<string, JsonValue> = {};
  for (const bindingId of bindings) {
    const batch = runner.batches.get(bindingId);
    if (batch !== undefined) {
      summary[bindingId] = { row_count: batch.row_count };
    }
  }
  return summary;
}

async function effectiveConfidenceCounts(options: {
  integration: IntegrationResult;
  canonicalResults: readonly CanonicalizationResult[];
  sourceAssets: Readonly<Record<string, SourceAsset>>;
  signal?: AbortSignal;
}): Promise<Map<string, number>> {
  const batchBySourceId = new Map<string, string>();
  for (const result of options.canonicalResults) {
    const asset = options.sourceAssets[result.batch.binding_id];
    if (asset === undefined) {
      throw new BuildError(`confidence lineage is missing source asset for ${result.batch.binding_id}`);
    }
    if (batchBySourceId.has(asset.source_id)) {
      throw new BuildError(`confidence lineage source_id '${asset.source_id}' is ambiguous`);
    }
    batchBySourceId.set(asset.source_id, result.batch.batch_id);
  }
  const counts = new Map<string, number>();
  let headerSeen = false;
  let sourceIndex = -1;
  for await (const { values } of delimitedRowsFromFileAsync(
    options.integration.mergedPath,
    ",",
    options.signal,
  )) {
    if (!headerSeen) {
      headerSeen = true;
      sourceIndex = values.indexOf("source_id");
      if (sourceIndex < 0) {
        throw new BuildError("integrated primary has no source_id lineage column");
      }
      continue;
    }
    const sourceId = values[sourceIndex] ?? "";
    const batchId = batchBySourceId.get(sourceId);
    if (batchId === undefined) {
      throw new BuildError(`integrated row references unknown source_id '${sourceId}'`);
    }
    counts.set(batchId, (counts.get(batchId) ?? 0) + 1);
  }
  if (!headerSeen) throw new BuildError("integrated primary is missing its header");
  const effectiveTotal = [...counts.values()].reduce((total, count) => total + count, 0);
  if (effectiveTotal !== options.integration.rowCount) {
    throw new BuildError(
      `confidence lineage count ${effectiveTotal} does not match integrated primary ${options.integration.rowCount}`,
    );
  }
  return counts;
}

function reviewedHumanState(
  result: CanonicalizationResult,
  mappingState: HumanReviewState,
): HumanReviewState {
  if (mappingState === "pending" || mappingState === "rejected") return mappingState;
  const mappingReview = result.batch.statistics["mapping_human_review_state"];
  if (mappingReview === "corrected" || mappingReview === "accepted") {
    mappingState = mappingReview;
  }
  const unitCorrection = result.batch.statistics["human_unit_correction"];
  if (
    unitCorrection !== null &&
    typeof unitCorrection === "object" &&
    !Array.isArray(unitCorrection) &&
    unitCorrection["method"] === "human_correction"
  ) {
    return "corrected";
  }
  return mappingState;
}

/**
 * The fixed-skeleton operation runner (Python ``expression_runner.py`` wiring).
 * Returns sync or async OperationOutput per operation kind.
 */
export function createTsCoreOperationRunner(options: {
  spec: DatasetBuildSpec;
  taskId: string;
  taskRoot: string;
  outputDir: string;
  sourceAssets: Readonly<Record<string, SourceAsset>>;
  mappingAssets: Readonly<Record<string, SourceAsset>>;
  metadataAssets: Readonly<Record<string, SourceAsset>>;
  runnerState: RunnerState;
  bindings: ReadonlyMap<string, ReturnType<typeof import("../contracts/spec.js").parseSourceBinding>>;
  /** Phase-A bindings recovered from checkpoint rehydration (WP-A5). */
  rehydratedBindingIds: Set<string>;
  /** I-04 publish fence: true while this build still owns its lock. */
  fence?: (() => Promise<boolean>) | null;
  hilGate?: DatasetHILGate | null;
}): OperationRunner {
  const { spec, taskId, taskRoot, outputDir, sourceAssets, mappingAssets, metadataAssets, runnerState, bindings, rehydratedBindingIds } = options;
  const fence = options.fence ?? null;
  const hilGate = options.hilGate ?? null;
  const familyRegistry = createDefaultDatasetFamilyRegistry();
  familyRegistry.get(spec.dataset_family);
  const schema = familyRegistry.schemaRegistry().get(spec.schema_ref);

  const assembler = createDefaultFamilyAssemblerRegistry()
    .createCapability(spec.dataset_family);

  return async (op, upstream, signal, suspension, upstreamResults = {}): Promise<OperationOutput> => {
    throwIfAborted(signal);
    switch (op.kind) {
      case "acquire": {
        const asset = sourceAssets[op.category];
        if (asset === undefined) {
          throw new BuildError(`no source asset supplied for binding ${op.category!}`);
        }
        const assetPath = path.join(taskRoot, asset.relative_path);
        if (!existsSync(assetPath)) {
          throw new BuildError(`source asset file is missing: ${asset.relative_path}`);
        }
        return makeOperationOutput({
          binding_id: op.category,
          source_id: asset.source_id,
          asset_id: asset.asset_id,
        });
      }
      case "parse": {
        const binding = bindings.get(op.category);
        if (binding === undefined) {
          throw new BuildError(`unknown binding ${op.category!}`);
        }
        const asset = sourceAssets[op.category];
        if (asset === undefined) {
          throw new BuildError(`no source asset supplied for binding ${op.category!}`);
        }
        const adapter = getAdapter(binding.adapter_id);
        const parameters = adapterParamsForBinding(binding);
        const sourcePath = path.join(taskRoot, asset.relative_path);
        let metadataPath: string | null = null;
        const metadataAsset = metadataAssets[op.category];
        if (metadataAsset !== undefined) {
          metadataPath = path.join(taskRoot, metadataAsset.relative_path);
          if (!existsSync(metadataPath)) {
            throw new BuildError(
              `metadata asset file is missing: ${metadataAsset.relative_path}`,
            );
          }
        }
        const batch = await adapter.parse(asset, sourcePath, {
          buildId: spec.build_id,
          bindingId: binding.binding_id,
          schemaRef: spec.schema_ref,
          outputDir,
          parameters,
          metadataPath,
          signal,
        });
        runnerState.batches.set(binding.binding_id, batch);
        // I-04 no-replay resume: persist the parsed batch so a downstream op
        // that re-runs after this op is reused has a durable, honest source
        // (re-deriving statistics/declared_mappings from the raw rows is not
        // possible). Same path as the executor's stateDir (outputDir/state).
        mkdirSync(path.join(outputDir, "state", "parsed"), { recursive: true });
        writeFileSync(
          path.join(outputDir, "state", "parsed", `${binding.binding_id}.json`),
          JSON.stringify(batch),
        );
        return makeOperationOutput({
          binding_id: binding.binding_id,
          batch_id: batch.batch_id,
          schema_ref: batch.schema_ref,
          row_count: batch.row_count,
          column_count: batch.column_count,
          file: batch.file_asset?.relative_path ?? null,
        });
      }
      case "canonicalize": {
        const parsedBatch = runnerState.batches.get(op.category);
        if (parsedBatch === undefined) {
          throw new BuildError(`no parsed batch cached for binding ${op.category!}`);
        }
        const normalizationProfile = expressionNormalizationV1();
        const reviewed = await reviewBatchForHIL({
          batch: parsedBatch,
          profile: normalizationProfile,
          gate: hilGate,
          buildId: spec.build_id,
          signal,
          suspension: suspension ?? null,
        });
        const batch = reviewed.batch;
        runnerState.batches.set(batch.binding_id, batch);
        let probeIndex: ProbeIndex | undefined;
        let probeTargetNamespace: string | undefined;
        let probeMappingAuditPath: string | undefined;
        const annotationAsset = mappingAssets[op.category];
        if (annotationAsset !== undefined) {
          const annotationPath = path.join(taskRoot, annotationAsset.relative_path);
          if (!existsSync(annotationPath)) {
            throw new BuildError(
              `mapping asset file is missing: ${annotationAsset.relative_path}`,
            );
          }
          if (batch.file_asset === null) {
            throw new BuildError("batch file asset is missing before probe mapping");
          }
          const platformIds = Array.isArray(batch.statistics.platform_ids)
            ? batch.statistics.platform_ids.map(String)
            : [];
          const probe = await buildProbeMapping({
            annotationPath,
            batchPath: path.join(outputDir, batch.file_asset.relative_path),
            bindingId: op.category,
            platformId: platformIds.length > 0 ? platformIds[0] : null,
            annotationAsset,
            outputDir,
            signal,
            materializeProbeMap: false,
          });
          probeIndex = probe.probe_index;
          probeTargetNamespace = probe.target_namespace;
          probeMappingAuditPath = probe.detail_path;
        }
        let result: CanonicalizationResult;
        try {
          result = await canonicalize(
            {
              batch,
              schema,
              profile: normalizationProfile,
              outputDir,
              probeIndex,
              probeTargetNamespace,
              unitCorrection: reviewed.unitCorrection,
            },
            signal,
          );
        } finally {
          probeIndex?.destroy();
        }
        if (probeMappingAuditPath !== undefined) {
          result = {
            ...result,
            auditPaths: [...result.auditPaths, probeMappingAuditPath],
          };
        }
        runnerState.canonicalResults.push(result);
        return makeOperationOutput({
          binding_id: op.category,
          row_count: result.rowCount,
          file: result.canonicalPath,
          rejected_count: result.rejectedCount,
        });
      }
      case "compatibility_gate": {
        const gate = checkExpressionCompatibility({
          spec,
          results: runnerState.canonicalResults,
        });
        if (!gate.compatible) {
          throw new BuildError(`compatibility gate failed: ${gate.reasons.join("; ")}`);
        }
        return makeOperationOutput({ compatible: true, reasons: [...gate.reasons] });
      }
      case "integrate": {
        if (runnerState.canonicalResults.length === 0) {
          throw new BuildError("cannot integrate zero sources");
        }
        const integration = await integrate({
          results: runnerState.canonicalResults,
          mergeStrategy: spec.merge_strategy,
          schema,
          buildId: spec.build_id,
          outputDir,
          signal,
        });
        runnerState.integration = integration;
        const successfulAssetIds = runnerState.canonicalResults
          .map((result) => sourceAssets[result.batch.binding_id ?? ""]?.asset_id)
          .filter((assetId): assetId is string => assetId !== undefined)
          .sort();
        const primaryFileSha256 = await sha256FileStream(integration.mergedPath, signal);
        const primaryFileSize = (await stat(integration.mergedPath)).size;
        return makeOperationOutput({
          dataset_family: spec.dataset_family,
          row_granularity: spec.row_granularity,
          schema_ref: spec.schema_ref,
          row_count: integration.rowCount,
          column_count: schema.fields.length,
          primary_file_sha256: primaryFileSha256,
          successful_asset_ids: successfulAssetIds,
          dedup_count: integration.dedupCount,
          conflict_count: integration.conflictCount,
          merged_file: integration.mergedPath,
        }, [{
          relative_path: path.relative(taskRoot, integration.mergedPath).replaceAll(path.sep, "/"),
          size_bytes: primaryFileSize,
          sha256: primaryFileSha256,
        }]);
      }
      case "assemble": {
        const integrationResult = upstreamResults.integrate;
        if (integrationResult === undefined) {
          throw new BuildError("committed integration result is missing before assemble");
        }
        const candidate = assembler.assemble({
          taskId,
          buildId: spec.build_id,
          datasetFamily: spec.dataset_family,
          rowGranularity: spec.row_granularity,
          schema,
          integrationResult,
          registeredAssetIds: Array.isArray(integrationResult.output_summary.successful_asset_ids)
            ? integrationResult.output_summary.successful_asset_ids.filter((value): value is string => typeof value === "string")
            : integrationResult.dependency_closure.input_asset_ids,
        });
        runnerState.candidate = candidate;
        return makeOperationOutput(candidate as unknown as Record<string, unknown>);
      }
      case "validate_profile": {
        const integration = runnerState.integration;
        if (integration === null) throw new BuildError("integration result is missing");
        const candidate = runnerState.candidate ?? parsePublicationCandidate(upstream.assemble);
        runnerState.candidate = candidate;
        if (candidate.task_id !== taskId || candidate.build_id !== spec.build_id) {
          throw new BuildError("publication candidate identity does not match the build");
        }
        const primaryTable = candidate.tables.find((table) => table.definition.role === "primary");
        if (primaryTable === undefined || primaryTable.row_count !== integration.rowCount) {
          throw new BuildError("publication candidate primary does not match integration");
        }
        const successfulAssets: Record<string, SourceAsset> = {};
        for (const result of runnerState.canonicalResults) {
          const bindingId = result.batch.binding_id ?? "";
          if (bindingId !== "" && bindingId in sourceAssets) {
            successfulAssets[bindingId] = sourceAssets[bindingId];
          }
        }
        const provenancePath = await buildProvenanceDocument({
          schema,
          integration,
          canonicalResults: runnerState.canonicalResults,
          sourceAssets: successfulAssets,
          outputDir,
          signal,
        });
        const effectiveCounts = await effectiveConfidenceCounts({
          integration,
          canonicalResults: runnerState.canonicalResults,
          sourceAssets,
          signal,
        });
        const batchDefaults = runnerState.canonicalResults.flatMap((result) => {
          const recordCount = effectiveCounts.get(result.batch.batch_id) ?? 0;
          if (recordCount === 0) return [];
          const mapping = mappingConfidence(result.batch.declared_mappings);
          const sourceDatabase = result.batch.statistics["source_database"];
          const declaredChannel = result.batch.statistics["extraction_channel"];
          const channel = typeof declaredChannel === "string"
            ? declaredChannel
            : typeof sourceDatabase === "string" &&
                ["gdc", "xena", "reactome", "pubmed"].includes(sourceDatabase)
              ? "official_api"
              : "deterministic_parser";
          const evaluated = evaluateConfidence({
            confidence_id: `confidence_batch_${result.batch.batch_id}`,
            batch_id: result.batch.batch_id,
            record_id: `batch_default_${result.batch.batch_id}`,
            channel,
            components: {
              source_reliability: "high",
              extraction_reliability: "high",
              mapping_reliability: mapping.reliability,
              cross_source_consistency: "not_checked",
              human_review_state: reviewedHumanState(result, mapping.human_review_state),
            },
            reasons: mapping.reasons,
          });
          return [{
            schema_version: "1.0" as const,
            batch_id: result.batch.batch_id,
            record_count: recordCount,
            level: evaluated.level,
            channel: evaluated.channel,
            components: evaluated.components,
            reasons: evaluated.reasons,
          }];
        });
        const confidencePath = await writeConfidenceArtifact(outputDir, {
          schema_version: "1.0",
          batch_defaults: batchDefaults,
          record_overrides: [],
        });
        const auditPaths = [
          ...runnerState.canonicalResults.flatMap((result) => result.auditPaths),
          confidencePath,
        ];
        const summary = sourceSummary([...bindings.keys()], runnerState);
        let manifest = await assembleManifest({
          taskId,
          buildId: spec.build_id,
          spec,
          schema,
          integration,
          canonicalResults: runnerState.canonicalResults,
          provenancePath,
          auditPaths: auditPaths.filter((item) => existsSync(item)),
          validation: placeholderValidation(spec.validation_profile_ref),
          sourceSummary: summary,
          outputDir,
          signal,
        });
        const profile = getValidationProfile(spec.validation_profile_ref);
        const validation = await profile.validate({
          manifest,
          primaryPath: integration.mergedPath, // absolute, integrator-owned
          schema,
          manifestDigest: manifest.sha256,
          outputDir,
          signal,
        });
        // Re-assemble with the authoritative validation and persist once.
        manifest = await assembleManifest({
          taskId,
          buildId: spec.build_id,
          spec,
          schema,
          integration,
          canonicalResults: runnerState.canonicalResults,
          provenancePath,
          auditPaths: auditPaths.filter((item) => existsSync(item)),
          validation,
          sourceSummary: summary,
          outputDir,
          signal,
          reusePrimaryEntry: manifest.artifacts.find((item) => item.role === "primary_dataset") ?? null,
        });
        writeManifest(manifest, outputDir);
        runnerState.manifest = manifest;
        runnerState.validation = validation;
        return makeOperationOutput({
          status: validation.status,
          checked_count: validation.checked_count,
          failed_count: validation.failed_count,
          manifest_digest: manifest.sha256,
        });
      }
      case "publish": {
        const candidate = runnerState.candidate;
        if (candidate === null) {
          throw new BuildError("publication candidate is missing before publish");
        }
        if (candidate.task_id !== taskId || candidate.build_id !== spec.build_id) {
          throw new BuildError("publication candidate identity does not match publish build");
        }
        const manifest = runnerState.manifest;
        const validation = runnerState.validation;
        if (manifest === null || validation === null) {
          throw new BuildError("validation result is missing before publish");
        }
        // Provenance closure covers only phase-A-successful bindings (Python
        // expression_runner parity: rejected bindings contribute no rows).
        const expectedSourceAssetIds = new Set<string>();
        for (const bindingId of rehydratedBindingIds) {
          const asset = bindingId in sourceAssets ? sourceAssets[bindingId] : undefined;
          if (asset !== undefined) expectedSourceAssetIds.add(asset.asset_id);
        }
        for (const result of runnerState.canonicalResults) {
          const bindingId = result.batch.binding_id;
          const asset = bindingId in sourceAssets ? sourceAssets[bindingId] : undefined;
          if (asset !== undefined) expectedSourceAssetIds.add(asset.asset_id);
        }
        const published = await promotePublication({
          outputDir,
          manifest,
          validation,
          publicationCandidate: candidate,
          expectedSourceAssetIds: expectedSourceAssetIds.size > 0 ? expectedSourceAssetIds : null,
          signal,
          fence,
        });
        runnerState.publicationId = published.publicationId;
        return makeOperationOutput({
          publication_id: published.publicationId,
          version_dir: published.versionDir,
          supersedes: published.supersedesPublicationId,
        });
      }
      default:
        throw new BuildError(`unknown operation kind ${String(op.kind)}`);
    }
  };
}

/** The TypeScript Dataset Core (default since Phase 7; opt-in when introduced in M2). */
export class TypeScriptDatasetCore {
  readonly taskRoot: string;
  private readonly options: TypeScriptDatasetCoreOptions;
  private readonly activeCancels = new Map<string, AbortController>();

  constructor(options: TypeScriptDatasetCoreOptions) {
    this.options = options;
    this.taskRoot = options.taskRoot;
  }

  async validateDatasetBuildSpec(spec: DatasetBuildSpec): Promise<SpecValidationResult> {
    const familyRegistry = createDefaultDatasetFamilyRegistry();
    const validator = new SpecValidator(
      familyRegistry.schemaRegistry(),
      familyRegistry.validationProfileRefs(),
      familyRegistry,
    );
    return validator.validate(spec);
  }

  async executeDatasetBuild(
    spec: DatasetBuildSpec,
    context: ExecuteContext,
  ): Promise<BuildRecord> {
    const { taskId, taskRoot } = this.options;
    const buildId = spec.build_id;
    // Admission lookups are pure and may throw. Resolve them before taking the
    // fenced build lease so invalid direct Core calls cannot strand the lock.
    const familyRegistry = createDefaultDatasetFamilyRegistry();
    familyRegistry.get(spec.dataset_family);
    familyRegistry.schemaRegistry().get(spec.schema_ref);
    const outputDir = path.join(taskRoot, "datasets_build", buildId);
    const stateDir = path.join(outputDir, "state");
    mkdirSync(outputDir, { recursive: true });

    const lease: BuildLockLease = await acquireBuildLock(
      { lockRoot: path.join(taskRoot, "state", "build-locks") },
      taskId,
      buildId,
      context.runId,
    );
    const controller = new AbortController();
    const combined = new AbortController();
    const onAbort = (): void => combined.abort();
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (context.signal?.aborted === true) {
      combined.abort();
    } else {
      context.signal?.addEventListener("abort", onAbort, { once: true });
    }
    this.activeCancels.set(buildId, controller);
    const signal = combined.signal;
    const runnerState: RunnerState = {
      batches: new Map(),
      canonicalResults: [],
      integration: null,
      candidate: null,
      manifest: null,
      validation: null,
      publicationId: null,
    };
    const rehydratedBindingIds = new Set<string>();
    const perBindingOutcomes: Record<string, import("../contracts/index.js").BindingRejection> = {};
    const bindings = new Map(
      spec.source_bindings.map((binding) => [binding.binding_id, binding]),
    );
    const runner = createTsCoreOperationRunner({
      spec,
      taskId,
      taskRoot,
      outputDir,
      sourceAssets: context.sourceAssets ?? {},
      mappingAssets: context.mappingAssets ?? {},
      metadataAssets: context.metadataAssets ?? {},
      runnerState,
      bindings,
      rehydratedBindingIds,
      fence: async (): Promise<boolean> => lease.assertOwned(),
      hilGate: this.options.hilGate ?? null,
    });
    const executor = new DatasetBuildExecutor({
      taskId,
      buildId,
      stateDir,
      taskRoot,
      plan: buildOperationPlan(spec),
      runOperation: runner,
      cancellationRequested: () => signal.aborted,
      cancellationSignal: signal,
      operationTimeoutMs: this.options.operationTimeoutMs ?? 0,
      // Cross-restart continuation: rebuild in-memory runner state from the
      // checkpoint so the plan can continue from the suspension point.
      rehydrateCompletedRunners: true,
      onRehydratedOperation: (op, output) => {
        if (op.kind === "parse") {
          const bindingId = String(output.binding_id ?? "");
          const parsedPath = path.join(stateDir, "parsed", `${bindingId}.json`);
          if (bindingId !== "" && existsSync(parsedPath)) {
            try {
              runnerState.batches.set(bindingId, JSON.parse(readFileSync(parsedPath, "utf8")) as DataBatch);
            } catch {
              // Fail closed: leave the batch unreconstructed; a downstream
              // re-run (e.g. canonicalize) then fails with a clear error.
            }
          }
        } else if (op.kind === "canonicalize") {
          const bindingId = String(output.binding_id ?? "");
          if (bindingId !== "") rehydratedBindingIds.add(bindingId);
        } else if (op.kind === "integrate") {
          runnerState.integration = {
            batch: EMPTY_MERGED_BATCH,
            mergedPath: String(output.merged_file ?? ""),
            rowCount: typeof output.row_count === "number" ? output.row_count : 0,
            dedupCount: typeof output.dedup_count === "number" ? output.dedup_count : 0,
            conflictCount: typeof output.conflict_count === "number" ? output.conflict_count : 0,
            conflictsPath: null,
            tempStoreBytes: 0,
            tempStoreRows: 0,
          };
        } else if (op.kind === "assemble") {
          runnerState.candidate = parsePublicationCandidate(output);
        } else if (op.kind === "validate_profile") {
          const manifestPath = path.join(outputDir, "dataset_manifest.json");
          const validationPath = path.join(outputDir, "validation_report.json");
          if (existsSync(manifestPath) && existsSync(validationPath)) {
            runnerState.manifest = JSON.parse(
              readFileSync(manifestPath, "utf8"),
            ) as DatasetManifest;
            runnerState.validation = JSON.parse(
              readFileSync(validationPath, "utf8"),
            ) as ValidationResult;
          }
        }
      },
      eventSink: this.options.eventSink === undefined || this.options.eventSink === null
        ? null
        : (event) => this.options.eventSink?.(event, buildId),
      sourceAssets: context.sourceAssets ?? {},
      mappingAssets: context.mappingAssets ?? {},
      perBindingOutcomes,
      discardOutputs: (op) => {
        // K1: best-effort hygiene for cancelled/timeout operations.
        if (op.kind === "parse" || op.kind === "canonicalize") {
          void rm(path.join(outputDir, "batches", `${op.category}`), { recursive: true, force: true });
        }
      },
    });
    let outcome: Awaited<ReturnType<DatasetBuildExecutor["run"]>>;
    try {
      outcome = await executor.run();
      // When the whole plan was checkpoint-completed (re-execution of a
      // finished build), the publish runner does not re-run — its output
      // still carries the deterministic publication id.
      const publishOutput = executor.getOutput("publish");
      const publicationId = runnerState.publicationId ??
        (typeof publishOutput?.publication_id === "string"
          ? publishOutput.publication_id
          : null);
      return {
        build_id: buildId,
        status: outcome.status,
        error: outcome.error === null ? null : outcome.error.message,
        publication_id: publicationId,
        manifest: runnerState.manifest,
        validation: runnerState.validation,
        completed_operations: outcome.completedOperationIds,
        rejected_sources: Object.keys(perBindingOutcomes),
      };
    } finally {
      this.activeCancels.delete(buildId);
      controller.signal.removeEventListener("abort", onAbort);
      context.signal?.removeEventListener("abort", onAbort);
      await lease.release();
    }
  }

  cancelDatasetBuild(buildId: string): void {
    this.activeCancels.get(buildId)?.abort();
  }

  async getBuild(buildId: string): Promise<BuildRecord | null> {
    const { taskRoot } = this.options;
    const outputDir = path.join(taskRoot, "datasets_build", buildId);
    const manifestPath = path.join(outputDir, "dataset_manifest.json");
    if (!existsSync(manifestPath)) return null;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as DatasetManifest;
    const reportPath = path.join(outputDir, "validation_report.json");
    const validation = existsSync(reportPath)
      ? (JSON.parse(await readFile(reportPath, "utf8")) as unknown)
      : null;
    return {
      build_id: buildId,
      status: "completed",
      error: null,
      publication_id: null,
      manifest,
      validation: validation === null ? null : (validation as ValidationResult),
      completed_operations: [],
      rejected_sources: [],
    };
  }

  async listBuildArtifacts(buildId: string): Promise<Array<{ artifact_id: string; relative_path: string; role: string }>> {
    const build = await this.getBuild(buildId);
    if (build?.manifest === null || build?.manifest === undefined) return [];
    return build.manifest.artifacts.map((entry) => ({
      artifact_id: entry.artifact_id,
      relative_path: entry.relative_path,
      role: entry.role,
    }));
  }
}

export type { DatasetBuildSpec, SourceAsset, ValidationResult };
