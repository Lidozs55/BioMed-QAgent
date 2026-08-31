/**
 * Gold6 R4 automatic untrusted-artifact fallback (Host/Core-owned slice).
 *
 * When a fully committed dynamic execution (``DynamicFamilyExecutionResult``)
 * fails formal publication with an allowlisted typed rejection (literature
 * semantic profile, final B3/ProductAssessment non-publishable, or
 * ``publication_acceptance`` human reject/skip), this helper archives each
 * candidate table once into the existing, non-authoritative task quarantine
 * (``untrusted-artifact-store.ts``) so the user can still download the bytes.
 * The quarantine never produces an OperationResult, ProductAssessment,
 * Publication, ``current_publication_id``,
 * ``artifact_produced``/``publication_created`` event, or a formal task
 * success: receipts are plain ``ua_*`` records with ``trust: "untrusted"``,
 * ``authoritative: false``.
 *
 * Fail-closed: every other failure mode (cancellation/abort, timeout/resource
 * baseline, filesystem/copy/hash/path errors, stale generation/fence/lock
 * loss, HIL request errors, identity mismatch, unknown errors) propagates
 * unchanged with zero fallback. The helper never string-classifies: phase3
 * selects via ``instanceof`` on dataset-layer typed rejection classes only.
 *
 * No-TOCTOU byte verification: each table is re-read through an opened file
 * handle with canonical relative-path validation, real committed-root +
 * candidate containment, lstat/realpath symlink/junction/hardlink checks,
 * and an opened-handle stat identity snapshot compared before and after the
 * read/hash. Any swap/symlink/hardlink/size/hash failure, or any committed
 * root identity change, aborts before any quarantine write.
 *
 * All-or-nothing: every quarantine write happens only after the full verify
 * pass succeeds. If any storage step still fails, only the quarantine direc-
 * tories this invocation created are removed (bounded cleanup); pre-existing
 * or manual quarantine submissions are never touched.
 */
import { lstat, realpath, open, rm } from "node:fs/promises";
import path from "node:path";

import type { MultiTableValidationCheck } from "../dataset/contracts/validation.js";
import type { DynamicFamilyExecutionResult } from "../dataset/dynamic-family/submission.js";
import { sha256Bytes } from "../dataset/adapters/hashing.js";
import { storeUntrustedArtifact } from "./untrusted-artifact-store.js";
import { UNTRUSTED_ARTIFACT_DIRECTORY } from "@biomed/contracts";

const MEDIA_TYPE_BY_DELIMITER: Readonly<Record<string, string>> = {
  ",": "text/csv",
  "\t": "text/tab-separated-values",
  ";": "text/csv",
  "|": "text/csv",
};

/** Deterministic media type for a candidate table's delimiter. */
export function untrustedFallbackMediaType(delimiter: string): string {
  return MEDIA_TYPE_BY_DELIMITER[delimiter] ?? "application/octet-stream";
}

const FALLBACK_SOURCE_PREFIX =
  "Automatic untrusted-artifact fallback: the dynamic publication was formally rejected";

const MAX_REASON_CHARS = 500;

/** Bounded rejection detail projected into the fallback ``source_note``. */
export interface DynamicPublicationRejectionDetail {
  /** Bounded error message from the formal publication rejection. */
  readonly message: string;
  /** Failed B3 checks, when the rejection came from validation closure. */
  readonly failedChecks?: readonly MultiTableValidationCheck[];
}

function boundedReason(detail: DynamicPublicationRejectionDetail): string {
  const checks = (detail.failedChecks ?? [])
    .map((check) => `${check.scope}:${check.check_id}${check.detail === "" ? "" : ` (${check.detail.slice(0, 200)})`}`)
    .join(", ");
  return [
    detail.message.slice(0, MAX_REASON_CHARS),
    ...(checks === "" ? [] : [`failed checks: ${checks.slice(0, MAX_REASON_CHARS)}`]),
  ].join(" | ");
}

