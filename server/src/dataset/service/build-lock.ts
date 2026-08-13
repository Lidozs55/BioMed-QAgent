/**
 * Cross-platform build lock (M2, I-04).
 *
 * One publisher per ``task_id + build_id``. Directory-based mutual exclusion
 * (atomic ``mkdir``) — no POSIX-only flock semantics, works on Windows. A
 * crash leaves a stale lock directory that a later acquirer reclaims when the
 * recorded owner PID is dead or the lock is older than ``staleMs``.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BuildLockOptions {
  /** Lock directory root (e.g. <taskRoot>/state/build-locks). */
  lockRoot: string;
  /** Reclaim locks older than this many ms (default 5 min). */
  staleMs?: number;
  now?: () => Date;
}

export interface BuildLockLease {
  taskId: string;
  buildId: string;
  owner: string;
  release(): Promise<void>;
}

export class BuildLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuildLockError";
  }
}

interface LockOwnerRecord {
  owner: string;
  pid: number;
  acquired_at: string;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readOwner(lockDir: string): Promise<LockOwnerRecord | null> {
  try {
    const raw = await readFile(path.join(lockDir, "owner.json"), "utf8");
    return JSON.parse(raw) as LockOwnerRecord;
  } catch {
    return null;
  }
}

export async function acquireBuildLock(
  options: BuildLockOptions,
  taskId: string,
  buildId: string,
  owner: string,
): Promise<BuildLockLease> {
  const { lockRoot } = options;
  const staleMs = options.staleMs ?? 5 * 60_000;
  const now = options.now ?? (() => new Date());
  const lockDir = path.join(lockRoot, taskId, `${buildId}.lock`);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // Parent recursive, lock dir atomic: recursive mkdir on the lock dir
      // itself would silently succeed on contention instead of throwing EEXIST.
      await mkdir(path.dirname(lockDir), { recursive: true });
      await mkdir(lockDir);
      await writeFile(
        path.join(lockDir, "owner.json"),
        `${JSON.stringify({ owner, pid: process.pid, acquired_at: now().toISOString() })}\n`,
        "utf8",
      );
      let released = false;
      return {
        taskId,
        buildId,
        owner,
        release: async () => {
          if (released) return;
          released = true;
          await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Contended: reclaim only when the holder is dead or the lock is stale.
      const recorded = await readOwner(lockDir);
      let stale = true;
      if (recorded !== null) {
        const age = now().getTime() - Date.parse(recorded.acquired_at);
        stale = age > staleMs || !isProcessAlive(recorded.pid);
      }
      if (!stale) {
        throw new BuildLockError(
          `build ${buildId} is locked by another publisher (owner: ${recorded?.owner ?? "unknown"})`,
        );
      }
      await rm(lockDir, { recursive: true, force: true });
    }
  }
  throw new BuildLockError(`build ${buildId} lock could not be acquired`);
}
