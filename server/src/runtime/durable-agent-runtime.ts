import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";

import type {
  BuildResult,
  EventEnvelope,
  EventPayload,
  JsonValue,
  TaskMode,
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
  DurableApprovalGate,
  type ApprovalGateHandle,
} from "./approval-gate.js";
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
const MAX_IMPORT_FILES = 10;
const MAX_IMPORT_FILE_BYTES = 500 * 1024 * 1024;
const MAX_IMPORT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
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
    /** Durable credential-approval gate (P5-D9); pass to business tools. */
    approvalGate: ApprovalGateHandle;
    /** Append a durable event for the currently active run (M2 core sink). */
    recordRunEvent: (payload: EventPayload) => Promise<void>;
  }) => Promise<DurableAgentWorkspace>;
  repository?: DurableTaskRepository;
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
  approvalGate: ApprovalGateHandle;
  /**
   * A standalone download-resume execution (no AI inference). The run is a
   * durable follow-up run whose tool lifecycle is synthesized directly, so
   * the frontend renders a tool-call bubble with a live progress strip.
   */
  activeDownload: {
    runId: string;
    controller: AbortController;
    promise: Promise<void>;
  } | null;
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

interface ImportUpload {
  name: string;
  bytes: Buffer;
  sha256: string;
}

function uploadFilename(value: string): string {
  const base = path.posix.basename(value.replaceAll("\\", "/"));
  if (base === "" || base === "." || base === "..") {
    throw new TypeError("Uploaded file has invalid filename");
  }
  const sanitized = base.replace(/[^A-Za-z0-9._-]/g, "_");
  if (sanitized === "") throw new TypeError("Uploaded file has invalid filename");
  return sanitized;
}

