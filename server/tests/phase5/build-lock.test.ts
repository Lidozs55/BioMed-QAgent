/**
 * I-04 build lock ownership/fencing tests (final-audit round 3).
 *
 * The lock must guarantee: one publisher per task_id + build_id, never two.
 * Each scenario below was verified to fail against the pre-audit algorithm
 * (acquired_at-based staleness, blind rm, mkdir-only takeover).
 */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseDatasetManifest } from "../../src/dataset/contracts/manifest.js";
import { parseValidationResult } from "../../src/dataset/contracts/validation.js";
import { promotePublication } from "../../src/dataset/publish/publisher.js";
import { LockLostError, acquireBuildLock, BuildLockError } from "../../src/dataset/service/build-lock.js";

const require = createRequire(import.meta.url);
const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function lockRoot(): Promise<string> {
  const root = await mkdtemp(join(os.tmpdir(), "p5-lock-audit-"));
  roots.push(root);
  return join(root, "locks");
}

const lockDirFor = (lockRootPath: string): string =>
  join(lockRootPath, "task_1", "build_1.lock");

async function writeFakeOwner(lockDir: string, pid: number, acquiredAt = new Date().toISOString()): Promise<void> {
  await writeFile(
    join(lockDir, "owner.json"),
    `${JSON.stringify({ owner: "fake", pid, token: "fake-token", acquired_at: acquiredAt })}\n`,
  );
}

