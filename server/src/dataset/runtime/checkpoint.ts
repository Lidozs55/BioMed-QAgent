/**
 * Persistent build state for crash recovery and idempotent operation reuse
 * (Python ``app/datasets/runtime/checkpoint.py``; ARCHITECTURE §5.1;
 * Design §12.2).
 *
 * Mirrors the V1 pipeline checkpoint semantics (atomic writes, file hash
 * verification, append-only attempt prefix validation) keyed by operation
 * instead of stage.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { types } from "node:util";
import { sha256FileStream } from "../adapters/hashing.js";
import { OperationAbortedError, throwIfAborted } from "../cooperative.js";
import { parseOperationResultManifest } from "../contracts/operation-result.js";
import type { OperationResultManifest } from "@biomed/contracts";
import { sha256Json } from "./digests.js";
import type { CoreReleaseIdentity } from "./release-identity.js";
import {
  parseOperationAttempt,
  type OperationAttempt,
  type OperationOutput,
  type StageOutputFile,
} from "./operations.js";

export { sha256Json };

/** Map an operation id to a safe file stem (ids may contain ':'). */
export function operationFilename(operationId: string): string {
  return operationId.replace(/:/g, "_");
}

/**
 * Build execution state with append-only operation-attempt history (Python
 * ``BuildState``).
 */
export interface BuildState {
  task_id: string;
  build_id: string;
  operation_attempts: OperationAttempt[];
  inflight_attempt: OperationAttempt | null;
  completed_operations: Record<string, string>;
  fixed_operation_checkpoint_identities: FixedOperationCheckpointIdentityState;
}

export function newBuildState(taskId: string, buildId: string): BuildState {
  return {
    task_id: taskId,
    build_id: buildId,
    operation_attempts: [],
    inflight_attempt: null,
    completed_operations: {},
    fixed_operation_checkpoint_identities: nativeFixedOperationCheckpointIdentityState(),
  };
}

/**
 * Find a SUCCEEDED attempt matching the given digests (idempotency).  The
 * scan is in reverse append order (Python ``BuildState.find_reusable``).
 */
export function findReusable(
  state: BuildState,
  operationId: string,
  inputDigest: string,
  parameterDigest: string,
): OperationAttempt | null {
  for (let index = state.operation_attempts.length - 1; index >= 0; index -= 1) {
    const attempt = state.operation_attempts[index];
    if (
      attempt.operation_id === operationId &&
      attempt.status === "succeeded" &&
      attempt.input_digest === inputDigest &&
      attempt.parameter_digest === parameterDigest
    ) {
      return attempt;
    }
  }
  return null;
}

const CHECKPOINT_SHA256 = /^[0-9a-f]{64}$/u;
const CHECKPOINT_RELEASE_IDENTITY = /^(?:sha256:[0-9a-f]{64}|ref:[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127})$/u;
const PERSISTED_IDENTITY_KEYS = new Set([
  "core_release_identity",
  "fixed_operation_implementation_component_digest",
]);
const EXPECTED_IDENTITY_KEYS = new Set([
  "coreReleaseIdentity",
  "implementationComponentDigest",
]);

type CheckpointIdentityRecord = Record<string, unknown>;

function snapshotCheckpointIdentityRecord(
  value: unknown,
  keys: ReadonlySet<string>,
  label: string,
): CheckpointIdentityRecord {
  if (
    value === null || typeof value !== "object" || Array.isArray(value)
    || types.isProxy(value) || !Object.isFrozen(value)
  ) {
    throw new TypeError(`${label} must be a frozen plain non-Proxy object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must have a plain object prototype`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.size || ownKeys.some((key) =>
    typeof key !== "string" || !keys.has(key))) {
    throw new TypeError(`${label} has unknown or missing fields`);
  }
  const result = Object.create(null) as CheckpointIdentityRecord;
  for (const key of ownKeys) {
    const descriptor = descriptors[key as string];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`${label}.${String(key)} must be an enumerable data property`);
    }
    result[key as string] = descriptor.value;
  }
  return result;
}

/** Identity persisted beside a fixed operation checkpoint. */
export interface FixedOperationCheckpointIdentity {
  readonly core_release_identity: string | null | undefined;
  readonly fixed_operation_implementation_component_digest: string | null | undefined;
}

