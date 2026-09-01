/**
 * WP-A7 bounded-release-tail heap acceptance.
 *
 * The real release tail (profile validation + confidence scan + provenance
 * closure + hash-while-copy publish) runs in a child process capped to a
 * small heap while processing a primary far larger than that heap.  The tail
 * must stream every pass (row-length-bounded validation scan, streamed
 * confidence aggregator, streamed artifact hash, streamed copy) and complete
 * without OOM — a tail that buffered the whole primary (readFile / byte-string
 * analytics) would never finish under the cap.  The fixture covers, in one
 * process: validation, confidence, provenance, and publish.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VITE_NODE_ENTRY = createRequire(import.meta.url).resolve("vite-node/vite-node.mjs");
const CHILD = path.join(REPO_ROOT, "server", "tests", "phase5", "fixtures", "tail-heap-child.mts");

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runTailChild(
  workRoot: string,
  rowCount: number,
  heapMb: number,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", `--max-old-space-size=${heapMb}`, VITE_NODE_ENTRY, CHILD, workRoot, String(rowCount)],
      { stdio: "pipe" },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("WP-A7 release tail low-heap", () => {
  it("runs validation/confidence/provenance/publish on a large primary in a capped heap without OOM", async () => {
    const workRoot = await mkdtemp(path.join(os.tmpdir(), "release-tail-heap-"));
    roots.push(workRoot);
    // ~180 bytes/row → 400k rows ≈ 72+ MiB primary, larger than the 64 MB
    // capped heap could ever buffer whole; the tail must stream every pass.
    const rowCount = 400_000;
    const heapMb = 64;
    const { code, stdout, stderr } = await runTailChild(workRoot, rowCount, heapMb);
    expect(stderr, `child stderr: ${stderr.slice(0, 400)}`).toBe("");
    expect(code).toBe(0);
    const [tag, status, bytes, versionDir] = stdout.trim().split(/\s+/);
    expect(tag).toBe("tail");
    expect(status).toBe("passed");
    // The primary is sizable and the release went through the full
    // publish path (version promoted under publish/build_tail_*).
    expect(Number(bytes)).toBeGreaterThan(64 * 1024 * 1024);
    expect(versionDir).toMatch(/^publish\/build_tail_[0-9a-f]{16}$/);
  }, 300_000);
});
