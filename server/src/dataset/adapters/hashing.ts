/**
 * Content hashing helpers for the build chain (Python ``hashing.py``).
 *
 * Deviation from Python: this port hashes with a single buffered read
 * instead of streaming. The file-based exchange format is preserved; a
 * streaming implementation can be reintroduced at integration time if
 * GB-scale matrices require it.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function sha256File(path: string): string {
  const buffer = readFileSync(path);
  return createHash("sha256").update(buffer).digest("hex");
}