export type FixedOperationCheckpointMigrationState =
  | "native"
  | "legacy_identity_missing";

/**
 * Per-operation identities persisted in the same atomic BuildState snapshot as
 * the attempt and completion projection. A legacy state has no identity
 * evidence and therefore cannot make an old checkpoint reusable.
 */
export interface FixedOperationCheckpointIdentityState {
  readonly schema_version: "1.0";
  migration_state: FixedOperationCheckpointMigrationState;
  readonly operations: Record<string, Readonly<FixedOperationCheckpointIdentity>>;
}

const FIXED_OPERATION_IDENTITY_STATE_KEYS = new Set([
  "schema_version",
  "migration_state",
  "operations",
]);

function nativeFixedOperationCheckpointIdentityState(): FixedOperationCheckpointIdentityState {
  return {
    schema_version: "1.0",
    migration_state: "native",
    operations: {},
  };
}

function parseFixedOperationCheckpointIdentity(
  value: unknown,
  operationId: string,
): Readonly<FixedOperationCheckpointIdentity> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`fixed operation checkpoint identity '${operationId}' must be an object`);
  }
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== PERSISTED_IDENTITY_KEYS.size ||
    keys.some((key) => typeof key !== "string" || !PERSISTED_IDENTITY_KEYS.has(key))
  ) {
    throw new TypeError(`fixed operation checkpoint identity '${operationId}' has unknown or missing fields`);
  }
  return Object.freeze({
    core_release_identity: record.core_release_identity as string | null | undefined,
    fixed_operation_implementation_component_digest:
      record.fixed_operation_implementation_component_digest as string | null | undefined,
  });
}

function parseFixedOperationCheckpointIdentityState(
  value: unknown,
): FixedOperationCheckpointIdentityState {
  if (value === undefined) {
    return {
      schema_version: "1.0",
      migration_state: "legacy_identity_missing",
      operations: {},
    };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("fixed operation checkpoint identities must be an object");
  }
  const record = value as Record<string, unknown>;
  const keys = Reflect.ownKeys(record);
  if (
    keys.length !== FIXED_OPERATION_IDENTITY_STATE_KEYS.size ||
    keys.some((key) => typeof key !== "string" || !FIXED_OPERATION_IDENTITY_STATE_KEYS.has(key))
  ) {
    throw new TypeError("fixed operation checkpoint identities have unknown or missing fields");
  }
  if (record.schema_version !== "1.0") {
    throw new TypeError("fixed operation checkpoint identity schema_version must be '1.0'");
  }
  if (record.migration_state !== "native" && record.migration_state !== "legacy_identity_missing") {
    throw new TypeError("fixed operation checkpoint identity migration_state is invalid");
  }
  if (
    record.operations === null || typeof record.operations !== "object" ||
    Array.isArray(record.operations)
  ) {
    throw new TypeError("fixed operation checkpoint identity operations must be an object");
  }
  const operations = Object.fromEntries(Object.entries(record.operations).map(
    ([operationId, identity]) => [
      operationId,
      parseFixedOperationCheckpointIdentity(identity, operationId),
    ],
  ));
  return {
    schema_version: "1.0",
    migration_state: record.migration_state,
    operations,
  };
}

/** Persist the identity only as part of a successful fixed operation commit. */
export function markFixedOperationCheckpointIdentity(
  state: BuildState,
  operationId: string,
  identity: Readonly<FixedOperationCheckpointIdentity>,
): void {
  state.fixed_operation_checkpoint_identities.migration_state = "native";
  state.fixed_operation_checkpoint_identities.operations[operationId] = Object.freeze({
    core_release_identity: identity.core_release_identity,
    fixed_operation_implementation_component_digest:
      identity.fixed_operation_implementation_component_digest,
  });
}

/** Return persisted identity evidence for one operation, or null for legacy state. */
export function fixedOperationCheckpointIdentity(
  state: BuildState,
  operationId: string,
): Readonly<FixedOperationCheckpointIdentity> | null {
  if (state.fixed_operation_checkpoint_identities.migration_state !== "native") return null;
  return state.fixed_operation_checkpoint_identities.operations[operationId] ?? null;
}

