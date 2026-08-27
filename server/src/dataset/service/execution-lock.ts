/**
 * Cross-platform execution lock — one publisher per task_id + requirement_id.
 *
 * Directory-based mutual exclusion (atomic ``mkdir``) — no POSIX-only flock
 * semantics, works on Windows.  Ownership is a *fenced lease*:
 *
 * - ``owner.json`` records ``{ owner, pid, token, acquired_at }``; the file's
 *   mtime doubles as a heartbeat refreshed by the holder on an interval, so a
 *   live process is never preempted for age alone — ``acquired_at`` is
 *   informational, not a lease (an execution may legitimately
 *   run far longer than one operation timeout).
 * - A lock is stale only when the recorded PID is dead **or** the heartbeat
 *   is older than ``staleMs`` (a stalled event loop cannot refresh it, so a
 *   hung holder is still reclaimable).
 * - Reclaiming a stale lock is an **atomic rename** of the whole lock
 *   directory: exactly one contender can ever win the takeover; losers get
 *   ENOENT and re-classify.  The fresh ``owner.json`` is created with
 *   exclusive create (``wx``), closing the mkdir-then-init window in which a
 *   contender could observe a lock without its owner record.
 * - ``release()`` re-reads ``owner.json`` and deletes only a lock it still
 *   owns — a displaced lease can never remove the successor's lock.
 * - ``assertOwned()`` is the publish-time fence: the publisher re-checks the
 *   token + heartbeat immediately before the immutable rename, so an execution
 *   whose lease was taken over can never publish late.
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

export interface ExecutionLockOptions {
  /** Lock directory root (e.g. <taskRoot>/state/execution-locks). */
  lockRoot: string;
  /** Heartbeat staleness threshold (default 10 s). */
  staleMs?: number;
  /** Heartbeat refresh interval (default 2 s; must stay well below staleMs). */
  heartbeatMs?: number;
  /** Grace for an in-progress owner.json initialization (default 2 s). */
  initGraceMs?: number;
  /** How long acquire keeps retrying a contended lock before failing (default 10 s). */
  retryMs?: number;
  /** Retry/read interval inside acquire (default 50 ms). */
  retryIntervalMs?: number;
  /** Injectable clock for the acquired_at record (default Date). */
  now?: () => Date;
  /** Injectable sleep for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable process-alive probe (default process.kill 0). */
  isAlive?: (pid: number) => boolean;
}

export interface ExecutionLockLease {
  taskId: string;
  requirementId: string;
  owner: string;
  /**
   * Fence: true while this lease still owns the lock (token matches and the
   * heartbeat is fresh).  Re-checked by the publisher at the rename boundary.
   */
  assertOwned(): Promise<boolean>;
  release(): Promise<void>;
}

export class ExecutionLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionLockError";
  }
}

/** The lease was taken over before its final promotion (fencing violation). */
export class LockLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockLostError";
  }
}

interface LockOwnerRecord {
  owner: string;
  pid: number;
  token: string;
  acquired_at: string;
}

