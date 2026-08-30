/**
 * Untrusted artifact quarantine store.
 *
 * Persists explicitly non-authoritative artifacts submitted to an EXISTING
 * task for human review/download. Storage lives under
 * ``<taskRoot>/quarantine/<submission_id>/`` so ordinary task deletion removes
 * the quarantine with the task root; receipts are written with the shared
 * atomic JSON helper. This store never touches ``publish/``,
 * ``events.jsonl``, source assets, or any formal projection — quarantine
 * submissions are review conveniences, not publications.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseUntrustedArtifactReceipt,
  UNTRUSTED_ARTIFACT_DIRECTORY,
  UNTRUSTED_SUBMISSION_ID_PATTERN,
  type UntrustedArtifactReceipt,
  type UntrustedArtifactSubmissionInput,
} from "@biomed/contracts";

import { sha256Bytes } from "../dataset/adapters/hashing.js";
import { readJsonFileOrNull, writeJsonAtomic } from "../persistence/atomic-json.js";
import { requireSafeId } from "./safe-id.js";

const RECEIPT_FILENAME = "receipt.json";
const ARTIFACT_FILENAME = "artifact.bin";
/** Internal-only sidecar recording the caller's idempotency key, if any. */
const KEY_FILENAME = "key.json";

/** Server-generated submission id — the only filesystem name derived from a submission. */
function newSubmissionId(): string {
  return `ua_${randomBytes(12).toString("hex")}`;
}

function quarantineRoot(taskRoot: string): string {
  return path.join(taskRoot, UNTRUSTED_ARTIFACT_DIRECTORY);
}

function submissionDirectory(taskRoot: string, submissionId: string): string {
  requireSafeId(submissionId, "submissionId");
  return path.join(quarantineRoot(taskRoot), submissionId);
}

export class UntrustedArtifactConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UntrustedArtifactConflictError";
  }
}

export interface StoredUntrustedArtifact {
  receipt: UntrustedArtifactReceipt;
  bytes: Buffer;
}

/**
 * Persist one quarantine submission and return its receipt.
 *
 * Idempotency (opt-in, keyed by ``input.idempotency_key``): the same task +
 * key + digest returns the existing receipt unchanged; the same task + key
 * with a different digest is a conflict. Without a key every call stores a
 * new submission.
 */
export async function storeUntrustedArtifact(
  taskRoot: string,
  taskId: string,
  input: UntrustedArtifactSubmissionInput,
): Promise<UntrustedArtifactReceipt> {
  requireSafeId(taskId, "taskId");
  const bytes = Buffer.from(input.bytes_base64, "base64");
  if (bytes.length === 0) {
    throw new TypeError("Decoded submission bytes are empty");
  }
  const sha256 = sha256Bytes(bytes);

  const idempotencyKey = input.idempotency_key;
  if (idempotencyKey !== null) {
    const existing = await findByKey(taskRoot, idempotencyKey);
    if (existing !== null) {
      if (existing.receipt.sha256 === sha256) return existing.receipt;
      throw new UntrustedArtifactConflictError(
        "idempotency_key already used for a different artifact digest",
      );
    }
  }

  const submissionId = newSubmissionId();
  const directory = submissionDirectory(taskRoot, submissionId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, ARTIFACT_FILENAME), bytes, { flag: "wx" });
  const receipt: UntrustedArtifactReceipt = {
    schema_version: "1.0",
    submission_id: submissionId,
    task_id: taskId,
    name: input.name,
    media_type: input.media_type,
    source_note: input.source_note,
    coverage_status: input.coverage_status,
    covered_scope: input.covered_scope,
    missing_scope: input.missing_scope,
    authoritative: false,
    trust: "untrusted",
    size_bytes: bytes.length,
    sha256,
    submitted_at: new Date().toISOString(),
  };
  await writeJsonAtomic(path.join(directory, RECEIPT_FILENAME), receipt);
  if (idempotencyKey !== null) {
    await writeJsonAtomic(path.join(directory, KEY_FILENAME), { key: idempotencyKey });
  }
  return receipt;
}

/** All quarantine receipts for a task, oldest first. */
export async function listUntrustedArtifacts(
  taskRoot: string,
): Promise<UntrustedArtifactReceipt[]> {
  let entries;
  try {
    entries = await readdir(quarantineRoot(taskRoot), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const receipts: UntrustedArtifactReceipt[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const receipt = await readReceipt(taskRoot, entry.name);
    if (receipt !== null) receipts.push(receipt);
  }
  return receipts.sort((left, right) => left.submitted_at.localeCompare(right.submitted_at));
}

/** One quarantine receipt, or null when the submission id is invalid or unknown. */
export async function getUntrustedArtifact(
  taskRoot: string,
  submissionId: string,
): Promise<UntrustedArtifactReceipt | null> {
  if (!UNTRUSTED_SUBMISSION_ID_PATTERN.test(submissionId)) return null;
  return readReceipt(taskRoot, submissionId);
}

/**
 * Decoded quarantine bytes for the download endpoint, after re-verifying the
 * stored digest against the receipt (a drifted artifact.bin never downloads).
 */
export async function getUntrustedArtifactContent(
  taskRoot: string,
  submissionId: string,
): Promise<StoredUntrustedArtifact | null> {
  const receipt = await getUntrustedArtifact(taskRoot, submissionId);
  if (receipt === null) return null;
  const bytes = await readFile(
    path.join(submissionDirectory(taskRoot, receipt.submission_id), ARTIFACT_FILENAME),
  );
  if (bytes.length !== receipt.size_bytes || sha256Bytes(bytes) !== receipt.sha256) {
    throw new UntrustedArtifactConflictError(
      "Quarantine artifact bytes do not match its receipt",
    );
  }
  return { receipt, bytes };
}

async function readReceipt(
  taskRoot: string,
  submissionId: string,
): Promise<UntrustedArtifactReceipt | null> {
  let raw: unknown;
  try {
    const value = await readJsonFileOrNull(
      path.join(submissionDirectory(taskRoot, submissionId), RECEIPT_FILENAME),
    );
    raw = value;
  } catch {
    // A corrupt receipt must not make the listing endpoint fail for the
    // whole task; the unreadable submission is skipped instead.
    return null;
  }
  if (raw === null) return null;
  try {
    const receipt = parseUntrustedArtifactReceipt(raw);
    if (receipt.submission_id !== submissionId) return null;
    return receipt;
  } catch {
    return null;
  }
}

async function findByKey(
  taskRoot: string,
  idempotencyKey: string,
): Promise<{ receipt: UntrustedArtifactReceipt } | null> {
  for (const receipt of await listUntrustedArtifacts(taskRoot)) {
    let stored: { key?: unknown } | null;
    try {
      const value = await readJsonFileOrNull<{ key?: unknown }>(
        path.join(submissionDirectory(taskRoot, receipt.submission_id), KEY_FILENAME),
      );
      stored = value;
    } catch {
      stored = null;
    }
    if (stored !== null && stored.key === idempotencyKey) return { receipt };
  }
  return null;
}