export type CheckpointNotReusableCode =
  | "CHECKPOINT_REUSE_IDENTITY_MISSING"
  | "CHECKPOINT_REUSE_IDENTITY_INVALID"
  | "CHECKPOINT_CORE_RELEASE_IDENTITY_MISMATCH"
  | "CHECKPOINT_OPERATION_IMPLEMENTATION_DIGEST_MISMATCH";

export type FixedOperationCheckpointReuseDecision =
  | {
      readonly kind: "reusable";
      readonly identity_digest: string;
    }
  | {
      readonly kind: "not_reusable";
      readonly code: CheckpointNotReusableCode;
    };

/**
 * Bind fixed-operation checkpoint reuse to both the validated Core release and
 * its deployed implementation component. This staging-only predicate performs
 * no checkpoint lookup or runtime wiring; absent, malformed, or stale identity
 * evidence is an explicit typed cache miss.
 */
export function verifyFixedOperationCheckpointIdentity(
  checkpoint: FixedOperationCheckpointIdentity | null | undefined,
  expected: Readonly<{
    readonly coreReleaseIdentity: CoreReleaseIdentity;
    readonly implementationComponentDigest: string | null | undefined;
  }>,
): FixedOperationCheckpointReuseDecision {
  const expectedRecord = snapshotCheckpointIdentityRecord(
    expected,
    EXPECTED_IDENTITY_KEYS,
    "expected checkpoint identity",
  );
  if (checkpoint === null || checkpoint === undefined) {
    return { kind: "not_reusable", code: "CHECKPOINT_REUSE_IDENTITY_MISSING" };
  }
  const checkpointRecord = snapshotCheckpointIdentityRecord(
    checkpoint,
    PERSISTED_IDENTITY_KEYS,
    "persisted checkpoint identity",
  );
  const coreReleaseIdentity = expectedRecord.coreReleaseIdentity;
  const expectedImplementationDigest = expectedRecord.implementationComponentDigest;
  const persistedReleaseIdentity = checkpointRecord.core_release_identity;
  const persistedImplementationDigest =
    checkpointRecord.fixed_operation_implementation_component_digest;
  if (
    persistedReleaseIdentity === null || persistedReleaseIdentity === undefined ||
    persistedImplementationDigest === null || persistedImplementationDigest === undefined ||
    expectedImplementationDigest === null || expectedImplementationDigest === undefined
  ) {
    return { kind: "not_reusable", code: "CHECKPOINT_REUSE_IDENTITY_MISSING" };
  }
  if (
    typeof coreReleaseIdentity !== "string" ||
    typeof persistedReleaseIdentity !== "string" ||
    typeof expectedImplementationDigest !== "string" ||
    typeof persistedImplementationDigest !== "string" ||
    !CHECKPOINT_RELEASE_IDENTITY.test(coreReleaseIdentity) ||
    !CHECKPOINT_RELEASE_IDENTITY.test(persistedReleaseIdentity) ||
    !CHECKPOINT_SHA256.test(expectedImplementationDigest) ||
    !CHECKPOINT_SHA256.test(persistedImplementationDigest)
  ) {
    return { kind: "not_reusable", code: "CHECKPOINT_REUSE_IDENTITY_INVALID" };
  }
  if (persistedReleaseIdentity !== coreReleaseIdentity) {
    return { kind: "not_reusable", code: "CHECKPOINT_CORE_RELEASE_IDENTITY_MISMATCH" };
  }
  if (persistedImplementationDigest !== expectedImplementationDigest) {
    return {
      kind: "not_reusable",
      code: "CHECKPOINT_OPERATION_IMPLEMENTATION_DIGEST_MISMATCH",
    };
  }
  return {
    kind: "reusable",
    identity_digest: sha256Json({
      core_release_identity: coreReleaseIdentity,
      fixed_operation_implementation_component_digest: expectedImplementationDigest,
    }),
  };
}

/** Append a new operation attempt (append-only, never mutate existing). */
export function appendAttempt(state: BuildState, attempt: OperationAttempt): void {
  state.operation_attempts.push(attempt);
}

/** Record the output digest of a completed operation. */
export function markCompleted(state: BuildState, operationId: string, outputDigest: string): void {
  state.completed_operations[operationId] = outputDigest;
}

