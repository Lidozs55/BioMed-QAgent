import type {
  OperationResultCommitReceipt,
  OperationResultDependencyClosure,
  OperationResultFileReceipt,
  OperationResultKind,
  OperationResultManifest,
  OperationResultOutputKind,
  OperationResultStatus,
} from "@biomed/contracts";
import {
  assertExactKeys,
  assertIsoDateTime,
  assertJsonRecord,
  assertNonEmptyString,
  assertNonNegativeInt,
  assertRecord,
  assertRelativePath,
  assertSafeId,
  assertSha256,
  assertStringArray,
} from "./primitives.js";

const KINDS = new Set<OperationResultKind>([
  "acquire", "parse", "canonicalize", "compatibility_gate", "integrate",
  "assemble", "derive", "validate_profile", "publish",
]);
const OUTPUT_KINDS = new Set<OperationResultOutputKind>([
  "source_asset", "parsed_table", "canonical_table", "compatibility_report",
  "integrated_table", "publication_candidate", "derived_evidence",
  "validation_result", "publication_manifest",
]);
const STATUSES = new Set<OperationResultStatus>(["succeeded", "failed", "cancelled", "skipped"]);
const FILE_KEYS = ["relative_path", "size_bytes", "sha256"] as const;
const CLOSURE_KEYS = ["input_asset_ids", "upstream_result_manifest_ids", "parameter_digest", "implementation_digest"] as const;
const COMMIT_KEYS = ["state", "commit_id", "committed_at"] as const;
const MANIFEST_KEYS = [
  "schema_version", "result_manifest_id", "task_id", "run_id", "requirement_id", "operation_id",
  "operation_kind", "operation_attempt_id", "attempt", "status", "input_digest",
  "parameter_digest", "implementation_digest", "output_digest", "output_kind",
  "output_summary", "output_files", "dependency_closure", "commit",
] as const;

function enumValue<T extends string>(value: unknown, values: Set<T>, name: string): T {
  const text = assertNonEmptyString(value, name);
  if (!values.has(text as T)) throw new TypeError(`${name} is invalid`);
  return text as T;
}
function unique(values: string[], name: string): string[] {
  if (new Set(values).size !== values.length) throw new TypeError(`${name} must not contain duplicates`);
  return values;
}
function safeIdArray(value: unknown, name: string): string[] {
  return unique(assertStringArray(value, name).map((item, index) => assertSafeId(item, `${name}[${index}]`)), name);
}
function operationIdentifier(value: unknown, name: string): string {
  const text = assertNonEmptyString(value, name);
  if (text.includes("\0") || text.includes("/") || text.includes("\\") || text.includes("..")) {
    throw new TypeError(`${name} must be a safe operation identifier`);
  }
  return text;
}

export function parseOperationResultFileReceipt(value: unknown): OperationResultFileReceipt {
  const record = assertRecord(value, "OperationResultFileReceipt");
  assertExactKeys(record, FILE_KEYS, "OperationResultFileReceipt");
  return {
    relative_path: assertRelativePath(record.relative_path, "OperationResultFileReceipt.relative_path"),
    size_bytes: assertNonNegativeInt(record.size_bytes, "OperationResultFileReceipt.size_bytes"),
    sha256: assertSha256(record.sha256, "OperationResultFileReceipt.sha256"),
  };
}

export function parseOperationResultDependencyClosure(value: unknown): OperationResultDependencyClosure {
  const record = assertRecord(value, "OperationResultDependencyClosure");
  assertExactKeys(record, CLOSURE_KEYS, "OperationResultDependencyClosure");
  return {
    input_asset_ids: safeIdArray(record.input_asset_ids, "OperationResultDependencyClosure.input_asset_ids"),
    upstream_result_manifest_ids: safeIdArray(record.upstream_result_manifest_ids, "OperationResultDependencyClosure.upstream_result_manifest_ids"),
    parameter_digest: assertSha256(record.parameter_digest, "OperationResultDependencyClosure.parameter_digest"),
    implementation_digest: assertSha256(record.implementation_digest, "OperationResultDependencyClosure.implementation_digest"),
  };
}

function parseCommit(value: unknown): OperationResultCommitReceipt {
  const record = assertRecord(value, "OperationResultCommitReceipt");
  assertExactKeys(record, COMMIT_KEYS, "OperationResultCommitReceipt");
  if (record.state !== "committed") throw new TypeError("OperationResultCommitReceipt.state must be committed");
  return {
    state: "committed",
    commit_id: assertSafeId(record.commit_id, "OperationResultCommitReceipt.commit_id"),
    committed_at: assertIsoDateTime(record.committed_at, "OperationResultCommitReceipt.committed_at"),
  };
}

