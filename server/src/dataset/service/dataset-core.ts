/**
 * Application-facing Dataset Core service interface (M2, I-02/I-06).
 *
 * Agent tools depend on this interface only — never on which implementation
 * backs it. Phase 8: the legacy Python rollback bridge is deleted; the TS
 * core (``TsDatasetCoreAdapter``) is the only implementation. The wire shape
 * is the frozen DatasetBridgeResponse so the tool layer and event projection
 * stay stable.
 */

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";

import { BuildError } from "../adapters/errors.js";
import { sha256FileStreamWithSize } from "../adapters/hashing.js";
import { OperationAbortedError } from "../cooperative.js";

import {
  DATASET_BRIDGE_VERSION,
  type BuildResult,
  type DatasetBridgeResponse,
  type DatasetBuildSpec,
} from "@biomed/contracts";

import type { SourceAsset } from "../contracts/index.js";
import type { SpecValidationResult } from "../validation/index.js";
import type { BuildRecord, TypeScriptDatasetCore } from "./ts-core.js";

export interface DatasetCoreIdentity {
  taskId: string;
  runId: string;
  piSessionId: string;
  toolCallId: string;
  signal?: AbortSignal;
}

export interface ValidateDatasetBuildInput extends DatasetCoreIdentity {
  spec: DatasetBuildSpec;
}

export interface ExecuteDatasetBuildInput extends DatasetCoreIdentity {
  spec: DatasetBuildSpec;
  sourceFiles: Record<string, string>;
  mappingFiles: Record<string, string>;
  metadataFiles?: Record<string, string>;
}

export interface DatasetCoreCancelInput {
  taskId: string;
  runId: string;
  piSessionId: string;
  toolCallId: string;
  buildId: string;
}

export interface DatasetCoreService {
  validate(input: ValidateDatasetBuildInput): Promise<DatasetBridgeResponse>;
  execute(input: ExecuteDatasetBuildInput): Promise<DatasetBridgeResponse>;
  cancel(input: DatasetCoreCancelInput): Promise<void>;
}

export type { BuildRecord };

function mediaTypeFor(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".tsv" || ext === ".txt") return "text/tab-separated-values";
  if (ext === ".csv") return "text/csv";
  if (ext === ".gz") return "application/gzip";
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

/**
 * One resolved asset reference (TASK-047-A1): bytes hashed and hash wall
 * time only — never content.
 */
export interface AssetResolutionRecord {
  bindingId: string;
  role: "source" | "mapping";
  relativePath: string;
  sizeBytes: number;
  hashMs: number;
  assetId: string;
  sha256: string;
}

interface ResolvedReference {
  asset: SourceAsset;
  bytes: number;
  hashMs: number;
}

/**
 * Rebuild a SourceAsset from a task-relative reference (bridge semantics).
 * The digest is computed by streaming (bounded heap on GB-scale sources),
 * honoring the operation AbortSignal, and the pre-hash ``stat`` size is
 * cross-checked against the bytes actually consumed so a file swapped
 * between check and use is rejected instead of building on a stale identity.
 */
export async function resolveReferencedAsset(
  taskRoot: string,
  reference: string,
  signal?: AbortSignal | null,
): Promise<ResolvedReference | null> {
  const full = path.resolve(taskRoot, reference);
  if (!full.startsWith(path.resolve(taskRoot) + path.sep)) return null;
  const info = await stat(full).catch(() => null);
  if (info === null || !info.isFile()) return null;
  const started = performance.now();
  const { sha256, bytes } = await sha256FileStreamWithSize(full, signal);
  const hashMs = Math.max(0, performance.now() - started);
  if (bytes !== info.size) {
    throw new BuildError(
      `source asset changed while hashing (TOCTOU guard): stat size ${info.size} != read ${bytes} bytes for '${reference}'`,
    );
  }
  return {
    asset: {
      schema_version: "1.0",
      asset_id: `asset_${sha256}`,
      kind: "source",
      relative_path: path.relative(taskRoot, full).split(path.sep).join("/"),
      sha256,
      size_bytes: bytes,
      media_type: mediaTypeFor(full),
      generated_by_step_id: null,
      source_id: `resolved_${path.basename(full)}`,
      successful_attempt_id: null,
      derived_from_asset_id: null,
      data_level: "repository_processed",
    },
    bytes,
    hashMs,
  };
}

function newRequestId(): string {
  return `core_req_${randomUUID()}`;
}

function validationEnvelope(
  requestId: string,
  result: SpecValidationResult,
): DatasetBridgeResponse {
  return {
    version: DATASET_BRIDGE_VERSION,
    request_id: requestId,
    ok: true,
    data: {
      valid: result.valid,
      reason_codes: result.reason_codes,
      reasons: result.reasons,
    },
    error: null,
  };
}

function buildResultFrom(record: BuildRecord): BuildResult {
  const manifest = record.manifest;
  const status: BuildResult["status"] = record.rejected_sources.length > 0
    ? "partial_success"
    : "succeeded";
  return {
    status,
    valid_row_count: manifest?.row_count ?? 0,
    successful_sources: manifest === null ? [] : Object.keys(manifest.source_summary),
    rejected_sources: record.rejected_sources,
    available_artifact_roles: manifest === null
      ? []
      : [...new Set(manifest.artifacts.map((entry) => entry.role))],
    publication_id: record.publication_id,
    reason_codes: [],
    user_summary: record.rejected_sources.length > 0
      ? `Dataset build completed with ${record.rejected_sources.length} rejected source(s).`
      : "Dataset build completed and published.",
    recommended_next_action: record.rejected_sources.length > 0
      ? "review rejected source bindings"
      : "none",
    build_id: record.build_id,
  };
}

