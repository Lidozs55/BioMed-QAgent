import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import path from "node:path";
import { mkdir } from "node:fs/promises";

import type {
  BuildResult,
  EventEnvelope,
  TaskMode,
  TaskPage,
  WebSocketControlFrame,
} from "@biomed/contracts";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  BioMedAgentError,
  type BioMedAgentAdapter,
  type BioMedAgentSession,
  type BioMedAgentTool,
} from "../agent/contracts.js";
import { PiEventAdapter } from "../agent/event-adapter.js";
import {
  ArtifactIntegrityError,
  getTaskArtifact,
  listTaskArtifacts,
} from "./artifact-store.js";
import {
  DurableTaskConflictError,
  DurableTaskRepository,
} from "./task-repository.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_INPUT_LENGTH = 64 * 1024;
const MAX_WS_COMMAND_BYTES = 8 * 1024;
const MAX_WS_BUFFERED_BYTES = 64 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export interface DurableAgentWorkspace {
  root: string;
  tools: readonly BioMedAgentTool[];
  setRunId?: (runId: string) => void;
  setPiSessionId?: (piSessionId: string) => void;
  consumeBuildResult?: () => BuildResult | null;
  dispose(): Promise<void>;
}

export interface DurableAgentRuntimeOptions {
  tasksRoot: string;
  adapter: BioMedAgentAdapter;
  workspaceFactory: (identity: {
    taskId: string;
    runId: string;
  }) => Promise<DurableAgentWorkspace>;
  repository?: DurableTaskRepository;
  legacyBaseUrl?: string;
  fetch?: typeof fetch;
  cancellationTimeoutMs?: number;
}

export interface DurableAgentRuntime {
  readonly repository: DurableTaskRepository;
  handle(request: IncomingMessage, response: ServerResponse): boolean;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): Promise<void>;
}

interface ActiveTask {
  session: BioMedAgentSession;
  workspace: DurableAgentWorkspace;
  adapter: PiEventAdapter;
  activeRunId: string | null;
}

interface Subscription {
  lastSent: number;
  initializing: boolean;
  pending: EventEnvelope[];
}

function pathname(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://application-host").pathname;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new TypeError("Request body is too large");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(body: Record<string, unknown>, name: string, max = 128): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new TypeError(`${name} must be a bounded non-empty string`);
  }
  return value;
}

function inputString(body: Record<string, unknown>): string {
  return requiredString(body, "input", MAX_INPUT_LENGTH);
}

function taskMode(value: unknown): TaskMode {
  if (value === "agent" || value === "fixture" || value === "import") return value;
  throw new TypeError("mode is invalid");
}

function databases(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError("databases must be a string array");
  }
  return value as string[];
}

function rawDataText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

function controlError(
  code: string,
  message: string,
  taskId?: string,
): WebSocketControlFrame {
  return taskId === undefined
    ? { type: "error", code, message }
    : { type: "error", code, message, task_id: taskId };
}

