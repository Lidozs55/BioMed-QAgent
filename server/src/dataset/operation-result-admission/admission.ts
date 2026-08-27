/**
 * C-T8 Core quarantine admission, stage 2: OperationResult admission
 * (ADR-033/039 and the current Family Host execution constraints). Stage 1
 * (`transform-admission`) returns only opaque
 * quarantine evidence; this pure adapter re-reads the immutable committed
 * root through a Core-owned opaque resolver, re-verifies hash/size and the
 * closed world, and constructs a strict native `OperationResultManifest`
 * validated by the contracts parser roundtrip.
 *
 * Trust boundary: the Host receipt is never re-parsed here. Every authority
 * is the Core-owned evidence produced by `admitTransformExecution` plus the
 * caller-supplied expected invocation, and the committed bytes are
 * re-verified from disk. The adapter never constructs a
 * PublicationCandidate or Publication — this module is quarantine evidence
 * only.
 */

import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import type {
  JsonValue,
  OperationResultFileReceipt,
  OperationResultKind,
  OperationResultManifest,
  OperationResultOutputKind,
  TerminalReason,
} from "@biomed/contracts";

import { canonicalDigest } from "../adapters/identity.js";
import { parseOperationResultManifest } from "../contracts/operation-result.js";
import { assertJsonRecord } from "../contracts/primitives.js";
import type {
  CoreCommittedTransformOutput,
  TransformQuarantineAdmissionEvidence,
} from "../transform-admission/types.js";
import type {
  ExpectedOperationAdmission,
  OperationResultAdmissionInput,
  OperationResultAdmissionRejectionCode,
} from "./types.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const BUFFER_SIZE = 64 * 1024;

const OPERATION_KINDS: readonly OperationResultKind[] = [
  "acquire",
  "parse",
  "canonicalize",
  "compatibility_gate",
  "integrate",
  "derive",
  "assemble",
  "validate_profile",
  "publish",
];

const OUTPUT_KINDS: readonly OperationResultOutputKind[] = [
  "source_asset",
  "parsed_table",
  "canonical_table",
  "compatibility_report",
  "integrated_table",
  "publication_candidate",
  "derived_evidence",
  "validation_result",
  "publication_manifest",
];

const TERMINAL_REASONS: readonly TerminalReason[] = [
  "succeeded",
  "compile_rejected",
  "admission_rejected",
  "failed",
  "cancelled",
  "timeout",
  "oom",
  "quota_exceeded",
  "policy_violation",
  "sandbox_unavailable",
];

/**
 * ADR-030 output_kind pairing. The contracts parser enforces only four of
 * these; the adapter enforces the full deterministic pairing so a transform
 * result can never be mislabeled (e.g. an assemble result cannot claim
 * `parsed_table`).
 */
const OUTPUT_KIND_BY_OPERATION_KIND: Record<OperationResultKind, OperationResultOutputKind> = {
  acquire: "source_asset",
  parse: "parsed_table",
  canonicalize: "canonical_table",
  compatibility_gate: "compatibility_report",
  integrate: "integrated_table",
  derive: "derived_evidence",
  assemble: "publication_candidate",
  validate_profile: "validation_result",
  publish: "publication_manifest",
};

/** Typed rejection: the only failure product of the pure adapter. */
export class OperationResultAdmissionError extends Error {
  constructor(
    readonly code: OperationResultAdmissionRejectionCode,
    message: string,
  ) {
    super(message);
    this.name = "OperationResultAdmissionError";
  }
}

interface RootIdentity {
  resolvedPath: string;
  realPath: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
}

interface FileSnapshot {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  nlink: number;
}

function rejection(code: OperationResultAdmissionRejectionCode, detail: string): never {
  throw new OperationResultAdmissionError(code, detail);
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : "unknown operation result admission error";
}

function assertNonEmpty(value: unknown, code: OperationResultAdmissionRejectionCode, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    rejection(code, `${name} must be a non-empty string`);
  }
}

function assertNoNul(value: string, code: OperationResultAdmissionRejectionCode, name: string): void {
  if (value.includes("\0")) {
    rejection(code, `${name} must not contain NUL`);
  }
}

