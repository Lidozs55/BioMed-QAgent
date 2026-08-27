import { createHash } from "node:crypto";

import type {
  DeriveCommittedOutputKind,
  DeriveCommittedResultRef,
  DeriveInputKind,
  DeterministicDeriveInput,
  DeterministicDeriveProvenance,
  DeterministicDeriveRequest,
  DeterministicDeriveResultReceipt,
  DeriveReferenceVersion,
  JsonValue,
} from "@biomed/contracts";
import {
  assertExactKeys,
  assertJsonRecord,
  assertNonEmptyString,
  assertRecord,
  assertSafeId,
  assertSha256,
} from "./primitives.js";
import { parseRegisteredSourceAssetRef } from "./source.js";

const REFERENCE_KEYS = ["schema_version", "reference_id", "version", "digest"] as const;
const COMMITTED_RESULT_KEYS = [
  "schema_version", "result_manifest_id", "output_kind", "output_digest", "commit_id",
] as const;
const INPUT_KEYS = [
  "schema_version", "input_id", "kind", "digest", "asset_ref", "committed_result_ref",
] as const;
const REQUEST_KEYS = [
  "schema_version", "slot", "request_id", "task_id", "requirement_id", "algorithm_id",
  "algorithm_version", "implementation_digest", "parameters", "reference", "inputs",
  "output_schema_ref", "request_identity_digest",
] as const;
const PROVENANCE_KEYS = [
  "schema_version", "slot", "request_id", "request_identity_digest", "algorithm_id",
  "algorithm_version", "implementation_digest", "parameters", "reference", "inputs",
  "output_schema_ref", "output_digest",
] as const;
const RECEIPT_KEYS = [
  "schema_version", "result_id", "task_id", "requirement_id", "slot", "request_id",
  "request_identity_digest", "output_kind", "output_schema_ref", "output_digest",
  "output_summary", "provenance",
] as const;
const COMMITTED_OUTPUT_KINDS = new Set<DeriveCommittedOutputKind>([
  "canonical_table", "integrated_table", "derived_evidence",
]);
const INPUT_KINDS = new Set<DeriveInputKind>(["registered_asset", "committed_result"]);

function enumValue<T extends string>(value: unknown, values: Set<T>, name: string): T {
  const text = assertNonEmptyString(value, name);
  if (!values.has(text as T)) throw new TypeError(`${name} is invalid`);
  return text as T;
}

function assertReferenceIdentifier(value: unknown, name: string): string {
  const identifier = assertNonEmptyString(value, name);
  if (!/^[A-Za-z0-9_.:-]+$/.test(identifier) || identifier.includes("..")) {
    throw new TypeError(`${name} must be a safe reference identifier`);
  }
  return identifier;
}

function assertVersion(value: unknown, name: string): string {
  return assertReferenceIdentifier(value, name);
}

const FORBIDDEN_PARAMETER_KEYS = new Set([
  "code", "script", "command", "executable", "module", "import",
  "node", "nodes", "edge", "edges", "dependencies",
]);

function assertDeclarativeParameters(value: unknown): Record<string, JsonValue> {
  const parameters = assertJsonRecord(value, "DeterministicDeriveRequest.parameters");
  const inspect = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      for (const item of entry) inspect(item);
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    for (const [key, item] of Object.entries(entry)) {
      if (FORBIDDEN_PARAMETER_KEYS.has(key.toLowerCase())) {
        throw new TypeError(`derive parameters forbid code or DAG field '${key}'`);
      }
      inspect(item);
    }
  };
  inspect(parameters);
  return parameters;
}

function parseReference(value: unknown): DeriveReferenceVersion {
  const record = assertRecord(value, "DeriveReferenceVersion");
  assertExactKeys(record, REFERENCE_KEYS, "DeriveReferenceVersion");
  if (record.schema_version !== "1.0") throw new TypeError("DeriveReferenceVersion.schema_version must be 1.0");
  return {
    schema_version: "1.0",
    reference_id: assertReferenceIdentifier(record.reference_id, "DeriveReferenceVersion.reference_id"),
    version: assertVersion(record.version, "DeriveReferenceVersion.version"),
    digest: assertSha256(record.digest, "DeriveReferenceVersion.digest"),
  };
}

function parseCommittedResultRef(value: unknown): DeriveCommittedResultRef {
  const record = assertRecord(value, "DeriveCommittedResultRef");
  assertExactKeys(record, COMMITTED_RESULT_KEYS, "DeriveCommittedResultRef");
  if (record.schema_version !== "1.0") throw new TypeError("DeriveCommittedResultRef.schema_version must be 1.0");
  return {
    schema_version: "1.0",
    result_manifest_id: assertSafeId(record.result_manifest_id, "DeriveCommittedResultRef.result_manifest_id"),
    output_kind: enumValue(record.output_kind, COMMITTED_OUTPUT_KINDS, "DeriveCommittedResultRef.output_kind"),
    output_digest: assertSha256(record.output_digest, "DeriveCommittedResultRef.output_digest"),
    commit_id: assertSafeId(record.commit_id, "DeriveCommittedResultRef.commit_id"),
  };
}

