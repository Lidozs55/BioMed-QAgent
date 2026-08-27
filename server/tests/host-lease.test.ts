/**
 * Tasks-root exclusive lease: a second live Application Host process must
 * fail fast at startup instead of silently marking the first host's active
 * runs interrupted (and interleaving concurrent events.jsonl appends). The
 * 2026-08-27 multi-instance incident is the reproducing background; see
 * docs/ISSUES.md §运行环境.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  claimTasksRootExclusive,
  HostLeaseHeldError,
  readHostLease,
} from "../src/runtime/host-lease.js";
import { createDurableAgentRuntime } from "../src/runtime/durable-agent-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Wait until a live-but-foreign pid is available: our own parent process. */
function liveForeignPid(): number {
  const ppid = process.ppid;
  expect(ppid).toBeGreaterThan(0);
  expect(ppid).not.toBe(process.pid);
  return ppid;
}

/** Spawn a short-lived real process and return its pid after it exits. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return pid;
}

describe("tasks-root exclusive host lease", () => {
  test("claims a fresh tasks root and rewrites a stale lease from a dead process", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "host-lease-"));
    roots.push(root);

    const lease = await claimTasksRootExclusive(root);
    expect(lease.holder_pid).toBe(process.pid);
    const recorded = await readHostLease(root);
    expect(recorded?.holder_pid).toBe(process.pid);

    const stale = await claimTasksRootExclusive(root, { holderPid: await deadPid() });
    expect(stale.holder_pid).toBe(process.pid);
  });

  test("a live foreign holder refuses the claim with the holder pid", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "host-lease-"));
    roots.push(root);
    const foreign = liveForeignPid();

    await expect(claimTasksRootExclusive(root, { holderPid: foreign })).rejects.toThrow(HostLeaseHeldError);
    await expect(claimTasksRootExclusive(root, { holderPid: foreign })).rejects.toThrow(
      new RegExp(`pid ${foreign}`),
    );
  });

  test("the same process may re-claim its own lease", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "host-lease-"));
    roots.push(root);

    await claimTasksRootExclusive(root);
    await expect(claimTasksRootExclusive(root)).resolves.toMatchObject({ holder_pid: process.pid });
  });

  test("createDurableAgentRuntime refuses to start while a live foreign host holds the lease", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "host-lease-runtime-"));
    roots.push(root);

    await expect(createDurableAgentRuntime({
      tasksRoot: root,
      adapter: {
        createSession: async () => {
          throw new Error("must not be reached");
        },
      },
      workspaceFactory: async () => ({ root, tools: [], dispose: async () => undefined }),
      leaseOverride: { holderPid: liveForeignPid() },
    })).rejects.toThrow(HostLeaseHeldError);

    // A stale (dead-holder) lease must not block runtime creation.
    await expect(createDurableAgentRuntime({
      tasksRoot: root,
      adapter: {
        createSession: async () => {
          throw new Error("session is not started during construction");
        },
      },
      workspaceFactory: async () => ({ root, tools: [], dispose: async () => undefined }),
      leaseOverride: { holderPid: await deadPid() },
    })).resolves.toBeDefined();
  });

  test("the lease file is ignored by task-directory scans", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "host-lease-scan-"));
    roots.push(root);
    await claimTasksRootExclusive(root);
    const raw = JSON.parse(await readFile(path.join(root, ".host-lease.json"), "utf-8")) as {
      holder_pid: number;
    };
    expect(raw.holder_pid).toBe(process.pid);
  });
});