export async function createDurableAgentRuntime(
  options: DurableAgentRuntimeOptions,
): Promise<DurableAgentRuntime> {
  const repository = options.repository ?? new DurableTaskRepository(options.tasksRoot);
  await repository.recoverActiveRuns();
  const activeTasks = new Map<string, ActiveTask>();
  const activeExecutions = new Set<Promise<void>>();
  const webSocketServer = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  let closed = false;

  async function consumeRun(taskId: string, runId: string, input: string): Promise<void> {
    const task = activeTasks.get(taskId);
    if (task === undefined) return;
    try {
      for await (const source of task.session.run(input)) {
        const payloads = task.adapter.adapt(runId, source).map((event) =>
          event.payload.type === "run_completed"
            ? {
                type: "run_completed" as const,
                build_result: task.workspace.consumeBuildResult?.() ?? null,
              }
            : event.payload,
        );
        if (payloads.length > 0) {
          await repository.appendRunEvents(taskId, runId, payloads);
        }
      }
    } catch (error) {
      for (const event of task.adapter.failed(runId, error)) {
        await repository.appendRunEvent(taskId, runId, event.payload);
      }
    } finally {
      if (task.activeRunId === runId) task.activeRunId = null;
    }
  }

  function startRun(taskId: string, runId: string, input: string): void {
    const task = activeTasks.get(taskId);
    if (task === undefined) throw new ReferenceError("Task session is unavailable");
    if (task.activeRunId !== null) {
      throw new DurableTaskConflictError("active_run", "Task already has an active run");
    }
    task.workspace.setRunId?.(runId);
    task.activeRunId = runId;
    const execution = consumeRun(taskId, runId, input);
    activeExecutions.add(execution);
    const cleanup = (): void => {
      activeExecutions.delete(execution);
    };
    void execution.then(cleanup, cleanup);
  }

  async function createSession(taskId: string, runId: string): Promise<ActiveTask> {
    const workspace = await options.workspaceFactory({ taskId, runId });
    const sessionDir = path.join(workspace.root, "state", "pi-session");
    await mkdir(sessionDir, { recursive: true });
    let disposed = false;
    const disposeWorkspace = async (): Promise<void> => {
      if (disposed) return;
      disposed = true;
      await workspace.dispose();
    };
    try {
      const session = await options.adapter.createSession({
        taskId,
        runId,
        cwd: workspace.root,
        sessionDir,
        tools: workspace.tools,
        cleanup: disposeWorkspace,
      });
      workspace.setPiSessionId?.(session.piSessionId);
      await repository.recordPiSessionId(taskId, session.piSessionId);
      return {
        session,
        workspace: { ...workspace, dispose: disposeWorkspace },
        adapter: new PiEventAdapter({ taskId }),
        activeRunId: null,
      };
    } catch (error) {
      await disposeWorkspace();
      throw error;
    }
  }

  async function createTask(request: IncomingMessage): Promise<unknown> {
    const body = await readJsonBody(request);
    const mode = taskMode(body.mode);
    if (mode !== "agent") throw new TypeError("The Pi runtime currently accepts agent tasks only");
    const accepted = await repository.createTask({
      requestId: requiredString(body, "request_id"),
      input: inputString(body),
      databases: databases(body.databases),
      mode,
    });
    const snapshot = await repository.getSnapshot(accepted.task_id);
    const admittedRun = snapshot?.runs.find((run) => run.run_id === accepted.run_id);
    if (!activeTasks.has(accepted.task_id) && admittedRun?.status === "queued") {
      try {
        const task = await createSession(accepted.task_id, accepted.run_id);
        activeTasks.set(accepted.task_id, task);
        startRun(accepted.task_id, accepted.run_id, body.input as string);
      } catch (error) {
        await repository.appendRunEvent(accepted.task_id, accepted.run_id, {
          type: "run_failed",
          error: "Agent session could not start",
          error_code: "configuration_error",
        });
        throw error;
      }
    }
    return accepted;
  }

  async function createRun(taskId: string, request: IncomingMessage): Promise<unknown> {
    const body = await readJsonBody(request);
    const requestId = requiredString(body, "request_id");
    const before = await repository.getSnapshot(taskId);
    const existingRun = before?.runs.find((run) => run.request_id === requestId);
    const accepted = await repository.createRun(taskId, {
      requestId,
      input: inputString(body),
    });
    if (existingRun !== undefined) return accepted;
    let task = activeTasks.get(taskId);
    if (task === undefined) {
      try {
        task = await createSession(taskId, accepted.run_id);
        activeTasks.set(taskId, task);
      } catch (error) {
        await repository.appendRunEvent(taskId, accepted.run_id, {
          type: "run_failed",
          error: "Agent session could not start",
          error_code: "configuration_error",
        });
        throw error;
      }
    }
    startRun(taskId, accepted.run_id, body.input as string);
    return accepted;
  }

  async function cancelRun(taskId: string, runId: string): Promise<unknown> {
    const snapshot = await repository.getSnapshot(taskId);
    if (snapshot === null || snapshot.task.active_run_id !== runId) {
      throw new ReferenceError("Run not found");
    }
    const task = activeTasks.get(taskId);
    if (task === undefined || task.activeRunId !== runId) {
      throw new DurableTaskConflictError("active_run", "Run is not cancellable");
    }
    let unsubscribeTerminal: (() => void) | undefined;
    const terminal = new Promise<void>((resolve) => {
      const unsubscribe = repository.subscribe((event) => {
        if (
          event.task_id === taskId && event.run_id === runId &&
          (event.type === "run_cancelled" || event.type === "run_failed")
        ) {
          unsubscribe();
          unsubscribeTerminal = undefined;
          resolve();
        }
      });
      unsubscribeTerminal = unsubscribe;
    });
    await repository.appendRunEvent(taskId, runId, {
      type: "run_cancel_requested",
      reason: null,
    });
    await task.session.cancel("user requested");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        terminal,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Run cancellation acknowledgement timed out")),
            options.cancellationTimeoutMs ?? 10_000,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      unsubscribeTerminal?.();
    }
    return await repository.getSnapshot(taskId);
  }

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://application-host");
      if (request.method === "POST" && url.pathname === "/api/v1/tasks") {
        sendJson(response, 202, await createTask(request));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/tasks") {
        const limit = Number(url.searchParams.get("limit") ?? "50");
        const local = await repository.listTasks(limit);
        sendJson(response, 200, await mergeLegacyTasks(local, request, options, limit));
        return;
      }
      const task = /^\/api\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && task !== null) {
        const snapshot = await repository.getSnapshot(decodeURIComponent(task[1] ?? ""));
        sendJson(response, snapshot === null ? 404 : 200, snapshot ?? { detail: "Task not found" });
        return;
      }
      const events = /^\/api\/v1\/tasks\/([^/]+)\/events$/.exec(url.pathname);
      if (request.method === "GET" && events !== null) {
        const taskId = decodeURIComponent(events[1] ?? "");
        if (await repository.getSnapshot(taskId) === null) {
          sendJson(response, 404, { detail: "Task not found" });
          return;
        }
        const after = Number(url.searchParams.get("after_sequence") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "100");
        sendJson(response, 200, { events: await repository.listEvents(taskId, after, limit) });
        return;
      }
      const messages = /^\/api\/v1\/tasks\/([^/]+)\/messages$/.exec(url.pathname);
      if (request.method === "GET" && messages !== null) {
        const snapshot = await repository.getSnapshot(decodeURIComponent(messages[1] ?? ""));
        sendJson(response, snapshot === null ? 404 : 200, snapshot === null
          ? { detail: "Task not found" }
          : { schema_version: "1.0", messages: snapshot.messages, next_cursor: null });
        return;
      }
      const artifacts = /^\/api\/v1\/tasks\/([^/]+)\/artifacts$/.exec(url.pathname);
      if (request.method === "GET" && artifacts !== null) {
        const taskId = decodeURIComponent(artifacts[1] ?? "");
        if (await repository.getSnapshot(taskId) === null) {
          sendJson(response, 404, { detail: "Task not found" });
          return;
        }
        sendJson(response, 200, {
          artifacts: await listTaskArtifacts(pathForTask(options.tasksRoot, taskId)),
          degraded: false,
        });
        return;
      }
      const artifact = /^\/api\/v1\/tasks\/([^/]+)\/artifacts\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && artifact !== null) {
        const taskId = decodeURIComponent(artifact[1] ?? "");
        const artifactId = decodeURIComponent(artifact[2] ?? "");
        if (await repository.getSnapshot(taskId) === null) {
          sendJson(response, 404, { detail: "Task not found" });
          return;
        }
        const resolved = await getTaskArtifact(pathForTask(options.tasksRoot, taskId), artifactId);
        if (resolved === null) {
          sendJson(response, 404, { detail: "Artifact not found" });
          return;
        }
        response.writeHead(200, {
          "content-type": resolved.mediaType,
          "content-length": String(resolved.bytes.length),
          "content-disposition": `attachment; filename="${resolved.name}"`,
        });
        response.end(resolved.bytes);
        return;
      }
      const runs = /^\/api\/v1\/tasks\/([^/]+)\/runs$/.exec(url.pathname);
      if (request.method === "POST" && runs !== null) {
        sendJson(response, 202, await createRun(decodeURIComponent(runs[1] ?? ""), request));
        return;
      }
      const cancel = /^\/api\/v1\/tasks\/([^/]+)\/runs\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && cancel !== null) {
        sendJson(response, 202, await cancelRun(
          decodeURIComponent(cancel[1] ?? ""),
          decodeURIComponent(cancel[2] ?? ""),
        ));
        return;
      }
      sendJson(response, 404, { detail: "Not Found" });
    } catch (error) {
      if (error instanceof DurableTaskConflictError) {
        sendJson(response, 409, { detail: error.message });
      } else if (error instanceof ArtifactIntegrityError) {
        sendJson(response, 409, { detail: error.message });
      } else if (error instanceof ReferenceError) {
        sendJson(response, 404, { detail: error.message });
      } else if (error instanceof BioMedAgentError) {
        sendJson(response, 502, { detail: error.message });
      } else if (error instanceof SyntaxError || error instanceof TypeError) {
        sendJson(response, 422, { detail: error.message });
      } else {
        sendJson(response, 500, { detail: "Task runtime failed" });
      }
    }
  }

  webSocketServer.on("connection", (socket) => {
    sockets.add(socket);
    const subscriptions = new Map<string, Subscription>();
    let legacySocket: WebSocket | undefined;
    let legacyConnect: Promise<WebSocket> | undefined;
    const sendRaw = (text: string): void => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
        socket.close(1013, "slow subscriber; reconnect and replay");
        return;
      }
      socket.send(text);
    };
    const send = (value: unknown): void => {
      sendRaw(JSON.stringify(value));
    };
    const sendEvent = (event: EventEnvelope): void => {
      const subscription = subscriptions.get(event.task_id);
      if (subscription === undefined || event.sequence <= subscription.lastSent) return;
      if (subscription.initializing) {
        subscription.pending.push(event);
        return;
      }
      subscription.lastSent = event.sequence;
      send(event);
    };
    const unsubscribeRepository = repository.subscribe(sendEvent);

    const connectLegacy = (): Promise<WebSocket> => {
      if (legacySocket?.readyState === WebSocket.OPEN) return Promise.resolve(legacySocket);
      if (legacyConnect !== undefined) return legacyConnect;
      if (options.legacyBaseUrl === undefined) {
        return Promise.reject(new Error("Legacy WebSocket runtime is unavailable"));
      }
      const target = new URL("/api/v1/ws", options.legacyBaseUrl);
      target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
      legacyConnect = new Promise<WebSocket>((resolve, reject) => {
        const upstream = new WebSocket(target);
        const onError = (error: Error): void => {
          upstream.removeListener("open", onOpen);
          legacyConnect = undefined;
          reject(error);
        };
        const onOpen = (): void => {
          upstream.removeListener("error", onError);
          legacySocket = upstream;
          upstream.on("message", (raw) => {
            sendRaw(rawDataText(raw));
          });
          upstream.once("close", () => {
            if (legacySocket === upstream) legacySocket = undefined;
          });
          upstream.on("error", () => {
            send(controlError("legacy_runtime_unavailable", "Legacy WebSocket runtime failed"));
          });
          legacyConnect = undefined;
          resolve(upstream);
        };
        upstream.once("error", onError);
        upstream.once("open", onOpen);
      });
      return legacyConnect;
    };

    const forwardLegacy = (rawCommand: string): void => {
      void connectLegacy().then(
        (upstream) => upstream.send(rawCommand),
        () => send(controlError(
          "legacy_runtime_unavailable",
          "Legacy WebSocket runtime is unavailable",
        )),
      );
    };

    socket.on("message", (raw: RawData) => {
      const text = rawDataText(raw);
      if (Buffer.byteLength(text) > MAX_WS_COMMAND_BYTES) {
        send(controlError("invalid_command", "Command is too large"));
        return;
      }
      let command: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(text);
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error();
        command = value as Record<string, unknown>;
      } catch {
        send(controlError("invalid_json", "Invalid JSON"));
        return;
      }
      if (command.type === "ping") {
        if (legacySocket?.readyState === WebSocket.OPEN) forwardLegacy(text);
        else send({ type: "pong" });
        return;
      }
      const taskId = typeof command.task_id === "string" ? command.task_id : "";
      if (!SAFE_ID.test(taskId)) {
        send(controlError("invalid_command", "Invalid WebSocket command"));
        return;
      }
      if (!taskId.startsWith("task_ts_")) {
        forwardLegacy(text);
        return;
      }
      if (command.type === "unsubscribe") {
        subscriptions.delete(taskId);
        return;
      }
      if (command.type !== "subscribe" || !Number.isInteger(command.after_sequence) || Number(command.after_sequence) < 0) {
        send(controlError("invalid_command", "Invalid WebSocket command", taskId));
        return;
      }
      const subscription: Subscription = {
        lastSent: Number(command.after_sequence),
        initializing: true,
        pending: [],
      };
      subscriptions.set(taskId, subscription);
      void (async () => {
        if (await repository.getSnapshot(taskId) === null) {
          subscriptions.delete(taskId);
          send(controlError("task_not_found", "Task not found", taskId));
          return;
        }
        for (;;) {
          const replay = await repository.listEvents(taskId, subscription.lastSent);
          for (const event of replay) {
            if (event.sequence <= subscription.lastSent) continue;
            subscription.lastSent = event.sequence;
            send(event);
          }
          if (replay.length < 1_000) break;
        }
        subscription.initializing = false;
        for (const event of subscription.pending.sort((left, right) => left.sequence - right.sequence)) {
          sendEvent(event);
        }
        subscription.pending.length = 0;
      })().catch(() => send(controlError("internal_error", "WebSocket adapter failed", taskId)));
    });
    socket.once("close", () => {
      sockets.delete(socket);
      subscriptions.clear();
      unsubscribeRepository();
      legacySocket?.close(1000, "client disconnect");
    });
  });

  return {
    repository,
    handle(request, response) {
      const requestPath = pathname(request);
      if (requestPath === "/api/v1/tasks") {
        const url = new URL(request.url ?? "/api/v1/tasks", "http://application-host");
        if (request.method === "GET" && url.searchParams.has("cursor")) return false;
        void dispatch(request, response);
        return true;
      }
      const taskMatch = /^\/api\/v1\/tasks\/([^/]+)/.exec(requestPath);
      const taskId = taskMatch === null ? "" : decodeURIComponent(taskMatch[1] ?? "");
      if (!taskId.startsWith("task_ts_")) {
        return false;
      }
      void dispatch(request, response);
      return true;
    },
    handleUpgrade(request, socket, head) {
      if (pathname(request) !== "/api/v1/ws" || closed) return false;
      const origin = request.headers.origin;
      const host = request.headers.host;
      if (origin !== undefined && (host === undefined || !sameOriginHost(origin, host))) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return true;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
      return true;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.close(1001, "Host shutdown");
      const results = await Promise.allSettled([...activeTasks.values()].map(async (task) => {
        try {
          if (task.activeRunId !== null) await task.session.cancel("Host shutdown");
          await task.session.dispose();
        } finally {
          await task.workspace.dispose();
        }
      }));
      const executionResults = await Promise.allSettled([...activeExecutions]);
      activeTasks.clear();
      const errors = [...results, ...executionResults].flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) throw new AggregateError(errors, "Durable Agent runtime cleanup failed");
    },
  };
}

