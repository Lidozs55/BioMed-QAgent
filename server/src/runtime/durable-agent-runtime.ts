import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";

import { sha256Bytes } from "../dataset/adapters/hashing.js";
import { SAFE_ID } from "./safe-id.js";

import type {
  EventEnvelope,
  EventPayload,
  HumanReviewRecord,
  HILRequest,
  JsonValue,
  ResumeHILInput,
  TaskMode,
  WebSocketControlFrame,
} from "@biomed/contracts";
import {
  APIError,
  parseJsonTextStrict,
  parseResumeHILInput,
  parseUntrustedArtifactMetadata,
  parseUntrustedArtifactReceipt,
  type UntrustedArtifactReceipt,
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
  type PermissionBroker,
  type PermissionBrokerRegistry,
} from "../agent/permissions/broker.js";
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
  getUntrustedArtifact,
  getUntrustedArtifactContent,
  listUntrustedArtifacts,
  storeUntrustedArtifact,
} from "./untrusted-artifact-store.js";
import {
  DurableTaskConflictError,
  DurableTaskRepository,
} from "./task-repository.js";

import { DurableHILStore, HILConflictError } from "./hil-store.js";
import { readTaskTextFile } from "./task-file.js";
import type { HILGatePreReview } from "./hil-pre-review.js";
import { claimTasksRootExclusive } from "./host-lease.js";

import { readExecutionContinuation } from "./execution-continuation.js";

import { DiskWorkspaceManager, type WorkspaceManager } from "../agent/workspace/workspace-manager.js";


const MAX_BODY_BYTES = 64 * 1024;
const MAX_INPUT_LENGTH = 64 * 1024;
const MAX_IMPORT_FILES = 10;
const MAX_IMPORT_FILE_BYTES = 500 * 1024 * 1024;
const MAX_IMPORT_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_WS_COMMAND_BYTES = 8 * 1024;
const MAX_WS_BUFFERED_BYTES = 64 * 1024;

// Pi's threshold compaction ends the turn without auto-continue. The runtime
// resumes the run with a fresh turn so long tasks survive the compaction
// boundary; this bounds how many times a single run may be resumed.
const MAX_COMPACTION_CONTINUATIONS = 3;
const CONTINUE_AFTER_COMPACTION_PROMPT =
  "Continue the task. Your previous turn was compacted; resume from where you left off.";

export interface DurableAgentWorkspace {
  root: string;
  tools: readonly BioMedAgentTool[];
  /** Permission control plane for this task (plan §32–§33). */
  permissionBroker?: PermissionBroker;
  setRunId?: (runId: string) => void;
  setPiSessionId?: (piSessionId: string) => void;
  getCurrentPublicationId?: () => string | null;
  /**
   * Run-termination hook (round-4 audit): the workspace clears per-run
   * temporary grants when the run ends, so the settings UI never lists
   * stale run grants after the run is done.
   */
  onRunEnd?: (runId: string) => void;
  dispose(): Promise<void>;
}

export interface DurableAgentRuntimeOptions {
  tasksRoot: string;
  /**
   * Exclusive tasks-root lease test hook: `holderPid` simulates a lease
   * recorded by that pid before claiming; `pid` simulates the claiming
   * process id. Production callers omit it.
   */
  leaseOverride?: { holderPid?: number; pid?: number };
  /** Owns ``data/workspaces/<taskId>`` lifecycle (create/remove/restore). */
  workspaceManager?: WorkspaceManager;
  /** Live broker registry for preset-switch invalidation + grant management. */
  permissionBrokerRegistry?: PermissionBrokerRegistry;
  /**
   * Three-tier HIL approval seam (human_review / llm_pre_review /
   * auto_approve). Null keeps the classic human-only flow.
   */
  hilPreReview?: HILGatePreReview | null;
  adapter: BioMedAgentAdapter;
  workspaceFactory: (identity: {
    taskId: string;
    runId: string;
    /** Durable credential-approval gate (P5-D9); pass to business tools. */
    approvalGate: ApprovalGateHandle;
    /** Append a durable event for the currently active run (M2 core sink). */
    recordRunEvent: (payload: EventPayload) => Promise<void>;
    /** Task mode (agent / fixture / import); import tasks get extra tools. */
    mode: TaskMode;
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

  permissionBroker: PermissionBroker | null;
}

/**
 * A task-level standalone download (P5-D3 resume, no AI run) that is
 * currently in flight. Tracked independently of ``activeTasks`` so a resume
 * launched after a server restart (when the session map is empty) can still
 * be cancelled via ``downloads/cancel``.
 */
interface ActiveDownloadHandle {
  controller: AbortController;
  promise: Promise<void>;
}

/**
 * A deterministic dataset-execution continuation (cross-restart resume) that is
 * currently in flight for a run. Tracked independently of ``activeTasks``:
 * the continuation runs the TS Core executor with a lightweight tool
 * workspace (no AI session) so the resumed build never depends on the model
 * reinterpreting a synthetic prompt. While it is in flight, later HIL
 * resolutions for the same run are delivered to its gate.
 */
interface ActiveContinuationHandle {
  controller: AbortController;
  gate: DurableApprovalGate;
  promise: Promise<void>;
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
  const value = parseJsonTextStrict(
    Buffer.concat(chunks).toString("utf8"),
    { maxChars: MAX_BODY_BYTES },
  );
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Request body must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectCorruptedText(value: string, field: string): string {
  if (value.includes("\uFFFD")) {
    throw new TypeError(`${field} contains corrupted UTF-8 text (U+FFFD replacement character)`);
  }
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new TypeError(`${field} contains an invalid UTF-16 surrogate`);
  }
  return value;
}

function requiredString(body: Record<string, unknown>, name: string, max = 128): string {
  const value = body[name];
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new TypeError(`${name} must be a bounded non-empty string`);
  }
  return rejectCorruptedText(value, name);
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
      sha256: sha256Bytes(bytes),
    });
  }
  return { requestId, note, uploads };
}

