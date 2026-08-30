import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  acquireApplicationInstanceLock,
  APPLICATION_INSTANCE_LOCK_DIRECTORY,
  resolveApplicationInstanceLockRoot,
} from "../src/runtime/application-instance-lock.js";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "application-instance-lock-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production application instance lock", () => {
  test("claims a fresh lock, releases it, and allows a later claim", async () => {
    const lockRoot = await temporaryRoot();
    const first = await acquireApplicationInstanceLock({ lockRoot });
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") throw new Error("expected acquired lock");

    await first.lease.release();
    const second = await acquireApplicationInstanceLock({ lockRoot });
    expect(second.status).toBe("acquired");
    if (second.status === "acquired") await second.lease.release();
  });

  test("allows exactly one of two concurrent contenders to acquire", async () => {
    const lockRoot = await temporaryRoot();
    const [first, second] = await Promise.all([
      acquireApplicationInstanceLock({ lockRoot }),
      acquireApplicationInstanceLock({ lockRoot }),
    ]);

    expect([first.status, second.status].sort()).toEqual(["acquired", "already_running"]);
    if (first.status === "acquired") await first.lease.release();
    if (second.status === "acquired") await second.lease.release();
  });

  test("reports an already-running live holder without replacing it", async () => {
    const lockRoot = await temporaryRoot();
    const holder = await acquireApplicationInstanceLock({ lockRoot, pid: 101, isAlive: () => true });
    expect(holder.status).toBe("acquired");

    const contender = await acquireApplicationInstanceLock({ lockRoot, pid: 202, isAlive: () => true });
    expect(contender).toMatchObject({ status: "already_running", holderPid: 101 });
    if (holder.status === "acquired") await holder.lease.release();
  });

  test("atomically replaces a dead holder and an old lease cannot remove the successor", async () => {
    const lockRoot = await temporaryRoot();
    const old = await acquireApplicationInstanceLock({ lockRoot, pid: 101, isAlive: () => true });
    expect(old.status).toBe("acquired");

    const successor = await acquireApplicationInstanceLock({
      lockRoot,
      pid: 202,
      isAlive: (pid) => pid === 202,
    });
    expect(successor.status).toBe("acquired");
    if (old.status === "acquired") await old.lease.release();

    const blocked = await acquireApplicationInstanceLock({
      lockRoot,
      pid: 303,
      isAlive: (pid) => pid === 202 || pid === 303,
    });
    expect(blocked).toMatchObject({ status: "already_running", holderPid: 202 });
    if (successor.status === "acquired") await successor.lease.release();
  });

  test("recovers a lock whose owner initialization never completed", async () => {
    const lockRoot = await temporaryRoot();
    await mkdir(path.join(lockRoot, APPLICATION_INSTANCE_LOCK_DIRECTORY));

    const claimed = await acquireApplicationInstanceLock({
      lockRoot,
      initGraceMs: 0,
      retryIntervalMs: 1,
    });
    expect(claimed.status).toBe("acquired");
    if (claimed.status === "acquired") await claimed.lease.release();
  });

  test("does not disguise filesystem errors as another running instance", async () => {
    const parent = await temporaryRoot();
    const lockRoot = path.join(parent, "not-a-directory");
    await writeFile(lockRoot, "file", "utf8");

    await expect(acquireApplicationInstanceLock({ lockRoot })).rejects.toMatchObject({ code: "EEXIST" });
  });

  test("resolves a stable per-user lock root for each supported platform", () => {
    expect(resolveApplicationInstanceLockRoot({
      platform: "win32",
      environment: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
      homeDir: "C:\\Users\\tester",
    })).toBe(path.join("C:\\Users\\tester\\AppData\\Local", "BioMed-QAgent", "runtime"));
    expect(resolveApplicationInstanceLockRoot({
      platform: "darwin",
      environment: {},
      homeDir: "/Users/tester",
    })).toBe(path.join("/Users/tester", "Library", "Application Support", "BioMed-QAgent", "runtime"));
    expect(resolveApplicationInstanceLockRoot({
      platform: "linux",
      environment: { XDG_RUNTIME_DIR: "/run/user/1000" },
      homeDir: "/home/tester",
    })).toBe(path.join("/run/user/1000", "biomed-qagent"));
    expect(resolveApplicationInstanceLockRoot({
      platform: "linux",
      environment: {},
      homeDir: "/home/tester",
    })).toBe(path.join("/home/tester", ".local", "state", "biomed-qagent", "runtime"));
  });
});