describe("I-04 build lock ownership", () => {
  it("never preempts a live owner on age alone (heartbeat, not acquired_at, is the lease)", async () => {
    const root = await lockRoot();
    const a = await acquireBuildLock(
      { lockRoot: root, staleMs: 300, heartbeatMs: 40 },
      "task_1", "build_1", "run_a",
    );
    // acquired_at is one hour old; only the heartbeat keeps the lock alive.
    const ownerJson = join(lockDirFor(root), "owner.json");
    await utimes(ownerJson, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    // Wait well past staleMs: the heartbeat must keep refreshing mtime.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(
      acquireBuildLock({ lockRoot: root, staleMs: 300, heartbeatMs: 40, retryMs: 250 }, "task_1", "build_1", "run_b"),
    ).rejects.toThrow(/locked by another publisher/);
    await expect(a.assertOwned()).resolves.toBe(true);
    await a.release();
  });

  it("does not delete a lock whose owner.json is still being initialized", async () => {
    const root = await lockRoot();
    const lockDir = lockDirFor(root);
    await mkdir(lockDir, { recursive: true });
    // A legit owner is mid-init: its record lands 300 ms after the mkdir.
    const initPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        void writeFakeOwner(lockDir, process.pid).then(() => resolve());
      }, 300);
    });
    await expect(
      acquireBuildLock(
        { lockRoot: root, initGraceMs: 2_000, retryMs: 400 },
        "task_1", "build_1", "run_b",
      ),
    ).rejects.toThrow(/locked by another publisher/);
    await initPromise;
    // The contender never deleted the lock during the init window.
    expect(existsSync(lockDir)).toBe(true);
    expect(await readFile(join(lockDir, "owner.json"), "utf8")).toContain("fake-token");
  });

  it("reclaims a lock directory that was created but never initialized", async () => {
    const root = await lockRoot();
    const lockDir = lockDirFor(root);
    await mkdir(lockDir, { recursive: true });
    // No owner.json ever appears (owner crashed before init): after the init
    // grace the lock is reclaimable.
    const lease = await acquireBuildLock(
      { lockRoot: root, initGraceMs: 100, retryMs: 2_000 },
      "task_1", "build_1", "run_a",
    );
    await expect(lease.assertOwned()).resolves.toBe(true);
    await lease.release();
  });

  it("release() of a displaced lease never deletes the successor's lock", async () => {
    const root = await lockRoot();
    const a = await acquireBuildLock(
      { lockRoot: root, staleMs: 10_000, heartbeatMs: 60_000 },
      "task_1", "build_1", "run_a",
    );
    // Simulate a stalled event loop: no heartbeat for an hour while the
    // process (this test) is still alive.
    const ownerJson = join(lockDirFor(root), "owner.json");
    await utimes(ownerJson, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    const b = await acquireBuildLock(
      { lockRoot: root, staleMs: 1_000, heartbeatMs: 60_000 },
      "task_1", "build_1", "run_b",
    );
    await expect(a.assertOwned()).resolves.toBe(false); // displaced
    await a.release(); // must NOT remove B's lock
    await expect(b.assertOwned()).resolves.toBe(true);
    await b.release();
    expect(existsSync(lockDirFor(root))).toBe(false);
  });

  it("concurrent stale takeovers yield exactly one owner (atomic rename)", async () => {
    const root = await lockRoot();
    for (let round = 0; round < 4; round += 1) {
      const lockDir = lockDirFor(root);
      await mkdir(lockDir, { recursive: true });
      await writeFakeOwner(lockDir, 99_999_999); // dead pid => stale
      const results = await Promise.allSettled([
        acquireBuildLock({ lockRoot: root, initGraceMs: 20, retryMs: 300 }, "task_1", "build_1", "run_b"),
        acquireBuildLock({ lockRoot: root, initGraceMs: 20, retryMs: 300 }, "task_1", "build_1", "run_c"),
      ]);
      const winners = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireBuildLock>>> => r.status === "fulfilled",
      );
      expect(winners.length, `round ${round}: exactly one contender wins`).toBe(1);
      const winner = winners[0].value;
      await expect(winner.assertOwned(), `round ${round}: winner still owns`).resolves.toBe(true);
      // Exactly one owner record exists in the lock dir.
      const entries = await readdir(lockDir);
      expect(entries.filter((e) => e === "owner.json").length).toBe(1);
      await winner.release();
    }
  });

  it("real child processes serialize on the lock (cross-process mutual exclusion)", async () => {
    const root = await lockRoot();
    const script = fileURLToPath(new URL("./fixtures/build-lock-child.mts", import.meta.url));
    const tsxEntry = require.resolve("tsx/cli");

    // Keep the black-box test within the worker budget: the Vitest worker
    // competes with one real child process. This still proves a real
    // cross-process lease race without adding two extra CPU-heavy workers.
    const startPath = join(root, "child.start");
    const readyPath = join(root, "child.ready");
    await mkdir(root, { recursive: true });
    const child = spawn(
      process.execPath,
      [tsxEntry, script, root, "2", "150", readyPath, startPath],
      { stdio: "pipe" },
    );
    const childResult = new Promise<{ code: number; stderr: string }>((resolve) => {
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error) => { stderr += String(error); });
      child.on("close", (code) => resolve({ code: code ?? -1, stderr: stderr.slice(0, 400) }));
    });
    const stopChild = async (): Promise<{ code: number; stderr: string } | undefined> => {
      await writeFile(startPath, "abort\n", "utf8").catch(() => undefined);
      if (child.exitCode === null) child.kill();
      return Promise.race([
        childResult,
        new Promise<undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), 2_000);
          timer.unref();
        }),
      ]);
    };
    const parentTag = `parent-${process.pid}`;
    const logParent = (line: string): void => {
      appendFileSync(join(root, "events.log"), `${Date.now()} ${parentTag} ${line}\n`);
    };
    const runParent = async (): Promise<void> => {
      for (let round = 0; round < 2; round += 1) {
        let lease: Awaited<ReturnType<typeof acquireBuildLock>> | undefined;
        try {
          lease = await acquireBuildLock(
            { lockRoot: root, retryMs: 20_000, retryIntervalMs: 20, heartbeatMs: 150, staleMs: 1_500 },
            "task_1",
            "build_1",
            parentTag,
          );
          logParent("acquire");
          await new Promise((resolve) => setTimeout(resolve, 150));
          logParent((await lease.assertOwned()) ? "fence-ok" : "fence-lost");
        } finally {
          if (lease !== undefined) {
            await lease.release();
            logParent("release");
          }
        }
      }
    };

    let parentCompletion: Promise<void> | undefined;
    const childCompletion = childResult;

    try {
      const readyDeadline = Date.now() + 10_000;
      while (!existsSync(readyPath) && Date.now() < readyDeadline && child.exitCode === null) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (!existsSync(readyPath)) {
        const earlyResult = await stopChild();
        throw new Error(`lock child did not reach the barrier: ${JSON.stringify(earlyResult)}`);
      }
      await writeFile(startPath, "start\n", "utf8");

      parentCompletion = runParent().catch(async (error: unknown) => {
        await stopChild();
        throw error;
      });
      const [childOutcome, parentOutcome] = await Promise.allSettled([
        childCompletion,
        parentCompletion,
      ]);
      if (childOutcome.status === "rejected") throw childOutcome.reason;
      if (childOutcome.value.code !== 0) {
        throw new Error(`lock child failed (${childOutcome.value.code}): ${childOutcome.value.stderr}`);
      }
      if (parentOutcome.status === "rejected") throw parentOutcome.reason;
    } finally {
      await stopChild();
    }

    // Mutual exclusion: the acquire/fence/release log must never show two
    // overlapping holders.
    const log = (await readFile(join(root, "events.log"), "utf8")).trim().split("\n");
    expect(log.length).toBeGreaterThan(0);
    let heldBy: string | null = null;
    for (const line of log) {
      const [timestamp, child, action] = line.split(" ");
      expect(Number(timestamp)).toBeGreaterThan(0);
      if (action === "acquire") {
        expect(heldBy, `no overlap: ${line} while ${heldBy ?? "nobody"} held`).toBeNull();
        heldBy = child;
      } else if (action === "fence-ok") {
        expect(heldBy).toBe(child);
      } else if (action === "release") {
        expect(heldBy).toBe(child);
        heldBy = null;
      } else {
        throw new Error(`unexpected log line: ${line}`);
      }
    }
    expect(heldBy).toBeNull();
  });
});

