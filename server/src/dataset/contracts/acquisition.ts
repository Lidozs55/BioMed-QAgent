import type {
  AcquisitionAttemptStatus,
  AcquisitionCacheLineage,
  CoreAcquisitionRequest,
  CoreDownloadAttempt,
  WorkflowRecipeRef,
  WorkflowRecipeStatus,
} from "@biomed/contracts";
import {
  assertBoolean,
  assertExactKeys,
  assertIsoDateTime,
  assertJsonRecord,
  assertNonEmptyString,
  assertNonNegativeInt,
  assertRecord,
  assertRelativePath,
  assertSafeId,
  assertSha256,
} from "./primitives.js";
import { parseRegisteredSourceAssetRef } from "./source.js";

const REQUEST_KEYS = ["schema_version", "request_id", "task_id", "build_id", "binding_id", "mode", "provider_id", "recipe_id", "recipe_version", "parameters"] as const;
const RECIPE_KEYS = ["schema_version", "recipe_id", "recipe_version", "status", "implementation_digest"] as const;
const LINEAGE_KEYS = ["schema_version", "cache_key", "request_identity_digest", "cache_blob_sha256", "resumed_from_attempt_id", "part_relative_path"] as const;
const ATTEMPT_KEYS = ["schema_version", "attempt_id", "request_id", "task_id", "provider_id", "attempt_number", "status", "url", "bytes_received", "error_code", "retryable", "started_at", "finished_at", "cache_lineage", "asset"] as const;
const STATUSES = new Set<AcquisitionAttemptStatus>(["pending", "running", "succeeded", "failed", "cancelled"]);

function id(value: unknown, name: string): string { return assertSafeId(value, name); }
function status(value: unknown, name: string): AcquisitionAttemptStatus {
  const text = assertNonEmptyString(value, name);
  if (!STATUSES.has(text as AcquisitionAttemptStatus)) throw new TypeError(`${name} is invalid`);
  return text as AcquisitionAttemptStatus;
}

export function parseCoreAcquisitionRequest(
  value: unknown,
  expectedTaskId?: string,
  recipeRef?: WorkflowRecipeRef,
): CoreAcquisitionRequest {
  const record = assertRecord(value, "CoreAcquisitionRequest");
  assertExactKeys(record, REQUEST_KEYS, "CoreAcquisitionRequest");
  if (record.schema_version !== "1.0") throw new TypeError("CoreAcquisitionRequest.schema_version must be 1.0");
  const taskId = id(record.task_id, "CoreAcquisitionRequest.task_id");
  if (expectedTaskId !== undefined && taskId !== expectedTaskId) throw new TypeError("acquisition request belongs to a different task");
  const mode = record.mode;
  if (mode !== "builtin" && mode !== "workflow_recipe") throw new TypeError("CoreAcquisitionRequest.mode is invalid");
  const providerId = record.provider_id === null ? null : id(record.provider_id, "CoreAcquisitionRequest.provider_id");
  const recipeId = record.recipe_id === null ? null : id(record.recipe_id, "CoreAcquisitionRequest.recipe_id");
  const recipeVersion = record.recipe_version === null ? null : assertPositive(record.recipe_version, "CoreAcquisitionRequest.recipe_version");
  if (mode === "builtin" && (providerId === null || recipeId !== null || recipeVersion !== null)) throw new TypeError("builtin acquisition requires provider_id and forbids recipe identity");
  if (mode === "workflow_recipe" && (providerId !== null || recipeId === null || recipeVersion === null)) throw new TypeError("workflow_recipe acquisition requires recipe identity and forbids provider_id");
  if (mode === "workflow_recipe" && recipeRef !== undefined) {
    if (recipeRef.status !== "PROMOTED" || recipeRef.recipe_id !== recipeId || recipeRef.recipe_version !== recipeVersion) {
      throw new TypeError("workflow recipe must be PROMOTED and match request identity");
    }
  }
  return { schema_version: "1.0", request_id: id(record.request_id, "CoreAcquisitionRequest.request_id"), task_id: taskId, build_id: id(record.build_id, "CoreAcquisitionRequest.build_id"), binding_id: id(record.binding_id, "CoreAcquisitionRequest.binding_id"), mode, provider_id: providerId, recipe_id: recipeId, recipe_version: recipeVersion, parameters: assertJsonRecord(record.parameters, "CoreAcquisitionRequest.parameters") };
}

