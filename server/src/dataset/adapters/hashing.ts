/**
 * Content hashing helpers for the build chain (Python ``hashing.py``).
 *
 * Deviation from Python: this port hashes with a single buffered read
 * instead of streaming. The file-based exchange format is preserved; a
 * streaming implementation can be reintroduced at integration time if
 * GB-scale matrices require it.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFileSync } from "node:fs";
import { throwIfAborted } from "../cooperative.js";

/** SHA-256 hex of in-memory bytes (deduplicated from the copies in
 * ``dataset/service/dataset-core.ts``, ``runtime/artifact-store.ts``,
 * ``runtime/durable-agent-runtime.ts`` and ``product/build-store.ts``). */
export function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path: string): string {
  const buffer = readFileSync(path);
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Cooperative streaming sha256 for the async Core path: reads the file as a
 * stream (the event loop stays responsive between chunks) and re-checks the
 * operation AbortSignal every 1024 chunks, so checksums of GB-scale
 * artifacts honor wall-clock timeouts and cancels.
 */
export async function sha256FileStream(
  path: string,
  signal?: AbortSignal | null,
): Promise<string> {
  throwIfAborted(signal);
  const hasher = createHash("sha256");
  const stream = createReadStream(path);
  try {
    let chunkCount = 0;
    for await (const chunk of stream) {
      hasher.update(chunk as Buffer);
      chunkCount += 1;
      if (chunkCount % 1024 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        throwIfAborted(signal);
      }
    }
  } finally {
    stream.destroy();
  }
  throwIfAborted(signal);
  return hasher.digest("hex");
}

export interface FileHashResult {
  sha256: string;
  bytes: number;
}

/**
 * Cooperative streaming sha256 with a byte count for the Core pre-asset
 * resolution path (TASK-047-A1).  Yields to the event loop every 256 chunks
 * (~16 MB) so cancels land mid-hash on GB-scale files, and reports how many
 * bytes were actually consumed so the caller can reject check-then-use
 * (TOCTOU) races against a pre-hash ``stat``.
 */
export async function sha256FileStreamWithSize(
  path: string,
  signal?: AbortSignal | null,
): Promise<FileHashResult> {
  throwIfAborted(signal);
  const hasher = createHash("sha256");
  const stream = createReadStream(path);
  let bytes = 0;
  try {
    let chunkCount = 0;
    for await (const chunk of stream) {
      const buffer = chunk as Buffer;
      hasher.update(buffer);
      bytes += buffer.length;
      chunkCount += 1;
      if (chunkCount % 256 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        throwIfAborted(signal);
      }
    }
  } finally {
    stream.destroy();
  }
  throwIfAborted(signal);
  return { sha256: hasher.digest("hex"), bytes };
}