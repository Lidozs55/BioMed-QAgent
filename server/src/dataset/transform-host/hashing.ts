import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";

const HASH_BUFFER_BYTES = 64 * 1024;

export function sha256Bytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Hash the already-open immutable file identity, never a path that can be swapped. */
export async function sha256FileHandle(file: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
  let position = 0;
  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

export function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}
