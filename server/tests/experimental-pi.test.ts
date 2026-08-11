import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  BioMedAgentAdapter,
  BioMedAgentEvent,
  BioMedAgentSession,
  BioMedSessionConfig,
} from "../src/agent/contracts.js";
import {
  createExperimentalPiRuntime,
  createOptionalExperimentalPiRuntime,
} from "../src/agent/experimental-pi.js";
import { createApplicationHost, type ApplicationHost } from "../src/app/create-app.js";

const hosts: ApplicationHost[] = [];
const legacyServers: Server[] = [];

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await Promise.all(
    legacyServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
});

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as AddressInfo).port;
}

class FakeAdapter implements BioMedAgentAdapter {
  readonly created: BioMedSessionConfig[] = [];
  readonly sessions = new Map<string, BioMedAgentSession>();

  async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
    this.created.push(config);
    const session: BioMedAgentSession = {
      piSessionId: `pi-${config.runId}`,
      taskId: config.taskId,
      runId: config.runId,
      async *run(input: string): AsyncIterable<BioMedAgentEvent> {
        yield { type: "turn_started" };
        yield { type: "assistant_delta", delta: `echo:${input}` };
        yield { type: "turn_completed" };
      },
      cancel: async () => undefined,
      dispose: async () => undefined,
    };
    this.sessions.set(config.runId, session);
    return session;
  }
}

describe("experimental Pi Host composition", () => {
  test("disabled mode never constructs Pi", async () => {
    const factory = vi.fn(async () => {
      throw new Error("must not run");
    });

    const runtime = await createOptionalExperimentalPiRuntime(false, factory);

    expect(runtime).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  test("executes one deterministic fake-adapter turn under the experimental path", async () => {
    const legacy = createServer((_request, response) => response.end("legacy"));
    legacyServers.push(legacy);
    const legacyPort = await listen(legacy);
    const adapter = new FakeAdapter();
    const host = await createApplicationHost({
      publicHost: "127.0.0.1",
      publicPort: 0,
      legacy: async () => ({
        target: `http://127.0.0.1:${legacyPort}`,
        close: async () => undefined,
      }),
      experimentalPi: () =>
        createExperimentalPiRuntime({
          adapter,
          workspaceFactory: async () => ({
            root: path.join(process.cwd(), "server"),
            tools: [],
            dispose: async () => undefined,
          }),
        }),
      frontend: async () => ({
        middleware: (_request, response) => response.end("frontend"),
        close: async () => undefined,
      }),
    });
    hosts.push(host);
    const port = (host.server.address() as AddressInfo).port;

    const response = await fetch(`http://127.0.0.1:${port}/experimental/pi/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: "task-1", run_id: "run-1", input: "hello" }),
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      task_id: "task-1",
      run_id: "run-1",
      pi_session_id: "pi-run-1",
      events: [
        { type: "turn_started" },
        { type: "assistant_delta", delta: "echo:hello" },
        { type: "turn_completed" },
      ],
      durable: false,
    });
    expect(adapter.created).toHaveLength(1);
    expect(adapter.created[0]).toMatchObject({
      taskId: "task-1",
      runId: "run-1",
      cwd: path.join(process.cwd(), "server"),
      tools: [],
    });
  });

  test("runs a later sequential turn through the same mapped session", async () => {
    const adapter = new FakeAdapter();
    const disposeWorkspace = vi.fn(async () => undefined);
    const runtime = await createExperimentalPiRuntime({
      adapter,
      workspaceFactory: async () => ({
        root: path.join(process.cwd(), "server"),
        tools: [],
        dispose: disposeWorkspace,
      }),
    });
    const server = createServer((request, response) => runtime.handle(request, response));
    legacyServers.push(server);
    const port = await listen(server);
    const create = await fetch(`http://127.0.0.1:${port}/experimental/pi/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task_id: "task-1", run_id: "run-1", input: "one" }),
    });
    expect(create.status).toBe(201);

    const next = await fetch(
      `http://127.0.0.1:${port}/experimental/pi/sessions/run-1/turns`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: "two" }),
      },
    );

    expect(next.status).toBe(200);
    expect((await next.json()) as object).toMatchObject({
      run_id: "run-1",
      pi_session_id: "pi-run-1",
    });
    expect(adapter.created).toHaveLength(1);
    await runtime.close();
    expect(disposeWorkspace).toHaveBeenCalledOnce();
  });
});
