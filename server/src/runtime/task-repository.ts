import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import type {
  EventEnvelope,
  EventPayload,
  TaskPage,
  TaskMode,
  TaskRunAccepted,
  TaskSnapshot,
} from "@biomed/contracts";

import { readJsonFileOrNull, writeJsonAtomic } from "../persistence/atomic-json.js";
import { requireSafeId, SAFE_ID } from "./safe-id.js";
import {
  SourceAssetRegistry,
  type SourceAssetRegistryOptions,
} from "./source-assets/registry.js";
import {
  reduceTaskEvents,
  type DurableTaskMetadata,
} from "./task-reducer.js";

export interface CreateDurableTaskInput {
  requestId: string;
  input: string;
  databases: string[];
  mode: TaskMode;
}

export interface CreateDurableRunInput {
  requestId: string;
  input: string;
}

export class DurableTaskConflictError extends Error {
  constructor(
    readonly code:
      | "request_id_reused"
      | "request_id_owned_by_another_task"
      | "active_run"
      | "active_download"
      | "task_not_continuable",
    message: string,
  ) {
    super(message);
    this.name = "DurableTaskConflictError";
  }
}

export interface DurableTaskRepositoryOptions {
  id?: () => string;
  now?: () => Date;
}

type EventListener = (event: EventEnvelope) => void;

function requireCleanUtf8(value: string): void {
  if (/\uFFFD/u.test(value)) {
    throw new TypeError(
      "input contains corrupted UTF-8 text (U+FFFD replacement character); " +
        "read source files with 'utf8' encoding and submit via JSON.stringify",
    );
  }
}

function taskTitle(input: string): string {
  const firstLine = input.trim().split(/\r?\n/, 1)[0] ?? "";
  return firstLine.slice(0, 120) || "New task";
}

function parseEvents(text: string): EventEnvelope[] {
  const events: EventEnvelope[] = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`events.jsonl line ${index + 1} is not valid JSON: ${(error as Error).message}`, { cause: error });
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error(`events.jsonl line ${index + 1} is not an event object`);
    }
    const sequence = (parsed as { sequence?: unknown }).sequence;
    if (typeof sequence !== "number" || !Number.isInteger(sequence) || sequence < 1) {
      throw new Error(`events.jsonl line ${index + 1} has an invalid sequence`);
    }
    const previous = events.at(-1)?.sequence;
    if (previous !== undefined && sequence !== previous + 1) {
      throw new Error(`events.jsonl sequence gap at line ${index + 1}: expected ${previous + 1}, got ${sequence}`);
    }
    events.push(parsed as EventEnvelope);
  }
  return events;
}

export class DurableTaskRepository {
  readonly tasksRoot: string;
  private readonly id: () => string;
  private readonly now: () => Date;
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<EventListener>();
  private readonly latestSequence = new Map<string, number>();

