import type { BuildResult, DatasetBuildSpec } from "./dataset-build.js";
import type { JsonValue } from "./json.js";

export const DATASET_BRIDGE_VERSION = 1 as const;

export type DatasetBridgeOperation =
  | "validate_dataset_build_spec"
  | "execute_dataset_build"
  | "get_build_result";

interface DatasetBridgeRequestBase {
  version: typeof DATASET_BRIDGE_VERSION;
  request_id: string;
  task_id: string;
  run_id: string;
  pi_session_id: string;
  tool_call_id: string;
}

export type DatasetBridgeRequest =
  | (DatasetBridgeRequestBase & {
      op: "validate_dataset_build_spec";
      args: { spec: DatasetBuildSpec };
    })
  | (DatasetBridgeRequestBase & {
      op: "execute_dataset_build";
      args: {
        spec: DatasetBuildSpec;
        source_files: Record<string, string>;
        mapping_files: Record<string, string>;
      };
    })
  | (DatasetBridgeRequestBase & {
      op: "get_build_result";
      args: { build_id: string };
    });

export interface DatasetBridgeValidationData {
  valid: boolean;
  reason_codes: string[];
  reasons: string[];
}

export interface DatasetBridgeManifestReference {
  build_id: string;
  manifest_id: string;
  sha256: string;
}

export interface DatasetBridgeArtifactReference {
  build_id: string;
  artifact_id: string;
  role: string;
  media_type: string;
  size_bytes: number;
  sha256: string;
}

export interface DatasetBridgeBuildData {
  build_id: string;
  build_result: BuildResult;
  publication_id: string | null;
  manifest: DatasetBridgeManifestReference | null;
  artifacts: DatasetBridgeArtifactReference[];
  validation_summary: Record<string, JsonValue> | null;
}

export type DatasetBridgeErrorCode =
  | "invalid_input"
  | "spec_rejected"
  | "no_data"
  | "partial_success"
  | "core_execution_error"
  | "bridge_unavailable"
  | "cancelled";

export interface DatasetBridgeErrorDetails {
  reason_codes?: string[];
  fields?: string[];
  category?: string;
  cancellation_source?: string;
  build_result?: BuildResult;
  build_id?: string;
  publication_id?: string | null;
  manifest?: DatasetBridgeManifestReference | null;
  artifacts?: DatasetBridgeArtifactReference[];
  validation_summary?: Record<string, JsonValue> | null;
}

export interface DatasetBridgeError {
  code: DatasetBridgeErrorCode;
  message: string;
  retryable: boolean;
  details: DatasetBridgeErrorDetails;
}

export type DatasetBridgeResponse =
  | {
      version: typeof DATASET_BRIDGE_VERSION;
      request_id: string;
      ok: true;
      data: DatasetBridgeValidationData | DatasetBridgeBuildData;
      error: null;
    }
  | {
      version: typeof DATASET_BRIDGE_VERSION;
      request_id: string;
      ok: false;
      data: null;
      error: DatasetBridgeError;
    };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/i;
const ERROR_CODES = new Set<DatasetBridgeErrorCode>([
  "invalid_input",
  "spec_rejected",
  "no_data",
  "partial_success",
  "core_execution_error",
  "bridge_unavailable",
  "cancelled",
]);

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new TypeError(`${name} has unknown fields: ${extras.join(", ")}`);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function safeId(value: unknown, name: string): string {
  const text = requiredString(value, name);
  if (!SAFE_ID.test(text)) throw new TypeError(`${name} must be a safe identifier`);
  return text;
}

