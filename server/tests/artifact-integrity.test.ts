import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";

import type {
  BioMedAgentAdapter,
  BioMedAgentEvent,
  BioMedAgentSession,
  BioMedSessionConfig,
} from "../src/agent/contracts.js";
import {
  DiskWorkspaceManager,
} from "../src/agent/workspace/index.js";
import { createDurableAgentRuntime } from "../src/runtime/durable-agent-runtime.js";

const roots: string[] = [];

function immediateAdapter(): BioMedAgentAdapter {
  return {
    async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
      return {
        piSessionId: `pi_${config.taskId}`,
        taskId: config.taskId,
        runId: config.runId,
        run: async function* run(): AsyncIterable<BioMedAgentEvent> {
          yield { type: "turn_completed" };
        },
        cancel: async () => undefined,
        dispose: async () => undefined,
      };
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function runtimeFixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "biomed-artifact-integrity-"));
  roots.push(base);
  const tasksRoot = path.join(base, "output", "tasks");
  const workspacesRoot = path.join(base, "workspaces");
  await mkdir(tasksRoot, { recursive: true });
  const workspaceManager = new DiskWorkspaceManager({ workspacesRoot });
  const runtime = await createDurableAgentRuntime({
    tasksRoot,
    workspaceManager,
    adapter: immediateAdapter(),
    workspaceFactory: async ({ taskId }) => ({
      root: await workspaceManager.ensure(taskId),
      tools: [],
      dispose: async () => undefined,
    }),
  });
  const server: Server = createServer((request, response) => {
    if (!runtime.handle(request, response)) response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, tasksRoot, workspacesRoot, runtime, server, baseUrl };
}

async function createTask(baseUrl: string, requestId: string): Promise<{ task_id: string }> {
  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      request_id: requestId,
      input: `integrity ${requestId}`,
      databases: [],
      mode: "agent",
    }),
  });
  expect(created.status).toBe(202);
  return await created.json() as { task_id: string };
}

describe("publication integrity hardening (P7)", () => {
  test("an agent workspace file never becomes a Publication automatically", async () => {
    const { baseUrl, runtime, server, workspacesRoot } = await runtimeFixture();
    const { task_id: taskId } = await createTask(baseUrl, "req_p7_workspace");

    // The agent writes an arbitrary file (even one named like an artifact)
    // into its own workspace.
    const workspaceRoot = path.join(workspacesRoot, taskId);
    await mkdir(path.join(workspaceRoot, "results"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "results", "primary.csv"), "gene_id,value\nTP53,1\n", "utf8");
    await writeFile(path.join(workspaceRoot, "dataset_manifest.json"), "{}", "utf8");

    const listing = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/artifacts`);
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({ artifacts: [], degraded: false });

    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("published artifacts are manifest-registered and hash-verified on every read", async () => {
    const { baseUrl, runtime, server, tasksRoot } = await runtimeFixture();
    const { task_id: taskId } = await createTask(baseUrl, "req_p7_publish");

    // Simulate the Dataset Core publication path (the ONLY way artifacts
    // appear): manifest + publication.json under the task output.
    const primary = "gene_id,value\nTP53,1\n";
    const sha256 = createHash("sha256").update(primary).digest("hex");
    const publicationDir = path.join(
      tasksRoot,
      taskId,
      "datasets_build",
      "build_one",
      "publish",
      "version_1",
    );
    await mkdir(path.join(publicationDir, "merged"), { recursive: true });
    await writeFile(path.join(publicationDir, "merged", "primary.csv"), primary, "utf8");
    await writeFile(path.join(publicationDir, "dataset_manifest.json"), JSON.stringify({
      manifest_id: "manifest_one",
      task_id: taskId,
      build_id: "build_one",
      artifacts: [{
        artifact_id: "artifact_primary",
        role: "primary_dataset",
        relative_path: "merged/primary.csv",
        media_type: "text/csv",
        size_bytes: Buffer.byteLength(primary),
        sha256,
      }],
    }), "utf8");
    await writeFile(path.join(publicationDir, "publication.json"), JSON.stringify({
      publication_id: "publication_one",
      manifest_ref: "manifest_one",
    }), "utf8");

    const listing = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/artifacts`);
    const listed = await listing.json() as { artifacts: Array<{ artifact_id: string }> };
    expect(listed.artifacts.map((artifact) => artifact.artifact_id)).toContain("artifact_primary");

    // Trust comes from Core + Manifest + Hash (plan §24): a mutation made
    // behind the framework's back (e.g. via allowed process.exec) is detected.
    await writeFile(path.join(publicationDir, "merged", "primary.csv"), "corrupt", "utf8");
    const download = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/artifacts/artifact_primary`);
    expect(download.status).toBe(409);
    const body = await download.json() as { detail: string };
    expect(body.detail).toMatch(/integrity/i);

    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("workspace files must be registered as SourceAssets to reach the Core", async () => {
    const { baseUrl, runtime, server, workspacesRoot } = await runtimeFixture();
    const { task_id: taskId } = await createTask(baseUrl, "req_p7_sourceasset");
    const workspaceRoot = path.join(workspacesRoot, taskId);
    await mkdir(path.join(workspaceRoot, "raw"), { recursive: true });
    await writeFile(path.join(workspaceRoot, "raw", "clinical.tsv"), "a\tb", "utf8");

    // The workspace file exists, but nothing in the framework output
    // references it — the pipeline never sees it as a source.
    const listing = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/artifacts`);
    expect((await listing.json() as { artifacts: unknown[] }).artifacts).toEqual([]);
    // source_assets (framework-owned) stays empty even though the agent
    // dropped files into its own workspace.
    const sourceAssets = path.join(tasksRootOf(workspacesRoot), taskId, "source_assets");
    await expect(import("node:fs/promises").then(({ readdir }) => readdir(sourceAssets))).rejects.toMatchObject({ code: "ENOENT" });

    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

function tasksRootOf(workspacesRoot: string): string {
  return path.join(path.dirname(workspacesRoot), "output", "tasks");
}
