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
    await expect(exec?.execute({
      executable: process.execPath,
      args: ["-e", "process.stderr.write('failed'); process.exit(3)"],
    })).resolves.toMatchObject({
      isError: true,
      details: { policy: "allowed", exitCode: 3, stderr: "failed" },
    });
    await expect(exec?.execute({
      executable: path.join(base, "missing", "curl.exe"),
      args: [
        "-sSL",
        "--max-time",
        "60",
        "-o",
        "staging/dilirank2_repo_README.md",
        "https://raw.githubusercontent.com/georgyzaouk/dilirank2-prediction/main/README.md",
      ],
    })).resolves.toMatchObject({
      isError: true,
      details: {
        policy: "rejected",
        exitCode: null,
        stderr: expect.stringMatching(/governed.*download_from_page.*Dataset Core provider/i),
      },
    });
    expect(JSON.stringify(tools)).not.toContain("@earendil-works");
  });

  test("lists and reads downloaded source_assets rooted at task output, write/edit denied", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "biomed-workspace-sourceassets-"));
    roots.push(base);
    const workspaceRoot = path.join(base, "workspace");
    const taskOutputRoot = path.join(base, "output");
    await mkdir(workspaceRoot, { recursive: true });
    const assetDir = path.join(taskOutputRoot, "source_assets", "asset_abc");
    await mkdir(assetDir, { recursive: true });
    await writeFile(path.join(assetDir, "GSE1_series_matrix.txt"), "!series_matrix", "utf8");

    const permissionFixture = createPermissionFixture({
      taskId: "task-src",
      runId: "run-src",
      taskOutputRoot,
    });
    const workspace = await createTaskWorkspace({
      taskId: "task-src",
      runId: "run-src",
      workspaceRoot,
      taskOutputRoot,
      dataRoot: base,
      repositoryRoot: base,
      permissions: permissionFixture.broker,
      audit: new InMemoryWorkspaceAuditSink(),
    });

    const tools = createWorkspaceTools(workspace);
    const list = tools.find((tool) => tool.name === "workspace_list");
    const read = tools.find((tool) => tool.name === "workspace_read");
    const write = tools.find((tool) => tool.name === "workspace_write");

    const listResult = await list?.execute({ path: "source_assets" });
    expect(listResult?.isError).toBe(false);
    expect(listResult?.details).toMatchObject({
      path: "source_assets",
      entries: [{ path: "source_assets/asset_abc", type: "directory" }],
    });

    const readResult = await read?.execute({ path: "source_assets/asset_abc/GSE1_series_matrix.txt" });
    expect(readResult?.isError).toBe(false);
    expect(readResult?.details).toMatchObject({
      path: "source_assets/asset_abc/GSE1_series_matrix.txt",
      text: "!series_matrix",
    });

    const writeResult = await write?.execute({
      path: "source_assets/asset_abc/out.csv",
      content: "probe\tgene\n",
    });
    expect(writeResult?.isError).toBe(true);
    expect(JSON.stringify(writeResult)).toMatch(/denied|deny|not allowed|write/i);
  });
});
