import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type {
  BioMedAgentAdapter,
  BioMedAgentSession,
  BioMedSessionConfig,
} from "../src/agent/contracts.js";
import type { WorkspaceManager } from "../src/agent/workspace/workspace-manager.js";
import { MAX_TASK_FILE_BYTES, readTaskTextFile } from "../src/runtime/task-file.js";
import { createDurableAgentRuntime } from "../src/runtime/durable-agent-runtime.js";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "biomed-task-file-"));
  roots.push(root);
  return root;
}

describe("readTaskTextFile", () => {
  test("serves csv/json text under the workspace with matching media types", async () => {
    const workspace = await makeWorkspace();
    await mkdir(path.join(workspace, "parsed", "chart_data"), { recursive: true });
    await writeFile(
      path.join(workspace, "parsed", "chart_data", "chart_data.csv"),
      "\ufeffchart_id,chart_type\nchart_001,bar\n",
      "utf8",
    );
    await writeFile(path.join(workspace, "notes.json"), "{\"a\":1}", "utf8");

    const csv = await readTaskTextFile(workspace, "parsed/chart_data/chart_data.csv");
    expect(csv).toEqual({
      ok: true,
      content: "\ufeffchart_id,chart_type\nchart_001,bar\n",
      mediaType: "text/csv; charset=utf-8",
    });
    const json = await readTaskTextFile(workspace, "notes.json");
    expect(json).toMatchObject({ ok: true, mediaType: "application/json; charset=utf-8" });
  });

  test("rejects empty, absolute, backslash and traversal paths", async () => {
    const workspace = await makeWorkspace();
    const backslashPath = "a" + String.fromCharCode(92) + "b.csv";
    for (const candidate of ["", "C:/etc/passwd", "/etc/passwd", backslashPath, "../secret.txt", "parsed/../../secret"]) {
      const result = await readTaskTextFile(workspace, candidate);
      expect(result).toEqual({ ok: false, code: "invalid_path" });
    }
  });

  test("rejects non-text extensions and missing files", async () => {
    const workspace = await makeWorkspace();
    expect(await readTaskTextFile(workspace, "binary.exe")).toEqual({
      ok: false,
      code: "invalid_path",
    });
    expect(await readTaskTextFile(workspace, "parsed/chart_data/missing.csv")).toEqual({
      ok: false,
      code: "not_found",
    });
    await mkdir(path.join(workspace, "dir.csv"), { recursive: true });
    expect(await readTaskTextFile(workspace, "dir.csv")).toEqual({ ok: false, code: "not_found" });
  });

  test("rejects oversized files", async () => {
    const workspace = await makeWorkspace();
    const payload = "x".repeat(MAX_TASK_FILE_BYTES + 1);
    await writeFile(path.join(workspace, "big.csv"), payload, "utf8");
    expect(await readTaskTextFile(workspace, "big.csv")).toEqual({ ok: false, code: "too_large" });
  });
});

describe("task file API route", () => {
  function stubWorkspaceManager(workspace: string): WorkspaceManager {
    return {
      getPath: () => workspace,
      ensure: async () => workspace,
      exists: async () => true,
      remove: async () => undefined,
    };
  }

  const adapter: BioMedAgentAdapter = {
    async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
      return {
        piSessionId: `pi_${config.taskId}`,
        taskId: config.taskId,
        runId: config.runId,
        run: async function* () {
          yield { type: "turn_started" };
          yield { type: "turn_completed" };
        },
        resetRunProgress: () => undefined,
        cancel: async () => undefined,
        steer: async () => undefined,
        compact: async () => ({ summary: "compacted" }),
        dispose: async () => undefined,
      };
    },
  };

  test("serves chart CSVs from the task workspace and rejects traversal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-task-file-api-"));
    roots.push(root);
    const workspace = await makeWorkspace();
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter,
      workspaceFactory: async () => ({ root: workspace, tools: [], dispose: async () => undefined }),
      workspaceManager: stubWorkspaceManager(workspace),
    });
    const server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const admitted = await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "request-file", input: "chart task", databases: [], mode: "agent" }),
    });
    expect(admitted.status).toBe(202);
    const accepted = (await admitted.json()) as { task_id: string };

    const chartDir = path.join(workspace, "parsed", "chart_data");
    await mkdir(chartDir, { recursive: true });
    await writeFile(
      path.join(chartDir, "chart_data.csv"),
      "\ufeffchart_id,chart_type\ntitle\nchart_001,bar,Activity\n",
      "utf8",
    );
    await writeFile(
      path.join(chartDir, "chart_data_points.csv"),
      "\ufeffpoint_id,chart_id,x_value,y_value\np1,chart_001,1,2.5\n",
      "utf8",
    );

    const served = await fetch(
      `${base}/api/v1/tasks/${accepted.task_id}/file?path=parsed%2Fchart_data%2Fchart_data.csv`,
    );
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(await served.text()).toContain("chart_001");

    const traversal = await fetch(
      `${base}/api/v1/tasks/${accepted.task_id}/file?path=..%2Fsecret.txt`,
    );
    expect(traversal.status).toBe(400);

    const missing = await fetch(
      `${base}/api/v1/tasks/${accepted.task_id}/file?path=parsed/chart_data/missing.csv`,
    );
    expect(missing.status).toBe(404);

    const unknownTask = await fetch(
      `${base}/api/v1/tasks/does-not-exist/file?path=parsed/chart_data/chart_data.csv`,
    );
    expect(unknownTask.status).toBe(404);

    await runtime.close();
  });
});