describe("I-04 publish fence", () => {
  it("promotePublication refuses to publish once the lease is displaced", async () => {
    const root = await lockRoot();
    const outputDir = join(root, "output");
    await mkdir(outputDir, { recursive: true });
    const manifest = parseDatasetManifest({
      schema_version: "1.0",
      manifest_id: "manifest_fence_test",
      task_id: "task_1",
      build_id: "build_1",
      dataset_family: "expression",
      row_granularity: "gene",
      schema_ref: "gene_expression.long.v1",
      row_count: 0,
      sha256: "0".repeat(64),
      artifacts: [],
    });
    const validation = parseValidationResult({
      schema_version: "1.0",
      manifest_digest: manifest.sha256,
      profile_ref: "minimal",
      status: "passed",
      checked_count: 0,
      failed_count: 0,
    });

    const a = await acquireBuildLock(
      { lockRoot: root, staleMs: 10_000, heartbeatMs: 60_000 },
      "task_1", "build_1", "run_a",
    );
    const ownerJson = join(lockDirFor(root), "owner.json");
    await utimes(ownerJson, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    const b = await acquireBuildLock(
      { lockRoot: root, staleMs: 1_000, heartbeatMs: 60_000 },
      "task_1", "build_1", "run_b",
    );
    await expect(a.assertOwned()).resolves.toBe(false); // a displaced by b
    await expect(
      promotePublication({
        outputDir,
        manifest,
        validation,
        fence: async () => a.assertOwned(),
      }),
    ).rejects.toThrow(LockLostError);
    await a.release(); // must not delete b's lock
    await expect(b.assertOwned()).resolves.toBe(true);
    await b.release();
  });

  it("rejects with BuildLockError while a live owner holds (retry then fail)", async () => {
    const root = await lockRoot();
    const a = await acquireBuildLock(
      { lockRoot: root, staleMs: 10_000, heartbeatMs: 60_000 },
      "task_1", "build_1", "run_a",
    );
    await expect(
      acquireBuildLock({ lockRoot: root, retryMs: 300 }, "task_1", "build_1", "run_b"),
    ).rejects.toBeInstanceOf(BuildLockError);
    await a.release();
  });
});
