import type { DatasetExecutionSpec } from "@biomed/contracts";

import path from "node:path";

import { readJsonFileOrNull, writeJsonAtomic } from "../persistence/atomic-json.js";
import { requireSafeId } from "./safe-id.js";

/**
 * Durable record of a dataset-execution invocation, persisted by the
 * ``execute_dataset_execution`` tool before it hands execution to the TS Core.
 *
 * On a process restart the deterministic continuation never asks the model
 * to "continue the task" from a synthetic prompt: the runtime reads this
 * record, rebuilds a tool workspace bound to the ORIGINAL run, replays the
 * same tool call (original ``tool_call_id``) and lets the executor resume
 * from its checkpointed state. The record lives under
 * ``state/hil/continuations/<requirement_id>.json`` inside the task root.
 */
export interface SuspendedExecutionContinuation {
  schema_version: 1;
  requirement_id: string;
  task_id: string;
  run_id: string;
  pi_session_id: string;
  tool_call_id: string;
  spec: DatasetExecutionSpec;
  source_files: Record<string, string>;
  mapping_files: Record<string, string>;
  metadata_files: Record<string, string>;
  cleaning_rule_receipt?: import("@biomed/contracts").CleaningRulePreflightReceipt;
  registered_source_asset_ids: string[];
  created_at: string;
}

/** ``<taskRoot>/state/hil/continuations/<requirementId>.json``. */
export function continuationPath(
  taskRoot: string,
  requirementId: string,
): string {
  requireSafeId(requirementId, "requirement_id");
  return path.join(taskRoot, "state", "hil", "continuations", `${requirementId}.json`);
}

/** Atomic write (tmp + rename) so a crash never leaves a partial record. */
export async function saveExecutionContinuation(
  taskRoot: string,
  continuation: SuspendedExecutionContinuation,
): Promise<void> {
  await writeJsonAtomic(continuationPath(taskRoot, continuation.requirement_id), continuation);
}

function parseContinuation(value: unknown): SuspendedExecutionContinuation | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1) return null;
  for (const name of ["requirement_id", "task_id", "run_id", "pi_session_id", "tool_call_id", "created_at"] as const) {
    if (typeof record[name] !== "string" || record[name].trim() === "") return null;
  }
  for (const name of ["spec", "source_files", "mapping_files", "metadata_files"] as const) {
    if (record[name] === null || typeof record[name] !== "object" || Array.isArray(record[name])) {
      return null;
    }
  }
  if (record.registered_source_asset_ids !== undefined &&
      (!Array.isArray(record.registered_source_asset_ids) ||
       record.registered_source_asset_ids.some((assetId) => typeof assetId !== "string" || !/^asset_[0-9a-f]{64}$/.test(assetId)))) {
    return null;
  }
  return {
    ...record,
    registered_source_asset_ids: Array.isArray(record.registered_source_asset_ids)
      ? record.registered_source_asset_ids as string[]
      : [],
  } as unknown as SuspendedExecutionContinuation;
}

export async function readExecutionContinuation(
  taskRoot: string,
  requirementId: string,
): Promise<SuspendedExecutionContinuation | null> {
  try {
    const value = await readJsonFileOrNull<unknown>(continuationPath(taskRoot, requirementId));
    return value === null ? null : parseContinuation(value);
  } catch {
    return null;
  }
}

/**
 * Durable record of a dynamic-family publication that is awaiting its
 * ``publication_acceptance`` review. Persisted by ``publishDynamicFamily``
 * BEFORE the blocking HIL request is created, it binds everything needed to
 * complete the publication deterministically after an Application Host
 * restart: task/run/requirement identity, the candidate and its canonical
 * digest, the registered inputs, the provisional assessment digest, the
 * deterministic review request id, the submission receipt, and the staged
 * B3/provenance inputs. The resume rejects digest drift, a second
 * resolution, or a different run, and promotes exactly once.
 */