async function readImportForm(request: IncomingMessage): Promise<{
  requestId: string;
  note: string;
  uploads: ImportUpload[];
}> {
  const contentType = request.headers["content-type"];
  if (contentType === undefined || !contentType.toLowerCase().startsWith("multipart/form-data")) {
    throw new TypeError("Import tasks require multipart/form-data");
  }
  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMPORT_TOTAL_BYTES) {
    throw new RangeError("Total upload size exceeds limit");
  }
  const form = await new Response(Readable.toWeb(request), {
    headers: { "content-type": contentType },
  }).formData();
  const requestValue = form.get("request_id");
  const noteValue = form.get("input");
  if (typeof requestValue !== "string") throw new TypeError("request_id is required");
  const requestId = requestValue.trim();
  if (requestId === "") throw new TypeError("request_id is required");
  const note = typeof noteValue === "string" ? noteValue.trim() : "";
  const fileValues = form.getAll("files");
  if (fileValues.length === 0) throw new TypeError("At least one file is required");
  if (fileValues.length > MAX_IMPORT_FILES) throw new TypeError(`Too many files (max ${MAX_IMPORT_FILES})`);
  const uploads: ImportUpload[] = [];
  const names = new Set<string>();
  let total = 0;
  for (const value of fileValues) {
    if (typeof value === "string") throw new TypeError("Uploaded file is invalid");
    const name = uploadFilename(value.name);
    if (names.has(name)) throw new TypeError(`Duplicate uploaded filename: ${name}`);
    names.add(name);
    if (value.size > MAX_IMPORT_FILE_BYTES) {
      throw new RangeError(`File ${name} exceeds max size (${MAX_IMPORT_FILE_BYTES} bytes)`);
    }
    total += value.size;
    if (total > MAX_IMPORT_TOTAL_BYTES) throw new RangeError("Total upload size exceeds limit");
    const bytes = Buffer.from(await value.arrayBuffer());
    uploads.push({
      name,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return { requestId, note, uploads };
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
    task.approvalGate.setRunId(runId);
    task.activeRunId = runId;
    const execution = consumeRun(taskId, runId, input);
    activeExecutions.add(execution);
    const cleanup = (): void => {
      activeExecutions.delete(execution);
    };
    void execution.then(cleanup, cleanup);
  }

  async function createSession(taskId: string, runId: string): Promise<ActiveTask> {
    const approvalGate = new DurableApprovalGate(taskId, repository, runId);
    const workspace = await options.workspaceFactory({
      taskId,
      runId,
      approvalGate,
      recordRunEvent: async (payload) => {
        // Track the ACTIVE run: sessions outlive runs, so a second run's
        // core events must carry its own run_id.
        const activeRunId = activeTasks.get(taskId)?.activeRunId ?? runId;
        await repository.appendRunEvent(taskId, activeRunId, payload);
      },
    });
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
        approvalGate,
        activeDownload: null,
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
    await launchAcceptedTask(accepted, body.input as string);
    return accepted;
  }

  async function launchAcceptedTask(
    accepted: { task_id: string; run_id: string },
    input: string,
    prepare?: (taskRoot: string) => Promise<void>,
  ): Promise<void> {
    const snapshot = await repository.getSnapshot(accepted.task_id);
    const admittedRun = snapshot?.runs.find((run) => run.run_id === accepted.run_id);
    if (!activeTasks.has(accepted.task_id) && admittedRun?.status === "queued") {
      try {
        await prepare?.(pathForTask(options.tasksRoot, accepted.task_id));
        const task = await createSession(accepted.task_id, accepted.run_id);
        activeTasks.set(accepted.task_id, task);
        startRun(accepted.task_id, accepted.run_id, input);
      } catch (error) {
        await repository.appendRunEvent(accepted.task_id, accepted.run_id, {
          type: "run_failed",
          error: "Agent session could not start",
          error_code: "configuration_error",
        });
        throw error;
      }
    }
  }

  async function createImportTask(request: IncomingMessage): Promise<unknown> {
    const imported = await readImportForm(request);
    const fileList = imported.uploads.map((upload) => upload.name).join(", ");
    const hashes = imported.uploads.map((upload) => `${upload.name}=${upload.sha256}`).join(", ");
    const composedInput = imported.note === ""
      ? `Import ${imported.uploads.length} file(s) into local cache: ${fileList}`
      : `${imported.note}\n\n[uploaded_files (${imported.uploads.length}): ${fileList}]`;
    const durableInput = `${composedInput}\n[uploaded_sha256: ${hashes}]`;
    const accepted = await repository.createTask({
      requestId: imported.requestId,
      input: durableInput,
      databases: [],
      mode: "import",
    });
    await launchAcceptedTask(accepted, durableInput, async (taskRoot) => {
      const sourceAssets = path.join(taskRoot, "source_assets");
      await mkdir(sourceAssets, { recursive: true });
      await Promise.all(imported.uploads.map((upload) => (
        writeFile(path.join(sourceAssets, upload.name), upload.bytes, { flag: "wx" })
      )));
    });
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
    // A suspended credential approval must not outlive the cancelled run.
    task.approvalGate.rejectPending(runId, new Error("run cancelled"));
    // A standalone download-resume run has no AI inference to cancel; abort
    // the in-flight downloader and let its promise emit run_cancelled.
    const download = task.activeDownload;
    if (download !== null && download.runId === runId) {
      download.controller.abort();
    }
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

  /**
   * Resume an interrupted acquisition directly (P5-D3 part-file resume)
   * without an AI inference pass: create a durable follow-up run, synthesize
   * the tool lifecycle (started/progress/completed) around the configured
   * tool's ``execute``, and close the run. The user then sends "继续" to
   * start a normal AI run for the remaining analysis.
   */
  async function resumeDownload(
    taskId: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const requestId = requiredString(body, "request_id", 256);
    const toolName = requiredString(body, "tool_name", 128);
    const argumentsValue = body.arguments;
    if (
      argumentsValue === null ||
      argumentsValue === undefined ||
      typeof argumentsValue !== "object" ||
      Array.isArray(argumentsValue)
    ) {
      throw new TypeError("arguments must be an object");
    }
    const snapshot = await repository.getSnapshot(taskId);
    if (snapshot === null) throw new ReferenceError("Task not found");
    if (snapshot.task.mode !== "agent") {
      throw new DurableTaskConflictError(
        "task_not_continuable",
        "Task cannot be continued",
      );
    }
    if (snapshot.task.active_run_id !== null) {
      throw new DurableTaskConflictError(
        "active_run",
        "Task already has an active run",
      );
    }
    const task = activeTasks.get(taskId);
    if (task === undefined) {
      throw new ReferenceError("任务会话不可用，请使用“继续”让 AI 恢复下载");
    }
    const tool = task.workspace.tools.find(
      (candidate) => candidate.name === toolName,
    );
    if (tool === undefined) {
      throw new ReferenceError(`Tool not found: ${toolName}`);
    }
    // 独立续传 run：只创建 run 容器，不启动 AI 推理，直接执行下载工具续传。
    const accepted = await repository.createRun(taskId, {
      requestId,
      input: "继续下载被中断的数据文件（自动续传）",
    });
    const runId = accepted.run_id;
    task.workspace.setRunId?.(runId);
    task.approvalGate.setRunId(runId);
    task.activeRunId = runId;
    await repository.appendRunEvents(taskId, runId, [
      { type: "run_started" },
      {
        type: "tool_started",
        tool_call_id: `resume_${runId.slice(-8)}`,
        tool_name: tool.name,
        arguments: argumentsValue as Record<string, JsonValue>,
      },
    ]);
    const controller = new AbortController();
    const promise = executeDownloadResume(
      taskId,
      runId,
      tool,
      argumentsValue,
      controller.signal,
    );
    task.activeDownload = { runId, controller, promise };
    void promise.finally(() => {
      if (task.activeDownload?.runId === runId) task.activeDownload = null;
      if (task.activeRunId === runId) task.activeRunId = null;
    });
    return accepted;
  }

  async function executeDownloadResume(
    taskId: string,
    runId: string,
    tool: BioMedAgentTool,
    argumentsValue: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    const cancel = async (reason: string): Promise<void> => {
      await repository.appendRunEvent(taskId, runId, {
        type: "run_cancelled",
        reason,
      });
    };
    let result: { content: string; isError?: boolean };
    try {
      result = await tool.execute(argumentsValue, signal);
    } catch (error) {
      if (signal.aborted) return cancel("用户取消了下载恢复");
      const message = error instanceof Error ? error.message : String(error);
      await repository.appendRunEvents(taskId, runId, [
        {
          type: "tool_completed",
          tool_name: tool.name,
          output: message,
          is_error: true,
        },
        {
          type: "run_failed",
          error: message,
          error_code: "internal_error",
        },
      ]);
      return;
    }
    if (signal.aborted) return cancel("用户取消了下载恢复");
    const isError = result.isError === true;
    await repository.appendRunEvents(taskId, runId, [
      {
        type: "tool_completed",
        tool_name: tool.name,
        output: result.content,
        is_error: isError,
      },
      isError
        ? {
            type: "run_failed",
            error: result.content,
            error_code: "download_incomplete",
          }
        : { type: "run_completed", build_result: null },
    ]);
  }

  async function resumeRun(taskId: string, runId: string, body: Record<string, unknown>): Promise<unknown> {
    const snapshot = await repository.getSnapshot(taskId);
    if (snapshot === null || !snapshot.runs.some((run) => run.run_id === runId)) {
      throw new ReferenceError("Run not found");
    }
    const requestId = requiredString(body, "request_id", 256);
    let decision: "approve" | "reject";
    if (body.decision === "approve" || body.decision === "reject") {
      decision = body.decision;
    } else {
      throw new TypeError("decision must be approve or reject");
    }
    const detail = body.detail;
    const payload = {
      type: "user_input_resumed" as const,
      request_id: requestId,
      decision,
      detail: detail === null || detail === undefined || typeof detail !== "object"
        ? {}
        : detail as Record<string, JsonValue>,
    };
    await repository.appendRunEvent(taskId, runId, payload);
    const task = activeTasks.get(taskId);
    task?.approvalGate.resolvePending(runId, decision);
    return await repository.getSnapshot(taskId);
  }

  async function compactTask(taskId: string): Promise<Record<string, string>> {
    const snapshot = await repository.getSnapshot(taskId);
    if (snapshot === null) throw new ReferenceError("Task not found");
    const runId = snapshot.task.active_run_id;
    if (runId === null) {
      throw new DurableTaskConflictError("active_run", "Task has no active run to compact");
    }
    const task = activeTasks.get(taskId);
    if (task === undefined || task.activeRunId !== runId || task.session.compact === undefined) {
      throw new DurableTaskConflictError("active_run", "Task compaction is unavailable");
    }
    const result = await task.session.compact();
    await repository.appendRunEvent(taskId, runId, {
      type: "conversation_compacted",
      covered_through_run_id: runId,
      summary_digest: createHash("sha256").update(result.summary, "utf8").digest("hex"),
    });
    return { status: "compaction_requested", task_id: taskId, run_id: runId };
  }

  async function injectContext(
    taskId: string,
    body: Record<string, unknown>,
  ): Promise<Record<string, string | null>> {
    const text = requiredString(body, "text", 4_000);
    const expected = body.expected_run_id;
    if (expected !== null && expected !== undefined && typeof expected !== "string") {
      throw new TypeError("expected_run_id must be a string or null");
    }
    const snapshot = await repository.getSnapshot(taskId);
    if (snapshot === null) throw new ReferenceError("Task not found");
    const runId = snapshot.task.active_run_id;
    if (runId === null) {
      throw new DurableTaskConflictError("active_run", "Task has no active run to steer");
    }
    if (typeof expected === "string" && expected !== runId) {
      throw new DurableTaskConflictError(
        "active_run",
        `expected active run ${expected} but task has run ${runId}`,
      );
    }
    const task = activeTasks.get(taskId);
    if (task === undefined || task.activeRunId !== runId || task.session.steer === undefined) {
      throw new DurableTaskConflictError("active_run", "Run is no longer active");
    }
    const content = (
      "【方向调整】用户中断了上一次作答并调整了方向或做了补充。" +
      "请不要忘记上一次的任务内容，按照用户的内容继续作答或终止作答，" +
      `具体依照用户语义完成：\n${text}`
    );
    await task.session.steer(content);
    return {
      status: "steered",
      task_id: taskId,
      run_id: runId,
      message_id: null,
      content,
    };
  }

  async function deleteTask(taskId: string): Promise<void> {
    const task = activeTasks.get(taskId);
    if (task !== undefined) {
      const snapshot = await repository.getSnapshot(taskId);
      if (snapshot !== null && snapshot.task.active_run_id !== null) {
        throw new DurableTaskConflictError("active_run", "Active tasks cannot be deleted");
      }
      activeTasks.delete(taskId);
      await task.session.dispose();
    }
    await repository.deleteTask(taskId);
  }

  async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://application-host");
      if (request.method === "POST" && url.pathname === "/api/v1/import/tasks") {
        sendJson(response, 202, await createImportTask(request));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/v1/tasks") {
        sendJson(response, 202, await createTask(request));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/v1/tasks") {
        const limit = Number(url.searchParams.get("limit") ?? "50");
        sendJson(response, 200, await repository.listTasks(limit));
        return;
      }
      const task = /^\/api\/v1\/tasks\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && task !== null) {
        const snapshot = await repository.getSnapshot(decodeURIComponent(task[1] ?? ""));
        sendJson(response, snapshot === null ? 404 : 200, snapshot ?? { detail: "Task not found" });
        return;
      }
      if (request.method === "DELETE" && task !== null) {
        await deleteTask(decodeURIComponent(task[1] ?? ""));
        response.writeHead(204).end();
        return;
      }
      const compact = /^\/api\/v1\/tasks\/([^/]+)\/compact$/.exec(url.pathname);
      if (request.method === "POST" && compact !== null) {
        sendJson(response, 202, await compactTask(decodeURIComponent(compact[1] ?? "")));
        return;
      }
      const inject = /^\/api\/v1\/tasks\/([^/]+)\/inject-context$/.exec(url.pathname);
      if (request.method === "POST" && inject !== null) {
        sendJson(response, 202, await injectContext(
          decodeURIComponent(inject[1] ?? ""),
          await readJsonBody(request),
        ));
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
      const downloadResume = /^\/api\/v1\/tasks\/([^/]+)\/downloads\/resume$/.exec(url.pathname);
      if (request.method === "POST" && downloadResume !== null) {
        sendJson(response, 202, await resumeDownload(
          decodeURIComponent(downloadResume[1] ?? ""),
          await readJsonBody(request),
        ));
        return;
      }
      const resume = /^\/api\/v1\/tasks\/([^/]+)\/runs\/([^/]+)\/resume$/.exec(url.pathname);
      if (request.method === "POST" && resume !== null) {
        sendJson(response, 200, await resumeRun(
          decodeURIComponent(resume[1] ?? ""),
          decodeURIComponent(resume[2] ?? ""),
          await readJsonBody(request),
        ));
        return;
      }
      const subagentCancel = /^\/api\/v1\/tasks\/([^/]+)\/runs\/([^/]+)\/subagents\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && subagentCancel !== null) {
        const taskId = decodeURIComponent(subagentCancel[1] ?? "");
        const runId = decodeURIComponent(subagentCancel[2] ?? "");
        const snapshot = await repository.getSnapshot(taskId);
        if (snapshot === null || !snapshot.runs.some((run) => run.run_id === runId)) {
          throw new ReferenceError("Run not found");
        }
        throw new ReferenceError("Subagent not found");
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
      } else if (error instanceof RangeError) {
        sendJson(response, 413, { detail: error.message });
      } else {
        sendJson(response, 500, { detail: "Task runtime failed" });
      }
    }
  }

  webSocketServer.on("connection", (socket) => {
    sockets.add(socket);
    const subscriptions = new Map<string, Subscription>();
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
        send({ type: "pong" });
        return;
      }
      const taskId = typeof command.task_id === "string" ? command.task_id : "";
      if (!SAFE_ID.test(taskId)) {
        send(controlError("invalid_command", "Invalid WebSocket command"));
        return;
      }
      if (!taskId.startsWith("task_ts_")) {
        send(controlError("task_not_found", "Task not found", taskId));
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
    });
  });

  return {
    repository,
    handle(request, response) {
      const requestPath = pathname(request);
      if (requestPath === "/api/v1/import/tasks") {
        void dispatch(request, response);
        return true;
      }
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

function pathForTask(tasksRoot: string, taskId: string): string {
  if (!SAFE_ID.test(taskId)) throw new ReferenceError("Task not found");
  return path.join(tasksRoot, taskId);
}
