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

describe("WebSocket slow consumer", () => {
  test("closes a slow subscriber with 1013 (M05-T06)", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "biomed-ws-slow-"));
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
    const port = (server.address() as AddressInfo).port;

    const a = await runtime.repository.createTask({ requestId: "req-slow", input: "x", databases: [], mode: "agent" });

    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
    sockets.push(socket);
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "subscribe", task_id: a.task_id, after_sequence: 0 }));
    await new Promise((r) => setTimeout(r, 100));

    const big = "x".repeat(2048);
    const closeEvent = once(socket, "close");
    await runtime.repository.appendRunEvents(
      a.task_id,
      a.run_id,
      Array.from({ length: 200 }, (_, i) => ({ type: "assistant_delta", delta: `${big}${i}` })),
    );
    const [code] = await closeEvent;
    expect(code).toBe(1013);
    await runtime.close();
  }, 20_000);
});