function assertDigest(value: unknown, code: OperationResultAdmissionRejectionCode, name: string): string {
  assertNonEmpty(value, code, name);
  if (!SHA256_PATTERN.test(value)) {
    rejection(code, `${name} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertNonNegativeSafeInteger(value: number, code: OperationResultAdmissionRejectionCode, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    rejection(code, `${name} must be a non-negative safe integer`);
  }
}

function enumValue<T extends string>(value: unknown, values: readonly T[], code: OperationResultAdmissionRejectionCode, name: string): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    rejection(code, `${name} is invalid`);
  }
  return value as T;
}

function uniqueStrings(values: readonly string[], code: OperationResultAdmissionRejectionCode, name: string): string[] {
  if (!Array.isArray(values)) {
    rejection(code, `${name} must be an array`);
  }
  for (const [index, item] of values.entries()) {
    assertNonEmpty(item, code, `${name}[${index}]`);
    assertNoNul(item, code, `${name}[${index}]`);
  }
  if (new Set(values).size !== values.length) {
    rejection(code, `${name} must not contain duplicates`);
  }
  return [...values];
}

function validateExpectedOperation(expected: ExpectedOperationAdmission): void {
  for (const [name, value] of [
    ["task_id", expected.task_id],
    ["run_id", expected.run_id ?? ""],
    ["requirement_id", expected.requirement_id],
    ["operation_attempt_id", expected.operation_attempt_id],
  ] as const) {
    assertNonEmpty(value, "INVALID_EXPECTED_OPERATION", `expected.${name}`);
    assertNoNul(value, "INVALID_EXPECTED_OPERATION", `expected.${name}`);
  }
  assertNonEmpty(expected.operation_id, "INVALID_EXPECTED_OPERATION", "expected.operation_id");
  assertNoNul(expected.operation_id, "INVALID_EXPECTED_OPERATION", "expected.operation_id");
  if (
    expected.operation_id.includes("/")
    || expected.operation_id.includes("\\")
    || expected.operation_id.includes("..")
  ) {
    rejection("INVALID_EXPECTED_OPERATION", "expected.operation_id must be a safe operation identifier");
  }
  assertNonNegativeSafeInteger(expected.attempt, "INVALID_EXPECTED_OPERATION", "expected.attempt");
  if (expected.attempt < 1) {
    rejection("INVALID_EXPECTED_OPERATION", "expected.attempt must be >= 1");
  }
  assertNonNegativeSafeInteger(expected.generation, "INVALID_EXPECTED_OPERATION", "expected.generation");

  const exitState = enumValue(
    expected.expected_exit_state,
    TERMINAL_REASONS,
    "INVALID_EXPECTED_OPERATION",
    "expected.expected_exit_state",
  );
  if (exitState !== "succeeded") {
    rejection(
      "NON_SUCCESS_TERMINAL_STATE",
      `operation result admission rejects expected_exit_state=${exitState}; only succeeded may be admitted`,
    );
  }

  const operationKind = enumValue(
    expected.operation_kind,
    OPERATION_KINDS,
    "INVALID_EXPECTED_OPERATION",
    "expected.operation_kind",
  );
  const outputKind = enumValue(
    expected.output_kind,
    OUTPUT_KINDS,
    "INVALID_EXPECTED_OPERATION",
    "expected.output_kind",
  );
  if (OUTPUT_KIND_BY_OPERATION_KIND[operationKind] !== outputKind) {
    rejection(
      "OUTPUT_KIND_MISMATCH",
      `operation_kind=${operationKind} must pair with output_kind=${OUTPUT_KIND_BY_OPERATION_KIND[operationKind]}, got ${outputKind}`,
    );
  }

  assertDigest(expected.input_digest, "INVALID_EXPECTED_OPERATION", "expected.input_digest");
  assertDigest(expected.parameter_digest, "INVALID_EXPECTED_OPERATION", "expected.parameter_digest");
  assertDigest(expected.implementation_digest, "INVALID_EXPECTED_OPERATION", "expected.implementation_digest");
  try {
    assertJsonRecord(expected.output_summary, "expected.output_summary");
  } catch (error) {
    rejection("INVALID_EXPECTED_OPERATION", `expected.output_summary must be a JSON record: ${errorDetail(error)}`);
  }
  uniqueStrings(expected.input_asset_ids, "INVALID_EXPECTED_OPERATION", "expected.input_asset_ids");
  uniqueStrings(expected.upstream_result_manifest_ids, "INVALID_EXPECTED_OPERATION", "expected.upstream_result_manifest_ids");
  uniqueStrings(expected.declared_schemas, "INVALID_EXPECTED_OPERATION", "expected.declared_schemas");
  uniqueStrings(expected.declared_locators, "INVALID_EXPECTED_OPERATION", "expected.declared_locators");
}

function validateEvidence(evidence: TransformQuarantineAdmissionEvidence): void {
  if (
    evidence.schema_version !== "1.0"
    || evidence.evidence_kind !== "transform_quarantine_admission"
    || evidence.owner !== "dataset_core"
  ) {
    rejection("INVALID_EVIDENCE", "evidence must be Core-owned transform quarantine admission evidence");
  }
  if (evidence.decision !== "admitted" || evidence.rejection_code !== null || evidence.rejection_detail !== null) {
    rejection(
      "REJECTED_EVIDENCE",
      `quarantine evidence was not admitted (decision=${evidence.decision}, rejection_code=${evidence.rejection_code ?? "none"})`,
    );
  }
  if (
    evidence.receipt_evidence_class !== "production_host_receipt"
    && evidence.receipt_evidence_class !== "synthetic_test_fixture_receipt"
  ) {
    rejection("INVALID_EVIDENCE", "evidence must carry an explicit receipt evidence class");
  }
  for (const name of ["task_id", "run_id", "requirement_id", "invocation_id"] as const) {
    const value = evidence[name];
    if (value === null) {
      rejection("INVALID_EVIDENCE", `admitted evidence must carry ${name}`);
    }
  }
  if (evidence.attempt === null || evidence.generation === null) {
    rejection("INVALID_EVIDENCE", "admitted evidence must carry attempt and generation");
  }
  if (evidence.committed_root_ref === null) {
    rejection("INVALID_EVIDENCE", "admitted evidence must reference a committed root");
  }
  if (evidence.output_digest === null) {
    rejection("INVALID_EVIDENCE", "admitted evidence must carry an output digest");
  }
  assertDigest(evidence.output_digest, "INVALID_EVIDENCE", "evidence.output_digest");
  if (!Array.isArray(evidence.outputs) || evidence.outputs.length === 0) {
    rejection("INVALID_EVIDENCE", "admitted evidence must carry committed outputs");
  }
}

function assertInvocationBinding(
  evidence: TransformQuarantineAdmissionEvidence,
  expected: ExpectedOperationAdmission,
): void {
  if (
    evidence.task_id !== expected.task_id
    || evidence.requirement_id !== expected.requirement_id
    || evidence.attempt !== expected.attempt
  ) {
    rejection(
      "CROSS_TASK_MISMATCH",
      "evidence invocation identity (task/build/attempt) does not match the expected Core invocation",
    );
  }
  const generation = evidence.generation;
  if (generation === null) {
    rejection("INVALID_EVIDENCE", "admitted evidence must carry generation");
  }
  if (generation !== expected.generation) {
    const phase = generation < expected.generation
      ? "is stale (behind the expected generation)"
      : "is from a future generation";
    rejection(
      "LATE_GENERATION",
      `quarantine evidence generation=${generation} ${phase} (expected generation=${expected.generation})`,
    );
  }
}

function assertEvidenceDigestClosure(evidence: TransformQuarantineAdmissionEvidence): void {
  if (canonicalDigest(evidence.outputs) !== evidence.output_digest) {
    rejection("EVIDENCE_DIGEST_MISMATCH", "evidence output_digest does not close over its committed outputs");
  }
}

function validateCommittedOutputs(
  evidence: TransformQuarantineAdmissionEvidence,
  expected: ExpectedOperationAdmission,
): CoreCommittedTransformOutput[] {
  const outputs = evidence.outputs;
  const paths = new Set<string>();
  const tableIds = new Set<string>();
  for (const [index, output] of outputs.entries()) {
    const name = `evidence.outputs[${index}]`;
    for (const field of ["table_id", "schema_ref", "artifact_ref", "locator_ref"] as const) {
      assertNonEmpty(output[field], "INVALID_EVIDENCE", `${name}.${field}`);
      assertNoNul(output[field], "INVALID_EVIDENCE", `${name}.${field}`);
    }
    let relativePath: string;
    try {
      relativePath = assertRelativePathLocal(output.relative_path, `${name}.relative_path`);
    } catch {
      rejection("ABSOLUTE_PATH", `${name}.relative_path must be a canonical relative path`);
    }
    if (relativePath !== output.relative_path || output.relative_path.includes("\\")) {
      rejection("ABSOLUTE_PATH", `${name}.relative_path must use canonical forward slashes`);
    }
    if (paths.has(relativePath)) {
      rejection("INVALID_EVIDENCE", "committed output paths must be unique");
    }
    paths.add(relativePath);
    if (tableIds.has(output.table_id)) {
      rejection("INVALID_EVIDENCE", "committed output table ids must be unique");
    }
    tableIds.add(output.table_id);
    if (output.delimiter !== "," && output.delimiter !== "\t") {
      rejection("INVALID_EVIDENCE", `${name}.delimiter must be comma or tab`);
    }
    if (!Array.isArray(output.header) || output.header.length === 0) {
      rejection("INVALID_EVIDENCE", `${name}.header must not be empty`);
    }
    for (const [columnIndex, column] of output.header.entries()) {
      assertNonEmpty(column, "INVALID_EVIDENCE", `${name}.header[${columnIndex}]`);
      assertNoNul(column, "INVALID_EVIDENCE", `${name}.header[${columnIndex}]`);
    }
    if (new Set(output.header).size !== output.header.length) {
      rejection("INVALID_EVIDENCE", `${name}.header columns must be unique`);
    }
    assertNonNegativeSafeInteger(output.size_bytes, "INVALID_EVIDENCE", `${name}.size_bytes`);
    assertDigest(output.sha256, "INVALID_EVIDENCE", `${name}.sha256`);
    assertNonNegativeSafeInteger(output.row_count, "INVALID_EVIDENCE", `${name}.row_count`);
    if (!Array.isArray(output.source_locators) || output.source_locators.length === 0) {
      rejection("INVALID_EVIDENCE", `${name}.source_locators must not be empty`);
    }
    for (const [locatorIndex, locator] of output.source_locators.entries()) {
      const locatorName = `${name}.source_locators[${locatorIndex}]`;
      assertNonEmpty(locator.asset_id, "INVALID_EVIDENCE", `${locatorName}.asset_id`);
      assertNoNul(locator.asset_id, "INVALID_EVIDENCE", `${locatorName}.asset_id`);
      if (!expected.input_asset_ids.includes(locator.asset_id)) {
        rejection(
          "UNKNOWN_INPUT",
          `${name} locator references unknown input asset ${locator.asset_id}`,
        );
      }
    }
    if (!expected.declared_schemas.includes(output.schema_ref)) {
      rejection("UNKNOWN_SCHEMA", `${name} references undeclared schema ${output.schema_ref}`);
    }
    if (!expected.declared_locators.includes(output.locator_ref)) {
      rejection("UNKNOWN_LOCATOR", `${name} references undeclared locator ${output.locator_ref}`);
    }
  }
  for (const schema of expected.declared_schemas) {
    if (!outputs.some((output) => output.schema_ref === schema)) {
      rejection("INVALID_EXPECTED_OPERATION", `declared schema ${schema} has no committed output`);
    }
  }
  for (const locator of expected.declared_locators) {
    if (!outputs.some((output) => output.locator_ref === locator)) {
      rejection("INVALID_EXPECTED_OPERATION", `declared locator ${locator} has no committed output`);
    }
  }
  return outputs;
}

function assertRelativePathLocal(value: string, name: string): string {
  if (
    value.length === 0
    || value.includes("\\")
    || value.startsWith("/")
    || value.includes("..")
    || /^[A-Za-z]:[\\/]/.test(value)
  ) {
    throw new TypeError(`${name} must be a POSIX relative path`);
  }
  return value;
}

async function resolveCommittedRoot(
  resolver: OperationResultAdmissionInput["resolve_committed_root"],
  committedRootRef: string,
): Promise<string> {
  assertNonEmpty(committedRootRef, "INVALID_EVIDENCE", "evidence.committed_root_ref");
  assertNoNul(committedRootRef, "INVALID_EVIDENCE", "evidence.committed_root_ref");
  if (
    committedRootRef.includes("/")
    || committedRootRef.includes("\\")
    || committedRootRef.includes("..")
    || path.isAbsolute(committedRootRef)
  ) {
    rejection(
      "ABSOLUTE_PATH",
      "evidence.committed_root_ref must be an opaque relative child name, never an absolute or escaping path",
    );
  }
  let resolved: string;
  try {
    resolved = await resolver(committedRootRef);
  } catch (error) {
    rejection("INVALID_COMMITTED_ROOT", `committed root resolver failed: ${errorDetail(error)}`);
  }
  if (typeof resolved !== "string" || resolved.length === 0 || resolved.includes("\0")) {
    rejection("INVALID_COMMITTED_ROOT", "committed root resolver must return a non-empty path without NUL");
  }
  if (!path.isAbsolute(resolved)) {
    rejection("ABSOLUTE_PATH", "committed root resolver must return an absolute path");
  }
  return resolved;
}

function identityFromStats(resolvedPath: string, realPath: string, stats: Stats): RootIdentity {
  return {
    resolvedPath,
    realPath,
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
  };
}

function sameRootIdentity(identity: RootIdentity, stats: Stats): boolean {
  return stats.isDirectory()
    && !stats.isSymbolicLink()
    && stats.dev === identity.dev
    && stats.ino === identity.ino
    && stats.birthtimeMs === identity.birthtimeMs;
}

function sameFilesystemPath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLocaleLowerCase("en-US") === right.toLocaleLowerCase("en-US")
    : left === right;
}

async function captureRealDirectory(input: string, name: string): Promise<RootIdentity> {
  const resolvedPath = path.resolve(input);
  const stats = await lstat(resolvedPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    rejection("INVALID_COMMITTED_ROOT", `${name} must be a real directory`);
  }
  const realPath = await realpath(resolvedPath);
  if (!sameFilesystemPath(realPath, resolvedPath)) {
    rejection("INVALID_COMMITTED_ROOT", `${name} must not traverse a symlink or junction`);
  }
  return identityFromStats(resolvedPath, realPath, stats);
}

async function assertRootUnchanged(identity: RootIdentity, name: string): Promise<void> {
  const stats = await lstat(identity.resolvedPath);
  const currentRealPath = await realpath(identity.resolvedPath);
  if (!sameRootIdentity(identity, stats) || !sameFilesystemPath(currentRealPath, identity.realPath)) {
    rejection("INVALID_COMMITTED_ROOT", `${name} was swapped during admission`);
  }
}

function sameOrInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function expectedDirectories(relativePaths: readonly string[]): Set<string> {
  const directories = new Set<string>();
  for (const relativePath of relativePaths) {
    const segments = relativePath.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }
  return directories;
}

async function assertClosedWorld(
  root: RootIdentity,
  relativePaths: readonly string[],
): Promise<void> {
  await assertRootUnchanged(root, "committed root");
  const expectedFiles = new Set(relativePaths);
  const expectedDirs = expectedDirectories(relativePaths);
  const actualFiles = new Set<string>();
  const actualDirs = new Set<string>();

  async function visit(absoluteDirectory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const relativeEntry = relativeDirectory.length === 0
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      const absoluteEntry = path.join(absoluteDirectory, entry.name);
      const stats = await lstat(absoluteEntry);
      if (stats.isSymbolicLink()) {
        rejection("INVALID_COMMITTED_ROOT", `committed root/${relativeEntry} is a symlink or junction`);
      }
      if (stats.isDirectory()) {
        if (!expectedDirs.has(relativeEntry)) {
          rejection("CLOSED_WORLD_MISMATCH", `committed root contains undeclared directory ${relativeEntry}`);
        }
        actualDirs.add(relativeEntry);
        await visit(absoluteEntry, relativeEntry);
      } else if (stats.isFile()) {
        if (stats.nlink !== 1) {
          rejection("INVALID_COMMITTED_ROOT", `committed root/${relativeEntry} is hard-linked`);
        }
        if (!expectedFiles.has(relativeEntry)) {
          rejection("CLOSED_WORLD_MISMATCH", `committed root contains undeclared file ${relativeEntry}`);
        }
        actualFiles.add(relativeEntry);
      } else {
        rejection("INVALID_COMMITTED_ROOT", `committed root/${relativeEntry} is not a regular file`);
      }
    }
  }

  await visit(root.realPath, "");
  if (actualFiles.size !== expectedFiles.size || actualDirs.size !== expectedDirs.size) {
    rejection("CLOSED_WORLD_MISMATCH", "committed root does not contain the exact declared file closure");
  }
  await assertRootUnchanged(root, "committed root");
}

function fileSnapshot(stats: Stats): FileSnapshot {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    birthtimeMs: stats.birthtimeMs,
    nlink: stats.nlink,
  };
}

function sameFileSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs
    && left.nlink === right.nlink;
}

async function hashHandle(handle: FileHandle): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(BUFFER_SIZE);
  let position = 0;
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
    if (!Number.isSafeInteger(position)) {
      rejection("OUTPUT_BYTES_MISMATCH", "committed output size exceeds safe integer range");
    }
  }
  return { sha256: hash.digest("hex"), sizeBytes: position };
}

async function verifyCommittedFile(
  root: RootIdentity,
  output: CoreCommittedTransformOutput,
): Promise<void> {
  await assertRootUnchanged(root, "committed root");
  const requestedPath = path.resolve(root.realPath, ...output.relative_path.split("/"));
  if (!sameOrInside(root.realPath, requestedPath) || requestedPath === root.realPath) {
    rejection("INVALID_COMMITTED_ROOT", `${output.relative_path} escapes the committed root`);
  }
  const before = await lstat(requestedPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    rejection("INVALID_COMMITTED_ROOT", `${output.relative_path} is not an independent regular file`);
  }
  if (!sameFilesystemPath(await realpath(requestedPath), requestedPath)) {
    rejection("INVALID_COMMITTED_ROOT", `${output.relative_path} traverses a symlink or junction`);
  }
  if (before.size !== output.size_bytes) {
    rejection(
      "OUTPUT_BYTES_MISMATCH",
      `${output.relative_path} size ${before.size} does not match the committed evidence ${output.size_bytes}`,
    );
  }
  const beforeSnapshot = fileSnapshot(before);
  const handle = await open(requestedPath, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || !sameFileSnapshot(beforeSnapshot, fileSnapshot(opened))) {
      rejection("INVALID_COMMITTED_ROOT", `${output.relative_path} changed while being opened`);
    }
    const openedSnapshot = fileSnapshot(opened);
    const hashed = await hashHandle(handle);
    const current = fileSnapshot(await handle.stat());
    if (!sameFileSnapshot(openedSnapshot, current)) {
      rejection("INVALID_COMMITTED_ROOT", `${output.relative_path} was mutated while being hashed`);
    }
    if (hashed.sha256 !== output.sha256 || hashed.sizeBytes !== output.size_bytes) {
      rejection(
        "OUTPUT_BYTES_MISMATCH",
        `${output.relative_path} bytes do not match the committed evidence`,
      );
    }
  } finally {
    await handle.close();
  }
}

function buildManifest(
  evidence: TransformQuarantineAdmissionEvidence,
  expected: ExpectedOperationAdmission,
  committedAt: string,
  outputs: readonly CoreCommittedTransformOutput[],
): OperationResultManifest {
  const outputFiles: OperationResultFileReceipt[] = [...outputs]
    .map((output) => ({
      relative_path: output.relative_path,
      size_bytes: output.size_bytes,
      sha256: output.sha256,
    }))
    .sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  const resultManifestId = canonicalDigest({
    task_id: expected.task_id,
    run_id: expected.run_id ?? "run_unknown",
    requirement_id: expected.requirement_id,
    operation_id: expected.operation_id,
    operation_attempt_id: expected.operation_attempt_id,
  });
  return {
    schema_version: "1.0",
    result_manifest_id: resultManifestId,
    task_id: expected.task_id,
    run_id: expected.run_id ?? "run_unknown",
    requirement_id: expected.requirement_id,
    operation_id: expected.operation_id,
    operation_kind: expected.operation_kind,
    operation_attempt_id: expected.operation_attempt_id,
    attempt: expected.attempt,
    status: "succeeded",
    input_digest: expected.input_digest,
    parameter_digest: expected.parameter_digest,
    implementation_digest: expected.implementation_digest,
    // The Core-committed output digest from the quarantine evidence (verified
    // to close over evidence.outputs) flows through unchanged.
    output_digest: evidence.output_digest as string,
    output_kind: expected.output_kind,
    output_summary: JSON.parse(JSON.stringify(expected.output_summary)) as Record<string, JsonValue>,
    output_files: outputFiles,
    dependency_closure: {
      input_asset_ids: [...expected.input_asset_ids].sort(),
      upstream_result_manifest_ids: [...expected.upstream_result_manifest_ids].sort(),
      parameter_digest: expected.parameter_digest,
      implementation_digest: expected.implementation_digest,
    },
    commit: {
      state: "committed",
      commit_id: canonicalDigest({
        result_manifest_id: resultManifestId,
        committed_at: committedAt,
      }),
      committed_at: committedAt,
    },
  };
}

/**
 * Admit one committed quarantine root as a strict native
 * `OperationResultManifest`. Rejects (by throwing
 * `OperationResultAdmissionError`) on any tamper, closure violation, unknown
 * schema/locator/input, stale generation, absolute path, or non-succeeded
 * declared terminal state. Never constructs a PublicationCandidate.
 */
export async function admitOperationResultFromQuarantine(
  input: OperationResultAdmissionInput,
): Promise<OperationResultManifest> {
  const now = (input.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) {
    throw new TypeError("Core admission clock returned an invalid timestamp");
  }
  const committedAt = input.expected.committed_at ?? now.toISOString();
  try {
    validateExpectedOperation(input.expected);
  } catch (error) {
    if (error instanceof OperationResultAdmissionError) throw error;
    rejection("INVALID_EXPECTED_OPERATION", errorDetail(error));
  }
  validateEvidence(input.evidence);
  assertInvocationBinding(input.evidence, input.expected);
  assertEvidenceDigestClosure(input.evidence);
  const outputs = validateCommittedOutputs(input.evidence, input.expected);

  const rootPath = await resolveCommittedRoot(
    input.resolve_committed_root,
    input.evidence.committed_root_ref as string,
  );
  const root = await captureRealDirectory(rootPath, "committed root");
  const relativePaths = outputs.map((output) => output.relative_path);
  await assertClosedWorld(root, relativePaths);
  for (const output of outputs) {
    await verifyCommittedFile(root, output);
  }
  await assertRootUnchanged(root, "committed root");

  const manifest = buildManifest(input.evidence, input.expected, committedAt, outputs);
  parseOperationResultManifest(manifest, input.expected.task_id, input.expected.run_id, input.expected.requirement_id);
  parseOperationResultManifest(
    JSON.parse(JSON.stringify(manifest)) as unknown,
    input.expected.task_id,
    input.expected.run_id,
    input.expected.requirement_id,
  );
  return manifest;
}
