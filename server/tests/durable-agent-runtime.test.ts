import { once } from "node:events";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readdir, rm, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { EventEnvelope } from "@biomed/contracts";
import { packageDigest } from "../src/dataset/publish/manifest.js";
import { canonicalDigest } from "../src/dataset/adapters/identity.js";
import { computeHILEvidenceDigest } from "../src/dataset/contracts/hil-evidence.js";
import {
  completePublicationAcceptanceContinuation,
} from "../src/dataset/dynamic-family/publication.js";
import {
  readPublicationAcceptanceContinuation,
  savePublicationAcceptanceContinuation,
  type PublicationAcceptanceContinuationV1,
} from "../src/runtime/execution-continuation.js";
import { DurableHILStore } from "../src/runtime/hil-store.js";
import { DurableTaskRepository } from "../src/runtime/task-repository.js";
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
  readonly configs: BioMedSessionConfig[] = [];
  readonly steering: string[] = [];
  readonly compactions: string[] = [];
  progressResets = 0;
  compactError: Error | null = null;
  private cancelled = false;

  async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
    this.configs.push(config);
    return {
      piSessionId: `pi_${config.taskId}`,
      taskId: config.taskId,
      runId: config.runId,
      run: (input) => this.run(input),
      resetRunProgress: () => {
        this.progressResets += 1;
      },
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
    expect(adapter.configs[0]?.initialToolNames).toEqual([
      "inspect_dataset_execution_routes",
      "validate_dataset_execution",
      "execute_dataset_execution",
      "prepare_dynamic_family_publication",
      "submit_dynamic_family_publication",
    ]);
    expect(adapter.progressResets).toBe(1);

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
    expect(completed.payload).toEqual({ type: "run_completed" });

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

  test("serves cursor-paginated task history pages instead of falling through", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-cursor-"));
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

    const completed: string[] = [];
    for (const requestId of ["request-cursor-a", "request-cursor-b"]) {
      const accepted = await (await fetch(`${base}/api/v1/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          request_id: requestId,
          input: `cursor ${requestId}`,
          databases: [],
          mode: "agent",
        }),
      })).json() as { task_id: string; run_id: string };
      await fetch(`${base}/api/v1/tasks/${accepted.task_id}/runs/${accepted.run_id}/cancel`, {
        method: "POST",
      });
      completed.push(accepted.task_id);
    }
    // The cancel endpoint acknowledges before the terminal events land; poll
    // the real list endpoint until both tasks left the active set.
    await expect
      .poll(async () => {
        const page = (await (await fetch(`${base}/api/v1/tasks`)).json()) as {
          active_items: unknown[];
        };
        return page.active_items.length;
      }, { timeout: 15_000 })
      .toBe(0);

    const page1 = (await (await fetch(`${base}/api/v1/tasks?limit=1`)).json()) as {
      active_items: unknown[];
      items: { task_id: string }[];
      next_cursor: string | null;
    };
    expect(page1).toMatchObject({ active_items: [], next_cursor: completed[1] });
    expect(page1.items).toHaveLength(1);

    const cursor = page1.next_cursor as string;
    const page2Response = await fetch(`${base}/api/v1/tasks?limit=1&cursor=${cursor}`);
    expect(page2Response.status).toBe(200);
    const page2 = await page2Response.json();
    expect(page2).toMatchObject({
      active_items: [],
      items: [{ task_id: completed[0] }],
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

  test("rejects a run entry with an exhausted context budget before the first Pi turn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-budget-"));
    roots.push(root);
    const budget = { contextWindow: 100_000, maxTokens: 120_000, reserveTokens: 5_000 };
    class ExhaustedBudgetAdapter extends ControlledAdapter {
      override async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
        const session = await super.createSession(config);
        return { ...session, getBudget: () => budget };
      }
    }
    const adapter = new ExhaustedBudgetAdapter();
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
        request_id: "request-budget",
        input: "formal task",
        databases: [],
        mode: "agent",
      }),
    })).json() as { task_id: string };
    await expect.poll(async () => {
      const snapshot = await runtime.repository.getSnapshot(accepted.task_id);
      return snapshot?.runs.at(-1);
    }).toMatchObject({ status: "failed", summary: { error_code: "context_budget_exhausted" } });
    expect(adapter.runs).toEqual([]);

    budget.maxTokens = 8_192;
    const admitted = await fetch(`${base}/api/v1/tasks/${accepted.task_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "request-budget-ok", input: "next" }),
    });
    expect(admitted.status).toBe(202);
    await expect.poll(() => adapter.runs.length).toBe(1);
    adapter.gates[0]?.resolve();
    await runtime.close();
  });

  test("forces a durable cancelled terminal when the session never acknowledges cancellation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-durable-force-cancel-"));
    roots.push(root);
    let releaseCancel: () => void = () => undefined;
    const cancelGate = new Promise<void>((done) => {
      releaseCancel = done;
    });
    class UnacknowledgedCancelAdapter extends ControlledAdapter {
      override async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
        const session = await super.createSession(config);
        return { ...session, cancel: () => cancelGate };
      }
    }
    const adapter = new UnacknowledgedCancelAdapter();
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter,
      cancellationTimeoutMs: 50,
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
        request_id: "request-force-cancel",
        input: "formal task",
        databases: [],
        mode: "agent",
      }),
    })).json() as { task_id: string; run_id: string };
    await expect.poll(() => adapter.gates.length).toBe(1);

    const cancelResponse = await fetch(
      `${base}/api/v1/tasks/${accepted.task_id}/runs/${accepted.run_id}/cancel`,
      { method: "POST" },
    );
    expect(cancelResponse.status).toBe(202);
    await expect.poll(async () => {
      const snapshot = await runtime.repository.getSnapshot(accepted.task_id);
      return snapshot?.runs.at(-1);
    }).toMatchObject({ status: "cancelled" });

    const followUp = await fetch(`${base}/api/v1/tasks/${accepted.task_id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ request_id: "request-after-force-cancel", input: "next" }),
    });
    expect(followUp.status).toBe(202);
    await expect.poll(() => adapter.runs.length).toBe(2);
    // Wake the zombie execution and the follow-up turn so close() can settle.
    for (const gate of adapter.gates) gate.resolve();
    releaseCancel();
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
    const steerResponse = await steered.json() as Record<string, unknown>;
    expect(steerResponse).toMatchObject({
      status: "steered",
      task_id: accepted.task_id,
      run_id: accepted.run_id,
      message_id: expect.stringMatching(/^message_event_/),
      content: "focus on TP53",
    });
    expect(adapter.steering[0]).toContain("focus on TP53");

    const steerEvents = await runtime.repository.listEvents(accepted.task_id, 0);
    const steerEvent = steerEvents.find((event) => event.type === "run_steered");
    expect(steerEvent).toMatchObject({
      schema_version: "2.0",
      run_id: accepted.run_id,
      payload: { type: "run_steered", input: "focus on TP53" },
    });
    expect(steerResponse.message_id).toBe(`message_${steerEvent?.event_id}`);

    const steeredSnapshot = await runtime.repository.getSnapshot(accepted.task_id);
    const steeredMessage = steeredSnapshot?.messages.find(
      (message) => message.message_id === steerResponse.message_id,
    );
    expect(steeredMessage).toMatchObject({
      message_id: steerResponse.message_id,
      run_id: accepted.run_id,
      role: "user",
      content: "focus on TP53",
      sequence: steerEvent?.sequence,
    });

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
    })).json() as { task_id: string; run_id: string };
    const executionDir = path.join(root, accepted.task_id, "dataset_runs", accepted.run_id, "build_one");
    const primary = "gene_id,value\nTP53,1\n";
    const sha256 = createHash("sha256").update(primary).digest("hex");
    const publicationDir = path.join(executionDir, "publish", "publication_one");
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
      requirement_id: "build_one",
      dataset_family: "gene_expression",
      row_granularity: "gene",
      schema_ref: "gene.v1",
      row_count: 1,
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

describe("publication acceptance restart continuation (Gold6 T6)", () => {
  const REQUIREMENT_ID = "build_pub_resume";
  const PRIMARY_CSV = "record_id,value\nr1,1\nr2,2\n";
  const REGISTERED_ASSET_ID = `asset_${"a".repeat(64)}`;

  function sha256(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
  }

  function candidateFixture(taskId: string) {
    const primarySha = sha256(PRIMARY_CSV);
    return {
      schema_version: "1.0",
      candidate_id: "candidate_pub_resume",
      task_id: taskId,
      requirement_id: REQUIREMENT_ID,
      dataset_family: "gene_expression",
      row_granularity: "gene_sample_measurement",
      tables: [{
        definition: {
          table_id: "primary",
          schema_ref: "gene_expression.long.v1",
          role: "primary",
          required: true,
          allow_empty: false,
          primary_key: ["record_id"],
          field_names: ["record_id", "value"],
        },
        data_ref: {
          result_manifest_id: "result_pub_resume",
          output_kind: "integrated_table",
          output_file_index: 0,
          output_file_sha256: primarySha,
        },
        row_count: 2,
      }],
      relations: [],
      provenance_refs: [{
        result_manifest_id: "result_pub_resume",
        output_kind: "integrated_table",
        output_file_index: 0,
        output_file_sha256: primarySha,
      }],
      confidence_refs: [{
        result_manifest_id: "result_pub_resume",
        output_kind: "integrated_table",
        output_file_index: 0,
        output_file_sha256: primarySha,
      }],
      audit_refs: [],
      registered_asset_ids: [REGISTERED_ASSET_ID],
    } as const;
  }

  interface StagedPublication {
    taskId: string;
    runId: string;
    requestId: string;
    evidenceDigest: string;
    continuation: PublicationAcceptanceContinuationV1;
  }

  /** Stage what publishDynamicFamily leaves on disk while the review pends. */
  async function stagePendingPublication(root: string): Promise<StagedPublication> {
    const repository = new DurableTaskRepository(root);
    const accepted = await repository.createTask({
      requestId: `request_pub_resume_${root.length}`,
      input: "publish the dynamic family",
      databases: [],
      mode: "agent",
    });
    const taskId = accepted.task_id;
    const runId = accepted.run_id;
    await repository.appendRunEvent(taskId, runId, { type: "run_started" });

    const outputDir = path.join(root, taskId, "dataset_runs", runId, REQUIREMENT_ID);
    await mkdir(path.join(outputDir, "tables"), { recursive: true });
    await writeFile(path.join(outputDir, "tables", "primary.csv"), PRIMARY_CSV, "utf8");
    await writeFile(path.join(outputDir, "schema.json"), `${JSON.stringify({
      schema_version: "1.0",
      schema_id: "gene_expression.long.v1",
    })}\n`, "utf8");
    const assessment = {
      schema_version: "1.0",
      requirement_id: "dynamic_family_structural_b3.v1",
      package_id: "candidate_pub_resume",
      package_version: "1.0",
      product_status: "incomplete",
      scores: [],
      missing_requirements: ["dynamic_family_hil_acceptance.v1"],
      blockers: [{
        requirement_id: "dynamic_family_hil_acceptance.v1",
        dimension: "confidence",
        code: "human_review_pending",
        message: "review-status fields require genuine HIL acceptance evidence before publication",
      }],
    };
    const assessmentText = JSON.stringify(assessment);
    await writeFile(path.join(outputDir, "product_assessment.json"), assessmentText, "utf8");

    const candidate = candidateFixture(taskId);
    const primarySha = sha256(PRIMARY_CSV);
    const reviewItems = [{
      item_id: candidate.candidate_id,
      summary: "Review the evidence-bound dynamic publication candidate",
      subject: {
        candidate_ids: [candidate.candidate_id],
        table_ids: ["primary"],
      },
      evidence: { reviewed_snapshot: { candidate: candidate.candidate_id } },
      proposed_value: { action: "publish" },
      confidence_level: null,
    }];
    const requestInput = {
      task_id: taskId,
      run_id: runId,
      requirement_id: REQUIREMENT_ID,
      kind: "data_review" as const,
      review_type: "publication_acceptance" as const,
      blocking: true,
      subject: { candidate_ids: [candidate.candidate_id], table_ids: ["primary"] },
      review_items: reviewItems,
      summary: "Accept the evidence-bound dynamic publication candidate",
      evidence: { reviewed_snapshot: { candidate: candidate.candidate_id } },
      policy_ref: "dynamic_family_hil_acceptance.v1",
      idempotency_key: `dynamic-family-publication:${REQUIREMENT_ID}:candidate_pub_resume:${sha256(assessmentText)}`,
    };
    const store = new DurableHILStore(repository);
    const request = await store.createRequest(requestInput);
    await repository.appendRunEvent(taskId, runId, {
      type: "user_input_required",
      request_id: request.request_id,
      prompt_kind: "data_correction",
      summary: requestInput.summary,
      expires_at: null,
      fixture_exempt: false,
      detail: {},
      hil_request: request,
    });

    const b3Checks = [
      { check_id: "fixture_check", scope: "fixture", passed: true, detail: "ok" },
    ];
    const continuation: PublicationAcceptanceContinuationV1 = {
      schema_version: 1,
      continuation_kind: "publication_acceptance",
      task_id: taskId,
      run_id: runId,
      requirement_id: REQUIREMENT_ID,
      candidate_digest: canonicalDigest(candidate),
      candidate: candidate,
      registered_input_asset_ids: [REGISTERED_ASSET_ID],
      assessment_digest: sha256(assessmentText),
      assessment_size_bytes: Buffer.byteLength(assessmentText, "utf8"),
      expected_evidence_digest: computeHILEvidenceDigest({
        kind: requestInput.kind,
        review_type: requestInput.review_type,
        subject: requestInput.subject,
        review_items: reviewItems,
        summary: requestInput.summary,
        evidence: requestInput.evidence,
        policy_ref: requestInput.policy_ref,
      }),
      requested_review_id: request.request_id,
      submission_receipt_digest: sha256("submission-receipt"),
      reviewed_snapshot: { candidate: candidate.candidate_id },
      validation_profile_ref: "gene_expression.release.v1",
      b3_checked_count: b3Checks.length,
      b3_checks_sha256: canonicalDigest(b3Checks),
      b3_checks: b3Checks,
      provenance_base: {
        schema_version: "1.0",
        task_id: taskId,
        requirement_id: REQUIREMENT_ID,
        registered_asset_ids: [REGISTERED_ASSET_ID],
        execution_kind: "transform",
        operation_result_manifest_ids: ["result_pub_resume"],
        sources: [{ asset_id: REGISTERED_ASSET_ID }],
        source_receipts: [],
        core_acquisition_provenance: [],
      },
      tables: [{
        table_id: "primary",
        schema_ref: "gene_expression.long.v1",
        role: "primary",
        relative_path: "tables/primary.csv",
        row_count: 2,
        sha256: primarySha,
        size_bytes: Buffer.byteLength(PRIMARY_CSV, "utf8"),
      }],
      published_publication_id: null,
      created_at: "2026-08-30T00:00:00.000Z",
    };
    await savePublicationAcceptanceContinuation(path.join(root, taskId), continuation);
    return {
      taskId,
      runId,
      requestId: request.request_id,
      evidenceDigest: request.evidence_digest,
      continuation,
    };
  }

  test("publishes exactly once after a restart with a resolved acceptance review", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "durable-pub-continuation-"));
    roots.push(root);
    const staged = await stagePendingPublication(root);

    // Host restart: the pending publication acceptance must survive the
    // restart (no fail-closed run_failed) while it waits for the user.
    const runtime = await createDurableAgentRuntime({
      tasksRoot: root,
      adapter: { async createSession(): Promise<never> { throw new Error("unused"); } },
      workspaceFactory: async () => ({
        root: path.join(root, "workspace"),
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

    const eventsBefore = await runtime.repository.listEvents(staged.taskId, 0);
    expect(eventsBefore.some(
      (event) =>
        event.type === "run_failed" &&
        event.payload.type === "run_failed" &&
        event.payload.error.includes("Dynamic publication HIL cannot continue"),
    )).toBe(false);
    expect((await runtime.repository.getSnapshot(staged.taskId))?.runs[0]?.status).toBe(
      "awaiting_user_input",
    );

    // The user resolves the SAME pending review after the restart.
    const resumed = await fetch(`${base}/api/v1/tasks/${staged.taskId}/runs/${staged.runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: staged.requestId,
        evidence_digest: staged.evidenceDigest,
        decision: { action: "accept" },
        reason: null,
      }),
    });
    expect(resumed.status).toBe(200);

    await expect.poll(async () =>
      (await runtime.repository.getSnapshot(staged.taskId))?.runs[0]?.status,
    ).toBe("completed");

    // Exactly ONE immutable publication, bound to the ORIGINAL candidate.
    const publishDir = path.join(
      root, staged.taskId, "dataset_runs", staged.runId, REQUIREMENT_ID, "publish",
    );
    const versions = (await readdir(publishDir)).filter((name) => !name.startsWith("."));
    expect(versions).toHaveLength(1);
    const versionDir = path.join(publishDir, versions[0] ?? "");
    const publication = JSON.parse(
      await readFile(path.join(versionDir, "publication.json"), "utf8"),
    ) as { publication_id: string; manifest_sha256: string };
    const manifest = JSON.parse(
      await readFile(path.join(versionDir, "dataset_manifest.json"), "utf8"),
    ) as {
      sha256: string;
      candidate_refs: Array<{
        provenance_refs: string[];
      }>;
      artifacts: Array<{ role: string; sha256: string; relative_path: string }>;
    };
    expect(versions[0]).toBe(`${REQUIREMENT_ID}_${manifest.sha256.slice(0, 16)}`);
    expect(publication.manifest_sha256).toBeTypeOf("string");
    // The original candidate digest survives the restart: the promoted primary
    // table is byte-identical and matches the candidate's bound digest.
    const promotedPrimary = await readFile(path.join(versionDir, "tables", "primary.csv"), "utf8");
    expect(promotedPrimary).toBe(PRIMARY_CSV);
    expect(manifest.artifacts.find((artifact) => artifact.role === "primary_dataset")?.sha256).toBe(
      sha256(PRIMARY_CSV),
    );
    expect(manifest.candidate_refs[0]?.provenance_refs[0]).toBe(
      `result_pub_resume:integrated_table:0:${sha256(PRIMARY_CSV)}`,
    );
    // Review provenance is recorded and the run completed exactly once.
    const events = await runtime.repository.listEvents(staged.taskId, 0);
    expect(events.some((event) => event.type === "publication_created")).toBe(true);
    expect(events.filter((event) => event.type === "user_input_resumed")).toHaveLength(1);
    expect(events.some(
      (event) => event.type === "run_failed" &&
        event.payload.type === "run_failed" &&
        event.payload.error.includes("Dynamic publication HIL cannot continue"),
    )).toBe(false);

    // The consumed continuation records the publication (resume-once fence).
    const consumed = await readPublicationAcceptanceContinuation(
      path.join(root, staged.taskId),
      REQUIREMENT_ID,
    );
    expect(consumed?.published_publication_id).toBe(publication.publication_id);

    // A second resolution attempt must not publish again.
    const replay = await fetch(`${base}/api/v1/tasks/${staged.taskId}/runs/${staged.runId}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: staged.requestId,
        evidence_digest: staged.evidenceDigest,
        decision: { action: "reject" },
        reason: null,
      }),
    });
    expect([200, 409]).toContain(replay.status);
    expect((await readdir(publishDir)).filter((name) => !name.startsWith("."))).toHaveLength(1);
    await runtime.close();
  });

  test("rejects the publication continuation on staged drift or a different run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "durable-pub-continuation-drift-"));
    roots.push(root);
    const staged = await stagePendingPublication(root);
    const taskRoot = path.join(root, staged.taskId);
    const outputDir = path.join(taskRoot, "dataset_runs", staged.runId, REQUIREMENT_ID);
    const store = new DurableHILStore(new DurableTaskRepository(root));
    const review = await store.resolveRequest(staged.taskId, staged.runId, {
      request_id: staged.requestId,
      evidence_digest: staged.evidenceDigest,
      decision: { action: "accept" },
      reason: null,
    });

    // Digest drift: the staged provisional assessment was edited after the
    // candidate was persisted.
    await writeFile(
      path.join(outputDir, "product_assessment.json"),
      JSON.stringify({ tampered: true }),
      "utf8",
    );
    await expect(completePublicationAcceptanceContinuation({
      continuation: staged.continuation,
      taskRoot,
      runId: staged.runId,
      review,
    })).rejects.toThrow(/drift/i);

    // A different run must not drive this continuation.
    const fresh = await stagePendingPublication(root);
    const freshReview = await store.resolveRequest(fresh.taskId, fresh.runId, {
      request_id: fresh.requestId,
      evidence_digest: fresh.evidenceDigest,
      decision: { action: "accept" },
      reason: null,
    });
    await expect(completePublicationAcceptanceContinuation({
      continuation: fresh.continuation,
      taskRoot: path.join(root, fresh.taskId),
      runId: "run_other",
      review: freshReview,
    })).rejects.toThrow(/run/i);
  });
});
