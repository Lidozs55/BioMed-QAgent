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
import { sha256FileStream } from "../adapters/hashing.js";
import { OperationAbortedError, throwIfAborted } from "../cooperative.js";
import { parseOperationResultManifest } from "../contracts/operation-result.js";
import type { OperationResultManifest } from "@biomed/contracts";
import { sha256Json } from "./digests.js";
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
}

export function newBuildState(taskId: string, buildId: string): BuildState {
  return {
    task_id: taskId,
    build_id: buildId,
    operation_attempts: [],
    inflight_attempt: null,
    completed_operations: {},
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
  },
  cancellationSignal?: AbortSignal | null,
): Promise<Record<string, unknown> | null> {
  const outputFile = join(stateDir, `${operationFilename(options.operationId)}_output.json`);
  if (!existsSync(outputFile)) return null;
  try {
    throwIfAborted(cancellationSignal);
    const envelope = JSON.parse(readFileSync(outputFile, "utf8")) as OperationOutputEnvelope;
    if (
      envelope.task_id !== options.taskId ||
      envelope.build_id !== options.buildId ||
      envelope.operation_id !== options.operationId ||
      envelope.operation_attempt_id !== options.operationAttemptId ||
      envelope.output_digest !== options.outputDigest ||
      envelope.output_sha256 !== sha256Json(envelope.output)
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