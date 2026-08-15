import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";
import type { BioMedAgentAdapter } from "../src/agent/contracts.js";
import { createDurableAgentRuntime } from "../src/runtime/durable-agent-runtime.js";
import type { EventEnvelope } from "@biomed/contracts";

const servers: Server[] = [];
const sockets: WebSocket[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

const adapter: BioMedAgentAdapter = {
  async createSession(config) {
    return {
      piSessionId: `pi_${config.taskId}`,
      taskId: config.taskId,
      runId: config.runId,
      run: async function* () { yield { type: "turn_completed" }; },
      cancel: async () => undefined,
      steer: async () => undefined,
      compact: async () => ({ summary: "compacted" }),
      dispose: async () => undefined,
    };
  },
};

async function start() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biomed-ws-edge-"));
  roots.push(root);
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
  return { port: (server.address() as AddressInfo).port, runtime };
}

function inbox(socket: WebSocket) {
  const queued: unknown[] = [];
  const waiting: Array<(value: unknown) => void> = [];
  socket.on("message", (raw) => {
    const value: unknown = JSON.parse(raw.toString());
    const resolve = waiting.shift();
    if (resolve) resolve(value); else queued.push(value);
  });
  return {
    next: () => queued.shift() ?? new Promise<unknown>((resolve) => waiting.push(resolve)),
    nextOrTimeout: (ms: number): Promise<unknown> => {
      const existing = queued.shift();
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve("timeout"), ms);
        waiting.push((value) => { clearTimeout(timer); resolve(value); });
      });
    },
  };
}

async function createTask(port: number, requestId: string) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request_id: requestId, input: requestId, databases: [], mode: "agent" }),
  });
  return await res.json() as { task_id: string; run_id: string };
}

describe("WebSocket edge cases", () => {
  test("two tasks do not cross-subscribe (M05-T04)", async () => {
    const { port } = await start();
    const a = await createTask(port, "req-a");
    const b = await createTask(port, "req-b");

    const sa = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
    sockets.push(sa);
    await once(sa, "open");
    const fa = inbox(sa);
    sa.send(JSON.stringify({ type: "subscribe", task_id: a.task_id, after_sequence: 0 }));
    const aCreated = await fa.next() as EventEnvelope;
    expect(aCreated.task_id).toBe(a.task_id);

    const sb = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
    sockets.push(sb);
    await once(sb, "open");
    const fb = inbox(sb);
    sb.send(JSON.stringify({ type: "subscribe", task_id: b.task_id, after_sequence: 0 }));
    const bCreated = await fb.next() as EventEnvelope;
    expect(bCreated.task_id).toBe(b.task_id);
    expect(aCreated.task_id).not.toBe(b.task_id);
  });

  test("unsubscribe stops pushes (M05-T04)", async () => {
    const { port, runtime } = await start();
    const a = await runtime.repository.createTask({ requestId: "req-a", input: "x", databases: [], mode: "agent" });
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
    sockets.push(socket);
    await once(socket, "open");
    const frames = inbox(socket);
    socket.send(JSON.stringify({ type: "subscribe", task_id: a.task_id, after_sequence: 0 }));
    await frames.next();
    await frames.next();
    socket.send(JSON.stringify({ type: "unsubscribe", task_id: a.task_id }));
    await new Promise((r) => setTimeout(r, 300));
    await runtime.repository.appendRunEvent(a.task_id, a.run_id, { type: "run_started" });
    expect(await frames.nextOrTimeout(1500)).toBe("timeout");
  });

  test("replays many events in strict sequence order (M05-T08)", async () => {
    const { port, runtime } = await start();
    const a = await runtime.repository.createTask({ requestId: "req-a", input: "x", databases: [], mode: "agent" });
    await runtime.repository.appendRunEvents(
      a.task_id,
      a.run_id,
      Array.from({ length: 300 }, (_, i) => ({ type: "assistant_delta", delta: `d${i}` })),
    );
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
    sockets.push(socket);
    await once(socket, "open");
    const frames = inbox(socket);
    socket.send(JSON.stringify({ type: "subscribe", task_id: a.task_id, after_sequence: 0 }));
    const seqs: number[] = [];
    for (let i = 0; i < 302; i += 1) {
      const event = await frames.next() as EventEnvelope;
      seqs.push(event.sequence);
    }
    expect(seqs).toEqual(Array.from({ length: 302 }, (_, i) => i + 1));
  });
});