export interface PublicationAcceptanceContinuationV1 {
  schema_version: 1;
  continuation_kind: "publication_acceptance";
  task_id: string;
  run_id: string;
  requirement_id: string;
  /** canonicalDigest of ``candidate``; verified again on resume. */
  candidate_digest: string;
  candidate: unknown;
  registered_input_asset_ids: string[];
  /** Provisional ``product_assessment.json`` byte receipt. */
  assessment_digest: string;
  assessment_size_bytes: number;
  /** computeHILEvidenceDigest of the requested review; binds the resolution. */
  expected_evidence_digest: string;
  /** Deterministic id of the requested ``publication_acceptance`` request. */
  requested_review_id: string;
  /** Digest of the deterministic submission receipt bound at submit time. */
  submission_receipt_digest: string;
  reviewed_snapshot: unknown;
  validation_profile_ref: string;
  b3_checked_count: number;
  b3_checks_sha256: string;
  b3_checks: unknown[];
  provenance_base: Record<string, unknown>;
  tables: Array<{
    table_id: string;
    schema_ref: string;
    role: string;
    relative_path: string;
    row_count: number;
    sha256: string;
    size_bytes: number;
  }>;
  /** Set once the publication was promoted (resume-once fence). */
  published_publication_id: string | null;
  created_at: string;
}

/** ``<taskRoot>/state/hil/publication-continuations/<requirementId>.json``. */
export function publicationContinuationPath(
  taskRoot: string,
  requirementId: string,
): string {
  requireSafeId(requirementId, "requirement_id");
  return path.join(
    taskRoot, "state", "hil", "publication-continuations", `${requirementId}.json`,
  );
}

export async function savePublicationAcceptanceContinuation(
  taskRoot: string,
  continuation: PublicationAcceptanceContinuationV1,
): Promise<void> {
  await writeJsonAtomic(
    publicationContinuationPath(taskRoot, continuation.requirement_id),
    continuation,
  );
}

const SHA256_RE = /^[0-9a-f]{64}$/;

function parsePublicationContinuation(
  value: unknown,
): PublicationAcceptanceContinuationV1 | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schema_version !== 1) return null;
  if (record.continuation_kind !== "publication_acceptance") return null;
  for (const name of [
    "task_id", "run_id", "requirement_id", "requested_review_id", "created_at",
    "validation_profile_ref",
  ] as const) {
    if (typeof record[name] !== "string" || (record[name] as string).trim() === "") return null;
  }
  for (const name of [
    "candidate_digest", "assessment_digest", "expected_evidence_digest",
    "submission_receipt_digest", "b3_checks_sha256",
  ] as const) {
    if (typeof record[name] !== "string" || !SHA256_RE.test(record[name] as string)) return null;
  }
  if (typeof record.assessment_size_bytes !== "number" || record.assessment_size_bytes < 0) {
    return null;
  }
  if (typeof record.b3_checked_count !== "number" || record.b3_checked_count < 0) return null;
  if (record.candidate === null || typeof record.candidate !== "object" || Array.isArray(record.candidate)) {
    return null;
  }
  if (!Array.isArray(record.registered_input_asset_ids)) return null;
  if (!Array.isArray(record.b3_checks)) return null;
  if (
    record.provenance_base === null ||
    typeof record.provenance_base !== "object" ||
    Array.isArray(record.provenance_base)
  ) {
    return null;
  }
  if (!Array.isArray(record.tables)) return null;
  if (
    record.published_publication_id !== null &&
    typeof record.published_publication_id !== "string"
  ) {
    return null;
  }
  return record as unknown as PublicationAcceptanceContinuationV1;
}

export async function readPublicationAcceptanceContinuation(
  taskRoot: string,
  requirementId: string,
): Promise<PublicationAcceptanceContinuationV1 | null> {
  try {
    const value = await readJsonFileOrNull<unknown>(
      publicationContinuationPath(taskRoot, requirementId),
    );
    return value === null ? null : parsePublicationContinuation(value);
  } catch {
    return null;
  }
}
