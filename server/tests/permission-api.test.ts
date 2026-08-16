import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AddressInfo } from "node:net";

import { afterEach, describe, expect, test } from "vitest";
import { WebSocket } from "ws";

import type {
  BioMedAgentAdapter,
  BioMedAgentEvent,
  BioMedAgentSession,
  BioMedAgentTool,
  BioMedSessionConfig,
} from "../src/agent/contracts.js";
import {
  AppendOnlyPermissionAuditSink,
  PermissionBroker,
  PermissionEvaluator,
  ProtectedPaths,
  TemporaryGrantStore,
  InMemoryPermissionPolicyStore,
} from "../src/agent/permissions/index.js";
import {
  InMemoryWorkspaceAuditSink,
  createTaskWorkspace,
  DiskWorkspaceManager,
} from "../src/agent/workspace/index.js";
import { createWorkspaceTools } from "../src/agent/workspace/tools.js";
import { createDurableAgentRuntime } from "../src/runtime/durable-agent-runtime.js";
import type { EventEnvelope } from "@biomed/contracts";

const roots: string[] = [];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class PermissionDrivenAdapter implements BioMedAgentAdapter {
  private readonly tools: () => BioMedAgentTool[];
  readonly completed: Array<{ tool: string; result: unknown; isError: boolean }> = [];

  constructor(tools: () => BioMedAgentTool[]) {
    this.tools = tools;
  }

  async createSession(config: BioMedSessionConfig): Promise<BioMedAgentSession> {
    const toolsRef = this.tools;
    const completedRef = this.completed;
    return {
      piSessionId: `pi_${config.taskId}`,
      taskId: config.taskId,
      runId: config.runId,
      run: async function* run(): AsyncIterable<BioMedAgentEvent> {
        const read = toolsRef().find((tool) => tool.name === "workspace_read");
        if (read === undefined) throw new Error("workspace_read tool missing");
        const gate = deferred();
        const resultPromise = read.execute({ path: externalPath() }, undefined).then((result) => {
          gate.resolve();
          return result;
        });
        yield { type: "turn_started" };
        yield { type: "tool_started", toolCallId: "tc_1", toolName: "workspace_read", arguments: { path: externalPath() } };
        // The tool call suspends on the permission ask; the HTTP test flow
        // resolves it, then execution continues.
        const result = await resultPromise;
        yield { type: "tool_completed", toolCallId: "tc_1", toolName: "workspace_read", result, isError: result.isError ?? false };
        completedRef.push({ tool: "workspace_read", result: result.details, isError: result.isError ?? false });
        yield { type: "turn_completed" };
      },
      cancel: async () => undefined,
      dispose: async () => undefined,
    };
  }
}

let external: string | null = null;
function externalPath(): string {
  if (external === null) {
    external = path.join(os.tmpdir(), `biomed-perm-api-${process.pid}`);
    roots.push(external);
  }
  return path.join(external, "clinical.csv");
}

