import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  AppendOnlyTaskAuditSink,
  InMemoryWorkspaceAuditSink,
  createTaskWorkspace,
} from "../src/agent/workspace/index.js";
import { createPermissionFixture } from "./helpers/permission-fixture.js";
import { createWorkspaceTools } from "../src/agent/workspace/tools.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Workspace project tools", () => {
  test("appends Host-owned audit records beneath Task logs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-workspace-audit-"));
    roots.push(root);
    const sink = new AppendOnlyTaskAuditSink(root);
    const record = {
      taskId: "task-audit",
      runId: "run-audit",
      operation: "read" as const,
      path: "notes/row.txt",
      result: "success" as const,
      durationMs: 1,
      truncated: false,
      timestamp: "2026-08-12T00:00:00.000Z",
    };

    await sink.record(record);
    await sink.record({ ...record, result: "rejected" });

    const lines = (await readFile(path.join(root, "logs", "workspace-audit.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as object);
    expect(lines).toEqual([record, { ...record, result: "rejected" }]);
  });

  test("composes Pi-free structured descriptors over governed operations", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "biomed-workspace-tools-"));
    roots.push(base);
    const workspaceRoot = path.join(base, "workspace");
    const taskOutputRoot = path.join(base, "output");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, "notes", "row.txt"), "TP53", "utf8").catch(async () => {
      await mkdir(path.join(workspaceRoot, "notes"), { recursive: true });
      await writeFile(path.join(workspaceRoot, "notes", "row.txt"), "TP53", "utf8");
    });
    const permissionFixture = createPermissionFixture({
      taskId: "task-tools",
      runId: "run-tools",
      taskOutputRoot,
    });
    await permissionFixture.policyStore.setPersistentExecAllow(true);
    const permissions = permissionFixture.broker;
    const workspace = await createTaskWorkspace({
      taskId: "task-tools",
      runId: "run-tools",
      workspaceRoot,
      taskOutputRoot,
      dataRoot: base,
      repositoryRoot: base,
      permissions,
      audit: new InMemoryWorkspaceAuditSink(),
    });

    const tools = createWorkspaceTools(workspace);
    const read = tools.find((tool) => tool.name === "workspace_read");
    const exec = tools.find((tool) => tool.name === "workspace_exec");

    expect((exec?.parameters as { properties?: Record<string, unknown> }).properties?.timeout_seconds)
      .toMatchObject({ minimum: 1, maximum: 86_400 });
    expect(tools.map((tool) => tool.name)).toEqual([
      "workspace_read",
      "workspace_list",
      "workspace_search",
      "workspace_write",
      "workspace_edit",
      "workspace_exec",
    ]);
    await expect(read?.execute({ path: "notes/row.txt" })).resolves.toMatchObject({
      isError: false,
      details: { path: "notes/row.txt", text: "TP53" },
    });
    await expect(exec?.execute({
      executable: process.execPath,
      args: ["-e", "process.exit(0)"],
    })).resolves.toMatchObject({
      isError: false,
      details: { policy: "allowed", exitCode: 0 },
    });
    expect(JSON.stringify(tools)).not.toContain("@earendil-works");
  });
});
