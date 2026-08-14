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

import { existsSync, mkdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { JsonValue } from "@biomed/contracts";

import type {
  DatasetBuildSpec,
  DatasetManifest,
  SourceAsset,
  ValidationResult,
} from "../contracts/index.js";
import { BuildError } from "../adapters/errors.js";
import { adapterParamsForBinding, getAdapter } from "../adapters/adapters.js";
import { buildProbeMapping } from "../adapters/geo/probe-mapping.js";
import { canonicalize, expressionNormalizationV1 } from "../canonicalizer/index.js";
import { checkExpressionCompatibility } from "../compat/compat_gate.js";
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
import { buildGeneExpressionSchema } from "../schema/index.js";
import {
  getValidationProfile,
  SpecValidator,
  VALIDATION_PROFILE_REFS,
  type SpecValidationResult,
} from "../validation/index.js";
import { createDefaultSchemaRegistry } from "../schema/registry.js";
import { acquireBuildLock, type BuildLockLease } from "./build-lock.js";

export interface TypeScriptDatasetCoreOptions {
  taskId: string;
  taskRoot: string;
  /** Optional per-operation wall-clock timeout (ms). */
  operationTimeoutMs?: number;
  /** Core operation lifecycle sink, receiving the owning build id (M2 I-05). */
  eventSink?: ((event: CoreEventSinkEvent, buildId: string) => void | Promise<void>) | null;
}

export type CoreEventSinkEvent = Parameters<NonNullable<CoreEventSink>>[0];

export interface ExecuteContext {
  runId: string;
  /** binding_id → SourceAsset (downloaded by the acquisition service/tools). */
  sourceAssets?: Readonly<Record<string, SourceAsset>>;
  /** binding_id → platform annotation SourceAsset (probe builds). */
  mappingAssets?: Readonly<Record<string, SourceAsset>>;
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
  batches: Map<string, ReturnType<ReturnType<typeof getAdapter>["parse"]>>;
  canonicalResults: Array<ReturnType<typeof canonicalize>>;
  integration: ReturnType<typeof integrate> | null;
  manifest: DatasetManifest | null;
  validation: ValidationResult | null;
  publicationId: string | null;
}

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
  runnerState: RunnerState;
  bindings: ReadonlyMap<string, ReturnType<typeof import("../contracts/spec.js").parseSourceBinding>>;
}): OperationRunner {
  const { spec, taskId, taskRoot, outputDir, sourceAssets, mappingAssets, runnerState, bindings } = options;
  const schema = buildGeneExpressionSchema();

  return (op): OperationOutput => {
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
        const batch = adapter.parse(asset, sourcePath, {
          buildId: spec.build_id,
          bindingId: binding.binding_id,
          schemaRef: spec.schema_ref,
          outputDir,
          parameters,
        });
        runnerState.batches.set(binding.binding_id, batch);
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
        const batch = runnerState.batches.get(op.category);
        if (batch === undefined) {
          throw new BuildError(`no parsed batch cached for binding ${op.category!}`);
        }
        let probeMap: Readonly<Record<string, string>> | undefined;
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
          const probe = buildProbeMapping({
            annotationPath,
            batchPath: path.join(outputDir, batch.file_asset.relative_path),
            bindingId: op.category,
            platformId: platformIds.length > 0 ? platformIds[0] : null,
            annotationAsset,
            outputDir,
          });
          probeMap = probe.probe_to_gene;
          probeTargetNamespace = probe.target_namespace;
          probeMappingAuditPath = probe.detail_path;
        }
        let result = canonicalize({
          batch,
          schema,
          profile: expressionNormalizationV1(),
          outputDir,
          probeMap,
          probeTargetNamespace,
        });
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
        const integration = integrate({
          results: runnerState.canonicalResults,
          mergeStrategy: spec.merge_strategy,
          schema,
          buildId: spec.build_id,
          outputDir,
        });
        runnerState.integration = integration;
        return makeOperationOutput({
          row_count: integration.rowCount,
          dedup_count: integration.dedupCount,
          conflict_count: integration.conflictCount,
          merged_file: integration.mergedPath,
        });
      }
      case "validate_profile": {
        const integration = runnerState.integration;
        if (integration === null) throw new BuildError("integration result is missing");
        const successfulAssets: Record<string, SourceAsset> = {};
        for (const result of runnerState.canonicalResults) {
          const bindingId = result.batch.binding_id ?? "";
          if (bindingId !== "" && bindingId in sourceAssets) {
            successfulAssets[bindingId] = sourceAssets[bindingId];
          }
        }
        const provenancePath = buildProvenanceDocument({
          schema,
          integration,
          canonicalResults: runnerState.canonicalResults,
          sourceAssets: successfulAssets,
          outputDir,
        });
        const auditPaths = runnerState.canonicalResults.flatMap((result) => result.auditPaths);
        const summary = sourceSummary([...bindings.keys()], runnerState);
        let manifest = assembleManifest({
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
        });
        const profile = getValidationProfile(spec.validation_profile_ref);
        const validation = profile.validate({
          manifest,
          primaryPath: integration.mergedPath, // absolute, integrator-owned
          schema,
          manifestDigest: manifest.sha256,
          outputDir,
        });
        // Re-assemble with the authoritative validation and persist once.
        manifest = assembleManifest({
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
        const manifest = runnerState.manifest;
        const validation = runnerState.validation;
        if (manifest === null || validation === null) {
          throw new BuildError("validation result is missing before publish");
        }
        // Provenance closure covers only phase-A-successful bindings (Python
        // expression_runner parity: rejected bindings contribute no rows).
        const expectedSourceAssetIds = new Set<string>();
        for (const result of runnerState.canonicalResults) {
          const bindingId = result.batch.binding_id;
          const asset = bindingId in sourceAssets ? sourceAssets[bindingId] : undefined;
          if (asset !== undefined) expectedSourceAssetIds.add(asset.asset_id);
        }
        const published = promotePublication({
          outputDir,
          manifest,
          validation,
          expectedSourceAssetIds: expectedSourceAssetIds.size > 0 ? expectedSourceAssetIds : null,
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

/** The opt-in TypeScript Dataset Core (M2 profile DATASET_CORE=ts). */
export class TypeScriptDatasetCore {
  readonly taskRoot: string;
  private readonly options: TypeScriptDatasetCoreOptions;
  private readonly activeCancels = new Map<string, AbortController>();

  constructor(options: TypeScriptDatasetCoreOptions) {
    this.options = options;
    this.taskRoot = options.taskRoot;
  }

  async validateDatasetBuildSpec(spec: DatasetBuildSpec): Promise<SpecValidationResult> {
    const validator = new SpecValidator(createDefaultSchemaRegistry(), VALIDATION_PROFILE_REFS);
    return validator.validate(spec);
  }

  async executeDatasetBuild(
    spec: DatasetBuildSpec,
    context: ExecuteContext,
  ): Promise<BuildRecord> {
    const { taskId, taskRoot } = this.options;
    const buildId = spec.build_id;
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
      manifest: null,
      validation: null,
      publicationId: null,
    };
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
      runnerState,
      bindings,
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
      return {
        build_id: buildId,
        status: outcome.status,
        error: outcome.error === null ? null : outcome.error.message,
        publication_id: runnerState.publicationId,
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