function noDataResultFrom(record: BuildRecord): BuildResult {
  return {
    status: "no_data",
    valid_row_count: 0,
    successful_sources: [],
    rejected_sources: record.rejected_sources,
    available_artifact_roles: [],
    publication_id: null,
    reason_codes: ["no_primary_data"],
    user_summary: "Every source binding was rejected; no data could be built.",
    recommended_next_action: "review the rejected bindings and retry with valid sources",
    build_id: record.build_id,
  };
}

/** The opt-in TypeScript Deterministic Core behind the frozen bridge shape. */
export class TsDatasetCoreAdapter implements DatasetCoreService {
  private readonly taskRoot: string;
  private readonly onAssetResolved: ((record: AssetResolutionRecord) => void) | null;

  constructor(
    private readonly core: TypeScriptDatasetCore,
    options: { onAssetResolved?: (record: AssetResolutionRecord) => void } = {},
  ) {
    this.taskRoot = core.taskRoot;
    this.onAssetResolved = options.onAssetResolved ?? null;
  }

  async validate(input: ValidateDatasetBuildInput): Promise<DatasetBridgeResponse> {
    const result = await this.core.validateDatasetBuildSpec(input.spec);
    return validationEnvelope(newRequestId(), result);
  }

  /** Resolve references serially with the caller's AbortSignal; missing or
   * out-of-root references are dropped (rejected binding at Core level). */
  private async resolveAll(
    references: Record<string, string>,
    role: AssetResolutionRecord["role"],
    target: Record<string, SourceAsset>,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    for (const [bindingId, reference] of Object.entries(references)) {
      const resolved = await resolveReferencedAsset(this.taskRoot, reference, signal);
      if (resolved === null) continue;
      target[bindingId] = resolved.asset;
      this.onAssetResolved?.({
        bindingId,
        role,
        relativePath: reference,
        sizeBytes: resolved.bytes,
        hashMs: resolved.hashMs,
        assetId: resolved.asset.asset_id,
        sha256: resolved.asset.sha256,
      });
    }
  }

  async execute(input: ExecuteDatasetBuildInput): Promise<DatasetBridgeResponse> {
    // Spec-level validation first: reject invalid input before any file read
    // or hash (TASK-047-A1: invalid spec = zero file reads).
    const validation = await this.core.validateDatasetBuildSpec(input.spec);
    if (!validation.valid) {
      return {
        version: DATASET_BRIDGE_VERSION,
        request_id: newRequestId(),
        ok: false,
        data: null,
        error: {
          code: "invalid_input",
          message: validation.reasons.join("; ") || "Dataset build input was rejected",
          retryable: false,
          details: { fields: ["spec"] },
        },
      };
    }
    const sourceAssets: Record<string, SourceAsset> = {};
    const mappingAssets: Record<string, SourceAsset> = {};
    try {
      await this.resolveAll(input.sourceFiles, "source", sourceAssets, input.signal);
      await this.resolveAll(input.mappingFiles, "mapping", mappingAssets, input.signal);
    } catch (error) {
      if (error instanceof OperationAbortedError) {
        return {
          version: DATASET_BRIDGE_VERSION,
          request_id: newRequestId(),
          ok: false,
          data: null,
          error: {
            code: "cancelled",
            message: "asset hashing aborted by cancel",
            retryable: false,
            details: {},
          },
        };
      }
      if (error instanceof BuildError) {
        return {
          version: DATASET_BRIDGE_VERSION,
          request_id: newRequestId(),
          ok: false,
          data: null,
          error: {
            code: "core_execution_error",
            message: error.message,
            retryable: true,
            details: {},
          },
        };
      }
      throw error;
    }
    const record = await this.core.executeDatasetBuild(input.spec, {
      runId: input.runId,
      sourceAssets,
      mappingAssets,
      signal: input.signal,
    });
    if (record.status !== "completed") {
      const allRejected = record.rejected_sources.length > 0;
      return {
        version: DATASET_BRIDGE_VERSION,
        request_id: newRequestId(),
        ok: false,
        data: null,
        error: {
          code: record.status === "cancelled" ? "cancelled" : "core_execution_error",
          message: record.error ?? "Dataset Core execution failed",
          retryable: record.status !== "cancelled",
          details: allRejected
            ? { build_result: noDataResultFrom(record) }
            : {},
        },
      };
    }
    const manifest = record.manifest;
    return {
      version: DATASET_BRIDGE_VERSION,
      request_id: newRequestId(),
      ok: true,
      data: {
        build_id: record.build_id,
        build_result: buildResultFrom(record),
        publication_id: record.publication_id,
        manifest: manifest === null ? null : {
          build_id: manifest.build_id,
          manifest_id: manifest.manifest_id,
          sha256: manifest.sha256,
        },
        artifacts: manifest === null ? [] : manifest.artifacts.map((entry) => ({
          build_id: manifest.build_id,
          artifact_id: entry.artifact_id,
          role: entry.role,
          media_type: entry.media_type,
          size_bytes: entry.size_bytes,
          sha256: entry.sha256,
        })),
        validation_summary: record.validation === null ? null : {
          status: record.validation.status,
          checked_count: record.validation.checked_count,
          failed_count: record.validation.failed_count,
        },
      },
      error: null,
    };
  }

  async cancel(input: DatasetCoreCancelInput): Promise<void> {
    this.core.cancelDatasetBuild(input.buildId);
  }
}

/** Phase 8: the TS Dataset Core is the only implementation. */
export function createDatasetCoreService(options: {
  tsCore: TypeScriptDatasetCore;
  onAssetResolved?: (record: AssetResolutionRecord) => void;
}): DatasetCoreService {
  return new TsDatasetCoreAdapter(options.tsCore, options);
}

export type { DatasetBuildSpec };
