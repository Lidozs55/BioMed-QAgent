import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  DiskWorkspaceManager,
  markerPathFor,
  migrateLegacyWorkspace,
  readWorkspaceStateMarker,
} from "../src/agent/workspace/index.js";

const roots: string[] = [];

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "biomed-wsmgr-"));
  roots.push(base);
  const workspacesRoot = path.join(base, "workspaces");
  const tasksRoot = path.join(base, "output", "tasks");
  await mkdir(workspacesRoot, { recursive: true });
  await mkdir(tasksRoot, { recursive: true });
  return { base, workspacesRoot, tasksRoot };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DiskWorkspaceManager (data/workspaces/<taskId>)", () => {
  test("creates, reuses, and removes a task workspace at the canonical path", async () => {
    const { workspacesRoot } = await fixture();
    const manager = new DiskWorkspaceManager({ workspacesRoot });

    expect(manager.getPath("task_ts_abc")).toBe(path.join(workspacesRoot, "task_ts_abc"));
    const created = await manager.ensure("task_ts_abc");
    expect(created).toBe(path.join(workspacesRoot, "task_ts_abc"));
    expect(await manager.exists("task_ts_abc")).toBe(true);

    await writeFile(path.join(created, "notes.md"), "work", "utf8");
    // Reuse: ensure is idempotent and keeps files.
    const reused = await manager.ensure("task_ts_abc");
    expect(reused).toBe(created);
    expect(await readFile(path.join(reused, "notes.md"), "utf8")).toBe("work");

    await manager.remove("task_ts_abc");
    expect(await manager.exists("task_ts_abc")).toBe(false);
  });

  test("rejects unsafe task ids", async () => {
    const { workspacesRoot } = await fixture();
    const manager = new DiskWorkspaceManager({ workspacesRoot });
    for (const bad of ["../escape", "a/b", "a\\b", "", "has space"]) {
      expect(() => manager.getPath(bad)).toThrow();
      await expect(manager.ensure(bad)).rejects.toThrow();
    }
  });

  test("concurrent ensure yields exactly one directory", async () => {
    const { workspacesRoot } = await fixture();
    const manager = new DiskWorkspaceManager({ workspacesRoot });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => manager.ensure("task_ts_concurrent")),
    );
    expect(new Set(results)).toEqual(new Set([path.join(workspacesRoot, "task_ts_concurrent")]));
    expect(await manager.exists("task_ts_concurrent")).toBe(true);
  });

  test("restart restore: ensure after a fresh manager instance reuses the durable workspace", async () => {
    const { workspacesRoot } = await fixture();
    const first = new DiskWorkspaceManager({ workspacesRoot });
    const root = await first.ensure("task_ts_durable");
    await mkdir(path.join(root, "analysis"), { recursive: true });
    await writeFile(path.join(root, "analysis", "summary.json"), "{}", "utf8");

    // Simulate application restart: a brand-new manager must not delete or
    // recreate the workspace (plan §12).
    const second = new DiskWorkspaceManager({ workspacesRoot });
    const restored = await second.ensure("task_ts_durable");
    expect(restored).toBe(root);
    expect(await readFile(path.join(restored, "analysis", "summary.json"), "utf8")).toBe("{}");
  });

  test("remove is a no-op for unknown tasks", async () => {
    const { workspacesRoot } = await fixture();
    const manager = new DiskWorkspaceManager({ workspacesRoot });
    await expect(manager.remove("task_ts_missing")).resolves.toBeUndefined();
  });
});

