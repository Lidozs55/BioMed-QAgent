import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type {
  ExperimentalPiCancelAccepted,
  ExperimentalPiRunAccepted,
  ExperimentalPiTaskAccepted,
  ExperimentalPiWebSocketControlFrame,
} from "@biomed/contracts";
import { WebSocket, WebSocketServer, type RawData } from "ws";

import {
  BioMedAgentError,
  type BioMedAgentAdapter,
  type BioMedAgentSession,
  type BioMedAgentTool,
} from "./contracts.js";
import {
  PiEventAdapter,
  type PiEventAdapterDiagnostic,
} from "./event-adapter.js";
import { ExperimentalEventBus } from "../experimental/event-bus.js";

export interface ExperimentalPiRuntime {
  handle(request: IncomingMessage, response: ServerResponse): boolean;
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  close(): Promise<void>;
}

export interface ExperimentalPiRuntimeOptions {
  adapter: BioMedAgentAdapter;
  workspaceFactory: (identity: {
    taskId: string;
    runId: string;
  }) => Promise<{
    root: string;
    tools: readonly BioMedAgentTool[];
    dispose(): Promise<void>;
  }>;
  eventBus?: ExperimentalEventBus;
  id?: () => string;
  maxQueuedFrames?: number;
  onDiagnostic?: (diagnostic: PiEventAdapterDiagnostic) => void;
}

interface ExperimentalTask {
  taskId: string;
  session: BioMedAgentSession;
  adapter: PiEventAdapter;
  disposeWorkspace: () => Promise<void>;
  activeRunId?: string;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_INPUT_LENGTH = 64 * 1024;
const MAX_WS_COMMAND_BYTES = 8 * 1024;
const DEFAULT_MAX_QUEUED_FRAMES = 64;

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
    if (size > MAX_BODY_BYTES) {
      throw new BioMedAgentError(
        "INVALID_SESSION_CONFIG",
        "Experimental request body is too large",
      );
    }
    chunks.push(bytes);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("body must be an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    throw new BioMedAgentError(
      "INVALID_SESSION_CONFIG",
      "Experimental request body must be valid JSON",
      { cause: error },
    );
  }
}

function requireInput(body: Record<string, unknown>): string {
  const input = body.input;
  if (
    typeof input !== "string" ||
    input.trim() === "" ||
    input.length > MAX_INPUT_LENGTH
  ) {
    throw new BioMedAgentError(
      "INVALID_SESSION_CONFIG",
      "input must be a bounded non-empty string",
    );
  }
  return input;
}

function errorStatus(error: BioMedAgentError): number {
  if (error.code === "DUPLICATE_RUN" || error.code === "SESSION_BUSY") return 409;
  if (error.code === "RUN_NOT_FOUND") return 404;
  if (error.code === "INVALID_CONFIGURATION") return 503;
  if (error.code === "UPSTREAM_FAILURE") return 502;
  return 400;
}

function controlError(
  code: Extract<ExperimentalPiWebSocketControlFrame, { type: "error" }>["code"],
  message: string,
  taskId?: string,
): ExperimentalPiWebSocketControlFrame {
  return taskId === undefined
    ? { type: "error", code, message }
    : { type: "error", code, message, task_id: taskId };
}

function rawDataText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

export class BoundedWebSocketWriter {
  private readonly queue: string[] = [];
  private flushScheduled = false;
  private closed = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly maxQueuedFrames: number,
  ) {}

  send(frame: unknown): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.queue.length >= this.maxQueuedFrames) {
      this.closed = true;
      this.queue.length = 0;
      this.socket.close(1013, "slow subscriber");
      return;
    }
    this.queue.push(JSON.stringify(frame));
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  close(): void {
    this.closed = true;
    this.queue.length = 0;
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    while (this.queue.length > 0) {
      if (this.socket.bufferedAmount > MAX_BODY_BYTES) {
        this.closed = true;
        this.queue.length = 0;
        this.socket.close(1013, "slow subscriber");
        return;
      }
      this.socket.send(this.queue.shift() ?? "");
    }
  }
}

export async function createOptionalExperimentalPiRuntime(
  enabled: boolean,
  factory: () => Promise<ExperimentalPiRuntime>,
): Promise<ExperimentalPiRuntime | undefined> {
  return enabled ? factory() : undefined;
}

