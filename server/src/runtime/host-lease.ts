/**
 * Exclusive tasks-root lease for the durable runtime.
 *
 * Every `createDurableAgentRuntime` startup runs `recoverActiveRuns` over the
 * whole tasks root and marks active runs that are not in its own memory as
 * interrupted. Two live Application Host processes on one data directory
 * therefore kill each other's runs, and their concurrent `events.jsonl`
 * appends can corrupt the journal badly enough that the next startup fails
 * on a sequence-gap parse (docs/ISSUES.md §运行环境, 2026-08-27 incident).
 *
 * The lease turns that silent sweep into a fail-fast startup error: the
 * second live process refuses to start while the first holds the lease. A
 * lease from a dead process is stale and is taken over; the same process may
 * re-claim its own lease (tests and in-process restarts do this).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const LEASE_FILENAME = ".host-lease.json";

export interface HostLease {
  schema_version: "1.0";
  holder_pid: number;
  acquired_at: string;
}

export class HostLeaseHeldError extends Error {
  readonly holderPid: number;

  constructor(holderPid: number, leasePath: string) {
    super(
      `another Application Host process (pid ${holderPid}) holds the tasks-root lease at ${leasePath}; ` +
        "stop that process (or remove its stale lease file) before starting a second host on the same data directory",
    );
    this.name = "HostLeaseHeldError";
    this.holderPid = holderPid;
  }
}

export async function readHostLease(tasksRoot: string): Promise<HostLease | null> {
  try {
    const raw = JSON.parse(await readFile(path.join(tasksRoot, LEASE_FILENAME), "utf-8")) as Partial<HostLease>;
    const holderPid = raw.holder_pid;
    if (raw.schema_version !== "1.0" || typeof holderPid !== "number" || !Number.isSafeInteger(holderPid) || holderPid <= 0) {
      return null;
    }
    return { schema_version: "1.0", holder_pid: holderPid, acquired_at: raw.acquired_at ?? "" };
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM: the process exists but belongs to another user/session.
    return code === "EPERM";
  }
}

/**
 * Claim the exclusive host lease for `tasksRoot`. `options.holderPid`
 * overrides the recorded holder for tests; `options.pid` simulates the
 * claiming process id.
 */
export async function claimTasksRootExclusive(
  tasksRoot: string,
  options: { holderPid?: number; pid?: number } = {},
): Promise<HostLease> {
  await mkdir(tasksRoot, { recursive: true });
  const leasePath = path.join(tasksRoot, LEASE_FILENAME);
  const recorded = await readHostLease(tasksRoot);
  const claimingPid = options.pid ?? process.pid;
  // `holderPid` simulates a pre-existing lease holder for tests; production
  // claims read the recorded holder from the lease file.
  const holderPid = options.holderPid ?? recorded?.holder_pid;
  if (holderPid !== undefined && holderPid !== claimingPid && processAlive(holderPid)) {
    throw new HostLeaseHeldError(holderPid, leasePath);
  }
  const lease: HostLease = { schema_version: "1.0", holder_pid: claimingPid, acquired_at: new Date().toISOString() };
  await writeFile(leasePath, `${JSON.stringify(lease, null, 2)}\n`, "utf-8");
  return lease;
}