/** Bounded identity line appended to every fallback ``source_note``. */
export function untrustedFallbackIdentityLine(input: {
  taskId: string;
  runId: string;
  requirementId: string;
  resultManifestId: string;
}): string {
  return [
    `task=${input.taskId}`,
    `run=${input.runId}`,
    `requirement=${input.requirementId}`,
    `operation_result=${input.resultManifestId}`,
  ].join(" ");
}

/**
 * A typed error carrying the fallback receipts. The formal rejection stays
 * authoritative (this is an ``Error``; callers must not treat it as success),
 * while an integrator can project ``untrusted_artifacts``/``formal_status``
 * through the tool response without re-reading quarantine state.
 */
export class DynamicPublicationUntrustedFallbackError extends Error {
  readonly formal_status: "rejected";
  readonly untrusted_artifacts: UntrustedFallbackReceiptSummary[];

  constructor(options: {
    readonly message: string;
    readonly untrustedArtifacts: readonly UntrustedFallbackReceiptSummary[];
  }) {
    super(options.message);
    this.name = "DynamicPublicationUntrustedFallbackError";
    this.formal_status = "rejected";
    this.untrusted_artifacts = [...options.untrustedArtifacts];
  }
}

export interface UntrustedFallbackReceiptSummary {
  readonly submission_id: string;
  readonly table_id: string;
  readonly name: string;
  readonly size_bytes: number;
  readonly sha256: string;
}

interface RootIdentity {
  realPath: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  nlink: number;
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.birthtimeMs === right.birthtimeMs
    && left.nlink === right.nlink;
}

/** Verification failure inside the helper's own re-read gate. */
export class UntrustedFallbackIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedFallbackIntegrityError";
  }
}

function integrityRejection(detail: string): never {
  throw new UntrustedFallbackIntegrityError(detail);
}

interface RootHandle {
  root: RootIdentity;
  close(): Promise<void>;
}