function sameOriginHost(origin: string, host: string): boolean {
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host;
  } catch {
    return false;
  }
}

async function mergeLegacyTasks(
  local: TaskPage,
  request: IncomingMessage,
  options: DurableAgentRuntimeOptions,
  limit: number,
): Promise<TaskPage> {
  if (options.legacyBaseUrl === undefined) return local;
  const target = new URL(request.url ?? "/api/v1/tasks", options.legacyBaseUrl);
  const response = await (options.fetch ?? fetch)(target, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Legacy task listing failed (${response.status})`);
  const value: unknown = await response.json();
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Legacy task listing is invalid");
  }
  const page = value as Partial<TaskPage>;
  if (!Array.isArray(page.active_items) || !Array.isArray(page.items)) {
    throw new TypeError("Legacy task listing is invalid");
  }
  const active = [...local.active_items, ...page.active_items]
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  const history = [...local.items, ...page.items]
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  return {
    schema_version: "1.0",
    active_items: active,
    items: history.slice(0, limit),
    next_cursor: page.next_cursor ?? local.next_cursor,
  };
}

function pathForTask(tasksRoot: string, taskId: string): string {
  if (!SAFE_ID.test(taskId)) throw new ReferenceError("Task not found");
  return path.join(tasksRoot, taskId);
}