export async function createExperimentalPiRuntime(
  options: ExperimentalPiRuntimeOptions,
): Promise<ExperimentalPiRuntime> {
  const tasks = new Map<string, ExperimentalTask>();
  const bus = options.eventBus ?? new ExperimentalEventBus();
  const webSocketServer = new WebSocketServer({ noServer: true });
  const id = options.id ?? randomUUID;
  const maxQueuedFrames = options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
  const onDiagnostic =
    options.onDiagnostic ??
    ((diagnostic: PiEventAdapterDiagnostic): void => {
      console.debug("Experimental Pi event ignored", diagnostic);
    });
  let closed = false;

  function newId(prefix: "task" | "run"): string {
    return `${prefix}_${id()}`;
  }

  async function consumeRun(
    task: ExperimentalTask,
    runId: string,
    input: string,
  ): Promise<void> {
    try {
      for await (const source of task.session.run(input)) {
        for (const event of task.adapter.adapt(runId, source)) bus.publish(event);
      }
    } catch (error) {
      for (const event of task.adapter.failed(runId, error)) bus.publish(event);
    } finally {
      if (task.activeRunId === runId) delete task.activeRunId;
    }
  }

  function startRun(task: ExperimentalTask, runId: string, input: string): void {
    if (task.activeRunId !== undefined) {
      throw new BioMedAgentError("SESSION_BUSY", "Experimental task already has an active run");
    }
    task.activeRunId = runId;
    queueMicrotask(() => void consumeRun(task, runId, input));
  }

  async function createTask(
    request: IncomingMessage,
  ): Promise<ExperimentalPiTaskAccepted> {
    const body = await readJsonBody(request);
    const input = requireInput(body);
    if (
      body.fixture_profile !== undefined &&
      body.fixture_profile !== null &&
      typeof body.fixture_profile !== "string"
    ) {
      throw new BioMedAgentError(
        "INVALID_SESSION_CONFIG",
        "fixture_profile must be a string or null",
      );
    }
    const taskId = newId("task");
    const runId = newId("run");
    const workspace = await options.workspaceFactory({ taskId, runId });
    let disposePromise: Promise<void> | undefined;
    const disposeWorkspace = (): Promise<void> => {
      disposePromise ??= workspace.dispose();
      return disposePromise;
    };
    try {
      const session = await options.adapter.createSession({
        taskId,
        runId,
        cwd: workspace.root,
        tools: workspace.tools,
        cleanup: disposeWorkspace,
      });
      const task: ExperimentalTask = {
        taskId,
        session,
        adapter: new PiEventAdapter({ taskId, onDiagnostic }),
        disposeWorkspace,
      };
      tasks.set(taskId, task);
      bus.registerTask(taskId);
      startRun(task, runId, input);
      return {
        task_id: taskId,
        run_id: runId,
        session_id: session.piSessionId,
        status: "running",
        durable: false,
      };
    } catch (error) {
      await disposeWorkspace();
      throw error;
    }
  }

  async function createRun(
    taskId: string,
    request: IncomingMessage,
  ): Promise<ExperimentalPiRunAccepted> {
    const task = tasks.get(taskId);
    if (task === undefined) {
      throw new BioMedAgentError("RUN_NOT_FOUND", "Experimental task was not found");
    }
    const body = await readJsonBody(request);
    const runId = newId("run");
    startRun(task, runId, requireInput(body));
    return {
      task_id: taskId,
      run_id: runId,
      session_id: task.session.piSessionId,
      status: "running",
      durable: false,
    };
  }

  function cancelRun(taskId: string, runId: string): ExperimentalPiCancelAccepted {
    const task = tasks.get(taskId);
    if (task === undefined || task.activeRunId !== runId) {
      throw new BioMedAgentError("RUN_NOT_FOUND", "Experimental run was not found");
    }
    bus.publish(task.adapter.cancellationRequested(runId, "user requested"));
    void task.session.cancel("user requested").catch((error: unknown) => {
      for (const event of task.adapter.failed(runId, error)) bus.publish(event);
    });
    return { task_id: taskId, run_id: runId, status: "cancel_requested" };
  }

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://application-host");
      if (request.method === "POST" && url.pathname === "/experimental/pi/tasks") {
        sendJson(response, 201, await createTask(request));
        return;
      }
      const runs = /^\/experimental\/pi\/tasks\/([^/]+)\/runs$/.exec(url.pathname);
      if (request.method === "POST" && runs !== null) {
        sendJson(response, 202, await createRun(decodeURIComponent(runs[1] ?? ""), request));
        return;
      }
      const cancel = /^\/experimental\/pi\/tasks\/([^/]+)\/runs\/([^/]+)\/cancel$/.exec(
        url.pathname,
      );
      if (request.method === "POST" && cancel !== null) {
        sendJson(
          response,
          202,
          cancelRun(
            decodeURIComponent(cancel[1] ?? ""),
            decodeURIComponent(cancel[2] ?? ""),
          ),
        );
        return;
      }
      sendJson(response, 404, { error: { code: "NOT_FOUND", message: "Not Found" } });
    } catch (error) {
      const bounded =
        error instanceof BioMedAgentError
          ? error
          : new BioMedAgentError(
              "UPSTREAM_FAILURE",
              "Experimental Pi request failed",
              { cause: error },
            );
      sendJson(response, errorStatus(bounded), {
        error: { code: bounded.code, message: bounded.message },
      });
    }
  }

  webSocketServer.on("connection", (socket) => {
    const writer = new BoundedWebSocketWriter(socket, maxQueuedFrames);
    const subscriptions = new Map<string, () => void>();

    const sendControl = (frame: ExperimentalPiWebSocketControlFrame): void => {
      writer.send(frame);
    };
    socket.on("message", (raw: RawData) => {
      const rawText = rawDataText(raw);
      if (Buffer.byteLength(rawText) > MAX_WS_COMMAND_BYTES) {
        sendControl(controlError("invalid_command", "Command is too large"));
        return;
      }
      let command: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(rawText);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("command must be an object");
        }
        command = parsed as Record<string, unknown>;
      } catch {
        sendControl(controlError("invalid_command", "Command must be valid JSON"));
        return;
      }
      if (command.type === "ping") {
        sendControl({ type: "pong" });
        return;
      }
      const taskId = typeof command.task_id === "string" ? command.task_id : undefined;
      if (command.type === "subscribe" && taskId !== undefined) {
        if (Object.hasOwn(command, "after_sequence")) {
          sendControl(
            controlError(
              "experimental_replay_unavailable",
              "Experimental Pi streams are live-only and cannot replay",
              taskId,
            ),
          );
          return;
        }
        if (!bus.hasTask(taskId)) {
          sendControl(controlError("task_not_found", "Experimental task was not found", taskId));
          return;
        }
        subscriptions.get(taskId)?.();
        sendControl({ type: "subscribed", task_id: taskId });
        subscriptions.set(taskId, bus.subscribe(taskId, (event) => writer.send(event)));
        return;
      }
      if (command.type === "unsubscribe" && taskId !== undefined) {
        subscriptions.get(taskId)?.();
        subscriptions.delete(taskId);
        sendControl({ type: "unsubscribed", task_id: taskId });
        return;
      }
      sendControl(controlError("invalid_command", "Unsupported experimental command"));
    });
    socket.once("close", () => {
      writer.close();
      for (const unsubscribe of subscriptions.values()) unsubscribe();
      subscriptions.clear();
    });
  });

  return {
    handle(request, response) {
      const pathname = new URL(request.url ?? "/", "http://application-host").pathname;
      if (pathname !== "/experimental/pi" && !pathname.startsWith("/experimental/pi/")) {
        return false;
      }
      void dispatch(request, response);
      return true;
    },
    handleUpgrade(request, socket, head) {
      const pathname = new URL(request.url ?? "/", "http://application-host").pathname;
      if (pathname !== "/experimental/pi/ws" || closed) return false;
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
      return true;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      for (const client of webSocketServer.clients) client.close(1001, "Host shutdown");
      bus.close();
      const results = await Promise.allSettled(
        [...tasks.values()].map(async (task) => {
          try {
            await task.session.dispose();
          } finally {
            await task.disposeWorkspace();
          }
        }),
      );
      tasks.clear();
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, "Experimental Pi cleanup failed");
      }
    },
  };
}