function parseInput(value: unknown, expectedTaskId?: string): DeterministicDeriveInput {
  const record = assertRecord(value, "DeterministicDeriveInput");
  assertExactKeys(record, INPUT_KEYS, "DeterministicDeriveInput");
  if (record.schema_version !== "1.0") throw new TypeError("DeterministicDeriveInput.schema_version must be 1.0");
  const kind = enumValue(record.kind, INPUT_KINDS, "DeterministicDeriveInput.kind");
  const assetRef = record.asset_ref === null ? null : parseRegisteredSourceAssetRef(record.asset_ref, expectedTaskId);
  const resultRef = record.committed_result_ref === null ? null : parseCommittedResultRef(record.committed_result_ref);
  if (kind === "registered_asset" && (assetRef === null || resultRef !== null)) {
    throw new TypeError("registered_asset derive input requires only asset_ref");
  }
  if (kind === "committed_result" && (resultRef === null || assetRef !== null)) {
    throw new TypeError("committed_result derive input requires only committed_result_ref");
  }
  const digest = assertSha256(record.digest, "DeterministicDeriveInput.digest");
  if (assetRef !== null && assetRef.asset_id !== `asset_${digest}`) {
    throw new TypeError("registered derive input digest must match asset_ref");
  }
  if (resultRef !== null && resultRef.output_digest !== digest) {
    throw new TypeError("committed derive input digest must match result output_digest");
  }
  return {
    schema_version: "1.0",
    input_id: assertSafeId(record.input_id, "DeterministicDeriveInput.input_id"),
    kind,
    digest,
    asset_ref: assetRef,
    committed_result_ref: resultRef,
  };
}

function parseInputs(value: unknown, expectedTaskId?: string): DeterministicDeriveInput[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError("derive inputs must be a non-empty array");
  const inputs = value.map((item) => parseInput(item, expectedTaskId));
  if (new Set(inputs.map((item) => item.input_id)).size !== inputs.length) {
    throw new TypeError("derive inputs must not contain duplicate input_id values");
  }
  return inputs;
}

function parseImplementationDigest(value: unknown, name: string): string {
  return assertSha256(value, name);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

type DeterministicDeriveIdentityInput = Pick<
  DeterministicDeriveRequest,
  | "slot"
  | "algorithm_id"
  | "algorithm_version"
  | "implementation_digest"
  | "parameters"
  | "reference"
  | "inputs"
  | "output_schema_ref"
>;

export function computeDeterministicDeriveRequestIdentity(
  request: DeterministicDeriveIdentityInput,
): string {
  const identity = {
    slot: request.slot,
    algorithm_id: request.algorithm_id,
    algorithm_version: request.algorithm_version,
    implementation_digest: request.implementation_digest,
    parameters: request.parameters,
    reference: request.reference,
    inputs: request.inputs,
    output_schema_ref: request.output_schema_ref,
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(identity)), "utf8")
    .digest("hex");
}

export function assertDeterministicDeriveRequestIdentity(
  request: DeterministicDeriveRequest,
): void {
  if (request.request_identity_digest !== computeDeterministicDeriveRequestIdentity(request)) {
    throw new TypeError("derive request identity digest does not match its inputs");
  }
}

export function parseDeterministicDeriveRequest(
  value: unknown,
  expectedTaskId?: string,
  expectedRequirementId?: string,
): DeterministicDeriveRequest {
  const record = assertRecord(value, "DeterministicDeriveRequest");
  assertExactKeys(record, REQUEST_KEYS, "DeterministicDeriveRequest");
  if (record.schema_version !== "1.0") throw new TypeError("DeterministicDeriveRequest.schema_version must be 1.0");
  if (record.slot !== "derive") throw new TypeError("DeterministicDeriveRequest.slot must be derive");
  const taskId = assertSafeId(record.task_id, "DeterministicDeriveRequest.task_id");
  const requirementId = assertSafeId(record.requirement_id, "DeterministicDeriveRequest.requirement_id");
  if (expectedTaskId !== undefined && taskId !== expectedTaskId) throw new TypeError("derive request belongs to a different task");
  if (expectedRequirementId !== undefined && requirementId !== expectedRequirementId) throw new TypeError("derive request belongs to a different build");
  const inputs = parseInputs(record.inputs, taskId);
  const request: DeterministicDeriveRequest = {
    schema_version: "1.0",
    slot: "derive",
    request_id: assertSafeId(record.request_id, "DeterministicDeriveRequest.request_id"),
    task_id: taskId,
    requirement_id: requirementId,
    algorithm_id: assertSafeId(record.algorithm_id, "DeterministicDeriveRequest.algorithm_id"),
    algorithm_version: assertVersion(record.algorithm_version, "DeterministicDeriveRequest.algorithm_version"),
    implementation_digest: parseImplementationDigest(record.implementation_digest, "DeterministicDeriveRequest.implementation_digest"),
    parameters: assertDeclarativeParameters(record.parameters),
    reference: parseReference(record.reference),
    inputs,
    output_schema_ref: assertReferenceIdentifier(record.output_schema_ref, "DeterministicDeriveRequest.output_schema_ref"),
    request_identity_digest: assertSha256(record.request_identity_digest, "DeterministicDeriveRequest.request_identity_digest"),
  };
  assertDeterministicDeriveRequestIdentity(request);
  return request;
}

