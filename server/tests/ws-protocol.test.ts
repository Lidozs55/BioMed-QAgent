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

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const stubAdapter: BioMedAgentAdapter = {
  createSession: async () => {
    throw new Error("not used in protocol tests");
  },
};

async function startRuntime() {
  const root = await mkdtemp(path.join(os.tmpdir(), "biomed-ws-protocol-"));
  roots.push(root);
  const runtime = await createDurableAgentRuntime({
    tasksRoot: root,
    adapter: stubAdapter,
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

async function connect(port: number): Promise<{ socket: WebSocket; frames: { next(): Promise<unknown> } }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
  await once(socket, "open");
  return { socket, frames: inbox(socket) };
}

describe("WebSocket protocol edges", () => {
  test("ping returns pong", async () => {
    const { port, runtime } = await startRuntime();
    const { socket, frames } = await connect(port);
    socket.send(JSON.stringify({ type: "ping" }));
    await expect(frames.next()).resolves.toEqual({ type: "pong" });
    socket.close();
    await runtime.close();
  });

  test("invalid JSON returns invalid_json", async () => {
    const { port, runtime } = await startRuntime();
    const { socket, frames } = await connect(port);
    socket.send("{broken");
    await expect(frames.next()).resolves.toMatchObject({ type: "error", code: "invalid_json" });
    socket.close();
    await runtime.close();
  });

  test("unknown command returns invalid_command", async () => {
    const { port, runtime } = await startRuntime();
    const { socket, frames } = await connect(port);
    socket.send(JSON.stringify({ type: "mystery" }));
    await expect(frames.next()).resolves.toMatchObject({ type: "error", code: "invalid_command" });
    socket.close();
    await runtime.close();
  });

  test("illegal after_sequence returns invalid_command", async () => {
    const { port, runtime } = await startRuntime();
    const { socket, frames } = await connect(port);
    socket.send(JSON.stringify({ type: "subscribe", task_id: "task_ts_1", after_sequence: -1 }));
    await expect(frames.next()).resolves.toMatchObject({ type: "error", code: "invalid_command" });
    socket.close();
    await runtime.close();
  });

  test("subscribing to a missing task returns task_not_found", async () => {
    const { port, runtime } = await startRuntime();
    const { socket, frames } = await connect(port);
    socket.send(JSON.stringify({ type: "subscribe", task_id: "task_ts_missing", after_sequence: 0 }));
    await expect(frames.next()).resolves.toMatchObject({ type: "error", code: "task_not_found" });
    socket.close();
    await runtime.close();
  });
});