export function parseWorkflowRecipeRef(value: unknown): WorkflowRecipeRef {
  const record = assertRecord(value, "WorkflowRecipeRef");
  assertExactKeys(record, RECIPE_KEYS, "WorkflowRecipeRef");
  if (record.schema_version !== "1.0") throw new TypeError("WorkflowRecipeRef.schema_version must be 1.0");
  const statusValue = assertNonEmptyString(record.status, "WorkflowRecipeRef.status");
  if (!(["PROMOTED", "DRAFT", "RETIRED"] as WorkflowRecipeStatus[]).includes(statusValue as WorkflowRecipeStatus)) throw new TypeError("WorkflowRecipeRef.status is invalid");
  return { schema_version: "1.0", recipe_id: id(record.recipe_id, "WorkflowRecipeRef.recipe_id"), recipe_version: assertPositive(record.recipe_version, "WorkflowRecipeRef.recipe_version"), status: statusValue as WorkflowRecipeStatus, implementation_digest: assertSha256(record.implementation_digest, "WorkflowRecipeRef.implementation_digest") };
}

function parseCacheLineage(value: unknown): AcquisitionCacheLineage {
  const record = assertRecord(value, "AcquisitionCacheLineage");
  assertExactKeys(record, LINEAGE_KEYS, "AcquisitionCacheLineage");
  if (record.schema_version !== "1.0") throw new TypeError("AcquisitionCacheLineage.schema_version must be 1.0");
  const blob = record.cache_blob_sha256 === null ? null : assertSha256(record.cache_blob_sha256, "AcquisitionCacheLineage.cache_blob_sha256");
  const resumed = record.resumed_from_attempt_id === null ? null : id(record.resumed_from_attempt_id, "AcquisitionCacheLineage.resumed_from_attempt_id");
  const part = record.part_relative_path === null ? null : assertRelativePath(record.part_relative_path, "AcquisitionCacheLineage.part_relative_path");
  if (part !== null && !part.startsWith("source_assets/")) throw new TypeError("acquisition part path must stay in source_assets");
  return { schema_version: "1.0", cache_key: id(record.cache_key, "AcquisitionCacheLineage.cache_key"), request_identity_digest: assertSha256(record.request_identity_digest, "AcquisitionCacheLineage.request_identity_digest"), cache_blob_sha256: blob, resumed_from_attempt_id: resumed, part_relative_path: part };
}

export function parseCoreDownloadAttempt(value: unknown, expectedTaskId?: string): CoreDownloadAttempt {
  const record = assertRecord(value, "CoreDownloadAttempt");
  assertExactKeys(record, ATTEMPT_KEYS, "CoreDownloadAttempt");
  if (record.schema_version !== "1.0") throw new TypeError("CoreDownloadAttempt.schema_version must be 1.0");
  const taskId = id(record.task_id, "CoreDownloadAttempt.task_id");
  if (expectedTaskId !== undefined && taskId !== expectedTaskId) throw new TypeError("download attempt belongs to a different task");
  const attemptStatus = status(record.status, "CoreDownloadAttempt.status");
  const finishedAt = record.finished_at === null ? null : assertIsoDateTime(record.finished_at, "CoreDownloadAttempt.finished_at");
  const asset = record.asset === null ? null : parseRegisteredSourceAssetRef(record.asset, taskId);
  if (attemptStatus === "succeeded" && asset === null) throw new TypeError("succeeded download attempt requires registered asset");
  if (attemptStatus !== "succeeded" && asset !== null) throw new TypeError("non-succeeded download attempt must not publish asset");
  return { schema_version: "1.0", attempt_id: id(record.attempt_id, "CoreDownloadAttempt.attempt_id"), request_id: id(record.request_id, "CoreDownloadAttempt.request_id"), task_id: taskId, provider_id: id(record.provider_id, "CoreDownloadAttempt.provider_id"), attempt_number: assertPositive(record.attempt_number, "CoreDownloadAttempt.attempt_number"), status: attemptStatus, url: assertNonEmptyString(record.url, "CoreDownloadAttempt.url"), bytes_received: assertNonNegativeInt(record.bytes_received, "CoreDownloadAttempt.bytes_received"), error_code: record.error_code === null ? null : id(record.error_code, "CoreDownloadAttempt.error_code"), retryable: assertBoolean(record.retryable, "CoreDownloadAttempt.retryable"), started_at: assertIsoDateTime(record.started_at, "CoreDownloadAttempt.started_at"), finished_at: finishedAt, cache_lineage: parseCacheLineage(record.cache_lineage), asset };
}

function assertPositive(value: unknown, name: string): number {
  const number = assertNonNegativeInt(value, name);
  if (number < 1) throw new TypeError(`${name} must be >= 1`);
  return number;
}
