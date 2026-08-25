import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { EventEnvelope } from "@biomed/contracts";
import { packageDigest } from "../src/dataset/publish/manifest.js";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";

import type {
  BioMedAgentAdapter,
  BioMedAgentEvent,
  BioMedAgentSession,
  BioMedAgentTool,
  BioMedSessionConfig,
} from "../src/agent/contracts.js";
import type { EventPayload } from "@biomed/contracts";
import {
  createDurableAgentRuntime,
  type DurableAgentRuntimeOptions,
} from "../src/runtime/durable-agent-runtime.js";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class ControlledAdapter implements BioMedAgentAdapter {
  readonly gates: Deferred[] = [];
  readonly runs: string[] = [];
  readonly steering: string[] = [];
  readonly compactions: string[] = [];
  compactError: Error | null = null;
  private cancelled = false;

  async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
    return {
      piSessionId: `pi_${config.taskId}`,
      taskId: config.taskId,
      runId: config.runId,
      run: (input) => this.run(input),
      cancel: async () => {
        this.cancelled = true;
        this.gates.at(-1)?.resolve();
      },
      steer: async (text) => {
        this.steering.push(text);
      },
      compact: async (): Promise<{ summary: string }> => {
        if (this.compactError !== null) throw this.compactError;
        const summary = "compacted durable conversation";
        this.compactions.push(summary);
        return { summary };
      },
      dispose: async () => undefined,
    };
  }

  private async *run(input: string): AsyncIterable<BioMedAgentEvent> {
    this.runs.push(input);
    const gate = deferred();
    this.gates.push(gate);
    yield { type: "turn_started" };
    yield { type: "assistant_delta", delta: "durable response" };
    await gate.promise;
    if (this.cancelled) yield { type: "turn_cancelled", reason: "user requested" };
    else yield { type: "turn_completed" };
  }
}

class NoContentControlledAdapter extends ControlledAdapter {
  constructor() {
    super();
    this.compactError = new Error("Nothing to compact");
  }
}

function inbox(socket: WebSocket): { next(): Promise<unknown> } {
  const queued: unknown[] = [];
  const waiting: Array<(value: unknown) => void> = [];
  socket.on("message", (raw) => {
    const value: unknown = JSON.parse(raw.toString());
    const resolve = waiting.shift();
    if (resolve === undefined) queued.push(value);
    else resolve(value);
  });
  return {
    next: async () => queued.shift() ?? await new Promise<unknown>((resolve) => waiting.push(resolve)),
  };
}

async function nextEvent(
  frames: { next(): Promise<unknown> },
  type: string,
): Promise<EventEnvelope> {
  for (let index = 0; index < 16; index += 1) {
    const value = await frames.next();
    if (value !== null && typeof value === "object" && (value as { type?: string }).type === type) {
      return value as EventEnvelope;
    }
  }
  throw new Error(`missing ${type}`);
}