function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${name} must be a string array`);
  }
  return value as string[];
}

function stringMap(value: unknown, name: string): Record<string, string> {
  const object = record(value, name);
  for (const [key, item] of Object.entries(object)) {
    safeId(key, `${name} key`);
    requiredString(item, `${name}.${key}`);
  }
  return object as Record<string, string>;
}

function stringArrayMap(value: unknown, name: string): Record<string, string[]> {
  const object = record(value, name);
  for (const [key, item] of Object.entries(object)) strings(item, `${name}.${key}`);
  return object as Record<string, string[]>;
}

function jsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 8) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 1_000 && value.every((item) => jsonValue(item, depth + 1));
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length <= 1_000 && entries.every(([, item]) => jsonValue(item, depth + 1));
  }
  return false;
}

function taskRelativeRef(value: unknown, name: string): string {
  const text = requiredString(value, name);
  if (
    text.includes("\0") ||
    text.includes("\\") ||
    text.startsWith("/") ||
    /^[A-Za-z]:/.test(text) ||
    text.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError(`${name} must be a task-relative path`);
  }
  return text;
}

function parseSpec(value: unknown): DatasetBuildSpec {
  const spec = record(value, "spec");
  exact(spec, [
    "schema_version", "build_id", "objective", "dataset_family", "row_granularity",
    "entities", "cohort_filters", "required_fields", "schema_ref", "source_bindings",
    "normalization_profile_ref", "merge_strategy", "validation_profile_ref", "output_format",
    "target_entity_level",
  ], "spec");
  if (spec.schema_version !== undefined && spec.schema_version !== "1.0") throw new TypeError("spec.schema_version must be 1.0");
  safeId(spec.build_id, "spec.build_id");
  for (const field of ["objective", "dataset_family", "row_granularity", "schema_ref", "merge_strategy", "validation_profile_ref", "output_format"] as const) {
    requiredString(spec[field], `spec.${field}`);
  }
  stringArrayMap(spec.entities, "spec.entities");
  stringArrayMap(spec.cohort_filters, "spec.cohort_filters");
  strings(spec.required_fields, "spec.required_fields");
  if (!Array.isArray(spec.source_bindings) || spec.source_bindings.length === 0) throw new TypeError("spec.source_bindings must be non-empty");
  for (const [index, rawBinding] of spec.source_bindings.entries()) {
    const binding = record(rawBinding, `spec.source_bindings[${index}]`);
    exact(binding, ["schema_version", "binding_id", "source", "acquisition", "adapter_id", "accession", "parameters"], "source binding");
    if (binding.schema_version !== undefined && binding.schema_version !== "1.0") throw new TypeError("binding.schema_version must be 1.0");
    safeId(binding.binding_id, "binding.binding_id");
    requiredString(binding.source, "binding.source");
    requiredString(binding.adapter_id, "binding.adapter_id");
    if (binding.accession !== null && binding.accession !== undefined) requiredString(binding.accession, "binding.accession");
    if (!jsonValue(binding.parameters)) throw new TypeError("binding.parameters must be JSON");
    const acquisition = record(binding.acquisition, "binding.acquisition");
    exact(acquisition, ["schema_version", "mode", "provider_id", "recipe_id", "recipe_version"], "binding.acquisition");
    if (acquisition.schema_version !== undefined && acquisition.schema_version !== "1.0") throw new TypeError("acquisition.schema_version must be 1.0");
    if (acquisition.mode !== "builtin" && acquisition.mode !== "workflow_recipe") throw new TypeError("acquisition.mode is invalid");
    if (acquisition.mode === "builtin") requiredString(acquisition.provider_id, "acquisition.provider_id");
    if (acquisition.mode === "workflow_recipe") {
      requiredString(acquisition.recipe_id, "acquisition.recipe_id");
      if (!Number.isInteger(acquisition.recipe_version) || Number(acquisition.recipe_version) < 1) throw new TypeError("acquisition.recipe_version is invalid");
    }
  }
  if (spec.normalization_profile_ref !== null && spec.normalization_profile_ref !== undefined) requiredString(spec.normalization_profile_ref, "spec.normalization_profile_ref");
  if (
    spec.target_entity_level !== null &&
    spec.target_entity_level !== undefined &&
    spec.target_entity_level !== "gene" &&
    spec.target_entity_level !== "probe"
  ) throw new TypeError("spec.target_entity_level is invalid");
  return value as DatasetBuildSpec;
}

function validateReferenceMap(value: unknown, name: string): Record<string, string> {
  const mapping = stringMap(value, name);
  for (const [key, reference] of Object.entries(mapping)) taskRelativeRef(reference, `${name}.${key}`);
  return mapping;
}

export function parseDatasetBridgeRequest(value: unknown): DatasetBridgeRequest {
  const request = record(value, "bridge request");
  exact(request, [
    "version", "request_id", "task_id", "run_id", "pi_session_id",
    "tool_call_id", "op", "args",
  ], "bridge request");
  if (request.version !== DATASET_BRIDGE_VERSION) throw new TypeError("bridge version must be 1");
  safeId(request.request_id, "request_id");
  safeId(request.task_id, "task_id");
  safeId(request.run_id, "run_id");
  safeId(request.pi_session_id, "pi_session_id");
  safeId(request.tool_call_id, "tool_call_id");
  const args = record(request.args, "args");
  if (request.op === "validate_dataset_build_spec") {
    exact(args, ["spec"], "validate args");
    parseSpec(args.spec);
  } else if (request.op === "execute_dataset_build") {
    exact(args, ["spec", "source_files", "mapping_files"], "execute args");
    parseSpec(args.spec);
    validateReferenceMap(args.source_files, "source_files");
    validateReferenceMap(args.mapping_files, "mapping_files");
  } else if (request.op === "get_build_result") {
    exact(args, ["build_id"], "lookup args");
    safeId(args.build_id, "build_id");
  } else {
    throw new TypeError("unsupported dataset bridge operation");
  }
  return value as DatasetBridgeRequest;
}

function parseBuildResult(value: unknown): BuildResult {
  const result = record(value, "build_result");
  exact(result, [
    "schema_version", "status", "valid_row_count", "successful_sources", "rejected_sources",
    "available_artifact_roles", "publication_id", "reason_codes", "user_summary",
    "recommended_next_action", "build_id", "binding_failures",
  ], "build_result");
  if (!["succeeded", "partial_success", "no_data", "spec_rejected"].includes(String(result.status))) throw new TypeError("build_result.status is invalid");
  if (!Number.isInteger(result.valid_row_count) || Number(result.valid_row_count) < 0) throw new TypeError("build_result.valid_row_count is invalid");
  for (const field of ["successful_sources", "rejected_sources", "available_artifact_roles", "reason_codes"] as const) strings(result[field], `build_result.${field}`);
  if (result.publication_id !== null && result.publication_id !== undefined) safeId(result.publication_id, "build_result.publication_id");
  requiredString(result.user_summary, "build_result.user_summary");
  if (typeof result.recommended_next_action !== "string") throw new TypeError("build_result.recommended_next_action must be a string");
  if (result.build_id !== null && result.build_id !== undefined) safeId(result.build_id, "build_result.build_id");
  if (result.binding_failures !== undefined && !Array.isArray(result.binding_failures)) throw new TypeError("build_result.binding_failures must be an array");
  return value as BuildResult;
}

function parseManifestReference(value: unknown): DatasetBridgeManifestReference {
  const reference = record(value, "manifest reference");
  exact(reference, ["build_id", "manifest_id", "sha256"], "manifest reference");
  safeId(reference.build_id, "manifest.build_id");
  safeId(reference.manifest_id, "manifest.manifest_id");
  if (typeof reference.sha256 !== "string" || !SHA256.test(reference.sha256)) throw new TypeError("manifest.sha256 is invalid");
  return value as DatasetBridgeManifestReference;
}

function parseArtifacts(value: unknown): DatasetBridgeArtifactReference[] {
  if (!Array.isArray(value)) throw new TypeError("artifacts must be an array");
  for (const raw of value) {
    const artifact = record(raw, "artifact reference");
    exact(artifact, ["build_id", "artifact_id", "role", "media_type", "size_bytes", "sha256"], "artifact reference");
    safeId(artifact.build_id, "artifact.build_id");
    safeId(artifact.artifact_id, "artifact.artifact_id");
    requiredString(artifact.role, "artifact.role");
    requiredString(artifact.media_type, "artifact.media_type");
    if (!Number.isInteger(artifact.size_bytes) || Number(artifact.size_bytes) < 0) throw new TypeError("artifact.size_bytes is invalid");
    if (typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256)) throw new TypeError("artifact.sha256 is invalid");
  }
  return value as DatasetBridgeArtifactReference[];
}

function parseBuildData(value: unknown): DatasetBridgeBuildData {
  const data = record(value, "build data");
  exact(data, ["build_id", "build_result", "publication_id", "manifest", "artifacts", "validation_summary"], "build data");
  safeId(data.build_id, "build_id");
  parseBuildResult(data.build_result);
  if (data.publication_id !== null) safeId(data.publication_id, "publication_id");
  if (data.manifest !== null) parseManifestReference(data.manifest);
  parseArtifacts(data.artifacts);
  if (data.validation_summary !== null && !jsonValue(data.validation_summary)) throw new TypeError("validation_summary must be JSON");
  return value as DatasetBridgeBuildData;
}

function parseValidationData(value: unknown): DatasetBridgeValidationData {
  const data = record(value, "validation data");
  exact(data, ["valid", "reason_codes", "reasons"], "validation data");
  if (typeof data.valid !== "boolean") throw new TypeError("validation valid must be boolean");
  strings(data.reason_codes, "validation reason_codes");
  strings(data.reasons, "validation reasons");
  return value as DatasetBridgeValidationData;
}

function parseError(value: unknown): DatasetBridgeError {
  const error = record(value, "bridge error");
  exact(error, ["code", "message", "retryable", "details"], "bridge error");
  if (typeof error.code !== "string" || !ERROR_CODES.has(error.code as DatasetBridgeErrorCode)) throw new TypeError("bridge error code is invalid");
  requiredString(error.message, "bridge error message");
  if (typeof error.retryable !== "boolean") throw new TypeError("bridge error retryable must be boolean");
  const details = record(error.details, "bridge error details");
  exact(details, ["reason_codes", "fields", "category", "cancellation_source", "build_result", "build_id", "publication_id", "manifest", "artifacts", "validation_summary"], "bridge error details");
  if (details.reason_codes !== undefined) strings(details.reason_codes, "details.reason_codes");
  if (details.fields !== undefined) strings(details.fields, "details.fields");
  if (details.category !== undefined) requiredString(details.category, "details.category");
  if (details.cancellation_source !== undefined) requiredString(details.cancellation_source, "details.cancellation_source");
  if (details.build_result !== undefined) parseBuildResult(details.build_result);
  if (details.build_id !== undefined) safeId(details.build_id, "details.build_id");
  if (details.publication_id !== undefined && details.publication_id !== null) safeId(details.publication_id, "details.publication_id");
  if (details.manifest !== undefined && details.manifest !== null) parseManifestReference(details.manifest);
  if (details.artifacts !== undefined) parseArtifacts(details.artifacts);
  if (details.validation_summary !== undefined && details.validation_summary !== null && !jsonValue(details.validation_summary)) throw new TypeError("details.validation_summary must be JSON");
  return value as DatasetBridgeError;
}

export function parseDatasetBridgeResponse(value: unknown, expectedRequestId: string): DatasetBridgeResponse {
  const response = record(value, "bridge response");
  exact(response, ["version", "request_id", "ok", "data", "error"], "bridge response");
  if (response.version !== DATASET_BRIDGE_VERSION) throw new TypeError("bridge response version mismatch");
  if (safeId(response.request_id, "response.request_id") !== expectedRequestId) throw new TypeError("bridge response request_id mismatch");
  if (response.ok === true) {
    if (response.error !== null) throw new TypeError("successful bridge response cannot contain error");
    const data = record(response.data, "bridge response data");
    if (Object.prototype.hasOwnProperty.call(data, "valid")) parseValidationData(data);
    else parseBuildData(data);
  } else if (response.ok === false) {
    if (response.data !== null) throw new TypeError("failed bridge response cannot contain data");
    parseError(response.error);
  } else {
    throw new TypeError("bridge response ok must be boolean");
  }
  return value as DatasetBridgeResponse;
}