export function parseDeterministicDeriveProvenance(
  value: unknown,
  expectedTaskId?: string,
): DeterministicDeriveProvenance {
  const record = assertRecord(value, "DeterministicDeriveProvenance");
  assertExactKeys(record, PROVENANCE_KEYS, "DeterministicDeriveProvenance");
  if (record.schema_version !== "1.0") throw new TypeError("DeterministicDeriveProvenance.schema_version must be 1.0");
  if (record.slot !== "derive") throw new TypeError("DeterministicDeriveProvenance.slot must be derive");
  const inputs = parseInputs(record.inputs, expectedTaskId);
  const provenance: DeterministicDeriveProvenance = {
    schema_version: "1.0",
    slot: "derive",
    request_id: assertSafeId(record.request_id, "DeterministicDeriveProvenance.request_id"),
    request_identity_digest: assertSha256(record.request_identity_digest, "DeterministicDeriveProvenance.request_identity_digest"),
    algorithm_id: assertSafeId(record.algorithm_id, "DeterministicDeriveProvenance.algorithm_id"),
    algorithm_version: assertVersion(record.algorithm_version, "DeterministicDeriveProvenance.algorithm_version"),
    implementation_digest: parseImplementationDigest(record.implementation_digest, "DeterministicDeriveProvenance.implementation_digest"),
    parameters: assertDeclarativeParameters(record.parameters),
    reference: parseReference(record.reference),
    inputs,
    output_schema_ref: assertReferenceIdentifier(record.output_schema_ref, "DeterministicDeriveProvenance.output_schema_ref"),
    output_digest: assertSha256(record.output_digest, "DeterministicDeriveProvenance.output_digest"),
  };
  if (provenance.request_identity_digest !== computeDeterministicDeriveRequestIdentity(provenance)) {
    throw new TypeError("derive provenance identity digest does not match its inputs");
  }
  return provenance;
}

export function parseDeterministicDeriveResultReceipt(
  value: unknown,
  expectedTaskId?: string,
  expectedRequirementId?: string,
): DeterministicDeriveResultReceipt {
  const record = assertRecord(value, "DeterministicDeriveResultReceipt");
  assertExactKeys(record, RECEIPT_KEYS, "DeterministicDeriveResultReceipt");
  if (record.schema_version !== "1.0") throw new TypeError("DeterministicDeriveResultReceipt.schema_version must be 1.0");
  if (record.slot !== "derive") throw new TypeError("DeterministicDeriveResultReceipt.slot must be derive");
  if (record.output_kind !== "derived_evidence") throw new TypeError("DeterministicDeriveResultReceipt.output_kind must be derived_evidence");
  const taskId = assertSafeId(record.task_id, "DeterministicDeriveResultReceipt.task_id");
  const requirementId = assertSafeId(record.requirement_id, "DeterministicDeriveResultReceipt.requirement_id");
  if (expectedTaskId !== undefined && taskId !== expectedTaskId) throw new TypeError("derive result belongs to a different task");
  if (expectedRequirementId !== undefined && requirementId !== expectedRequirementId) throw new TypeError("derive result belongs to a different build");
  const provenance = parseDeterministicDeriveProvenance(record.provenance, taskId);
  const requestIdentityDigest = assertSha256(record.request_identity_digest, "DeterministicDeriveResultReceipt.request_identity_digest");
  const outputDigest = assertSha256(record.output_digest, "DeterministicDeriveResultReceipt.output_digest");
  if (provenance.request_identity_digest !== requestIdentityDigest) throw new TypeError("derive result request identity does not match provenance");
  if (provenance.output_digest !== outputDigest) throw new TypeError("derive result output digest does not match provenance");
  if (provenance.request_id !== record.request_id) throw new TypeError("derive result request_id does not match provenance");
  const outputSchemaRef = assertReferenceIdentifier(record.output_schema_ref, "DeterministicDeriveResultReceipt.output_schema_ref");
  if (provenance.output_schema_ref !== outputSchemaRef) throw new TypeError("derive result output schema does not match provenance");
  return {
    schema_version: "1.0",
    result_id: assertSafeId(record.result_id, "DeterministicDeriveResultReceipt.result_id"),
    task_id: taskId,
    requirement_id: requirementId,
    slot: "derive",
    request_id: assertSafeId(record.request_id, "DeterministicDeriveResultReceipt.request_id"),
    request_identity_digest: requestIdentityDigest,
    output_kind: "derived_evidence",
    output_schema_ref: outputSchemaRef,
    output_digest: outputDigest,
    output_summary: assertJsonRecord(record.output_summary, "DeterministicDeriveResultReceipt.output_summary"),
    provenance,
  };
}

export { parseReference as parseDeriveReferenceVersion, parseCommittedResultRef as parseDeriveCommittedResultRef };
