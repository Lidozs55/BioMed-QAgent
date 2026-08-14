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