function rawDataText(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return Buffer.from(raw).toString("utf8");
}

function isDynamicPublicationAcceptance(
  request: Pick<HILRequest, "requirement_id" | "review_type"> | null,
): boolean {
  return request?.requirement_id !== null && request?.review_type === "publication_acceptance";
}

/** GET quarantine listing response body (receipts are not formal artifacts). */
interface QuarantineListing {
  items: UntrustedArtifactReceipt[];
}

function quarantineListing(receipts: UntrustedArtifactReceipt[]): QuarantineListing {
  return { items: receipts.map((receipt) => parseUntrustedArtifactReceipt(receipt)) };
}

function sanitizeQuarantineFilename(value: string): string {
  const base = path.posix.basename(value.replaceAll("\\", "/"));
  const sanitized = base.replace(/[^A-Za-z0-9._-]/g, "_");
  return sanitized === "" ? "artifact.bin" : sanitized;
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
  // Fail fast before the recovery sweep: a second live host on the same
  // tasks root would interrupt this process's runs and interleave
  // events.jsonl appends (docs/ISSUES.md §运行环境).
  await claimTasksRootExclusive(options.tasksRoot, options.leaseOverride);

  const repository = options.repository ?? new DurableTaskRepository(options.tasksRoot);

  const hilStore = new DurableHILStore(repository);
  const hilRecoveries = await hilStore.reconcileTaskTimeline();
  await repository.rejectOrphanedPermissionRequests();
  await repository.recoverActiveRuns(new Set(
    hilRecoveries.map((recovery) => `${recovery.task_id}:${recovery.run_id}`),
  ));

  // Tests may omit the manager; the default simply removes a sibling dir.
  const workspaceManager = options.workspaceManager ?? new DiskWorkspaceManager({
    workspacesRoot: path.join(path.dirname(path.dirname(options.tasksRoot)), "workspaces"),
  });

  const failClosedDynamicPublicationRecovery = async (
    taskId: string,
    runId: string,
  ): Promise<void> => {
    await hilStore.cancelPendingForRun(taskId, runId);
    const snapshot = await repository.getSnapshot(taskId);
    const run = snapshot?.runs.find((candidate) => candidate.run_id === runId);
    if (
      run !== undefined &&
      run.status !== "completed" &&
      run.status !== "failed" &&
      run.status !== "cancelled"
    ) {
      await repository.appendRunEvent(taskId, runId, {
        type: "run_failed",
        error: "Dynamic publication HIL cannot continue after Application Host restart without a deterministic continuation",
        error_code: "configuration_error",
      });
    }
  };

  const activeTasks = new Map<string, ActiveTask>();
  const activeDownloads = new Map<string, ActiveDownloadHandle>();
  const activeContinuations = new Map<string, ActiveContinuationHandle>();
  const activeExecutions = new Set<Promise<void>>();
  const resumeOperations = new Map<string, Promise<unknown>>();
  const suspendedRuns = new Set<string>();
  const webSocketServer = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();
  let closed = false;

  async function consumeRun(taskId: string, runId: string, input: string): Promise<void> {
    const task = activeTasks.get(taskId);
    if (task === undefined) return;
    const runKey = `${taskId}:${runId}`;
    try {
      // Run-entry preflight: reject before the first Pi turn when the model
      // budget cannot hold the prompt plus max_tokens and the safety reserve.
      const budget = task.session.getBudget?.() ?? null;
      if (
        budget !== null &&
        budget.contextWindow - budget.maxTokens - budget.reserveTokens <= 0
      ) {
        await repository.appendRunEvent(taskId, runId, {
          type: "run_failed",
          error:
            `Context budget exhausted: context_window ${budget.contextWindow} minus ` +
            `max_tokens ${budget.maxTokens} and safety reserve ${budget.reserveTokens} ` +
            "leaves no room for the prompt",
          error_code: "context_budget_exhausted",
        });
        return;
      }
      let turnInput = input;
      for (let continuation = 0; ; continuation += 1) {
        let compacted = false;
        for await (const source of task.session.run(turnInput)) {
          if (suspendedRuns.has(runKey)) return;
          const payloads = task.adapter.adapt(runId, source).map((event) => event.payload);
          for (const payload of payloads) {
            if (payload.type === "conversation_compacted") compacted = true;
          }
          if (payloads.length > 0) {
            await repository.appendRunEvents(taskId, runId, payloads);
          }
        }
        // A threshold compaction ends the Pi turn without auto-continue; the
        // adapter therefore emitted no terminal event. Resume with a fresh
        // turn so the agent can finish the task, unless the run was suspended,
        // the resume budget is exhausted (then force the terminal event), or
        // the run already emitted its publication — the product is complete,
        // so post-publication compaction must not spawn busy-work turns.
        if (!compacted || suspendedRuns.has(runKey)) break;
        const published = task.workspace.getCurrentPublicationId?.() ?? null;
        if (
          published !== null ||
          continuation >= MAX_COMPACTION_CONTINUATIONS
        ) {
          const payloads = task.adapter.completeRun(runId).map((event) => event.payload);
          if (payloads.length > 0) {
            await repository.appendRunEvents(taskId, runId, payloads);
          }
          break;
        }
        turnInput = CONTINUE_AFTER_COMPACTION_PROMPT;
      }
    } catch (error) {
      if (suspendedRuns.has(runKey)) return;
      for (const event of task.adapter.failed(runId, error)) {
        await repository.appendRunEvent(taskId, runId, event.payload);
      }
    } finally {
      if (task.activeRunId === runId) task.activeRunId = null;
      // Round-4 audit: drop the run's temporary grants at run end — the
      // evaluator already ignores them (runId mismatch), but the settings UI
      // must not keep listing grants that can never fire again.
      task.workspace.onRunEnd?.(runId);
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
    task.session.resetRunProgress?.();
    task.activeRunId = runId;
    const execution = consumeRun(taskId, runId, input);
    activeExecutions.add(execution);
    const cleanup = (): void => {
      activeExecutions.delete(execution);
    };
    void execution.then(cleanup, cleanup);
  }

  async function createSession(taskId: string, runId: string, mode: TaskMode): Promise<ActiveTask> {
    const approvalGate = new DurableApprovalGate(
      taskId,
      repository,
      runId,
      hilStore,
      options.hilPreReview ?? null,
    );
    const workspace = await options.workspaceFactory({
      taskId,
      runId,
      mode,
      approvalGate,
      recordRunEvent: async (payload) => {
        // Track the ACTIVE run: sessions outlive runs, so a second run's
        // core events must carry its own run_id.
        const activeRunId = activeTasks.get(taskId)?.activeRunId ?? runId;
        await repository.appendRunEvent(taskId, activeRunId, payload);
      },
    });
    const sessionDir = path.join(options.tasksRoot, taskId, "state", "pi-session");
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
        initialToolNames: [
          "inspect_dataset_execution_routes",
          "validate_dataset_execution",
          "execute_dataset_execution",
          "prepare_dynamic_family_publication",
          "submit_dynamic_family_publication",
        ],
        getCurrentPublicationId: () => workspace.getCurrentPublicationId?.() ?? null,
        cleanup: disposeWorkspace,
      });
      workspace.setPiSessionId?.(session.piSessionId);
      await repository.recordPiSessionId(taskId, session.piSessionId);
      const active: ActiveTask = {
        session,
        workspace: { ...workspace, dispose: disposeWorkspace },
        adapter: new PiEventAdapter({ taskId }),
        activeRunId: null,
        approvalGate,


        permissionBroker: workspace.permissionBroker ?? null,

      };
      if (options.permissionBrokerRegistry !== undefined && active.permissionBroker !== null) {
        options.permissionBrokerRegistry.register(taskId, active.permissionBroker);
      }
      return active;
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
        const task = await createSession(
          accepted.task_id,
          accepted.run_id,
          snapshot?.task.mode ?? "agent",
        );
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
        task = await createSession(taskId, accepted.run_id, before?.task.mode ?? "agent");
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
    const pendingHIL = await hilStore.findPendingForRun(taskId, runId);
    const continuation = activeContinuations.get(`${taskId}:${runId}`);
    if (task === undefined && (pendingHIL !== null || continuation !== undefined)) {
      await repository.appendRunEvent(taskId, runId, {
        type: "run_cancel_requested",
        reason: null,
      });
      await hilStore.cancelPendingForRun(taskId, runId);
      // A deterministic continuation in flight must stop too, otherwise the
      // executor would keep grinding after the run was cancelled.
      continuation?.controller.abort();
      await repository.appendRunEvent(taskId, runId, {
        type: "run_cancelled",
        reason: "user requested",
      });
      return repository.getSnapshot(taskId);
    }
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
    await hilStore.cancelPendingForRun(taskId, runId);
    task.approvalGate.rejectPending(runId, new Error("run cancelled"));

    // An in-flight standalone download is a task-level entity independent of
    // this AI run; cancelling the run does not abort it. Use the dedicated
    // downloads/cancel endpoint to stop a download.

    // A suspended permission request must not outlive the cancelled run either.
    task.permissionBroker?.rejectPending(runId, new Error("run cancelled"));
    // The session cancel can itself hang on a stream that never times out;
    // bound it so the durable terminal is never hostage to the zombie stream.
    let cancelTimer: NodeJS.Timeout | undefined;
    await Promise.race([
      task.session.cancel("user requested"),
      new Promise<void>((resolve) => {
        cancelTimer = setTimeout(resolve, options.cancellationTimeoutMs ?? 10_000);
      }),
    ]);
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
    } catch {
      // The session never acknowledged cancellation (observed with a provider
      // stream that stays silent forever): force the durable terminal, free
      // the in-memory active-run slot, and mute the zombie execution loop so
      // it cannot append a duplicate terminal if it ever wakes.
      const runKey = `${taskId}:${runId}`;
      suspendedRuns.add(runKey);
      if (task.activeRunId === runId) task.activeRunId = null;
      task.workspace.onRunEnd?.(runId);
      await repository.appendRunEvent(taskId, runId, {
        type: "run_cancelled",
        reason: "user requested (forced; agent session did not acknowledge cancellation)",
      });
    } finally {
      if (cancelTimer !== undefined) clearTimeout(cancelTimer);
      if (timer !== undefined) clearTimeout(timer);
      unsubscribeTerminal?.();
    }
    return await repository.getSnapshot(taskId);
  }

  /**
   * Resume an interrupted acquisition directly (P5-D3 part-file resume)
   * without an AI inference pass and WITHOUT creating a new run. The download
   * is a task-level entity: the resume execution replays its progress and
   * completion onto the original (host) run's event stream using the original
   * tool-call id, so the frontend keeps updating the original tool-call
   * bubble (no new run, no new message, no duplicate component). The user
   * later sends "继续" to start a normal AI run for the remaining analysis.
   */
  async function resumeDownload(
    taskId: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const runId = requiredString(body, "run_id", 128);
    const toolCallId = requiredString(body, "tool_call_id", 128);
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
    // The original (host) run must exist; progress/completion are replayed
    // onto its event stream.
    if (!snapshot.runs.some((run) => run.run_id === runId)) {
      throw new ReferenceError("Run not found");
    }
    const existing = activeTasks.get(taskId);
    if (activeDownloads.has(taskId)) {
      throw new DurableTaskConflictError(
        "active_download",
        "A download is already in progress",
      );
    }
    // Resolve the tool execution environment. The normal path reuses the
    // task session's workspace; after a server restart the session is gone
    // (activeTasks cleared), so rebuild a lightweight workspace (tool bundle
    // only, no AI session) — the task can still resume without needing the
    // model to be reachable.
    const workspace =
      existing === undefined
        ? await options.workspaceFactory({
            taskId,
            runId,
            mode: snapshot.task.mode,
            approvalGate: new DurableApprovalGate(taskId, repository, runId),
            recordRunEvent: async (payload) => {
              await repository.appendRunEvent(taskId, runId, payload);
            },
          })
        : existing.workspace;
    if (existing !== undefined) {
      existing.workspace.setRunId?.(runId);
      existing.approvalGate.setRunId(runId);
    }
    const tool = workspace.tools.find(
      (candidate) => candidate.name === toolName,
    );
    if (tool === undefined) {
      if (existing === undefined) await workspace.dispose();
      throw new ReferenceError(`Tool not found: ${toolName}`);
    }
    // Reuse the original tool call: a tool_started carrying the original
    // tool_call_id on the host run makes the frontend reducer upsert the
    // existing bubble (status → running) instead of creating a new one.
    await repository.appendRunEvent(taskId, runId, {
      type: "tool_started",
      tool_call_id: toolCallId,
      tool_name: tool.name,
      arguments: argumentsValue as Record<string, JsonValue>,
    });
    const controller = new AbortController();
    const promise = executeDownloadResume(
      taskId,
      runId,
      toolCallId,
      tool,
      argumentsValue,
      controller.signal,
    );
    // Track the in-flight download independently of the session map so a
    // resume launched after a server restart can still be cancelled.
    activeDownloads.set(taskId, { controller, promise });
    void promise.finally(() => {
      if (activeDownloads.get(taskId)?.promise === promise) {
        activeDownloads.delete(taskId);
      }
      if (existing === undefined) {
        void workspace.dispose();
      }
    });
    return { task_id: taskId, run_id: runId };
  }

  async function executeDownloadResume(
    taskId: string,
    runId: string,
    toolCallId: string,
    tool: BioMedAgentTool,
    argumentsValue: unknown,
    signal: AbortSignal,
  ): Promise<void> {
    let result: { content: string; isError?: boolean };
    try {
      result = await tool.execute(argumentsValue, signal);
    } catch (error) {
      // User-cancelled: emit nothing — the host run is already terminal and
      // the frontend stall detection (no fresh progress) flips the bubble
      // back to "恢复下载". Failures are reported on the host tool call.
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      await repository.appendRunEvent(taskId, runId, {
        type: "tool_completed",
        tool_call_id: toolCallId,
        tool_name: tool.name,
        output: message,
        is_error: true,
      });
      return;
    }
    if (signal.aborted) return;
    await repository.appendRunEvent(taskId, runId, {
      type: "tool_completed",
      tool_call_id: toolCallId,
      tool_name: tool.name,
      output: result.content,
      is_error: result.isError === true,
    });
  }

  /** Abort the task's in-flight standalone download (if any). */
  async function cancelDownload(taskId: string): Promise<unknown> {
    const snapshot = await repository.getSnapshot(taskId);
    if (snapshot === null) throw new ReferenceError("Task not found");
    const handle = activeDownloads.get(taskId);
    if (handle === undefined) {
      throw new DurableTaskConflictError(
        "active_download",
        "No download is in progress",
      );
    }
    handle.controller.abort();
    return { status: "cancel_requested", task_id: taskId };
  }

  /**
   * Receive an opaque, explicitly non-authoritative artifact into the task's
   * quarantine (review/download only). Never a publication: no publish/, no
   * events.jsonl append, no formal projection, no source_assets write.
   */
  async function submitQuarantineArtifact(taskId: string, request: IncomingMessage): Promise<unknown> {
    if (await repository.getSnapshot(taskId) === null) throw new ReferenceError("Task not found");
    const contentType = request.headers["content-type"];
    if (contentType === undefined || !contentType.toLowerCase().startsWith("multipart/form-data")) {
      throw new TypeError("Quarantine submission requires multipart/form-data");
    }
    const form = await new Response(Readable.toWeb(request), {
      headers: { "content-type": contentType },
    }).formData();
    const metadataValue = form.get("metadata");
    const fileValue = form.get("file");
    if (typeof metadataValue !== "string") throw new TypeError("metadata is required");
    if (fileValue === null || typeof fileValue === "string") throw new TypeError("file is required");
    if (fileValue.size === 0) throw new TypeError("Submitted file is empty");
    if (fileValue.size > MAX_IMPORT_FILE_BYTES) throw new RangeError("Submitted file exceeds limit");
    let metadata;
    try {
      metadata = parseUntrustedArtifactMetadata(parseJsonTextStrict(metadataValue));
    } catch (error) {
      if (error instanceof APIError) throw new TypeError(error.message, { cause: error });
      throw error;
    }
    return storeUntrustedArtifact(
      pathForTask(options.tasksRoot, taskId),
      taskId,
      metadata,
      Buffer.from(await fileValue.arrayBuffer()),
    );
  }

  async function listQuarantineArtifacts(taskId: string): Promise<QuarantineListing> {
    if (await repository.getSnapshot(taskId) === null) throw new ReferenceError("Task not found");
    return quarantineListing(await listUntrustedArtifacts(pathForTask(options.tasksRoot, taskId)));
  }

  async function getQuarantineArtifact(taskId: string, submissionId: string): Promise<unknown> {
    if (await repository.getSnapshot(taskId) === null) throw new ReferenceError("Task not found");
    const receipt = await getUntrustedArtifact(pathForTask(options.tasksRoot, taskId), submissionId);
    if (receipt === null) throw new ReferenceError("Quarantine submission not found");
    return receipt;
  }

  async function getQuarantineArtifactContent(
    taskId: string,
    submissionId: string,
  ): Promise<{ receipt: UntrustedArtifactReceipt; bytes: Buffer }> {
    if (await repository.getSnapshot(taskId) === null) throw new ReferenceError("Task not found");
    const stored = await getUntrustedArtifactContent(pathForTask(options.tasksRoot, taskId), submissionId);
    if (stored === null) throw new ReferenceError("Quarantine submission not found");
    if (stored.bytes.length !== stored.receipt.size_bytes || sha256Bytes(stored.bytes) !== stored.receipt.sha256) {
      throw new ArtifactIntegrityError("Quarantine artifact bytes do not match its receipt");
    }
    return stored;
  }

  async function resumeRunOnce(taskId: string, runId: string, body: Record<string, unknown>): Promise<unknown> {
    const snapshot = await repository.getSnapshot(taskId);
    const run = snapshot?.runs.find((candidate) => candidate.run_id === runId);
    if (snapshot === null || run === undefined) {
      throw new ReferenceError("Run not found");
    }
    const requestId = requiredString(body, "request_id", 256);
    const storedRequest = await hilStore.getRequest(taskId, requestId);
    const pendingRequest = await hilStore.findPendingForRun(taskId, runId);
    if (pendingRequest !== null && pendingRequest.request_id !== requestId) {
      throw new HILConflictError("request_id does not match the pending HIL request");
    }

    if (storedRequest === null && pendingRequest === null) {
      if (body.evidence_digest !== undefined || typeof body.decision === "object") {
        throw new ReferenceError("HIL request not found");
      }
      if (body.decision !== "approve" && body.decision !== "reject") {
        throw new TypeError("decision must be approve or reject");
      }
      if (run.status !== "awaiting_user_input") {
        throw new DurableTaskConflictError("active_run", "Run is not awaiting user input");
      }
      const afterSequence = Math.max(0, snapshot.task.latest_sequence - 1_000);
      const events = await repository.listEvents(taskId, afterSequence, 1_000);
      const resumed = new Set<string>();
      let unresolvedRequestId: string | null = null;
      for (const event of [...events].reverse()) {
        if (event.run_id !== runId) continue;
        if (event.payload.type === "user_input_resumed") {
          resumed.add(event.payload.request_id);
          continue;
        }
        if (
          event.payload.type === "user_input_required"
          && !resumed.has(event.payload.request_id)
        ) {
          unresolvedRequestId = event.payload.request_id;
          break;
        }
      }
      if (unresolvedRequestId === null || unresolvedRequestId !== requestId) {
        throw new HILConflictError("request_id does not match the unresolved user input request");
      }
      const detail = body.detail;
      await repository.appendRunEvent(taskId, runId, {
        type: "user_input_resumed",
        request_id: requestId,
        decision: body.decision,
        detail: detail !== null && typeof detail === "object" && !Array.isArray(detail)
          ? detail as Record<string, JsonValue>
          : {},
      });
      return repository.getSnapshot(taskId);
    }

    let input: ResumeHILInput;
    try {
      input = parseResumeHILInput({
        request_id: body.request_id,
        evidence_digest: body.evidence_digest,
        decision: body.decision,
        reason: body.reason ?? null,
      });
    } catch (error) {
      throw new TypeError((error as Error).message, { cause: error });
    }
    let review: HumanReviewRecord;
    if (storedRequest?.status === "resolved") {
      review = await hilStore.resolveRequest(taskId, runId, input);
      const afterSequence = Math.max(0, snapshot.task.latest_sequence - 1_000);
      const alreadyResumed = (await repository.listEvents(taskId, afterSequence, 1_000)).some(
        (event) => event.run_id === runId
          && event.payload.type === "user_input_resumed"
          && event.payload.request_id === input.request_id,
      );
      if (alreadyResumed) {
        // Crash between an earlier resolution and the continuation start,
        // or an idempotent replay of the same request: nothing is driving
        // the suspended build. Restart the deterministic continuation unless
        // the run already reached a terminal state.
        const current = await repository.getSnapshot(taskId);
        const endedRun = current?.runs.find((candidate) => candidate.run_id === runId);
        const terminal =
          endedRun?.status === "completed" ||
          endedRun?.status === "failed" ||
          endedRun?.status === "cancelled";
        if (!terminal && activeTasks.get(taskId) === undefined) {
          const started = await startSuspendedExecutionContinuation(
            taskId,
            runId,
            storedRequest?.requirement_id ?? null,
          );
          if (!started && isDynamicPublicationAcceptance(storedRequest)) {
            await failClosedDynamicPublicationRecovery(taskId, runId);
          }
        }
        return repository.getSnapshot(taskId);
      }
    } else if (storedRequest?.blocking !== false && run.status !== "awaiting_user_input") {
      throw new DurableTaskConflictError("active_run", "Run is not awaiting user input");
    } else {
      review = await hilStore.resolveRequest(taskId, runId, input);
    }
    await repository.appendRunEvent(taskId, runId, {
      type: "user_input_resumed" as const,
      request_id: input.request_id,
      decision: review.decision,
      detail: {
        evidence_digest: input.evidence_digest,
        review_id: review.review_id,
        reason: review.reason,
      },
    });
    if (storedRequest?.blocking === false) {
      return repository.getSnapshot(taskId);
    }
    const task = activeTasks.get(taskId);
    const key = `${taskId}:${runId}`;
    const continuation = activeContinuations.get(key);
    if (continuation !== undefined) {
      // A deterministic execution continuation is already in flight for this
      // run: deliver the resolution to its gate. If the executor is not
      // yet waiting on this request, the store lookup resolves it when the
      // continuation reaches it — never a second driver.
      continuation.gate.resolvePending(runId, review);
      return repository.getSnapshot(taskId);
    }
    if (task?.approvalGate.resolvePending(runId, review) === true) {
      return repository.getSnapshot(taskId);
    }
    if (task === undefined) {
      const started = await startSuspendedExecutionContinuation(
        taskId,
        runId,
        storedRequest?.requirement_id ?? null,
      );
      if (started) return repository.getSnapshot(taskId);
      if (isDynamicPublicationAcceptance(storedRequest)) {
        await failClosedDynamicPublicationRecovery(taskId, runId);
        return repository.getSnapshot(taskId);
      }
    }
    const recoveredTask = await createSession(
      taskId,
      runId,
      (await repository.getSnapshot(taskId))?.task.mode ?? "agent",
    );
    activeTasks.set(taskId, recoveredTask);
    startRun(
      taskId,
      runId,
      [
        "A durable human-review request from the interrupted run has been resolved.",
        `Request: ${input.request_id}`,
        `Decision: ${JSON.stringify(review.decision)}`,
        "Continue the same task from the durable checkpoint. Do not ask the same review again;",
        "the reviewed operation will replay idempotently against the persisted decision.",
      ].join("\n"),
    );
    return await repository.getSnapshot(taskId);
  }

  /**
   * Replay a suspended dataset build deterministically (cross-restart
   * resume). Reads the persisted invocation (written by the tool before
   * ``execute``), rebuilds a lightweight tool workspace bound to the
   * original run, replays the original tool call with the original
   * ``tool_call_id``, and lets the TS Core executor resume from its
   * checkpoint. No AI session is created: the model is never asked to
   * "continue the task" and never re-derives the spec.
   *
   * Returns true when a continuation was started (or is already running);
   * false when this run has no durable continuation record (e.g. permission
   * requests) and the caller should fall back to the legacy resume prompt.
   */
  async function startSuspendedExecutionContinuation(
    taskId: string,
    runId: string,
    requirementId: string | null,
  ): Promise<boolean> {
    if (requirementId === null) return false;
    const snapshot = await repository.getSnapshot(taskId);
    if (snapshot === null || !snapshot.runs.some((run) => run.run_id === runId)) {
      return false;
    }
    const key = `${taskId}:${runId}`;
    if (activeContinuations.has(key)) return true;
    const continuation = await readExecutionContinuation(
      path.join(options.tasksRoot, taskId),
      requirementId,
    );
    if (continuation === null || continuation.run_id !== runId) return false;
    const approvalGate = new DurableApprovalGate(taskId, repository, runId);
    const workspace = await options.workspaceFactory({
      taskId,
      runId,
      mode: snapshot.task.mode,
      approvalGate,
      recordRunEvent: async (payload) => {
        await repository.appendRunEvent(taskId, runId, payload);
      },
    });
    workspace.setRunId?.(runId);
    const tool = workspace.tools.find(
      (candidate) => candidate.name === "execute_dataset_execution",
    );
    if (tool === undefined) {
      await workspace.dispose();
      return false;
    }
    const controller = new AbortController();
    const handle: ActiveContinuationHandle = {
      controller,
      gate: approvalGate,
      promise: Promise.resolve(),
    };
    let promise: Promise<void> = Promise.resolve();
    promise = executeExecutionContinuation(
      taskId,
      runId,
      tool,
      continuation.tool_call_id,
      {
        spec: continuation.spec,
        source_files: continuation.source_files,
        mapping_files: continuation.mapping_files,
        ...(Object.keys(continuation.metadata_files).length > 0
          ? { metadata_files: continuation.metadata_files }
          : {}),
      },
      controller.signal,
    ).finally(() => {
      if (activeContinuations.get(key)?.promise === promise) {
        activeContinuations.delete(key);
      }
      void workspace.dispose();
    });
    handle.promise = promise;
    activeContinuations.set(key, handle);
    return true;
  }

  /**
   * Deterministic executor driving one suspended build to a terminal run
   * event. Matches ``executeDownloadResume``: the original tool-call bubble
   * is upserted via a replayed ``tool_started`` and closed by
   * ``tool_completed``; the run then finalizes with ``run_completed`` or
   * ``run_failed``. No LLM turn is involved.
   */
  async function executeExecutionContinuation(
    taskId: string,
    runId: string,
    tool: BioMedAgentTool,
    toolCallId: string,
    argumentsValue: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    await repository.appendRunEvent(taskId, runId, {
      type: "tool_started",
      tool_call_id: toolCallId,
      tool_name: tool.name,
      arguments: argumentsValue as Record<string, JsonValue>,
    });
    let result: { content: string; isError?: boolean };
    try {
      result = await tool.execute(argumentsValue, signal, { toolCallId });
    } catch (error) {
      // User-cancelled: the run terminal was already recorded by cancelRun.
      if (signal.aborted) return;
      const message = error instanceof Error ? error.message : String(error);
      await repository.appendRunEvent(taskId, runId, {
        type: "tool_completed",
        tool_call_id: toolCallId,
        tool_name: tool.name,
        output: message,
        is_error: true,
      });
      await repository.appendRunEvent(taskId, runId, {
        type: "run_failed",
        error: message.slice(0, 4_000),
      });
      return;
    }
    if (signal.aborted) return;
    await repository.appendRunEvent(taskId, runId, {
      type: "tool_completed",
      tool_call_id: toolCallId,
      tool_name: tool.name,
      output: result.content,
      is_error: result.isError === true,
    });
    if (result.isError === true) {
      await repository.appendRunEvent(taskId, runId, {
        type: "run_failed",
        error: "Dataset execution continuation failed",
      });
      return;
    }
    await repository.appendRunEvent(taskId, runId, { type: "run_completed" });
  }

  function resumeRun(
    taskId: string,
    runId: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const key = `${taskId}:${runId}`;
    const previous = resumeOperations.get(key) ?? Promise.resolve();
    const operation = previous.then(
      () => resumeRunOnce(taskId, runId, body),
      () => resumeRunOnce(taskId, runId, body),
    );
    resumeOperations.set(key, operation);
    void operation.finally(() => {
      if (resumeOperations.get(key) === operation) resumeOperations.delete(key);
    }).catch(() => undefined);
    return operation;
  }

  async function compactTask(taskId: string): Promise<Record<string, string>> {
    const snapshot = await repository.getSnapshot(taskId);
    if (snapshot === null) throw new ReferenceError("Task not found");
    // Manual compaction is allowed at any point in a task's life, not only
    // while a run is active. When idle, compact against the latest run and
    // lazily rebuild the persisted Pi session if this process does not hold
    // one (e.g. after a server restart).
    const runId = snapshot.task.active_run_id ?? snapshot.runs.at(-1)?.run_id ?? null;
    if (runId === null) {
      throw new DurableTaskConflictError("active_run", "Task has no conversation to compact");
    }
    let task = activeTasks.get(taskId);
    let temporarySession = false;
    if (task === undefined) {
      const sessionDir = path.join(options.tasksRoot, taskId, "state", "pi-session");
      let hasPersistedSession: boolean;
      try {
        hasPersistedSession = (await readdir(sessionDir))
          .some((name) => name.endsWith(".jsonl"));
      } catch {
        hasPersistedSession = false;
      }
      if (!hasPersistedSession) {
        throw new DurableTaskConflictError(
          "active_run",
          "Task has no conversation to compact",
        );
      }
      task = await createSession(taskId, runId, snapshot.task.mode ?? "agent");
      temporarySession = true;
    }
    try {
      const compactionId = randomUUID();
      if (task.session.compact === undefined) {
        await repository.appendRunEvent(taskId, runId, {
          type: "conversation_compaction_failed",
          compaction_id: compactionId,
          covered_through_run_id: runId,
          reason: "error",
          message: "Task compaction is unavailable",
        });
        throw new DurableTaskConflictError("active_run", "Task compaction is unavailable");
      }
      await repository.appendRunEvent(taskId, runId, {
        type: "conversation_compaction_started",
        compaction_id: compactionId,
        covered_through_run_id: runId,
      });
      let result: { summary: string };
      try {
        result = await task.session.compact();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const noContent = /Nothing to compact|Already compacted/.test(message);
        await repository.appendRunEvent(taskId, runId, {
          type: "conversation_compaction_failed",
          compaction_id: compactionId,
          covered_through_run_id: runId,
          reason: noContent ? "no_content" : "error",
          message,
        });
        if (noContent) {
          throw new DurableTaskConflictError(
            "active_run",
            "Task has no conversation to compact",
          );
        }
        throw error;
      }
      await repository.appendRunEvent(taskId, runId, {
        type: "conversation_compacted",
        compaction_id: compactionId,
        covered_through_run_id: runId,
        summary_digest: createHash("sha256").update(result.summary, "utf8").digest("hex"),
      });
      return { status: "compaction_requested", task_id: taskId, run_id: runId };
    } finally {
      if (temporarySession) await task.session.dispose();
    }
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
    const event = await repository.appendRunEvent(taskId, runId, {
      type: "run_steered",
      input: text,
    });
    return {
      status: "steered",
      task_id: taskId,
      run_id: runId,
      message_id: `message_${event.event_id}`,
      content: text,
    };
  }

  async function resolvePermission(
    taskId: string,
    runId: string,
    requestId: string,
    body: Record<string, unknown>,
  ): Promise<unknown> {
    const snapshot = await repository.getSnapshot(taskId);
    if (snapshot === null || !snapshot.runs.some((run) => run.run_id === runId)) {
      throw new ReferenceError("Run not found");
    }
    let decision: "allow" | "deny";
    if (body.decision === "allow" || body.decision === "deny") {
      decision = body.decision;
    } else {
      throw new TypeError("decision must be allow or deny");
    }
    let grantScope: "once" | "run" | "task" | "persistent" | undefined;
    const rawScope = body.grant_scope;
    if (rawScope !== undefined && rawScope !== null) {
      if (rawScope === "once" || rawScope === "run" || rawScope === "task" || rawScope === "persistent") {
        grantScope = rawScope;
      } else {
        throw new TypeError("grant_scope must be once, run, task, or persistent");
      }
    }
    // Round-3 audit: run/task grants root at the approved canonical path by
    // default; an explicit ``scope_wide`` opt-in grants the whole scope.
    const scopeWide = body.scope_wide === true;
    const task = activeTasks.get(taskId);
    const broker = task?.permissionBroker;
    if (task === undefined || broker === null || broker === undefined) {
      throw new ReferenceError("Permission broker is unavailable for this task");
    }
    const resolved = await broker.resolve(runId, requestId, decision, grantScope, scopeWide);
    if (!resolved) {
      throw new ReferenceError("Permission request not found or expired");
    }
    return { status: "resolved", task_id: taskId, run_id: runId, request_id: requestId };
  }

  async function deleteTask(taskId: string): Promise<void> {
    const task = activeTasks.get(taskId);
    if (task !== undefined) {
      const snapshot = await repository.getSnapshot(taskId);
      if (snapshot !== null && snapshot.task.active_run_id !== null) {
        throw new DurableTaskConflictError("active_run", "Active tasks cannot be deleted");
      }
      activeTasks.delete(taskId);
      options.permissionBrokerRegistry?.unregister(taskId);
      await task.session.dispose();
    }
    await repository.deleteTask(taskId);
    // Formal deletion removes both the framework output (above) and the
    // agent workspace (plan §12: cancel → dispose → remove).
    await workspaceManager.remove(taskId);
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
        const cursor = url.searchParams.get("cursor");
        sendJson(response, 200, await repository.listTasks(limit, cursor));
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
          "content-length": String(resolved.sizeBytes),
          "content-disposition": `attachment; filename="${resolved.name.replaceAll('"', "")}"`,
        });
        resolved.stream.on("error", (error) => {
          if (!response.headersSent && !response.destroyed) {
            response.destroy(error instanceof Error ? error : new Error(String(error)));
          }
        });
        resolved.stream.pipe(response);
        return;
      }
      const taskFile = /^\/api\/v1\/tasks\/([^/]+)\/file$/.exec(url.pathname);
      if (request.method === "GET" && taskFile !== null) {
        const taskId = decodeURIComponent(taskFile[1] ?? "");
        if (await repository.getSnapshot(taskId) === null) {
          sendJson(response, 404, { detail: "Task not found" });
          return;
        }
        const relativePath = url.searchParams.get("path") ?? "";
        const file = await readTaskTextFile(
          workspaceManager.getPath(taskId),
          relativePath,
        );
        if (!file.ok) {
          const status =
            file.code === "invalid_path" ? 400 : file.code === "too_large" ? 413 : 404;
          sendJson(response, status, { detail: file.code });
          return;
        }
        response.writeHead(200, {
          "content-type": file.mediaType,
          "content-length": String(Buffer.byteLength(file.content, "utf8")),
        });
        response.end(file.content);
        return;
      }
      const quarantineList = /^\/api\/v1\/tasks\/([^/]+)\/quarantine$/.exec(url.pathname);
      if (request.method === "GET" && quarantineList !== null) {
        sendJson(response, 200, await listQuarantineArtifacts(decodeURIComponent(quarantineList[1] ?? "")));
        return;
      }
      if (request.method === "POST" && quarantineList !== null) {
        sendJson(response, 201, await submitQuarantineArtifact(
          decodeURIComponent(quarantineList[1] ?? ""),
          request,
        ));
        return;
      }
      const quarantineGet = /^\/api\/v1\/tasks\/([^/]+)\/quarantine\/([^/]+)$/.exec(url.pathname);
      if (request.method === "GET" && quarantineGet !== null) {
        sendJson(response, 200, await getQuarantineArtifact(
          decodeURIComponent(quarantineGet[1] ?? ""),
          decodeURIComponent(quarantineGet[2] ?? ""),
        ));
        return;
      }
      const quarantineContent = /^\/api\/v1\/tasks\/([^/]+)\/quarantine\/([^/]+)\/content$/.exec(url.pathname);
      if (request.method === "GET" && quarantineContent !== null) {
        const { receipt, bytes } = await getQuarantineArtifactContent(
          decodeURIComponent(quarantineContent[1] ?? ""),
          decodeURIComponent(quarantineContent[2] ?? ""),
        );
        response.writeHead(200, {
          "content-type": receipt.media_type,
          "content-length": String(bytes.length),
          "content-disposition": `attachment; filename="${sanitizeQuarantineFilename(receipt.name)}"`,
          "x-untrusted-artifact": "true",
        });
        response.end(bytes);
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
      const downloadCancel = /^\/api\/v1\/tasks\/([^/]+)\/downloads\/cancel$/.exec(url.pathname);
      if (request.method === "POST" && downloadCancel !== null) {
        sendJson(response, 202, await cancelDownload(
          decodeURIComponent(downloadCancel[1] ?? ""),
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
      const permission = /^\/api\/v1\/tasks\/([^/]+)\/runs\/([^/]+)\/permissions\/([^/]+)$/.exec(url.pathname);
      if (request.method === "POST" && permission !== null) {
        sendJson(response, 200, await resolvePermission(
          decodeURIComponent(permission[1] ?? ""),
          decodeURIComponent(permission[2] ?? ""),
          decodeURIComponent(permission[3] ?? ""),
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
      if (error instanceof DurableTaskConflictError || error instanceof HILConflictError) {
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
        console.error("task-runtime-failure", error);
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

  for (const recovery of hilRecoveries) {
    if (isDynamicPublicationAcceptance(recovery.request)) {
      await failClosedDynamicPublicationRecovery(recovery.task_id, recovery.run_id);
      continue;
    }
    if (recovery.review === null) continue;
    try {
      const recoveredTask = await createSession(
        recovery.task_id,
        recovery.run_id,
        (await repository.getSnapshot(recovery.task_id))?.task.mode ?? "agent",
      );
      activeTasks.set(recovery.task_id, recoveredTask);
      startRun(
        recovery.task_id,
        recovery.run_id,
        [
          "A durable human-review request was resolved before the Application Host restarted.",
          `Request: ${recovery.request.request_id}`,
          `Decision: ${JSON.stringify(recovery.review.decision)}`,
          "Continue the same task from the durable checkpoint. Do not ask the same review again;",
          "the reviewed operation will replay idempotently against the persisted decision.",
        ].join("\n"),
      );
    } catch (error) {
      await repository.appendRunEvent(recovery.task_id, recovery.run_id, {
        type: "run_failed",
        error: error instanceof Error ? error.message : "HIL recovery failed",
        error_code: "configuration_error",
      });
    }
  }

  return {
    repository,
    handle(request, response) {
      const requestPath = pathname(request);
      if (requestPath === "/api/v1/import/tasks") {
        void dispatch(request, response);
        return true;
      }
      if (requestPath === "/api/v1/tasks") {
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
      const results = await Promise.allSettled([...activeTasks.entries()].map(async ([taskId, task]) => {
        try {
          if (task.activeRunId !== null) {


            task.permissionBroker?.rejectPending(task.activeRunId, new Error("Host shutdown"));
            const pending = await hilStore.findPendingForRun(taskId, task.activeRunId);
            if (pending !== null) {
              suspendedRuns.add(`${taskId}:${task.activeRunId}`);
              task.approvalGate.rejectPending(
                task.activeRunId,
                new Error("Host shutdown while awaiting durable HIL"),
              );
            } else {
              await task.session.cancel("Host shutdown");
            }

          }
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