interface BuildStateFile {
  task_id: string;
  build_id: string;
  operation_attempts: unknown[];
  inflight_attempt: unknown;
  completed_operations: Record<string, string>;
  fixed_operation_checkpoint_identities?: unknown;
}

/**
 * Load build state from disk, or create a fresh one.  Throws on task/build id
 * mismatch to guard against workdir reuse or accidental id confusion.
 */
export function loadBuildState(stateDir: string, taskId: string, buildId: string): BuildState {
  const stateFile = join(stateDir, "build_state.json");
  if (existsSync(stateFile)) {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as BuildStateFile;
    if (parsed.task_id !== taskId || parsed.build_id !== buildId) {
      throw new Error(
        `build state id mismatch: file has ${parsed.task_id!}/${parsed.build_id!}, requested ${taskId}/${buildId}`,
      );
    }
    return {
      task_id: parsed.task_id,
      build_id: parsed.build_id,
      operation_attempts: parsed.operation_attempts.map((item) =>
        parseOperationAttempt(item),
      ),
      inflight_attempt:
        parsed.inflight_attempt === null || parsed.inflight_attempt === undefined
          ? null
          : parseOperationAttempt(parsed.inflight_attempt),
      completed_operations: parsed.completed_operations,
      fixed_operation_checkpoint_identities: parseFixedOperationCheckpointIdentityState(
        parsed.fixed_operation_checkpoint_identities,
      ),
    };
  }
  return newBuildState(taskId, buildId);
}

/** Persist build state atomically via temp file + rename. */
export function saveBuildState(stateDir: string, state: BuildState): void {
  mkdirSync(stateDir, { recursive: true });
  const stateFile = join(stateDir, "build_state.json");
  const tmp = `${stateFile}.part`;
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, stateFile);
}

/** Versioned, attempt-bound checkpoint for one operation output. */
export interface OperationOutputEnvelope {
  task_id: string;
  build_id: string;
  operation_id: string;
  operation_attempt_id: string;
  output_digest: string;
  output_sha256: string;
  output: Record<string, unknown>;
  files: StageOutputFile[];
}

/**
 * Serialize one operation output to ``state/<operation_id>_output.json``
 * (atomic write, Python ``save_operation_output``).
 */
export function saveOperationOutput(
  stateDir: string,
  envelope: OperationOutputEnvelope,
): void {
  mkdirSync(stateDir, { recursive: true });
  const outputFile = join(stateDir, `${operationFilename(envelope.operation_id)}_output.json`);
  const payload = `${JSON.stringify(envelope, null, 2)}\n`;
  const tmp = `${outputFile}.part`;
  writeFileSync(tmp, payload, "utf8");
  renameSync(tmp, outputFile);
}

function isInsideRoot(resolvedPath: string, root: string): boolean {
  if (resolvedPath === root) return true;
  return resolvedPath.startsWith(`${root}${sep}`);
}

/**
 * Load and validate an attempt-bound operation output checkpoint.  Returns
 * ``null`` when the checkpoint is missing, belongs to a different
 * task/build/attempt, fails digest or file hash verification, or references
 * files that no longer match (Python ``load_operation_output``).
 */