  constructor(tasksRoot: string, options: DurableTaskRepositoryOptions = {}) {
    this.tasksRoot = path.resolve(tasksRoot);
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sourceAssetRegistry(
    taskId: string,
    options: SourceAssetRegistryOptions = {},
  ): SourceAssetRegistry {
    requireSafeId(taskId, "taskId");
    return new SourceAssetRegistry(taskId, this.taskRoot(taskId), options);
  }

  async createTask(input: CreateDurableTaskInput): Promise<TaskRunAccepted> {
    requireSafeId(input.requestId, "requestId");
    if (input.input.trim() === "") throw new TypeError("input must not be empty");
    requireCleanUtf8(input.input);
    const existing = await this.findRequest(input.requestId);
    if (existing !== null) {
      const same = existing.snapshot.task.mode === input.mode &&
        existing.snapshot.task.databases.length === input.databases.length &&
        existing.snapshot.task.databases.every((value, index) => value === input.databases[index]) &&
        existing.run.input === input.input;
      if (!same) {
        throw new DurableTaskConflictError(
          "request_id_reused",
          "Request ID was reused with different request content",
        );
      }
      return this.accepted(existing.run.request_id, existing.snapshot.task.task_id, existing.run.run_id);
    }
    const taskId = `task_ts_${this.id()}`;
    const runId = `run_ts_${this.id()}`;
    requireSafeId(taskId, "taskId");
    requireSafeId(runId, "runId");
    const createdAt = this.now().toISOString();
    const metadata: DurableTaskMetadata = {
      schema_version: 1,
      task_id: taskId,
      mode: input.mode,
      databases: [...input.databases],
      title: taskTitle(input.input),
      created_at: createdAt,
    };
    const taskRoot = this.taskRoot(taskId);
    await mkdir(path.join(taskRoot, "state"), { recursive: true });
    await this.writeMetadata(taskId, metadata);
    await this.append(taskId, null, { type: "task_created", topic: metadata.title });
    await this.appendRunEvent(taskId, runId, {
      type: "run_queued",
      request_id: input.requestId,
      input: input.input,
    });
    return this.accepted(input.requestId, taskId, runId);
  }

  async createRun(taskId: string, input: CreateDurableRunInput): Promise<TaskRunAccepted> {
    requireSafeId(taskId, "taskId");
    requireSafeId(input.requestId, "requestId");
    if (input.input.trim() === "") throw new TypeError("input must not be empty");
    requireCleanUtf8(input.input);
    const existing = await this.findRequest(input.requestId);
    if (existing !== null) {
      if (existing.snapshot.task.task_id !== taskId) {
        throw new DurableTaskConflictError(
          "request_id_owned_by_another_task",
          "Request ID belongs to another task",
        );
      }
      if (existing.run.input !== input.input) {
        throw new DurableTaskConflictError(
          "request_id_reused",
          "Request ID was reused with different request content",
        );
      }
      return this.accepted(existing.run.request_id, taskId, existing.run.run_id);
    }
    const snapshot = await this.getSnapshot(taskId);
    if (snapshot === null) throw new ReferenceError("Task not found");
    if (snapshot.task.mode !== "agent") {
      throw new DurableTaskConflictError("task_not_continuable", "Task cannot be continued");
    }
    if (snapshot.task.active_run_id !== null) {
      throw new DurableTaskConflictError("active_run", "Task already has an active run");
    }
    const runId = `run_ts_${this.id()}`;
    requireSafeId(runId, "runId");
    await this.appendRunEvent(taskId, runId, {
      type: "run_queued",
      request_id: input.requestId,
      input: input.input,
    });
    return this.accepted(input.requestId, taskId, runId);
  }

  async appendRunEvent(taskId: string, runId: string, payload: EventPayload): Promise<EventEnvelope> {
    return (await this.appendRunEvents(taskId, runId, [payload]))[0];
  }

  async appendBuildEvent(
    taskId: string,
    runId: string,
    requirementId: string,
    payload: EventPayload,
  ): Promise<EventEnvelope> {
    requireSafeId(requirementId, "requirementId");
    return (await this.appendEvents(taskId, runId, [payload], requirementId))[0];
  }

  async appendRunEvents(
    taskId: string,
    runId: string,
    payloads: readonly EventPayload[],
  ): Promise<EventEnvelope[]> {
    requireSafeId(runId, "runId");
    return this.appendEvents(taskId, runId, payloads);
  }

  private appendEvents(
    taskId: string,
    runId: string | null,
    payloads: readonly EventPayload[],
    requirementId: string | null = null,
  ): Promise<EventEnvelope[]> {
    if (payloads.length === 0) throw new TypeError("payloads must not be empty");
    requireSafeId(taskId, "taskId");
    const previous = this.pending.get(taskId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      let sequence = this.latestSequence.get(taskId);
      if (sequence === undefined) {
        sequence = (await this.readAllEvents(taskId)).at(-1)?.sequence ?? 0;
      }
      const timestamp = this.now().toISOString();
      const events = payloads.map((payload, index) => ({
        schema_version: "2.0" as const,
        event_id: `event_${this.id()}`,
        type: payload.type,
        task_id: taskId,
        run_id: runId,
        ...(requirementId === null ? {} : { requirement_id: requirementId }),
        stage_attempt_id: null,
        sequence: sequence + index + 1,
        timestamp,
        payload,
      }));
      await mkdir(this.taskRoot(taskId), { recursive: true });
      const handle = await open(this.eventsPath(taskId), "a");
      try {
        await handle.writeFile(
          `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
          "utf8",
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.latestSequence.set(taskId, events.at(-1)?.sequence ?? sequence);
      for (const event of events) {
        for (const listener of this.listeners) listener(event);
      }
      return events;
    });
    this.pending.set(taskId, operation);
    const cleanup = (): void => {
      if (this.pending.get(taskId) === operation) this.pending.delete(taskId);
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }

  async getSnapshot(taskId: string): Promise<TaskSnapshot | null> {
    const metadata = await this.readMetadata(taskId);
    if (metadata === null) return null;
    return reduceTaskEvents(metadata, await this.readAllEvents(taskId));
  }

  async listTasks(limit = 50): Promise<TaskPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError("limit must be between 1 and 100");
    }
    await mkdir(this.tasksRoot, { recursive: true });
    const entries = await readdir(this.tasksRoot, { withFileTypes: true });
    const snapshots = (await Promise.all(entries
      .filter((entry) => entry.isDirectory() && SAFE_ID.test(entry.name))
      .map((entry) => this.getSnapshot(entry.name))))
      .filter((snapshot): snapshot is TaskSnapshot => snapshot !== null)
      .sort((left, right) => right.task.updated_at.localeCompare(left.task.updated_at));
    const active = snapshots.filter((snapshot) => snapshot.task.active_run_id !== null);
    const history = snapshots.filter((snapshot) => snapshot.task.active_run_id === null);
    return {
      schema_version: "1.0",
      active_items: active.map((snapshot) => snapshot.task),
      items: history.slice(0, limit).map((snapshot) => snapshot.task),
      next_cursor: history.length > limit ? history[limit - 1]?.task.task_id ?? null : null,
    };
  }

  async deleteTask(taskId: string): Promise<void> {
    requireSafeId(taskId, "taskId");
    const pending = this.pending.get(taskId);
    if (pending !== undefined) await pending;
    const snapshot = await this.getSnapshot(taskId);
    if (snapshot === null) throw new ReferenceError("Task not found");
    if (snapshot.task.active_run_id !== null) {
      throw new DurableTaskConflictError("active_run", "Active tasks cannot be deleted");
    }
    await rm(this.taskRoot(taskId), { recursive: true, force: false });
    this.latestSequence.delete(taskId);
  }

  async listEvents(taskId: string, afterSequence: number, limit = 1_000): Promise<EventEnvelope[]> {
    requireSafeId(taskId, "taskId");
    if (!Number.isInteger(afterSequence) || afterSequence < 0) {
      throw new TypeError("afterSequence must be a non-negative integer");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new TypeError("limit must be between 1 and 1000");
    }
    return (await this.readAllEvents(taskId))
      .filter((event) => event.sequence > afterSequence)
      .slice(0, limit);
  }

  /**
   * A workspace permission promise is intentionally in-memory and cannot be
   * resumed after a host restart. Reconcile its durable request before active
   * runs are recovered so the timeline is truthful and the old request cannot
   * be approved against a missing broker.
   */
  async rejectOrphanedPermissionRequests(): Promise<number> {
    await mkdir(this.tasksRoot, { recursive: true });
    const rejected: Array<{ taskId: string; runId: string; requestId: string }> = [];
    const entries = await readdir(this.tasksRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      const events = await this.readAllEvents(entry.name);
      const pending = new Map<string, string>();
      for (const event of events) {
        if (event.payload.type === "permission_requested" && event.run_id !== null) {
          pending.set(event.payload.request_id, event.run_id);
        } else if (event.payload.type === "permission_resolved") {
          pending.delete(event.payload.request_id);
        }
      }
      for (const [requestId, runId] of pending) {
        rejected.push({ taskId: entry.name, runId, requestId });
      }
    }
    for (const request of rejected) {
      await this.appendRunEvent(request.taskId, request.runId, {
        type: "permission_resolved",
        request_id: request.requestId,
        decision: "deny",
        grant_scope: null,
      });
    }
    return rejected.length;
  }

  async recoverActiveRuns(preservedRunKeys: ReadonlySet<string> = new Set()): Promise<void> {
    await mkdir(this.tasksRoot, { recursive: true });
    const entries = await readdir(this.tasksRoot, { withFileTypes: true });
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) return;
      const snapshot = await this.getSnapshot(entry.name);
      if (snapshot?.task.active_run_id === null || snapshot === null) return;
      if (preservedRunKeys.has(`${entry.name}:${snapshot.task.active_run_id}`)) return;
      await this.appendRunEvent(entry.name, snapshot.task.active_run_id, {
        type: "run_interrupted",
        reason: "Application Host restarted before the run reached a terminal state",
      });
    }));
  }

  async recordPiSessionId(taskId: string, piSessionId: string): Promise<void> {
    requireSafeId(piSessionId, "piSessionId");
    const metadata = await this.readMetadata(taskId);
    if (metadata === null) throw new ReferenceError("Task not found");
    if (metadata.pi_session_id !== undefined && metadata.pi_session_id !== piSessionId) {
      throw new DurableTaskConflictError(
        "task_not_continuable",
        "Task is already mapped to another Pi session",
      );
    }
    if (metadata.pi_session_id === piSessionId) return;
    await this.writeMetadata(taskId, { ...metadata, pi_session_id: piSessionId });
  }

  private append(taskId: string, runId: string | null, payload: EventPayload): Promise<EventEnvelope> {
    return this.appendEvents(taskId, runId, [payload]).then((events) => events[0]);
  }

  private taskRoot(taskId: string): string {
    return path.join(this.tasksRoot, taskId);
  }

  private accepted(requestId: string, taskId: string, runId: string): TaskRunAccepted {
    return {
      schema_version: "1.0",
      request_id: requestId,
      task_id: taskId,
      run_id: runId,
      status: "queued",
    };
  }

  private async findRequest(requestId: string): Promise<{
    snapshot: TaskSnapshot;
    run: TaskSnapshot["runs"][number];
  } | null> {
    await mkdir(this.tasksRoot, { recursive: true });
    const entries = await readdir(this.tasksRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
      const snapshot = await this.getSnapshot(entry.name);
      const run = snapshot?.runs.find((candidate) => candidate.request_id === requestId);
      if (snapshot !== null && snapshot !== undefined && run !== undefined) {
        return { snapshot, run };
      }
    }
    return null;
  }

  private eventsPath(taskId: string): string {
    return path.join(this.taskRoot(taskId), "events.jsonl");
  }

  private metadataPath(taskId: string): string {
    return path.join(this.taskRoot(taskId), "state", "task.json");
  }

  private async writeMetadata(taskId: string, metadata: DurableTaskMetadata): Promise<void> {
    await writeJsonAtomic(this.metadataPath(taskId), metadata);
  }

  private async readMetadata(taskId: string): Promise<DurableTaskMetadata | null> {
    requireSafeId(taskId, "taskId");
    return readJsonFileOrNull<DurableTaskMetadata>(this.metadataPath(taskId));
  }

  private async readAllEvents(taskId: string): Promise<EventEnvelope[]> {
    try {
      return parseEvents(await readFile(this.eventsPath(taskId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
