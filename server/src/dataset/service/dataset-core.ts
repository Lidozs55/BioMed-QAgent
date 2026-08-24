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
import { readdir, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import path from "node:path";

import { BuildError } from "../adapters/errors.js";
import { sha256FileStreamWithSize } from "../adapters/hashing.js";
import { OperationAbortedError, throwIfAborted } from "../cooperative.js";

import {
  DATASET_BRIDGE_VERSION,
  type BuildResult,
  type CoreAcquisitionRequest,
  type DatasetBridgeResponse,
  type DatasetBuildSpec,
  type ProviderRevisionEvidenceV1,
  type RegisteredSourceAssetRole,
  type SourceAssetRegistrationReceipt,
} from "@biomed/contracts";

import {
  parseProviderRevisionEvidenceV1,
  type SourceAsset,
} from "../contracts/index.js";
import type { CoreAcquisitionResult } from "../acquisition/runtime.js";
import { createDefaultDatasetFamilyRegistry } from "../families/index.js";
import { providerCarrierBinding } from "../runtime/provider-bindings.js";
import { SourceAssetRegistry } from "../../runtime/source-assets/registry.js";
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
  /** Optional until an authoritative revision-scoped schema path is activated. */
  providerRevisionEvidence?: readonly ProviderRevisionEvidenceV1[];
}

export interface ExecuteDatasetBuildInput extends DatasetCoreIdentity {
  spec: DatasetBuildSpec;
  sourceFiles: Record<string, string>;
  mappingFiles: Record<string, string>;
  metadataFiles?: Record<string, string>;
  /** Task-owned provider facts; never synthesized from build or request data. */
  providerRevisionEvidence?: readonly ProviderRevisionEvidenceV1[];
}

export interface DatasetCoreCancelInput {
  taskId: string;
  runId: string;
  piSessionId: string;
  toolCallId: string;
  buildId: string;
}

export interface DatasetCoreAcquireInput extends DatasetCoreIdentity {
  request: CoreAcquisitionRequest;
}

export interface DatasetCoreService {
  validate(input: ValidateDatasetBuildInput): Promise<DatasetBridgeResponse>;
  acquire(input: DatasetCoreAcquireInput): Promise<CoreAcquisitionResult>;
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
  role: "source" | "mapping" | "metadata";
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

const REGISTERED_ASSET_ID = /^asset_[0-9a-f]{64}$/;

function isRegisteredAssetId(reference: string): boolean {
  return REGISTERED_ASSET_ID.test(reference);
}

async function uniqueAssetFile(taskRoot: string, assetId: string, signal?: AbortSignal): Promise<string> {
  const assetRoot = path.resolve(taskRoot, "source_assets", assetId);
  const sourceRoot = path.resolve(taskRoot, "source_assets");
  if (!assetRoot.startsWith(`${sourceRoot}${path.sep}`)) {
    throw new BuildError(`registered asset '${assetId}' escaped source_assets`);
  }
  const rootInfo = await stat(assetRoot).catch(() => null);
  if (rootInfo === null || !rootInfo.isDirectory()) {
    throw new BuildError(`registered asset '${assetId}' directory is missing`);
  }
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    throwIfAborted(signal);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      throwIfAborted(signal);
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new BuildError(`registered asset '${assetId}' contains a symbolic link`);
      }
      if (entry.isDirectory()) {
        await visit(candidate);
      } else if (entry.isFile()) {
        files.push(candidate);
      } else {
        throw new BuildError(`registered asset '${assetId}' contains a non-file entry`);
      }
      if (files.length > 1) {
        throw new BuildError(`registered asset '${assetId}' must contain exactly one file`);
      }
    }
  };
  await visit(assetRoot);
  const file = files[0];
  if (file === undefined) throw new BuildError(`registered asset '${assetId}' contains no file`);
  return path.relative(taskRoot, file).split(path.sep).join("/");
}

