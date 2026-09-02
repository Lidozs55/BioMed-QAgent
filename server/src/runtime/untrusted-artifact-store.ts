import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseUntrustedArtifactReceipt,
  UNTRUSTED_ARTIFACT_DIRECTORY,
  UNTRUSTED_SUBMISSION_ID_PATTERN,
  type UntrustedArtifactMetadata,
  type UntrustedArtifactReceipt,
} from "@biomed/contracts";

import { sha256Bytes } from "../dataset/adapters/hashing.js";
import { readJsonFileOrNull, writeJsonAtomic } from "../persistence/atomic-json.js";
import { requireSafeId } from "./safe-id.js";

const RECEIPT_FILENAME = "receipt.json";
const ARTIFACT_FILENAME = "artifact.bin";

function quarantineRoot(taskRoot: string): string {
  return path.join(taskRoot, UNTRUSTED_ARTIFACT_DIRECTORY);
}

function submissionDirectory(taskRoot: string, submissionId: string): string {
  requireSafeId(submissionId, "submissionId");
  return path.join(quarantineRoot(taskRoot), submissionId);
}

export async function storeUntrustedArtifact(
  taskRoot: string,
  taskId: string,
  metadata: UntrustedArtifactMetadata,
  bytes: Buffer,
): Promise<UntrustedArtifactReceipt> {
  requireSafeId(taskId, "taskId");
  if (bytes.length === 0) throw new TypeError("Submitted file is empty");

  const submissionId = `ua_${randomBytes(12).toString("hex")}`;
  const root = quarantineRoot(taskRoot);
  const directory = submissionDirectory(taskRoot, submissionId);
  const stagingDirectory = path.join(
    root,
    `.${submissionId}.${randomBytes(6).toString("hex")}.partial`,
  );
  await mkdir(root, { recursive: true });
  let staged = false;
  try {
    await mkdir(stagingDirectory, { recursive: false });
    staged = true;
    await writeFile(path.join(stagingDirectory, ARTIFACT_FILENAME), bytes, { flag: "wx" });
    const receipt: UntrustedArtifactReceipt = {
      ...metadata,
      submission_id: submissionId,
      task_id: taskId,
      authoritative: false,
      trust: "untrusted",
      size_bytes: bytes.length,
      sha256: sha256Bytes(bytes),
      submitted_at: new Date().toISOString(),
    };
    await writeJsonAtomic(path.join(stagingDirectory, RECEIPT_FILENAME), receipt);
    await rename(stagingDirectory, directory);
    staged = false;
    return receipt;
  } catch (error) {
    // The hidden staging directory belongs only to this invocation. The final
    // ua_* directory becomes visible atomically only after both bytes and its
    // receipt are complete, so a failed call can never strand a partial ua_*.
    if (staged) {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

export async function listUntrustedArtifacts(taskRoot: string): Promise<UntrustedArtifactReceipt[]> {
  let entries;
  try {
    entries = await readdir(quarantineRoot(taskRoot), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const receipts = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => readReceipt(taskRoot, entry.name)));
  return receipts
    .filter((receipt): receipt is UntrustedArtifactReceipt => receipt !== null)
    .sort((left, right) => left.submitted_at.localeCompare(right.submitted_at));
}

export async function getUntrustedArtifact(
  taskRoot: string,
  submissionId: string,
): Promise<UntrustedArtifactReceipt | null> {
  if (!UNTRUSTED_SUBMISSION_ID_PATTERN.test(submissionId)) return null;
  return readReceipt(taskRoot, submissionId);
}

export async function getUntrustedArtifactContent(
  taskRoot: string,
  submissionId: string,
): Promise<{ receipt: UntrustedArtifactReceipt; bytes: Buffer } | null> {
  const receipt = await getUntrustedArtifact(taskRoot, submissionId);
  if (receipt === null) return null;
  const bytes = await readFile(path.join(
    submissionDirectory(taskRoot, receipt.submission_id),
    ARTIFACT_FILENAME,
  ));
  return { receipt, bytes };
}

async function readReceipt(
  taskRoot: string,
  submissionId: string,
): Promise<UntrustedArtifactReceipt | null> {
  if (!UNTRUSTED_SUBMISSION_ID_PATTERN.test(submissionId)) return null;
  const raw = await readJsonFileOrNull<unknown>(path.join(
    submissionDirectory(taskRoot, submissionId),
    RECEIPT_FILENAME,
  ));
  if (raw === null) return null;
  const receipt = parseUntrustedArtifactReceipt(raw);
  return receipt.submission_id === submissionId ? receipt : null;
}