export function parseOperationResultManifest(value: unknown, expectedTaskId?: string, expectedRunId?: string, expectedRequirementId?: string): OperationResultManifest {
  const record = assertRecord(value, "OperationResultManifest");
  assertExactKeys(record, MANIFEST_KEYS, "OperationResultManifest");
  if (record.schema_version !== "1.0") throw new TypeError("OperationResultManifest.schema_version must be 1.0");
  const taskId = assertSafeId(record.task_id, "OperationResultManifest.task_id");
  const runId = assertSafeId(record.run_id, "OperationResultManifest.run_id");
  const requirementId = assertSafeId(record.requirement_id, "OperationResultManifest.requirement_id");
  if (expectedTaskId !== undefined && taskId !== expectedTaskId) throw new TypeError("operation result belongs to a different task");
  if (expectedRunId !== undefined && runId !== expectedRunId) throw new TypeError("operation result belongs to a different run");
  if (expectedRequirementId !== undefined && requirementId !== expectedRequirementId) throw new TypeError("operation result belongs to a different requirement");
  const status = enumValue(record.status, STATUSES, "OperationResultManifest.status");
  const operationKind = enumValue(record.operation_kind, KINDS, "OperationResultManifest.operation_kind");
  const outputKind = enumValue(record.output_kind, OUTPUT_KINDS, "OperationResultManifest.output_kind");
  const outputDigest = record.output_digest === null ? null : assertSha256(record.output_digest, "OperationResultManifest.output_digest");
  if ((status === "succeeded" || status === "skipped") && outputDigest === null) throw new TypeError(`${status} operation result requires output_digest`);
  if ((status === "failed" || status === "cancelled") && outputDigest !== null) throw new TypeError(`${status} operation result must not carry output_digest`);
  if (operationKind === "acquire" && outputKind !== "source_asset") throw new TypeError("acquire result must output source_asset");
  if (operationKind === "assemble" && outputKind !== "publication_candidate") throw new TypeError("assemble result must output publication_candidate");
  if (operationKind === "derive" && outputKind !== "derived_evidence") throw new TypeError("derive result must output derived_evidence");
  if (operationKind === "publish" && outputKind !== "publication_manifest") throw new TypeError("publish result must output publication_manifest");
  const outputFiles = (() => {
    if (!Array.isArray(record.output_files)) throw new TypeError("OperationResultManifest.output_files must be an array");
    return record.output_files.map(parseOperationResultFileReceipt);
  })();
  const dependencyClosure = parseOperationResultDependencyClosure(record.dependency_closure);
  if (dependencyClosure.parameter_digest !== assertSha256(record.parameter_digest, "OperationResultManifest.parameter_digest")) throw new TypeError("parameter digest does not match dependency closure");
  if (dependencyClosure.implementation_digest !== assertSha256(record.implementation_digest, "OperationResultManifest.implementation_digest")) throw new TypeError("implementation digest does not match dependency closure");
  return {
    schema_version: "1.0",
    result_manifest_id: assertSafeId(record.result_manifest_id, "OperationResultManifest.result_manifest_id"),
    task_id: taskId,
    run_id: runId,
    requirement_id: requirementId,
    operation_id: operationIdentifier(record.operation_id, "OperationResultManifest.operation_id"),
    operation_kind: operationKind,
    operation_attempt_id: assertSafeId(record.operation_attempt_id, "OperationResultManifest.operation_attempt_id"),
    attempt: (() => { const n = assertNonNegativeInt(record.attempt, "OperationResultManifest.attempt"); if (n < 1) throw new TypeError("OperationResultManifest.attempt must be >= 1"); return n; })(),
    status,
    input_digest: assertSha256(record.input_digest, "OperationResultManifest.input_digest"),
    parameter_digest: assertSha256(record.parameter_digest, "OperationResultManifest.parameter_digest"),
    implementation_digest: assertSha256(record.implementation_digest, "OperationResultManifest.implementation_digest"),
    output_digest: outputDigest,
    output_kind: outputKind,
    output_summary: assertJsonRecord(record.output_summary, "OperationResultManifest.output_summary"),
    output_files: outputFiles,
    dependency_closure: dependencyClosure,
    commit: parseCommit(record.commit),
  };
}