async function captureRootHandle(trustedRoot: string): Promise<RootHandle> {
  const realRoot = await realpath(path.resolve(trustedRoot));
  const rootStat = await lstat(realRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    integrityRejection("committed trusted root is not a real directory");
  }
  const handle = await open(realRoot, "r");
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isDirectory() || openedStat.isSymbolicLink()) {
      integrityRejection("committed trusted root is not a real directory");
    }
    const identity: RootIdentity = {
      realPath: realRoot,
      dev: openedStat.dev,
      ino: openedStat.ino,
      birthtimeMs: openedStat.birthtimeMs,
    };
    return {
      root: identity,
      close: async () => {
        await handle.close();
      },
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * Opened-handle byte re-read with no-TOCTOU identity fencing:
 * 1. canonical relative-path validation (forward slashes, no ``..``, ``\0``,
 *    absolute, or escape past the verified committed root);
 * 2. candidate containment within real committed root;
 * 3. lstat regular-file + nlink===1 check (no symlink junction/hardlink);
 * 4. realpath no-symlink/junction check;
 * 5. opened-handle stat identity snapshot compared against the lstat and
 *    re-compared after the read + hash (swap/mutation during read aborts).
 */
async function verifiedBytesForOutput(
  rootHandle: RootHandle,
  relativePath: string,
  expectedSize: number,
  expectedSha256: string,
): Promise<Buffer> {
  if (
    relativePath.length === 0
    || relativePath.includes("\\")
    || relativePath.includes("\0")
    || relativePath.includes("..")
    || relativePath.startsWith("/")
    || path.win32.isAbsolute(relativePath)
    || relativePath.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    integrityRejection(`${relativePath} is not a canonical relative path`);
  }
  const requestedPath = path.resolve(rootHandle.root.realPath, ...relativePath.split("/"));
  if (!requestedPath.startsWith(rootHandle.root.realPath + path.sep)) {
    integrityRejection(`${relativePath} escapes the committed trusted root`);
  }
  const before = await lstat(requestedPath);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    integrityRejection(`${relativePath} is not an independent regular file (symlink or hardlinked)`);
  }
  if (await realpath(requestedPath) !== requestedPath) {
    integrityRejection(`${relativePath} traverses a symlink or junction`);
  }
  if (before.size !== expectedSize) {
    integrityRejection(`${relativePath} size ${before.size} does not match the admitted receipt ${expectedSize}`);
  }
  const beforeIdentity: FileIdentity = {
    dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs,
    ctimeMs: before.ctimeMs, birthtimeMs: before.birthtimeMs, nlink: before.nlink,
  };
  const handle = await open(requestedPath, "r");
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1) {
      integrityRejection(`${relativePath} is not a regular file while being opened`);
    }
    const openedIdentity: FileIdentity = {
      dev: opened.dev, ino: opened.ino, size: opened.size, mtimeMs: opened.mtimeMs,
      ctimeMs: opened.ctimeMs, birthtimeMs: opened.birthtimeMs, nlink: opened.nlink,
    };
    if (!sameFileIdentity(beforeIdentity, openedIdentity)) {
      integrityRejection(`${relativePath} changed while being opened`);
    }
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      offset += bytesRead;
      if (!Number.isSafeInteger(offset)) {
        integrityRejection(`${relativePath} exceeds the safe integer byte range`);
      }
    }
    const bytes = Buffer.concat(chunks);
    const current = await handle.stat();
    if (!sameFileIdentity(openedIdentity, {
      dev: current.dev, ino: current.ino, size: current.size, mtimeMs: current.mtimeMs,
      ctimeMs: current.ctimeMs, birthtimeMs: current.birthtimeMs, nlink: current.nlink,
    })) {
      integrityRejection(`${relativePath} was mutated while being read`);
    }
    if (bytes.length !== expectedSize) {
      integrityRejection(`${relativePath} size ${bytes.length} drifted from the admitted receipt`);
    }
    const digest = sha256Bytes(bytes);
    if (digest !== expectedSha256) {
      integrityRejection(`${relativePath} bytes do not match the admitted receipt`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

/**
 * Archive each committed candidate table into the task quarantine.
 *
 * Phase 1: verify every table's bytes against its admitted receipt through
 * the no-TOCTOU handle re-read (before any quarantine write); any integrity
 * failure leaves zero quarantine output. Phase 2: store all tables and
 * register the created submission ids; on any storage failure, remove only
 * the quarantine directories this invocation created (bounded cleanup);
 * pre-existing or manual submissions are never deleted.
 */
export async function archiveCommittedDynamicTablesAsUntrustedArtifacts(input: {
  readonly result: DynamicFamilyExecutionResult;
  readonly taskId: string;
  readonly taskRoot: string;
  readonly runId: string;
  readonly requirementId: string;
  /** Bounded rejection reason carried into the receipt ``source_note``. */
  readonly rejectionReason: string;
  /** Failed B3 checks, when the rejection came from validation closure. */
  readonly failedChecks?: readonly MultiTableValidationCheck[];
}): Promise<UntrustedFallbackReceiptSummary[]> {
  const candidate = input.result.materialization.candidate;
  if (candidate.task_id !== input.taskId || candidate.requirement_id !== input.requirementId) {
    throw new UntrustedFallbackIntegrityError(
      `untrusted fallback task/requirement identity mismatch: candidate task=${candidate.task_id} requirement=${candidate.requirement_id}, fallback task=${input.taskId} requirement=${input.requirementId}`,
    );
  }
  const operationResult = input.result.operationResult;
  if (operationResult.commit.state !== "committed") {
    throw new UntrustedFallbackIntegrityError(
      `untrusted fallback requires a committed operation result, received state '${operationResult.commit.state}'`,
    );
  }
  const identityLine = untrustedFallbackIdentityLine({
    taskId: input.taskId,
    runId: input.runId,
    requirementId: input.requirementId,
    resultManifestId: operationResult.result_manifest_id,
  });
  const sourceNote = [
    `${FALLBACK_SOURCE_PREFIX} (coverage is partial; formal publication, admission, and review closure were not obtained).`,
    `Rejection reason: ${boundedReason({ message: input.rejectionReason, failedChecks: input.failedChecks })}.`,
    identityLine,
  ].join(" ");

  // Capture + hold the committed-root handle so the root identity is fenced
  // across the entire verify pass and re-checked after the read loop.
  const rootHandle = await captureRootHandle(input.result.trustedRoot);
  try {
    // Phase 1: verify every table's bytes before any quarantine write.
    const verified: {
      tableId: string;
      schemaRef: string;
      fileName: string;
      bytes: Buffer;
    }[] = [];
    for (const table of candidate.tables) {
      const fileIndex = table.data_ref.output_file_index;
      const output = operationResult.output_files[fileIndex];
      if (output === undefined) {
        integrityRejection(`candidate table '${table.definition.table_id}' references a missing admitted output at index ${fileIndex}`);
      }
      if (output.sha256 !== table.data_ref.output_file_sha256) {
        integrityRejection(`candidate table '${table.definition.table_id}' data ref hash does not match the admitted output receipt`);
      }
      const bytes = await verifiedBytesForOutput(
        rootHandle,
        output.relative_path,
        output.size_bytes,
        output.sha256,
      );
      verified.push({
        tableId: table.definition.table_id,
        schemaRef: table.definition.schema_ref,
        fileName: output.relative_path.split("/").at(-1) ?? `${table.definition.table_id}.csv`,
        bytes,
      });
    }
    // Post-verify root identity re-check: any root swap during the read loop
    // aborts before any quarantine write.
    const afterStat = await lstat(rootHandle.root.realPath);
    if (!afterStat.isDirectory() || afterStat.isSymbolicLink()
      || afterStat.dev !== rootHandle.root.dev || afterStat.ino !== rootHandle.root.ino
      || afterStat.birthtimeMs !== rootHandle.root.birthtimeMs) {
      integrityRejection("committed trusted root identity changed during verification");
    }
    // Phase 2: all-or-nothing storage into the quarantine. Every submission
    // directory this call creates is attributed directly (each
    // ``storeUntrustedArtifact`` call creates exactly one new id), so a
    // mid-way failure removes only this invocation's receipts — never
    // pre-existing or manual submissions.
    const createdSubmissionIds: string[] = [];
    try {
      const receipts: UntrustedFallbackReceiptSummary[] = [];
      for (const table of verified) {
        const receipt = await storeUntrustedArtifact(
          input.taskRoot,
          input.taskId,
          {
            schema_version: "1.0",
            name: table.fileName,
            media_type: untrustedFallbackMediaType(","),
            source_note: sourceNote,
            coverage_status: "partial",
            covered_scope: [
              `table:${table.tableId}`,
              `schema:${table.schemaRef}`,
              `operation_result:${operationResult.result_manifest_id}`,
            ],
            missing_scope: [
              "formal_publication",
              "product_admission",
              "human_review_closure",
              "product_assessment",
            ],
          },
          table.bytes,
        );
        createdSubmissionIds.push(receipt.submission_id);
        receipts.push({
          submission_id: receipt.submission_id,
          table_id: table.tableId,
          name: receipt.name,
          size_bytes: receipt.size_bytes,
          sha256: receipt.sha256,
        });
      }
      return receipts;
    } catch (storageError) {
      await cleanupCreatedSubmissions(input.taskRoot, createdSubmissionIds);
      throw storageError;
    }
  } finally {
    await rootHandle.close();
  }
}

async function cleanupCreatedSubmissions(taskRoot: string, submissionIds: readonly string[]): Promise<void> {
  for (const submissionId of submissionIds) {
    await rm(path.join(taskRoot, UNTRUSTED_ARTIFACT_DIRECTORY, submissionId), { recursive: true, force: true });
  }
}