async function writeExternal(content: string): Promise<void> {
  const target = externalPath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("permission control plane over HTTP (P3)", () => {
  test("tool call → permission_requested → POST resolve → same tool call continues", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "biomed-perm-api-runtime-"));
    roots.push(base);
    const tasksRoot = path.join(base, "output", "tasks");
    const workspacesRoot = path.join(base, "workspaces");
    await mkdir(tasksRoot, { recursive: true });
    await writeExternal("external data");

    const adapter = new PermissionDrivenAdapter(() => tools);
    let tools: BioMedAgentTool[] = [];
    const workspaceManager = new DiskWorkspaceManager({ workspacesRoot });
    const runtime = await createDurableAgentRuntime({
      tasksRoot,
      workspaceManager,
      adapter,
      workspaceFactory: async ({ taskId, runId, recordRunEvent }) => {
        const workspaceRoot = await workspaceManager.ensure(taskId);
        const taskOutputRoot = path.join(tasksRoot, taskId);
        const policyStore = new InMemoryPermissionPolicyStore();
        const grants = new TemporaryGrantStore();
        const protectedPaths = new ProtectedPaths({ taskOutputRoot });
        const broker = new PermissionBroker({
          taskId,
          runId,
          evaluator: new PermissionEvaluator({ protectedPaths, grants, policyStore }),
          grants,
          policyStore,
          audit: new AppendOnlyPermissionAuditSink(taskOutputRoot),
          recordRunEvent,
        });
        const workspace = await createTaskWorkspace({
          taskId,
          runId,
          workspaceRoot,
          taskOutputRoot,
          dataRoot: base,
          repositoryRoot: base,
          permissions: broker,
          audit: new InMemoryWorkspaceAuditSink(),
        });
        tools = createWorkspaceTools(workspace);
        return {
          root: workspaceRoot,
          tools,
          permissionBroker: broker,
          dispose: () => workspace.dispose(),
        };
      },
    });
    const server: Server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const created = await fetch(`http://127.0.0.1:${port}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "req_perm",
        input: "read external file",
        databases: [],
        mode: "agent",
      }),
    });
    expect(created.status).toBe(202);
    const accepted = await created.json() as { task_id: string; run_id: string };

    // Wait for the durable permission_requested event (the tool call is
    // suspended inside the run loop).
    let requested: EventEnvelope | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const page = await fetch(
        `http://127.0.0.1:${port}/api/v1/tasks/${accepted.task_id}/events?after_sequence=0`,
      ).then((response) => response.json()) as { events: EventEnvelope[] };
      requested = page.events.find((event) => event.type === "permission_requested") ?? null;
      if (requested !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(requested).not.toBeNull();
    const requestedPayload = requested?.payload;
    if (requestedPayload === undefined || requestedPayload.type !== "permission_requested") {
      throw new Error("permission_requested payload missing");
    }
    expect(requestedPayload).toMatchObject({
      capability: "fs.read",
      scope: "external",
      resource: externalPath(),
    });
    const requestIdValue = requestedPayload.request_id;

    // Unknown request id → 404.
    const unknown = await fetch(
      `http://127.0.0.1:${port}/api/v1/tasks/${accepted.task_id}/runs/${accepted.run_id}/permissions/permission_nope`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow", grant_scope: "once" }),
      },
    );
    expect(unknown.status).toBe(404);

    // Resolve via the authoritative HTTP mutation (plan §32–§33).
    const resolved = await fetch(
      `http://127.0.0.1:${port}/api/v1/tasks/${accepted.task_id}/runs/${accepted.run_id}/permissions/${requestIdValue}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow", grant_scope: "once" }),
      },
    );
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ status: "resolved" });

    await expect.poll(async () => {
      const snapshot = await runtime.repository.getSnapshot(accepted.task_id);
      return snapshot?.runs.find((run) => run.run_id === accepted.run_id)?.status;
    }).toBe("completed");

    const events = (await fetch(
      `http://127.0.0.1:${port}/api/v1/tasks/${accepted.task_id}/events?after_sequence=0`,
    ).then((response) => response.json())) as { events: EventEnvelope[] };
    const resolvedEvent = events.events.find((event) => event.type === "permission_resolved");
    expect(resolvedEvent?.payload).toMatchObject({
      request_id: requestIdValue,
      decision: "allow",
      grant_scope: "once",
    });
    expect(adapter.completed).toEqual([
      { tool: "workspace_read", isError: false, result: expect.objectContaining({ text: "external data" }) },
    ]);

    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("deny returns a structured permission error to the tool call", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "biomed-perm-api-deny-"));
    roots.push(base);
    const tasksRoot = path.join(base, "output", "tasks");
    const workspacesRoot = path.join(base, "workspaces");
    await mkdir(tasksRoot, { recursive: true });
    await writeExternal("secret");

    const adapter = new PermissionDrivenAdapter(() => tools);
    let tools: BioMedAgentTool[] = [];
    const workspaceManager = new DiskWorkspaceManager({ workspacesRoot });
    const runtime = await createDurableAgentRuntime({
      tasksRoot,
      workspaceManager,
      adapter,
      workspaceFactory: async ({ taskId, runId, recordRunEvent }) => {
        const workspaceRoot = await workspaceManager.ensure(taskId);
        const taskOutputRoot = path.join(tasksRoot, taskId);
        const policyStore = new InMemoryPermissionPolicyStore();
        const grants = new TemporaryGrantStore();
        const protectedPaths = new ProtectedPaths({ taskOutputRoot });
        const broker = new PermissionBroker({
          taskId,
          runId,
          evaluator: new PermissionEvaluator({ protectedPaths, grants, policyStore }),
          grants,
          policyStore,
          audit: new AppendOnlyPermissionAuditSink(taskOutputRoot),
          recordRunEvent,
        });
        const workspace = await createTaskWorkspace({
          taskId,
          runId,
          workspaceRoot,
          taskOutputRoot,
          dataRoot: base,
          repositoryRoot: base,
          permissions: broker,
          audit: new InMemoryWorkspaceAuditSink(),
        });
        tools = createWorkspaceTools(workspace);
        return {
          root: workspaceRoot,
          tools,
          permissionBroker: broker,
          dispose: () => workspace.dispose(),
        };
      },
    });
    const server: Server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const created = await fetch(`http://127.0.0.1:${port}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "req_perm_deny",
        input: "read external file",
        databases: [],
        mode: "agent",
      }),
    });
    const accepted = await created.json() as { task_id: string; run_id: string };

    let requestId: string | null = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const page = await fetch(
        `http://127.0.0.1:${port}/api/v1/tasks/${accepted.task_id}/events?after_sequence=0`,
      ).then((response) => response.json()) as { events: EventEnvelope[] };
      const requested = page.events.find((event) => event.type === "permission_requested");
      if (requested !== undefined && requested.payload.type === "permission_requested") {
        requestId = requested.payload.request_id;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(requestId).not.toBeNull();

    await fetch(
      `http://127.0.0.1:${port}/api/v1/tasks/${accepted.task_id}/runs/${accepted.run_id}/permissions/${requestId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "deny" }),
      },
    );
    await expect.poll(async () => {
      const snapshot = await runtime.repository.getSnapshot(accepted.task_id);
      return snapshot?.runs.find((run) => run.run_id === accepted.run_id)?.status;
    }).toBe("completed");

    expect(adapter.completed).toEqual([
      {
        tool: "workspace_read",
        isError: true,
        result: expect.objectContaining({ code: "PERMISSION_DENIED" }),
      },
    ]);

    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("invalid decision and grant_scope values are rejected with 422", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "biomed-perm-api-validate-"));
    roots.push(base);
    const tasksRoot = path.join(base, "output", "tasks");
    const workspacesRoot = path.join(base, "workspaces");
    const runtime = await createDurableAgentRuntime({
      tasksRoot,
      workspaceManager: new DiskWorkspaceManager({ workspacesRoot }),
      adapter: {
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
      },
      workspaceFactory: async ({ taskId, runId }) => ({
        root: path.join(workspacesRoot, taskId),
        tools: [],
        dispose: async () => undefined,
        permissionBroker: new PermissionBroker({
          taskId,
          runId,
          evaluator: new PermissionEvaluator({
            protectedPaths: new ProtectedPaths({ taskOutputRoot: path.join(tasksRoot, taskId) }),
            grants: new TemporaryGrantStore(),
            policyStore: new InMemoryPermissionPolicyStore(),
          }),
          grants: new TemporaryGrantStore(),
          policyStore: new InMemoryPermissionPolicyStore(),
          audit: new AppendOnlyPermissionAuditSink(path.join(tasksRoot, taskId)),
          recordRunEvent: async () => undefined,
        }),
      }),
    });
    const server: Server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const created = await fetch(`http://127.0.0.1:${port}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "req_perm_val",
        input: "x",
        databases: [],
        mode: "agent",
      }),
    });
    const accepted = await created.json() as { task_id: string; run_id: string };

    const badDecision = await fetch(
      `http://127.0.0.1:${port}/api/v1/tasks/${accepted.task_id}/runs/${accepted.run_id}/permissions/permission_x`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "maybe" }),
      },
    );
    expect(badDecision.status).toBe(422);

    const badScope = await fetch(
      `http://127.0.0.1:${port}/api/v1/tasks/${accepted.task_id}/runs/${accepted.run_id}/permissions/permission_x`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "allow", grant_scope: "forever" }),
      },
    );
    expect(badScope.status).toBe(422);

    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("WebSocket delivers permission events on the run timeline", async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "biomed-perm-api-ws-"));
    roots.push(base);
    const tasksRoot = path.join(base, "output", "tasks");
    const workspacesRoot = path.join(base, "workspaces");
    await mkdir(tasksRoot, { recursive: true });
    await writeExternal("external data");

    const adapter = new PermissionDrivenAdapter(() => tools);
    let tools: BioMedAgentTool[] = [];
    const workspaceManager = new DiskWorkspaceManager({ workspacesRoot });
    const runtime = await createDurableAgentRuntime({
      tasksRoot,
      workspaceManager,
      adapter,
      workspaceFactory: async ({ taskId, runId, recordRunEvent }) => {
        const workspaceRoot = await workspaceManager.ensure(taskId);
        const taskOutputRoot = path.join(tasksRoot, taskId);
        const policyStore = new InMemoryPermissionPolicyStore();
        const broker = new PermissionBroker({
          taskId,
          runId,
          evaluator: new PermissionEvaluator({
            protectedPaths: new ProtectedPaths({ taskOutputRoot }),
            grants: new TemporaryGrantStore(),
            policyStore,
          }),
          grants: new TemporaryGrantStore(),
          policyStore,
          audit: new AppendOnlyPermissionAuditSink(taskOutputRoot),
          recordRunEvent,
        });
        const workspace = await createTaskWorkspace({
          taskId,
          runId,
          workspaceRoot,
          taskOutputRoot,
          dataRoot: base,
          repositoryRoot: base,
          permissions: broker,
          audit: new InMemoryWorkspaceAuditSink(),
        });
        tools = createWorkspaceTools(workspace);
        return {
          root: workspaceRoot,
          tools,
          permissionBroker: broker,
          dispose: () => workspace.dispose(),
        };
      },
    });
    const server: Server = createServer((request, response) => {
      if (!runtime.handle(request, response)) response.writeHead(404).end();
    });
    server.on("upgrade", (request, socket, head) => {
      if (!runtime.handleUpgrade(request, socket, head)) socket.destroy();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;

    const created = await fetch(`http://127.0.0.1:${port}/api/v1/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        request_id: "req_perm_ws",
        input: "read external file",
        databases: [],
        mode: "agent",
      }),
    });
    const accepted = await created.json() as { task_id: string; run_id: string };

    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws`);
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "subscribe", task_id: accepted.task_id, after_sequence: 0 }));
    const received: EventEnvelope[] = [];
    socket.on("message", (raw) => {
      const value = JSON.parse(raw.toString()) as EventEnvelope;
      if (value.type === "permission_requested" || value.type === "permission_resolved") {
        received.push(value);
      }
    });
    await expect.poll(async () => received.some((event) => event.type === "permission_requested"), {
      timeout: 10_000,
    }).toBe(true);
    socket.close();
    await runtime.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