function sourceAssetFromReceipt(receipt: Awaited<ReturnType<SourceAssetRegistry["register"]>>): SourceAsset {
  return {
    schema_version: "1.0",
    asset_id: receipt.asset_ref.asset_id,
    kind: "source",
    relative_path: receipt.relative_path,
    sha256: receipt.sha256,
    size_bytes: receipt.size_bytes,
    media_type: receipt.media_type,
    generated_by_step_id: null,
    source_id: receipt.source_id,
    successful_attempt_id: receipt.receipt_id,
    derived_from_asset_id: null,
    data_level: "repository_processed",
  };
}

interface VerifiedRegisteredAsset {
  asset: SourceAsset;
  receipt: SourceAssetRegistrationReceipt;
}

class ProviderRevisionEvidenceError extends BuildError {}

async function verifyRegisteredAssetStream(
  registry: SourceAssetRegistry,
  assetId: string,
  signal: AbortSignal | undefined,
  role: RegisteredSourceAssetRole,
): Promise<VerifiedRegisteredAsset> {
  throwIfAborted(signal);
  const resolved = await registry.resolveRole(assetId, role);
  if (resolved.registration_receipt.asset_ref.asset_id !== assetId) {
    throw new BuildError(`registered asset receipt does not match '${assetId}'`);
  }
  for await (const chunk of resolved.content) {
    void chunk;
    throwIfAborted(signal);
  }
  return {
    asset: sourceAssetFromReceipt(resolved.registration_receipt),
    receipt: resolved.registration_receipt,
  };
}

function receiptKey(receipt: SourceAssetRegistrationReceipt): string {
  return `${receipt.asset_ref.role}:${receipt.asset_ref.asset_id}`;
}

