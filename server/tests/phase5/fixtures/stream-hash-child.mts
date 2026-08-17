/**
 * TASK-047-A1 limited-heap child (runs under vite-node with a capped
 * --max-old-space-size): writes a <sizeMiB> MiB file of zeros into
 * <workRoot>/source.bin, then resolves it through the REAL Core pre-asset
 * path (streaming hash + TOCTOU guard). Prints
 *
 *   resolved <sha256> <size_bytes> <hashMs>
 *
 * and exits 0 on success; a legacy buffered read of the same file would
 * exceed the capped heap before hashing could complete.
 */

import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { resolveReferencedAsset } from "../../../src/dataset/service/dataset-core.js";

const [workRootArg, sizeMiBArg] = process.argv.slice(2);
const workRoot = String(workRootArg);
const sizeMiB = Number(sizeMiBArg);

await mkdir(workRoot, { recursive: true });
const target = join(workRoot, "source.bin");
await new Promise<void>((resolve, reject) => {
  const stream = createWriteStream(target);
  stream.on("error", reject);
  stream.on("close", () => resolve());
  const chunk = Buffer.alloc(1024 * 1024);
  for (let index = 0; index < sizeMiB; index += 1) {
    stream.write(chunk);
  }
  stream.end();
});

const resolved = await resolveReferencedAsset(workRoot, "source.bin");
if (resolved === null) {
  console.error("resolveReferencedAsset returned null");
  process.exit(1);
}
console.log(
  `resolved ${resolved.asset.sha256} ${resolved.bytes} ${resolved.hashMs.toFixed(1)}`,
);