describe("legacy staging/agent migration (W2)", () => {
  test("migrates agent-owned files into the workspace and marks state/workspace.json", async () => {
    const { base, workspacesRoot, tasksRoot } = await fixture();
    const taskId = "task_ts_legacy";
    const taskOutputRoot = path.join(tasksRoot, taskId);
    const workspaceRoot = path.join(workspacesRoot, taskId);
    await mkdir(path.join(taskOutputRoot, "staging", "agent", "scripts"), { recursive: true });
    await mkdir(path.join(taskOutputRoot, "state"), { recursive: true });
    await mkdir(path.join(taskOutputRoot, "logs"), { recursive: true });
    await writeFile(path.join(taskOutputRoot, "staging", "agent", "notes.md"), "legacy note", "utf8");
    await writeFile(path.join(taskOutputRoot, "staging", "agent", "scripts", "normalize.py"), "print(1)", "utf8");
    // Framework data must NOT be migrated.
    await writeFile(path.join(taskOutputRoot, "state", "task.json"), "{}", "utf8");
    await writeFile(path.join(taskOutputRoot, "logs", "runtime.log"), "log", "utf8");

    const manager = new DiskWorkspaceManager({
      workspacesRoot,
      migrateLegacy: async (id, root) => {
        await migrateLegacyWorkspace({
          taskId: id,
          workspaceRoot: root,
          taskOutputRoot: path.join(tasksRoot, id),
        });
      },
    });
    const created = await manager.ensure(taskId);

    // The staging/agent layer is dropped: scripts/ + notes.md at root.
    expect(await readFile(path.join(created, "notes.md"), "utf8")).toBe("legacy note");
    expect(await readFile(path.join(created, "scripts", "normalize.py"), "utf8")).toBe("print(1)");
    const entries = await readdir(created);
    expect(entries).not.toContain("staging");
    expect(entries).not.toContain("state");
    expect(entries).not.toContain("logs");

    const marker = await readWorkspaceStateMarker(taskOutputRoot);
    expect(marker).toMatchObject({
      version: 2,
      workspace: workspaceRoot,
      legacy_workspace_migrated: true,
    });
    expect(marker?.migrated_at).toBeDefined();
    void base;
  });

  test("idempotent: a second ensure does not re-copy or clobber workspace files", async () => {
    const { workspacesRoot, tasksRoot } = await fixture();
    const taskId = "task_ts_legacy2";
    const taskOutputRoot = path.join(tasksRoot, taskId);
    await mkdir(path.join(taskOutputRoot, "staging", "agent"), { recursive: true });
    await writeFile(path.join(taskOutputRoot, "staging", "agent", "a.txt"), "a", "utf8");

    const options = {
      workspacesRoot,
      migrateLegacy: async (id: string, root: string) => {
        await migrateLegacyWorkspace({
          taskId: id,
          workspaceRoot: root,
          taskOutputRoot: path.join(tasksRoot, id),
        });
      },
    };
    const manager = new DiskWorkspaceManager(options);
    const created = await manager.ensure(taskId);
    await writeFile(path.join(created, "a.txt"), "modified by agent", "utf8");

    const again = await manager.ensure(taskId);
    expect(again).toBe(created);
    // The agent's modification survived; no re-copy happened.
    expect(await readFile(path.join(created, "a.txt"), "utf8")).toBe("modified by agent");
    expect((await readWorkspaceStateMarker(taskOutputRoot))?.legacy_workspace_migrated).toBe(true);
  });

  test("creates an empty workspace when no legacy staging/agent exists", async () => {
    const { workspacesRoot, tasksRoot } = await fixture();
    const taskId = "task_ts_fresh";
    const manager = new DiskWorkspaceManager({
      workspacesRoot,
      migrateLegacy: async (id, root) => {
        await migrateLegacyWorkspace({
          taskId: id,
          workspaceRoot: root,
          taskOutputRoot: path.join(tasksRoot, id),
        });
      },
    });
    const created = await manager.ensure(taskId);
    expect(await readdir(created)).toEqual([]);
    const marker = await readWorkspaceStateMarker(path.join(tasksRoot, taskId));
    expect(marker).toMatchObject({ version: 2, legacy_workspace_migrated: false });
  });

  test("workspace files are never stored inside the task output", async () => {
    const { workspacesRoot, tasksRoot } = await fixture();
    const taskId = "task_ts_nooutput";
    const manager = new DiskWorkspaceManager({ workspacesRoot });
    const created = await manager.ensure(taskId);
    expect(created).not.toContain(path.join(tasksRoot, taskId));
    expect(await readdir(created)).toEqual([]);
    // Marker path lives in framework state, not in the workspace.
    expect(markerPathFor(path.join(tasksRoot, taskId))).toBe(
      path.join(tasksRoot, taskId, "state", "workspace.json"),
    );
  });
});