async function bindProviderRevisionEvidence(
  values: readonly ProviderRevisionEvidenceV1[] | undefined,
  taskId: string,
  registry: SourceAssetRegistry,
  buildReceipts?: ReadonlyMap<string, SourceAssetRegistrationReceipt>,
): Promise<readonly ProviderRevisionEvidenceV1[] | null> {
  if (values === undefined) return null;
  const bound: ProviderRevisionEvidenceV1[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    let evidence: ProviderRevisionEvidenceV1;
    try {
      evidence = parseProviderRevisionEvidenceV1(value);
    } catch (error) {
      throw new ProviderRevisionEvidenceError(
        `provider revision evidence was rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const receipt = evidence.source_asset_registration_receipt;
    if (receipt.task_id !== taskId || receipt.asset_ref.task_id !== taskId) {
      throw new ProviderRevisionEvidenceError("provider revision evidence belongs to a different task");
    }
    const key = receiptKey(receipt);
    if (seen.has(key)) {
      throw new ProviderRevisionEvidenceError(`provider revision evidence duplicates receipt '${receipt.receipt_id}'`);
    }
    seen.add(key);
    let registered: SourceAssetRegistrationReceipt;
    try {
      registered = await registry.verifyRegistrationReceipt(receipt);
    } catch (error) {
      throw new ProviderRevisionEvidenceError(
        `provider revision evidence receipt was rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const buildReceipt = buildReceipts?.get(key);
    if (
      buildReceipts !== undefined
      && (buildReceipt === undefined || JSON.stringify(buildReceipt) !== JSON.stringify(registered))
    ) {
      throw new ProviderRevisionEvidenceError(
        "provider revision evidence is not bound to this build input receipt",
      );
    }
    bound.push(evidence);
  }
  return Object.freeze(bound);
}

function newRequestId(): string {
  return `core_req_${randomUUID()}`;
}

function invalidInputEnvelope(message: string, fields: string[]): DatasetBridgeResponse {
  return {
    version: DATASET_BRIDGE_VERSION,
    request_id: newRequestId(),
    ok: false,
    data: null,
    error: {
      code: "invalid_input",
      message,
      retryable: false,
      details: { fields },
    },
  };
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
  private readonly acquisition: ((input: DatasetCoreAcquireInput) => Promise<CoreAcquisitionResult>) | null;

  constructor(
    private readonly core: TypeScriptDatasetCore,
    options: {
      onAssetResolved?: (record: AssetResolutionRecord) => void;
      acquisition?: (input: DatasetCoreAcquireInput) => Promise<CoreAcquisitionResult>;
    } = {},
  ) {
    this.taskRoot = core.taskRoot;
    this.onAssetResolved = options.onAssetResolved ?? null;
    this.acquisition = options.acquisition ?? null;
  }

  async validate(input: ValidateDatasetBuildInput): Promise<DatasetBridgeResponse> {
    if (input.taskId !== this.core.taskId) {
      return invalidInputEnvelope("dataset build task identity does not match the Core task", ["taskId"]);
    }
    try {
      const providerRevisionEvidence = await bindProviderRevisionEvidence(
        input.providerRevisionEvidence,
        input.taskId,
        new SourceAssetRegistry(input.taskId, this.taskRoot),
      );
      const result = await this.core.validateDatasetBuildSpec(input.spec, {
        providerRevisionEvidence,
      });
      return validationEnvelope(newRequestId(), result);
    } catch (error) {
      if (error instanceof BuildError || error instanceof TypeError) {
        return invalidInputEnvelope(
          error instanceof Error ? error.message : String(error),
          ["providerRevisionEvidence"],
        );
      }
      throw error;
    }
  }

  async acquire(input: DatasetCoreAcquireInput): Promise<CoreAcquisitionResult> {
    if (this.acquisition === null) throw new Error("Core acquisition is not configured");
    if (input.request.task_id !== input.taskId) throw new Error("acquisition request belongs to a different task");
    return this.acquisition(input);
  }

  /** Resolve references serially with the caller's AbortSignal; missing or
   * out-of-root references are dropped (rejected binding at Core level). */
  private async resolveAll(
    references: Record<string, string>,
    role: AssetResolutionRecord["role"],
    target: Record<string, SourceAsset>,
    signal: AbortSignal | undefined,
    registry: SourceAssetRegistry,
    registeredSourceAssetIds: Set<string>,
    buildReceipts: Map<string, SourceAssetRegistrationReceipt>,
    registeredAssetRole: RegisteredSourceAssetRole,
  ): Promise<void> {
    for (const [bindingId, reference] of Object.entries(references)) {
      throwIfAborted(signal);
      if (isRegisteredAssetId(reference)) {
        try {
          const relativePath = await uniqueAssetFile(this.taskRoot, reference, signal);
          const receipt = await registry.register({
            sourceId: bindingId,
            relativePath,
            role: registeredAssetRole,
          });
          if (receipt.asset_ref.asset_id !== reference || receipt.relative_path !== relativePath) {
            throw new BuildError(`registered asset receipt does not match '${reference}'`);
          }
          const verified = await verifyRegisteredAssetStream(
            registry,
            reference,
            signal,
            registeredAssetRole,
          );
          target[bindingId] = verified.asset;
          buildReceipts.set(receiptKey(verified.receipt), verified.receipt);
          if (role === "source") registeredSourceAssetIds.add(verified.asset.asset_id);
          this.onAssetResolved?.({
            bindingId,
            role,
            relativePath,
            sizeBytes: verified.asset.size_bytes,
            hashMs: 0,
            assetId: verified.asset.asset_id,
            sha256: verified.asset.sha256,
          });
        } catch (error) {
          if (error instanceof OperationAbortedError || error instanceof BuildError) throw error;
          throw new BuildError(
            `registered asset '${reference}' was rejected: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        continue;
      }
      const resolved = await resolveReferencedAsset(this.taskRoot, reference, signal);
      if (resolved === null) continue;
      const receipt = await registry.register({
        sourceId: bindingId,
        relativePath: resolved.asset.relative_path,
        role: registeredAssetRole,
      });
      const registered = await verifyRegisteredAssetStream(
        registry,
        receipt.asset_ref.asset_id,
        signal,
        registeredAssetRole,
      );
      target[bindingId] = registered.asset;
      buildReceipts.set(receiptKey(registered.receipt), registered.receipt);
      if (role === "source") registeredSourceAssetIds.add(registered.asset.asset_id);
      registry.recordLegacyPathCompatibilityUse(reference);
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
    if (input.taskId !== this.core.taskId) {
      return invalidInputEnvelope("dataset build task identity does not match the Core task", ["taskId"]);
    }
    // Spec-level validation first: reject invalid input before any file read
    // or hash (TASK-047-A1: invalid spec = zero file reads).
    const validation = await this.core.validateDatasetBuildSpec(input.spec, {
      providerRevisionEvidence: input.providerRevisionEvidence === undefined
        ? null
        : input.providerRevisionEvidence,
    });
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
    const metadataAssets: Record<string, SourceAsset> = {};
    const registeredSourceAssetIds = new Set<string>();
    const sourceAssetRegistry = new SourceAssetRegistry(input.taskId, this.taskRoot);
    const providerCarrier = providerCarrierBinding(
      input.spec.dataset_family,
      input.spec.source_bindings[0]?.source ?? "",
      input.spec.source_bindings[0]?.adapter_id ?? "",
      input.spec.schema_ref,
    );
    try {
      const buildReceipts = new Map<string, SourceAssetRegistrationReceipt>();
      await this.resolveAll(
        input.sourceFiles,
        "source",
        sourceAssets,
        input.signal,
        sourceAssetRegistry,
        registeredSourceAssetIds,
        buildReceipts,
        providerCarrier === null ? "source" : "carrier",
      );
      await this.resolveAll(
        input.mappingFiles,
        "mapping",
        mappingAssets,
        input.signal,
        sourceAssetRegistry,
        registeredSourceAssetIds,
        buildReceipts,
        "mapping",
      );
      await this.resolveAll(
        input.metadataFiles ?? {},
        "metadata",
        metadataAssets,
        input.signal,
        sourceAssetRegistry,
        registeredSourceAssetIds,
        buildReceipts,
        "metadata",
      );
      const providerRevisionEvidence = await bindProviderRevisionEvidence(
        input.providerRevisionEvidence,
        input.taskId,
        sourceAssetRegistry,
        buildReceipts,
      );
      const family = createDefaultDatasetFamilyRegistry().get(input.spec.dataset_family);
      const registeredIdsForCore = family.runtime_id === "registered_multitable.runtime.v1"
        ? registeredSourceAssetIds
        : undefined;
      const record = await this.core.executeDatasetBuild(input.spec, {
        runId: input.runId,
        sourceAssets,
        registeredSourceAssetIds: registeredIdsForCore,
        mappingAssets,
        metadataAssets,
        providerRevisionEvidence,
        registrationReceipts: Object.freeze([...buildReceipts.values()]),
        signal: input.signal,
      });
      return this.buildExecutionEnvelope(record, registeredSourceAssetIds);
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
      if (error instanceof ProviderRevisionEvidenceError) {
        return {
          version: DATASET_BRIDGE_VERSION,
          request_id: newRequestId(),
          ok: false,
          data: null,
          error: {
            code: "core_execution_error",
            message: error.message,
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
  }

  private buildExecutionEnvelope(
    record: BuildRecord,
    registeredSourceAssetIds: ReadonlySet<string>,
  ): DatasetBridgeResponse {
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
        publication: record.publication ?? null,
        manifest: manifest === null ? null : {
          build_id: manifest.build_id,
          manifest_id: manifest.manifest_id,
          sha256: manifest.sha256,
        },
        artifacts: manifest === null ? [] : manifest.artifacts.map((entry) => ({
          build_id: manifest.build_id,
          artifact_id: entry.artifact_id,
          name: path.posix.basename(entry.relative_path),
          role: entry.role,
          relative_path: entry.relative_path,
          media_type: entry.media_type,
          size_bytes: entry.size_bytes,
          sha256: entry.sha256,
          generated_by_step_id: "step_dataset_core_publish",
        })),
        validation_summary: record.validation === null ? null : {
          status: record.validation.status,
          checked_count: record.validation.checked_count,
          failed_count: record.validation.failed_count,
        },
        registeredSourceAssetIds: [...registeredSourceAssetIds].sort(),
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
  acquisition?: (input: DatasetCoreAcquireInput) => Promise<CoreAcquisitionResult>;
}): DatasetCoreService {
  return new TsDatasetCoreAdapter(options.tsCore, options);
}

export type { DatasetBuildSpec };