export async function loadOperationOutput(
  stateDir: string,
  options: {
    taskRoot: string;
    taskId: string;
    buildId: string;
    operationId: string;
    operationAttemptId: string;
    outputDigest: string;
    expectedFiles?: readonly StageOutputFile[];
  },
  cancellationSignal?: AbortSignal | null,
): Promise<Record<string, unknown> | null> {
  const outputFile = join(stateDir, `${operationFilename(options.operationId)}_output.json`);
  if (!existsSync(outputFile)) return null;
  try {
    throwIfAborted(cancellationSignal);
    const envelope = JSON.parse(readFileSync(outputFile, "utf8")) as OperationOutputEnvelope;
    const outputDigest = sha256Json(envelope.output);
    if (
      envelope.task_id !== options.taskId ||
      envelope.build_id !== options.buildId ||
      envelope.operation_id !== options.operationId ||
      envelope.operation_attempt_id !== options.operationAttemptId ||
      envelope.output_digest !== options.outputDigest ||
      envelope.output_digest !== outputDigest ||
      envelope.output_sha256 !== outputDigest ||
      (options.expectedFiles !== undefined &&
        JSON.stringify(envelope.files) !== JSON.stringify(options.expectedFiles))
    ) {
      return null;
    }
    const root = resolve(options.taskRoot);
    for (const file of envelope.files) {
      const parts = file.relative_path.split("/").filter((part) => part.length > 0);
      const path = join(options.taskRoot, ...parts);
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat === undefined || stat.isSymbolicLink()) return null;
      const resolved = resolve(path);
      if (!isInsideRoot(resolved, root)) return null;
      if (!existsSync(resolved)) return null;
      const fileStat = statSync(resolved);
      if (!fileStat.isFile()) return null;
      if (fileStat.size !== file.size_bytes) return null;
      if ((await sha256FileStream(resolved, cancellationSignal)) !== file.sha256) return null;
      // A successful hash is not enough when the path can be replaced while
      // it is being read. Re-stat after hashing so a late replacement or
      // append cannot turn an unverified byte sequence into a reusable
      // checkpoint.
      const afterHash = lstatSync(resolved, { throwIfNoEntry: false });
      if (
        afterHash === undefined ||
        afterHash.isSymbolicLink() ||
        !afterHash.isFile() ||
        afterHash.dev !== fileStat.dev ||
        afterHash.ino !== fileStat.ino ||
        afterHash.size !== file.size_bytes ||
        afterHash.mtimeMs !== fileStat.mtimeMs ||
        afterHash.ctimeMs !== fileStat.ctimeMs
      ) return null;
    }
    return envelope.output;
  } catch (error) {
    if (error instanceof OperationAbortedError) throw error;
    return null;
  }
}

/**
 * Validate that ``attempts.jsonl`` is an exact prefix of durable state.
 * Returns the number of persisted records (used for incremental appends).
 * Throws on a gap or mismatch — a crash must never leave an append-only log
 * diverged from the state projection (Python ``validate_attempt_log_prefix``).
 */
export function validateAttemptLogPrefix(
  state: BuildState,
  attemptsPath: string,
): number {
  if (!existsSync(attemptsPath)) return 0;
  const lines = readFileSync(attemptsPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length > state.operation_attempts.length) {
    throw new Error("operation attempt log is ahead of durable state");
  }
  for (let index = 0; index < lines.length; index += 1) {
    const persisted = parseOperationAttempt(JSON.parse(lines[index]));
    if (!deepEqualAttempt(persisted, state.operation_attempts[index])) {
      throw new Error("operation attempt log is not a durable state prefix");
    }
  }
  return lines.length;
}

function deepEqualAttempt(a: OperationAttempt, b: OperationAttempt): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Convenience: build a StageOutputFile triple. */
export function stageOutputFile(
  relativePath: string,
  sizeBytes: number,
  sha256: string,
): StageOutputFile {
  return { relative_path: relativePath, size_bytes: sizeBytes, sha256 };
}

/**
 * Atomic checkpoint write for one operation's result manifest (ADR-030).
 * Uses the same tmp-file + rename pattern as ``saveOperationOutput`` so a
 * crash can never leave a partially-written manifest behind.
 */
export function saveOperationResultManifest(
  stateDir: string,
  manifest: OperationResultManifest,
): void {
  mkdirSync(stateDir, { recursive: true });
  const manifestFile = join(
    stateDir,
    `${operationFilename(manifest.operation_id)}_result.json`,
  );
  const tmpFile = `${manifestFile}.part`;
  writeFileSync(tmpFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(tmpFile, manifestFile);
}

/**
 * Read back one operation's result manifest, verified by the strict ADR-030
 * contracts parser. Returns null when missing or malformed (fail-closed,
 * mirrors ``loadOperationOutput``).
 */
export function loadOperationResultManifest(
  stateDir: string,
  operationId: string,
): OperationResultManifest | null {
  const manifestFile = join(
    stateDir,
    `${operationFilename(operationId)}_result.json`,
  );
  if (!existsSync(manifestFile)) return null;
  try {
    return parseOperationResultManifest(JSON.parse(readFileSync(manifestFile, "utf8")));
  } catch {
    return null;
  }
}

export type { OperationOutput };