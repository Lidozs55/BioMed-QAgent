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
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { sha256Bytes } from "../adapters/hashing.js";

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

/** Rebuild a SourceAsset from a task-relative reference (bridge semantics). */
async function resolveReferencedAsset(
  taskRoot: string,
  reference: string,
): Promise<SourceAsset | null> {
  const full = path.resolve(taskRoot, reference);
  if (!full.startsWith(path.resolve(taskRoot) + path.sep)) return null;
  const info = await stat(full).catch(() => null);
  if (info === null || !info.isFile()) return null;
  const bytes = await readFile(full);
  const sha256 = sha256Bytes(bytes);
  return {
    schema_version: "1.0",
    asset_id: `asset_${sha256}`,
    kind: "source",
    relative_path: path.relative(taskRoot, full).split(path.sep).join("/"),
    sha256,
    size_bytes: info.size,
    media_type: mediaTypeFor(full),
    generated_by_step_id: null,
    source_id: `resolved_${path.basename(full)}`,
    successful_attempt_id: null,
    derived_from_asset_id: null,
    data_level: "repository_processed",
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

  constructor(private readonly core: TypeScriptDatasetCore) {
    this.taskRoot = core.taskRoot;
  }

  async validate(input: ValidateDatasetBuildInput): Promise<DatasetBridgeResponse> {
    const result = await this.core.validateDatasetBuildSpec(input.spec);
    return validationEnvelope(newRequestId(), result);
  }

  async execute(input: ExecuteDatasetBuildInput): Promise<DatasetBridgeResponse> {
    const sourceAssets: Record<string, SourceAsset> = {};
    for (const [bindingId, reference] of Object.entries(input.sourceFiles)) {
      const asset = await resolveReferencedAsset(this.taskRoot, reference);
      if (asset !== null) sourceAssets[bindingId] = asset;
    }
    const mappingAssets: Record<string, SourceAsset> = {};
    for (const [bindingId, reference] of Object.entries(input.mappingFiles)) {
      const asset = await resolveReferencedAsset(this.taskRoot, reference);
      if (asset !== null) mappingAssets[bindingId] = asset;
    }
    // Spec-level validation first: reject invalid input before any execution.
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
}): DatasetCoreService {
  return new TsDatasetCoreAdapter(options.tsCore);
}

export type { DatasetBuildSpec };
