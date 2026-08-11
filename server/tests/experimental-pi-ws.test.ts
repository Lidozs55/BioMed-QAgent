import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";

import type {
  BioMedAgentAdapter,
  BioMedAgentEvent,
  BioMedAgentSession,
  BioMedSessionConfig,
} from "../src/agent/contracts.js";
import { createExperimentalPiRuntime } from "../src/agent/experimental-pi.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class FakeAdapter implements BioMedAgentAdapter {
  readonly sessions: BioMedAgentSession[] = [];
  readonly gates: Deferred<void>[] = [];
  private cancelledReason?: string;
  readonly cancel = vi.fn(async (reason?: string) => {
    this.cancelledReason = reason ?? "cancelled";
  });

  async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
    const gate = deferred<void>();
    this.gates.push(gate);
    const session: BioMedAgentSession = {
      piSessionId: "pi-distinct-session",
      taskId: config.taskId,
      runId: config.runId,
      run: (input: string) => this.run(input, gate),
      cancel: async (reason) => {
        await this.cancel(reason);
        gate.resolve(undefined);
      },
      dispose: async () => undefined,
    };
    this.sessions.push(session);
    return session;
  }

  private async *run(input: string, gate: Deferred<void>): AsyncIterable<BioMedAgentEvent> {
    yield { type: "turn_started" };
    yield { type: "assistant_delta", delta: `echo:${input}` };
    await gate.promise;
    if (this.cancelledReason === undefined) yield { type: "turn_completed" };
    else yield { type: "turn_cancelled", reason: this.cancelledReason };
  }
}

async function startRuntime(adapter = new FakeAdapter()) {
  const runtime = await createExperimentalPiRuntime({
    adapter,
    workspaceFactory: async () => ({
      root: process.cwd(),
      tools: [],
      dispose: async () => undefined,
    }),
  });
  const server = createServer((request, response) => runtime.handle(request, response));
  server.on("upgrade", (request, socket, head) => {
    if (!runtime.handleUpgrade(request, socket, head)) socket.destroy();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  return { adapter, runtime, port };
}

function createInbox(socket: WebSocket): { next(label: string): Promise<unknown> } {
  const queued: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];
  socket.on("message", (data) => {
    const value: unknown = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter === undefined) queued.push(value);
    else waiter(value);
  });
  return {
    async next(label: string) {
      const value = queued.shift();
      const pending = value === undefined
        ? new Promise<unknown>((resolve) => waiters.push(resolve))
        : Promise.resolve(value);
      return Promise.race([
        pending,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error(`missing ${label} frame`)), 1_000),
        ),
      ]);
    },
  };
}

describe("experimental Pi HTTP and WebSocket protocol", () => {
  test("creates a task with distinct task, run, and Pi session identities", async () => {
    const { port } = await startRuntime();
    const response = await fetch(`http://127.0.0.1:${port}/experimental/pi/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "first", fixture_profile: null }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(201);
    expect(body).toMatchObject({ status: "running" });
    expect(body.task_id).toMatch(/^task_/);
    expect(body.run_id).toMatch(/^run_/);
    expect(body.session_id).toBe("pi-distinct-session");
    expect(new Set([body.task_id, body.run_id, body.session_id]).size).toBe(3);
  });

  test("subscribes live, streams envelopes, handles ping/unsubscribe, and rejects replay", async () => {
    const { adapter, port } = await startRuntime();
    const created = (await (
      await fetch(`http://127.0.0.1:${port}/experimental/pi/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "first" }),
      })
    ).json()) as { task_id: string };
    const socket = new WebSocket(`ws://127.0.0.1:${port}/experimental/pi/ws`);
    await once(socket, "open");
    const inbox = createInbox(socket);

    socket.send(JSON.stringify({ type: "subscribe", task_id: created.task_id, after_sequence: 0 }));
    expect(await inbox.next("replay rejection")).toMatchObject({
      type: "error",
      code: "experimental_replay_unavailable",
      task_id: created.task_id,
    });
    socket.send(JSON.stringify({ type: "subscribe", task_id: created.task_id }));
    expect(await inbox.next("subscribed")).toEqual({ type: "subscribed", task_id: created.task_id });
    socket.send(JSON.stringify({ type: "ping" }));
    expect(await inbox.next("pong")).toEqual({ type: "pong" });

    adapter.gates[0]?.resolve(undefined);
    const terminal = await inbox.next("terminal");
    expect(terminal).toMatchObject({
      type: "run_completed",
      task_id: created.task_id,
      sequence: expect.any(Number),
    });

    socket.send(JSON.stringify({ type: "unsubscribe", task_id: created.task_id }));
    expect(await inbox.next("unsubscribed")).toEqual({ type: "unsubscribed", task_id: created.task_id });
    socket.close();
  });

  test("runs another sequential turn on one task and one Pi session", async () => {
    const { adapter, port } = await startRuntime();
    const first = (await (
      await fetch(`http://127.0.0.1:${port}/experimental/pi/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "first" }),
      })
    ).json()) as { task_id: string; run_id: string; session_id: string };
    adapter.gates[0]?.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const secondResponse = await fetch(
      `http://127.0.0.1:${port}/experimental/pi/tasks/${first.task_id}/runs`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "second" }),
      },
    );
    const second = (await secondResponse.json()) as {
      task_id: string;
      run_id: string;
      session_id: string;
    };

    expect(secondResponse.status).toBe(202);
    expect(second.task_id).toBe(first.task_id);
    expect(second.run_id).not.toBe(first.run_id);
    expect(second.session_id).toBe(first.session_id);
    expect(adapter.sessions).toHaveLength(1);
  });

  test("accepts cancellation before acknowledgement is observed", async () => {
    const { adapter, port } = await startRuntime();
    const created = (await (
      await fetch(`http://127.0.0.1:${port}/experimental/pi/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "cancel" }),
      })
    ).json()) as { task_id: string; run_id: string };
    const socket = new WebSocket(`ws://127.0.0.1:${port}/experimental/pi/ws`);
    await once(socket, "open");
    const inbox = createInbox(socket);
    socket.send(JSON.stringify({ type: "subscribe", task_id: created.task_id }));
    await inbox.next("subscribed");

    const response = await fetch(
      `http://127.0.0.1:${port}/experimental/pi/tasks/${created.task_id}/runs/${created.run_id}/cancel`,
      { method: "POST" },
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      task_id: created.task_id,
      run_id: created.run_id,
      status: "cancel_requested",
    });
    expect(adapter.cancel).toHaveBeenCalledOnce();
    expect(await inbox.next("cancel request")).toMatchObject({
      type: "run_cancel_requested",
      run_id: created.run_id,
    });
    expect(await inbox.next("cancel acknowledgement")).toMatchObject({
      type: "run_cancelled",
      run_id: created.run_id,
    });
    socket.close();
  });
});