describe("durable formal Agent runtime", () => {
  test("replays persisted events then continues with live events on the same subscription", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-http-"));
    roots.push(root);
    const adapter = new ControlledAdapter();
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter,
      workspaceFactory: async () => ({ root, tools: [], dispose: async () => undefined }),
    });
    const server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.on("upgrade", (request, socket, head) => {
      if (!runtime.handleUpgrade(request, socket, head)) socket.destroy();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const admitted = await fetch(`http://127.0.0.1:${port}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "request-formal",
        input: "formal task",
        databases: [],
        mode: "agent",
      }),
    });
    expect(admitted.status).toBe(202);
    const accepted = await admitted.json() as { task_id: string; run_id: string };
    await new Promise((resolve) => setTimeout(resolve, 0));

    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
    await once(socket, "open");
    const frames = inbox(socket);
    socket.send(JSON.stringify({
      type: "subscribe",
      task_id: accepted.task_id,
      after_sequence: 0,
    }));

    const created = await nextEvent(frames, "task_created");
    const queued = await nextEvent(frames, "run_queued");
    const started = await nextEvent(frames, "run_started");
    const delta = await nextEvent(frames, "assistant_delta");
    expect([created, queued, started, delta].map((event) => event.sequence)).toEqual([1, 2, 3, 4]);

    adapter.gates[0]?.resolve();
    const completed = await nextEvent(frames, "run_completed");
    expect(completed.sequence).toBe(5);

    const snapshotResponse = await fetch(
      `http://127.0.0.1:${port}/api/v1/tasks/${accepted.task_id}`,
    );
    expect(snapshotResponse.status).toBe(200);
    expect(await snapshotResponse.json()).toMatchObject({
      task: { status: "completed", latest_sequence: 5 },
      runs: [{ run_id: accepted.run_id, status: "completed" }],
      messages: [
        { role: "user", content: "formal task" },
        { role: "assistant", content: "durable response" },
      ],
    });
    socket.close();
    await runtime.close();
  });

  test("lists durable tasks and returns cancellation only after the terminal event is stored", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-cancel-"));
    roots.push(root);
    const adapter = new ControlledAdapter();
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter,
      workspaceFactory: async () => ({ root, tools: [], dispose: async () => undefined }),
    });
    const server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const accepted = await (await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "request-cancel",
        input: "cancel me",
        databases: [],
        mode: "agent",
      }),
    })).json() as { task_id: string; run_id: string };
    await new Promise((resolve) => setTimeout(resolve, 0));

    const cancelled = await fetch(
      `${base}/api/v1/tasks/${accepted.task_id}/runs/${accepted.run_id}/cancel`,
      { method: "POST" },
    );
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toMatchObject({
      task: { task_id: accepted.task_id, status: "cancelled", active_run_id: null },
      runs: [{ run_id: accepted.run_id, status: "cancelled" }],
    });

    const page = await (await fetch(`${base}/api/v1/tasks?limit=10`)).json();
    expect(page).toMatchObject({
      active_items: [],
      items: [{ task_id: accepted.task_id, status: "cancelled" }],
      next_cursor: null,
    });
    await runtime.close();
  });

  test("does not execute an idempotent run admission retry twice", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-run-retry-"));
    roots.push(root);
    const adapter = new ControlledAdapter();
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter,
      workspaceFactory: async () => ({ root, tools: [], dispose: async () => undefined }),
    });
    const server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const first = await (await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "request-initial",
        input: "initial",
        databases: [],
        mode: "agent",
      }),
    })).json() as { task_id: string };
    await expect.poll(() => adapter.gates.length).toBe(1);
    adapter.gates[0]?.resolve();
    await expect.poll(async () => {
      const snapshot = await runtime.repository.getSnapshot(first.task_id);
      return snapshot?.task.status;
    }).toBe("completed");

    const body = JSON.stringify({ request_id: "request-retry", input: "next" });
    const admitted = await fetch(`${base}/api/v1/tasks/${first.task_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(admitted.status).toBe(202);
    await expect.poll(() => adapter.runs.length).toBe(2);
    const retry = await fetch(`${base}/api/v1/tasks/${first.task_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(retry.status).toBe(202);
    expect(await retry.json()).toEqual(await admitted.json());
    expect(adapter.runs).toEqual(["initial", "next"]);
    adapter.gates[1]?.resolve();
    await runtime.close();
  });

  test("compacts an idle task that has no active run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-idle-compact-"));
    roots.push(root);
    const adapter = new ControlledAdapter();
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter,
      workspaceFactory: async () => ({ root, tools: [], dispose: async () => undefined }),
    });
    const server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const accepted = await (await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "request-idle-compact",
        input: "finish then compact",
        databases: [],
        mode: "agent",
      }),
    })).json() as { task_id: string; run_id: string };
    await expect.poll(() => adapter.gates.length).toBe(1);
    adapter.gates[0]?.resolve();
    await expect.poll(async () => {
      const snapshot = await runtime.repository.getSnapshot(accepted.task_id);
      return snapshot?.task.status;
    }).toBe("completed");

    const compacted = await fetch(`${base}/api/v1/tasks/${accepted.task_id}/compact`, {
      method: "POST",
    });
    expect(compacted.status).toBe(202);
    expect(await compacted.json()).toMatchObject({
      status: "compaction_requested",
      task_id: accepted.task_id,
      run_id: accepted.run_id,
    });
    expect(adapter.compactions).toEqual(["compacted durable conversation"]);
    const events = await runtime.repository.listEvents(accepted.task_id, 0);
    expect(events.at(-1)?.payload).toMatchObject({
      type: "conversation_compacted",
      covered_through_run_id: accepted.run_id,
    });
    expect(events.at(-2)?.payload).toMatchObject({
      type: "conversation_compaction_started",
      covered_through_run_id: accepted.run_id,
    });
    await runtime.close();
  });

  test("records compaction started and no-content failed status for idle compaction", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-idle-no-content-"));
    roots.push(root);
    const adapter = new NoContentControlledAdapter();
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter,
      workspaceFactory: async () => ({ root, tools: [], dispose: async () => undefined }),
    });
    const server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const accepted = await (await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "request-idle-no-content",
        input: "finish then compact",
        databases: [],
        mode: "agent",
      }),
    })).json() as { task_id: string; run_id: string };
    await expect.poll(() => adapter.gates.length).toBe(1);
    adapter.gates[0]?.resolve();
    await expect.poll(async () => {
      const snapshot = await runtime.repository.getSnapshot(accepted.task_id);
      return snapshot?.task.status;
    }).toBe("completed");

    const response = await fetch(`${base}/api/v1/tasks/${accepted.task_id}/compact`, {
      method: "POST",
    });
    expect(response.status).toBe(409);
    const events = await runtime.repository.listEvents(accepted.task_id, 0);
    expect(events.at(-2)?.payload).toMatchObject({
      type: "conversation_compaction_started",
      covered_through_run_id: accepted.run_id,
    });
    expect(events.at(-1)?.payload).toMatchObject({
      type: "conversation_compaction_failed",
      reason: "no_content",
      covered_through_run_id: accepted.run_id,
    });
    await runtime.close();
  });

  test("refuses idle compaction without a persisted Pi session instead of creating one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-idle-no-session-"));
    roots.push(root);
    const workspaceFactory = async () => ({
      root,
      tools: [],
      dispose: async () => undefined,
    });
    const adapterA = new ControlledAdapter();
    const runtimeA = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter: adapterA,
      workspaceFactory,
    });
    const serverA = createServer((request, response) => {
      if (!runtimeA.handle(request, response)) response.writeHead(404).end();
    });
    serverA.listen(0, "127.0.0.1");
    await once(serverA, "listening");
    servers.push(serverA);
    const baseA = `http://127.0.0.1:${(serverA.address() as AddressInfo).port}`;
    const accepted = await (await fetch(`${baseA}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "request-idle-no-session",
        input: "no pi session is persisted",
        databases: [],
        mode: "agent",
      }),
    })).json() as { task_id: string; run_id: string };
    await expect.poll(() => adapterA.gates.length).toBe(1);
    adapterA.gates[0]?.resolve();
    await expect.poll(async () => (
      await runtimeA.repository.getSnapshot(accepted.task_id)
    )?.task.status).toBe("completed");
    await runtimeA.close();

    const adapterB = new ControlledAdapter();
    const runtimeB = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter: adapterB,
      workspaceFactory,
    });
    const serverB = createServer((request, response) => {
      if (!runtimeB.handle(request, response)) response.writeHead(404).end();
    });
    serverB.listen(0, "127.0.0.1");
    await once(serverB, "listening");
    servers.push(serverB);
    const baseB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}`;

    const compacted = await fetch(`${baseB}/api/v1/tasks/${accepted.task_id}/compact`, {
      method: "POST",
    });
    expect(compacted.status).toBe(409);
    expect(await compacted.json()).toEqual({ detail: "Task has no conversation to compact" });
    expect(adapterB.compactions).toEqual([]);
    await runtimeB.close();
  });

  test("maps steer and compaction to Pi, rejects unknown subagents, and deletes terminal tasks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-controls-"));
    roots.push(root);
    const adapter = new ControlledAdapter();
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter,
      workspaceFactory: async ({ taskId }) => ({
        root: path.join(root, taskId),
        tools: [],
        dispose: async () => undefined,
      }),
    });
    const server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const accepted = await (await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "request-controls",
        input: "initial request",
        databases: [],
        mode: "agent",
      }),
    })).json() as { task_id: string; run_id: string };
    await expect.poll(() => adapter.gates.length).toBe(1);

    const steered = await fetch(`${base}/api/v1/tasks/${accepted.task_id}/inject-context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "focus on TP53", expected_run_id: accepted.run_id }),
    });
    expect(steered.status).toBe(202);
    expect(await steered.json()).toMatchObject({
      status: "steered",
      task_id: accepted.task_id,
      run_id: accepted.run_id,
    });
    expect(adapter.steering[0]).toContain("focus on TP53");

    const corruptedSteer = await fetch(`${base}/api/v1/tasks/${accepted.task_id}/inject-context`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "损坏文本\uFFFD", expected_run_id: accepted.run_id }),
    });
    expect(corruptedSteer.status).toBe(422);
    expect(await corruptedSteer.json()).toMatchObject({
      detail: expect.stringContaining("corrupted UTF-8"),
    });

    const compacted = await fetch(`${base}/api/v1/tasks/${accepted.task_id}/compact`, {
      method: "POST",
    });
    expect(compacted.status).toBe(202);
    expect(adapter.compactions).toEqual(["compacted durable conversation"]);
    const events = await runtime.repository.listEvents(accepted.task_id, 0);
    expect(events.at(-1)?.payload).toMatchObject({
      type: "conversation_compacted",
      covered_through_run_id: accepted.run_id,
      summary_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    const subagent = await fetch(
      `${base}/api/v1/tasks/${accepted.task_id}/runs/${accepted.run_id}/subagents/missing/cancel`,
      { method: "POST" },
    );
    expect(subagent.status).toBe(404);

    adapter.gates[0]?.resolve();
    await expect.poll(async () => (
      await runtime.repository.getSnapshot(accepted.task_id)
    )?.task.status).toBe("completed");
    const deleted = await fetch(`${base}/api/v1/tasks/${accepted.task_id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);
    expect((await fetch(`${base}/api/v1/tasks/${accepted.task_id}`)).status).toBe(404);
    await runtime.close();
  });

  test("admits multipart imports only after placing uploaded files in source_assets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-import-"));
    roots.push(root);
    const adapter = new ControlledAdapter();
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter,
      workspaceFactory: async ({ taskId }) => ({
        root: path.join(root, taskId),
        tools: [],
        dispose: async () => undefined,
      }),
    });
    const server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const form = new FormData();
    form.set("request_id", "request-import");
    form.set("input", "Import this expression table");
    form.append("files", new File(["gene,value\nTP53,1\n"], "expression.csv", { type: "text/csv" }));

    const response = await fetch(`${base}/api/v1/import/tasks`, { method: "POST", body: form });
    expect(response.status).toBe(202);
    const accepted = await response.json() as { task_id: string };
    await expect.poll(() => adapter.runs.length).toBe(1);
    expect(adapter.runs[0]).toContain("[uploaded_files (1): expression.csv]");
    expect(await import("node:fs/promises").then(({ readFile }) => (
      readFile(path.join(root, accepted.task_id, "source_assets", "expression.csv"), "utf8")
    ))).toBe("gene,value\nTP53,1\n");
    adapter.gates[0]?.resolve();
    await runtime.close();
  });

  test("round-4 audit: run termination clears the run's temporary grants via onRunEnd", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-runend-"));
    roots.push(root);
    const adapter = new ControlledAdapter();
    const endedRuns: string[] = [];
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter,
      workspaceFactory: async () => ({
        root,
        tools: [],
        onRunEnd: (runId) => {
          endedRuns.push(runId);
        },
        dispose: async () => undefined,
      }),
    });
    const server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const port = (server.address() as AddressInfo).port;

    const admitted = await fetch(`http://127.0.0.1:${port}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "request-runend",
        input: "run end grant cleanup",
        databases: [],
        mode: "agent",
      }),
    });
    expect(admitted.status).toBe(202);
    const accepted = await admitted.json() as { task_id: string; run_id: string };
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Complete the run; the workspace must observe the end of THIS run id.
    adapter.gates[0]?.resolve();
    await expect.poll(
      () => endedRuns.includes(accepted.run_id),
      { timeout: 5_000 },
    ).toBe(true);

    // A second run in the same session triggers the hook again.
    const second = await fetch(`http://127.0.0.1:${port}/api/v1/tasks/${accepted.task_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "request-runend-2", input: "second run" }),
    });
    expect(second.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    adapter.gates[1]?.resolve();
    await expect.poll(
      () => endedRuns.length,
      { timeout: 5_000 },
    ).toBeGreaterThanOrEqual(2);

    await runtime.close();
  });

  test("serves only manifest-registered task artifacts and rejects integrity drift", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-artifact-"));
    roots.push(root);
    const adapter = new ControlledAdapter();
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter,
      workspaceFactory: async () => ({ root, tools: [], dispose: async () => undefined }),
    });
    const server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const accepted = await (await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "request-artifact",
        input: "build artifact",
        databases: [],
        mode: "agent",
      }),
    })).json() as { task_id: string };
    const buildDir = path.join(root, accepted.task_id, "datasets_build", "build_one");
    const primary = "gene_id,value\nTP53,1\n";
    const sha256 = createHash("sha256").update(primary).digest("hex");
    await mkdir(path.join(buildDir, "merged"), { recursive: true });
    await mkdir(path.join(buildDir, "publish", "version_1"), { recursive: true });
    const publicationDir = path.join(buildDir, "publish", "version_1");
    await mkdir(path.join(publicationDir, "merged"), { recursive: true });
    await writeFile(path.join(publicationDir, "merged", "primary.csv"), primary, "utf8");
    const digest = packageDigest([{
      schema_version: "1.0",
      artifact_id: "artifact_primary",
      role: "primary_dataset",
      relative_path: "merged/primary.csv",
      media_type: "text/csv",
      size_bytes: Buffer.byteLength(primary),
      sha256,
    }]);
    await writeFile(path.join(publicationDir, "dataset_manifest.json"), JSON.stringify({
      manifest_id: `manifest_${digest.slice(0, 16)}`,
      task_id: accepted.task_id,
      build_id: "build_one",
      sha256: digest,
      artifacts: [{
        artifact_id: "artifact_primary",
        role: "primary_dataset",
        relative_path: "merged/primary.csv",
        media_type: "text/csv",
        size_bytes: Buffer.byteLength(primary),
        sha256,
      }],
    }), "utf8");
    await writeFile(
      path.join(publicationDir, "publication.json"),
      JSON.stringify({
        schema_version: "1.1",
        publication_id: "publication_one",
        manifest_ref: `manifest_${digest.slice(0, 16)}`,
        manifest_sha256: createHash("sha256")
          .update(JSON.stringify(JSON.parse(await readFile(
            path.join(publicationDir, "dataset_manifest.json"),
            "utf8",
          ))))
          .digest("hex"),
        validation_result_ref: "validation_report.json",
        published_at: "2026-08-17T00:00:00+00:00",
        supersedes_publication_id: null,
      }),
      "utf8",
    );

    const listing = await fetch(`${base}/api/v1/tasks/${accepted.task_id}/artifacts`);
    expect(listing.status).toBe(200);
    expect(await listing.json()).toMatchObject({
      artifacts: [
        { artifact_id: "dataset_manifest", name: "dataset_manifest.json" },
        { artifact_id: "artifact_primary", name: "primary.csv", sha256 },
      ],
      degraded: false,
    });
    const download = await fetch(
      `${base}/api/v1/tasks/${accepted.task_id}/artifacts/artifact_primary`,
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(primary);

    await writeFile(path.join(publicationDir, "merged", "primary.csv"), "corrupt", "utf8");
    expect((await fetch(
      `${base}/api/v1/tasks/${accepted.task_id}/artifacts/artifact_primary`,
    )).status).toBe(409);
    await runtime.close();
  });

  test("rejects non-durable task subscriptions (legacy tasks are gone)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-ws-legacy-gone-"));
    roots.push(root);

    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter: new ControlledAdapter(),
      workspaceFactory: async () => ({ root, tools: [], dispose: async () => undefined }),
    });
    const server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.on("upgrade", (request, socket, head) => {
      if (!runtime.handleUpgrade(request, socket, head)) socket.destroy();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);

    const socket = new WebSocket(
      `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/ws`,
    );
    await once(socket, "open");
    const frames = inbox(socket);
    socket.send(JSON.stringify({
      type: "subscribe",
      task_id: "task_legacy",
      after_sequence: 7,
    }));

    expect(await nextEvent(frames, "error")).toMatchObject({
      type: "error",
      code: "task_not_found",
      task_id: "task_legacy",
    });
    socket.close();
    await runtime.close();
  });

  test("resumes an interrupted download directly without an AI run or a new run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-resume-dl-"));
    roots.push(root);
    const adapter = new ControlledAdapter();
    const callArgs: unknown[] = [];
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter,
      workspaceFactory: async ({ recordRunEvent }) => {
        const downloadTool: BioMedAgentTool = {
          name: "download_xena",
          label: "Download Xena dataset",
          description: "download a xena dataset",
          parameters: { type: "object" },
          execute: async (argumentsValue, signal) => {
            callArgs.push(argumentsValue);
            const progress: EventPayload = {
              type: "operation_progress",
              operation_id: "tool:acquisition:downloaded_bytes",
              kind: "downloaded_bytes",
              current: 50,
              total: 100,
              detail: { source: "xena", accession: "TCGA.PAAD", filename: "x.gz" },
            };
            await recordRunEvent(progress);
            if (signal?.aborted) throw new Error("aborted");
            return { content: JSON.stringify({ downloaded: true }), isError: false };
          },
        };
        return {
          root: path.join(root, "task"),
          tools: [downloadTool],
          setRunId: () => undefined,
          dispose: async () => undefined,
        };
      },
    });
    const server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const accepted = await (await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "request-resume-boot",
        input: "boot the task",
        databases: [],
        mode: "agent",
      }),
    })).json() as { task_id: string; run_id: string };
    adapter.gates[0]?.resolve();
    await expect.poll(async () => (
      await runtime.repository.getSnapshot(accepted.task_id)
    )?.task.status).toBe("completed");
    const beforeCount = (await runtime.repository.listEvents(accepted.task_id, 0)).length;

    // The resume request names the original (host) run and its tool call:
    // no new run is created, progress/completion replay onto the host run.
    const resumed = await fetch(
      `${base}/api/v1/tasks/${accepted.task_id}/downloads/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          run_id: accepted.run_id,
          tool_call_id: "call_download_xena",
          tool_name: "download_xena",
          arguments: { dataset_id: "TCGA.PAAD.sampleMap/HiSeqV2", file_type: "tsv" },
        }),
      },
    );
    expect(resumed.status).toBe(202);
    const acceptedResume = await resumed.json() as {
      task_id: string;
      run_id: string;
    };
    expect(acceptedResume.run_id).toBe(accepted.run_id);

    await expect.poll(async () => {
      const events = await runtime.repository.listEvents(accepted.task_id, 0);
      return events
        .filter((event) => event.run_id === accepted.run_id && event.type === "tool_completed")
        .length;
    }).toBe(1);
    expect(callArgs).toEqual([
      { dataset_id: "TCGA.PAAD.sampleMap/HiSeqV2", file_type: "tsv" },
    ]);

    const events = await runtime.repository.listEvents(accepted.task_id, 0);
    const resumeEvents = events.slice(beforeCount);
    expect(resumeEvents.map((event) => event.type)).toEqual([
      "tool_started",
      "operation_progress",
      "tool_completed",
    ]);
    expect(resumeEvents.map((event) => event.run_id)).toEqual([
      accepted.run_id,
      accepted.run_id,
      accepted.run_id,
    ]);
    expect(resumeEvents[0]?.payload).toMatchObject({
      type: "tool_started",
      tool_call_id: "call_download_xena",
      tool_name: "download_xena",
      arguments: { dataset_id: "TCGA.PAAD.sampleMap/HiSeqV2", file_type: "tsv" },
    });
    const snapshot = await runtime.repository.getSnapshot(accepted.task_id);
    expect(snapshot?.task.active_run_id).toBeNull();
    // No follow-up run was created: the run list is unchanged.
    expect(snapshot?.runs.map((run) => run.run_id)).toEqual([accepted.run_id]);
    await runtime.close();
  });

  test("cancels an in-flight download via the dedicated downloads/cancel endpoint", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-cancel-dl-"));
    roots.push(root);
    const adapter = new ControlledAdapter();
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter,
      workspaceFactory: async () => {
        const downloadTool: BioMedAgentTool = {
          name: "download_gdc",
          label: "Download GDC files",
          description: "download a gdc file",
          parameters: { type: "object" },
          execute: async (_argumentsValue, signal) => {
            await new Promise<void>((resolve) => {
              signal?.addEventListener("abort", () => resolve());
            });
            if (signal?.aborted) throw new Error("aborted by user");
            return { content: "{}", isError: false };
          },
        };
        return {
          root: path.join(root, "task"),
          tools: [downloadTool],
          setRunId: () => undefined,
          dispose: async () => undefined,
        };
      },
    });
    const server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const accepted = await (await fetch(`${base}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "request-cancel-dl-boot",
        input: "boot",
        databases: [],
        mode: "agent",
      }),
    })).json() as { task_id: string; run_id: string };
    adapter.gates[0]?.resolve();
    await expect.poll(async () => (
      await runtime.repository.getSnapshot(accepted.task_id)
    )?.task.status).toBe("completed");
    const beforeCount = (await runtime.repository.listEvents(accepted.task_id, 0)).length;

    const resumed = await fetch(
      `${base}/api/v1/tasks/${accepted.task_id}/downloads/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          run_id: accepted.run_id,
          tool_call_id: "call_download_gdc",
          tool_name: "download_gdc",
          arguments: { project_id: "TCGA-PAAD" },
        }),
      },
    );
    expect(resumed.status).toBe(202);
    // The download tool hangs until aborted; cancel via the task-level endpoint.
    const cancelled = await fetch(
      `${base}/api/v1/tasks/${accepted.task_id}/downloads/cancel`,
      { method: "POST" },
    );
    expect(cancelled.status).toBe(202);
    const cancelBody = await cancelled.json() as { status: string };
    expect(cancelBody.status).toBe("cancel_requested");

    const events = await runtime.repository.listEvents(accepted.task_id, 0);
    const resumeEvents = events.slice(beforeCount);
    // Only the synthesized tool_started was recorded; an aborted resume emits
    // no terminal event (the host run is already terminal, the frontend stall
    // detection flips the bubble back to "恢复下载").
    expect(resumeEvents.map((event) => event.type)).toEqual(["tool_started"]);
    await runtime.close();
  });

  test("resumes a download after a server restart by reconstructing a lightweight workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-resume-restart-"));
    roots.push(root);
    const factoryCalls: string[] = [];
    const executed: unknown[] = [];
    const workspaceFactory: DurableAgentRuntimeOptions["workspaceFactory"] = async ({ taskId, runId }) => {
      factoryCalls.push(`${taskId}:${runId}`);
      return {
        root: path.join(root, taskId),
        tools: [{
          name: "download_xena",
          label: "Download Xena dataset",
          description: "download a xena dataset",
          parameters: { type: "object" },
          execute: async (argumentsValue) => {
            executed.push(argumentsValue);
            return { content: JSON.stringify({ downloaded: true }), isError: false };
          },
        }],
        setRunId: () => undefined,
        dispose: async () => undefined,
      };
    };

    // First runtime creates the task and completes its AI run (session live).
    const adapterA = new ControlledAdapter();
    const runtimeA = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter: adapterA,
      workspaceFactory,
    });
    const serverA = createServer((request, response) => {
      if (!runtimeA.handle(request, response)) response.writeHead(404).end();
    });
    serverA.listen(0, "127.0.0.1");
    await once(serverA, "listening");
    servers.push(serverA);
    const baseA = `http://127.0.0.1:${(serverA.address() as AddressInfo).port}`;
    const accepted = await (await fetch(`${baseA}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "request-restart-boot",
        input: "boot",
        databases: [],
        mode: "agent",
      }),
    })).json() as { task_id: string; run_id: string };
    adapterA.gates[0]?.resolve();
    await expect.poll(async () => (
      await runtimeA.repository.getSnapshot(accepted.task_id)
    )?.task.status).toBe("completed");
    await runtimeA.close();
    expect(factoryCalls.length).toBe(1); // the boot session only

    // Second runtime stands in for the server restart: no task session is
    // reconstructed (recoverActiveRuns never rebuilds the in-memory workspace),
    // so resumeDownload must rebuild a lightweight workspace from
    // workspaceFactory to run the download tool directly.
    const runtimeB = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter: new ControlledAdapter(),
      workspaceFactory,
    });
    const serverB = createServer((request, response) => {
      if (!runtimeB.handle(request, response)) response.writeHead(404).end();
    });
    serverB.listen(0, "127.0.0.1");
    await once(serverB, "listening");
    servers.push(serverB);
    const baseB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}`;
    const beforeCount = (await runtimeB.repository.listEvents(accepted.task_id, 0)).length;

    const resumed = await fetch(
      `${baseB}/api/v1/tasks/${accepted.task_id}/downloads/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          run_id: accepted.run_id,
          tool_call_id: "call_download_xena",
          tool_name: "download_xena",
          arguments: { dataset_id: "TCGA.PAAD.sampleMap/HiSeqV2" },
        }),
      },
    );
    expect(resumed.status).toBe(202);
    const acceptedResume = await resumed.json() as { run_id: string };
    expect(acceptedResume.run_id).toBe(accepted.run_id);

    await expect.poll(async () => {
      const events = await runtimeB.repository.listEvents(accepted.task_id, 0);
      return events
        .filter((event) => event.run_id === accepted.run_id && event.type === "tool_completed")
        .length;
    }).toBe(1);
    // The download tool ran against the reconstructed workspace.
    expect(executed).toEqual([{ dataset_id: "TCGA.PAAD.sampleMap/HiSeqV2" }]);
    // The lightweight workspace was added at resume time (boot + one rebuild).
    expect(factoryCalls.length).toBe(2);
    expect(factoryCalls[1]).toBe(`${accepted.task_id}:${accepted.run_id}`);

    const events = await runtimeB.repository.listEvents(accepted.task_id, 0);
    const resumeEvents = events.slice(beforeCount);
    expect(resumeEvents.map((event) => event.type)).toEqual([
      "tool_started",
      "tool_completed",
    ]);
    await runtimeB.close();
  });

  test("cancels a download resumed after a server restart (activeDownloads tracks it without a session)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-resume-restart-cancel-"));
    roots.push(root);
    const workspaceFactory: DurableAgentRuntimeOptions["workspaceFactory"] = async ({ taskId }) => ({
      root: path.join(root, taskId),
      tools: [{
        name: "download_xena",
        label: "Download Xena dataset",
        description: "download a xena dataset",
        parameters: { type: "object" },
        execute: async (_argumentsValue, signal) => {
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve());
          });
          if (signal?.aborted) throw new Error("aborted by user");
          return { content: "{}", isError: false };
        },
      }],
      setRunId: () => undefined,
      dispose: async () => undefined,
    });

    // First runtime creates the task and completes its AI run.
    const adapterA = new ControlledAdapter();
    const runtimeA = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter: adapterA,
      workspaceFactory,
    });
    const serverA = createServer((request, response) => {
      if (!runtimeA.handle(request, response)) response.writeHead(404).end();
    });
    serverA.listen(0, "127.0.0.1");
    await once(serverA, "listening");
    servers.push(serverA);
    const baseA = `http://127.0.0.1:${(serverA.address() as AddressInfo).port}`;
    const accepted = await (await fetch(`${baseA}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "request-restart-cancel-boot",
        input: "boot",
        databases: [],
        mode: "agent",
      }),
    })).json() as { task_id: string; run_id: string };
    adapterA.gates[0]?.resolve();
    await expect.poll(async () => (
      await runtimeA.repository.getSnapshot(accepted.task_id)
    )?.task.status).toBe("completed");
    await runtimeA.close();

    // Second runtime stands in for the server restart: no session is
    // reconstructed, so the resumed download is tracked solely by the
    // activeDownloads map and must still be cancellable.
    const runtimeB = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter: new ControlledAdapter(),
      workspaceFactory,
    });
    const serverB = createServer((request, response) => {
      if (!runtimeB.handle(request, response)) response.writeHead(404).end();
    });
    serverB.listen(0, "127.0.0.1");
    await once(serverB, "listening");
    servers.push(serverB);
    const baseB = `http://127.0.0.1:${(serverB.address() as AddressInfo).port}`;

    const resumed = await fetch(
      `${baseB}/api/v1/tasks/${accepted.task_id}/downloads/resume`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          run_id: accepted.run_id,
          tool_call_id: "call_download_xena",
          tool_name: "download_xena",
          arguments: { dataset_id: "TCGA.PAAD.sampleMap/HiSeqV2" },
        }),
      },
    );
    expect(resumed.status).toBe(202);

    // Before the fix this returned 409 "No download is in progress": the
    // download handle was only registered on the (absent) active task entry.
    const cancelled = await fetch(
      `${baseB}/api/v1/tasks/${accepted.task_id}/downloads/cancel`,
      { method: "POST" },
    );
    expect(cancelled.status).toBe(202);
    expect(await cancelled.json()).toMatchObject({ status: "cancel_requested" });

    const events = await runtimeB.repository.listEvents(accepted.task_id, 0);
    const resumeEvents = events.filter((event) => event.type === "tool_started" || event.type === "tool_completed");
    // Only the synthesized tool_started was recorded; an aborted resume emits
    // no terminal event.
    expect(resumeEvents.map((event) => event.type)).toEqual(["tool_started"]);
    await runtimeB.close();
  });
});
