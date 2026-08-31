/**
 * Gold6 R4 automatic untrusted-artifact fallback (Host/Core-owned slice).
 *
 * When a fully committed dynamic execution (``DynamicFamilyExecutionResult``)
 * fails formal publication for a semantic/acceptance reason, this helper
 * archives each candidate table once into the existing, non-authoritative
 * task quarantine (``untrusted-artifact-store.ts``) so the user can still
 * download the bytes. The quarantine never produces an OperationResult,
 * ProductAssessment, Publication, ``current_publication_id``,
 * ``artifact_produced``/``publication_created`` event, or a formal task
 * success: receipts are plain ``ua_*`` records with ``trust: "untrusted"``,
 * ``authoritative: false``.
 *
 * Integrity/control failures (cancellation, stale generation, lock/fence
 * loss, identity mismatch, path traversal, missing admitted output, byte
 * drift) are never archived: the helper re-reads each table from the
 * committed Core ``trustedRoot`` and independently re-verifies exact size and
 * SHA-256 against the admitted ``OperationResult.output_files`` receipts.
 */
import { stat, readFile } from "node:fs/promises";
import path from "node:path";

import type { DynamicFamilyExecutionResult } from "../dataset/dynamic-family/submission.js";
import { sha256Bytes } from "../dataset/adapters/hashing.js";
import { storeUntrustedArtifact } from "./untrusted-artifact-store.js";
import type { MultiTableValidationCheck } from "../dataset/contracts/validation.js";

/** Extra rejection detail written into the fallback ``source_note``. */
export interface DynamicPublicationRejectionDetail {
  /** Bounded error message from the formal publication rejection. */
  readonly message: string;
  /** Failed B3 checks, when the rejection came from validation closure. */
  readonly failedChecks?: readonly MultiTableValidationCheck[];
}

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

/** Reasons that are integrity/control failures and must never be archived. */
const CONTROL_FAILURE_MARKERS = [
  "canceled",
  "cancelled",
  "aborted",
  "is stale",
  "stale generation",
  "generation is stale",
  "lock fence was lost",
  "lock was taken over",
  "displaced lease",
  "cross-task mismatch",
  "does not match the core task/requirement",
  "identity does not match",
  "identity mismatch",
  "escapes the",
  "path traversal",
  "lacks its admitted result",
  "missing admitted output",
  "is missing:",
  "bytes do not match",
  "does not match the committed evidence",
  "drifted",
  "publication refused",
  "atomic promotion failed",
] as const;

export function classifyDynamicPublicationRejection(message: string): string {
  const normalized = message.toLowerCase();
  for (const marker of CONTROL_FAILURE_MARKERS) {
    if (normalized.includes(marker)) return "control_failure";
  }
  return "semantic_rejection";
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
  readonly fallback_failure: string | null;

  constructor(options: {
    readonly message: string;
    readonly untrustedArtifacts: readonly UntrustedFallbackReceiptSummary[];
    readonly fallbackFailure?: string | null;
  }) {
    super(options.message);
    this.name = "DynamicPublicationUntrustedFallbackError";
    this.formal_status = "rejected";
    this.untrusted_artifacts = [...options.untrustedArtifacts];
    this.fallback_failure = options.fallbackFailure ?? null;
  }

  /**
   * Recovers failed B3 checks from the rejection error the publication path
   * threw (an ``Error`` with a ``MultiTableValidationCheck[]`` in a
   * ``failed_checks`` property, or the same carried on its ``cause``).
   * Returns ``undefined`` when the rejection carries no check closure.
   */
  static extractFailedChecks(error: unknown): MultiTableValidationCheck[] | undefined {
    const direct = extractChecks(error);
    if (direct !== undefined) return direct;
    const cause = error instanceof Error ? error.cause : undefined;
    return extractChecks(cause);
  }
}

function extractChecks(value: unknown): MultiTableValidationCheck[] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = (value as { failed_checks?: unknown }).failed_checks;
  if (!Array.isArray(candidate)) return undefined;
  const checks = candidate.filter((item): item is MultiTableValidationCheck =>
    item !== null && typeof item === "object"
    && typeof (item as { check_id?: unknown }).check_id === "string"
    && typeof (item as { scope?: unknown }).scope === "string"
    && typeof (item as { passed?: unknown }).passed === "boolean"
    && typeof (item as { detail?: unknown }).detail === "string");
  return checks.length === 0 ? undefined : checks;
}

export interface UntrustedFallbackReceiptSummary {
  readonly submission_id: string;
  readonly table_id: string;
  readonly name: string;
  readonly size_bytes: number;
  readonly sha256: string;
}

const MAX_REASON_CHARS = 500;

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
 * Archive each committed candidate table into the task quarantine.
 *
 * The committed execution is re-read from disk — the trustedRoot bytes are
 * never taken from the caller — and each table is admitted again against its
 * ``OperationResult.output_files`` receipt (exact size + SHA-256) before one
 * ``ua_*`` submission is stored per table. Any mismatch throws before any
 * quarantine write is made for that table; a missing receipt is a hard
 * control failure (the fallback must not archive unadmitted bytes).
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
    throw new Error(
      `untrusted fallback task/requirement identity mismatch: candidate task=${candidate.task_id} requirement=${candidate.requirement_id}, fallback task=${input.taskId} requirement=${input.requirementId}`,
    );
  }
  const operationResult = input.result.operationResult;
  if (operationResult.commit.state !== "committed") {
    throw new Error(
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
  const receipts: UntrustedFallbackReceiptSummary[] = [];
  // Phase 1: verify every table's bytes against its admitted receipt before
  // any quarantine write, so hash/size/identity drift leaves zero ua_* output.
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
      throw new Error(
        `untrusted fallback rejected: candidate table '${table.definition.table_id}' references a missing admitted output at index ${fileIndex}`,
      );
    }
    if (output.sha256 !== table.data_ref.output_file_sha256) {
      throw new Error(
        `untrusted fallback rejected: candidate table '${table.definition.table_id}' data ref hash does not match the admitted output receipt`,
      );
    }
    const absolutePath = path.join(input.result.trustedRoot, ...output.relative_path.split("/"));
    if (!path.resolve(absolutePath).startsWith(path.resolve(input.result.trustedRoot) + path.sep)) {
      throw new Error(
        `untrusted fallback rejected: output path for '${table.definition.table_id}' escapes the committed trusted root`,
      );
    }
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile() || fileStat.size !== output.size_bytes) {
      throw new Error(
        `untrusted fallback rejected: bytes for '${table.definition.table_id}' drifted (size)`,
      );
    }
    const bytes = await readFile(absolutePath);
    const digest = sha256Bytes(bytes);
    if (digest !== output.sha256) {
      throw new Error(
        `untrusted fallback rejected: bytes for '${table.definition.table_id}' drifted (sha256)`,
      );
    }
    verified.push({
      tableId: table.definition.table_id,
      schemaRef: table.definition.schema_ref,
      fileName: output.relative_path.split("/").at(-1) ?? `${table.definition.table_id}.csv`,
      bytes,
    });
  }
  // Phase 2: one ua_* submission per candidate table.
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
    receipts.push({
      submission_id: receipt.submission_id,
      table_id: table.tableId,
      name: receipt.name,
      size_bytes: receipt.size_bytes,
      sha256: receipt.sha256,
    });
  }
  return receipts;
}
