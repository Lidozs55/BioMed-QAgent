import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  AppendOnlyTaskAuditSink,
  InMemoryWorkspaceAuditSink,
  createTaskWorkspace,
} from "../src/agent/workspace/index.js";
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
      path: "parsed/row.txt",
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
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-workspace-tools-"));
    roots.push(root);
    await Promise.all(
      ["source_assets", "parsed", "normalized", "staging/agent", "artifacts", "state", "logs"]
        .map((name) => mkdir(path.join(root, name), { recursive: true })),
    );
    await writeFile(path.join(root, "parsed", "row.txt"), "TP53", "utf8");
    const workspace = await createTaskWorkspace({
      taskId: "task-tools",
      runId: "run-tools",
      root,
      audit: new InMemoryWorkspaceAuditSink(),
    });

    const tools = createWorkspaceTools(workspace);
    const read = tools.find((tool) => tool.name === "workspace_read");
    const exec = tools.find((tool) => tool.name === "workspace_exec");

    expect(tools.map((tool) => tool.name)).toEqual([
      "workspace_read",
      "workspace_list",
      "workspace_search",
      "workspace_write",
      "workspace_edit",
      "workspace_exec",
    ]);
    await expect(read?.execute({ path: "parsed/row.txt" })).resolves.toMatchObject({
      isError: false,
      details: { path: "parsed/row.txt", text: "TP53" },
    });
    await expect(exec?.execute({ executable: process.execPath, args: [] })).resolves.toMatchObject({
      isError: true,
      details: { policy: "disabled" },
    });
    expect(JSON.stringify(tools)).not.toContain("@earendil-works");
  });
});