function defaultIsProcessAlive(pid: number): boolean {
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

interface ClassifyContext {
  initGraceMs: number;
  retryIntervalMs: number;
  staleMs: number;
  isAlive: (pid: number) => boolean;
  sleep: (ms: number) => Promise<void>;
}

/**
 * Classify a contended lock.  A lock whose owner.json is missing is *not*
 * immediately stale: the mkdir happens before the owner record is written, so
 * contenders wait an init grace (re-reading) before declaring the holder dead
 * before initialization.
 */
async function classify(lockDir: string, ownerJson: string, ctx: ClassifyContext): Promise<"held" | "stale"> {
  const graceDeadline = Date.now() + ctx.initGraceMs;
  let recorded: LockOwnerRecord | null = null;
  while (Date.now() < graceDeadline) {
    recorded = await readOwner(lockDir);
    if (recorded !== null) break;
    await ctx.sleep(ctx.retryIntervalMs);
  }
  if (recorded === null) {
    return "stale"; // created but never initialized: dead before init
  }
  const heartbeat = await stat(ownerJson).catch(() => null);
  const heartbeatFresh = heartbeat !== null && Date.now() - heartbeat.mtimeMs <= ctx.staleMs;
  if (!ctx.isAlive(recorded.pid) || !heartbeatFresh) {
    return "stale";
  }
  return "held";
}

export async function acquireExecutionLock(
  options: ExecutionLockOptions,
  taskId: string,
  requirementId: string,
  owner: string,
): Promise<ExecutionLockLease> {
  const { lockRoot } = options;
  const staleMs = options.staleMs ?? 10_000;
  const heartbeatMs = options.heartbeatMs ?? 2_000;
  const initGraceMs = options.initGraceMs ?? 2_000;
  const retryMs = options.retryMs ?? 10_000;
  const retryIntervalMs = options.retryIntervalMs ?? 50;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isAlive = options.isAlive ?? defaultIsProcessAlive;
  const lockDir = path.join(lockRoot, taskId, `${requirementId}.lock`);
  const ownerJson = path.join(lockDir, "owner.json");
  const deadline = now().getTime() + retryMs;

  const classifyCtx: ClassifyContext = { initGraceMs, retryIntervalMs, staleMs, isAlive, sleep };

  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    const token = randomUUID();
    try {
      // Parent recursive, lock dir atomic: recursive mkdir on the lock dir
      // itself would silently succeed on contention instead of throwing EEXIST.
      await mkdir(path.dirname(lockDir), { recursive: true });
      await mkdir(lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Contended — never touch a lock that a live, heartbeating owner holds.
      const status = await classify(lockDir, ownerJson, classifyCtx);
      if (status === "held") {
        if (now().getTime() >= deadline) {
          const recorded = await readOwner(lockDir);
          throw new ExecutionLockError(
            `requirement ${requirementId} is locked by another publisher (owner: ${recorded?.owner ?? "unknown"})`,
          );
        }
        await sleep(retryIntervalMs);
        continue;
      }
      // Stale: atomic takeover.  Renaming the whole directory means exactly
      // one contender can win; losers get ENOENT and re-classify above.
      const graveyard = `${lockDir}.graveyard-${token}`;
      try {
        await rename(lockDir, graveyard);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "EPERM" || code === "EBUSY") {
          // Lost the takeover race, or a transient Windows handle conflict.
          await sleep(retryIntervalMs);
          continue;
        }
        throw error;
      }
      await rm(graveyard, { recursive: true, force: true }).catch(() => undefined);
      try {
        await mkdir(lockDir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          await sleep(retryIntervalMs);
          continue; // another contender initialized the fresh dir first
        }
        throw error;
      }
    }
    // We own a fresh lock dir.  Exclusive create: a takeover racing this init
    // window can never observe (or overwrite) a half-written owner record.
    try {
      await writeFile(
        ownerJson,
        `${JSON.stringify({ owner, pid: process.pid, token, acquired_at: now().toISOString() })}\n`,
        { flag: "wx" },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        await sleep(retryIntervalMs);
        continue; // someone else initialized this dir first
      }
      throw error;
    }
    let released = false;
    let heartbeat: NodeJS.Timeout | null = null;
    const stopHeartbeat = (): void => {
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    };
    heartbeat = setInterval(() => {
      void (async () => {
        // Heartbeat only while we still own the lock (token check), so a
        // displaced lease can never refresh the successor's heartbeat.
        const recorded = await readOwner(lockDir);
        if (recorded === null || recorded.token !== token) {
          stopHeartbeat();
          return;
        }
        await utimes(ownerJson, new Date(), new Date()).catch(() => undefined);
      })();
    }, heartbeatMs);
    heartbeat.unref();
    return {
      taskId,
      requirementId,
      owner,
      assertOwned: async (): Promise<boolean> => {
        const recorded = await readOwner(lockDir);
        if (recorded === null || recorded.token !== token) return false;
        const heartbeatStat = await stat(ownerJson).catch(() => null);
        if (heartbeatStat === null) return false;
        return Date.now() - heartbeatStat.mtimeMs <= staleMs;
      },
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        stopHeartbeat();
        // Owner-aware: only ever delete a lock we still own; a displaced
        // lease must not remove the successor's lock.
        const recorded = await readOwner(lockDir);
        if (recorded !== null && recorded.token === token) {
          await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
        }
      },
    };
  }
  throw new ExecutionLockError(`requirement ${requirementId} lock could not be acquired`);
}
