import type { WorkspaceAuditRecord } from "./audit.js";
import {
  AppendOnlyTaskAuditSink,
  InMemoryWorkspaceAuditSink,
  type WorkspaceAuditSink,
} from "./audit.js";
import {
  createWorkspaceContext,
  type TaskWorkspaceConfig,
  type WorkspaceContext,
} from "./context.js";
import { editWorkspaceText } from "./edit.js";
import {
  WorkspaceProcessRegistry,
  executeWorkspaceCommand,
  sanitizedCommand,
} from "./exec.js";
import { normalizeAgentPath } from "./path-policy.js";
import { listWorkspace, readWorkspaceText, searchWorkspace } from "./read.js";
import type {
  WorkspaceEditResult,
  WorkspaceExecResult,
  WorkspaceListResult,
  WorkspaceOperation,
  WorkspaceReadResult,
  WorkspaceSearchResult,
  WorkspaceWriteResult,
} from "./types.js";
import { WorkspacePolicyError } from "./types.js";
import { writeWorkspaceText } from "./write.js";

export { AppendOnlyTaskAuditSink, InMemoryWorkspaceAuditSink, WorkspacePolicyError };
export type { TaskWorkspaceConfig, WorkspaceAuditSink };

function boundedDuration(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function auditPath(input: string): string {
  try {
    return normalizeAgentPath(input);
  } catch {
    return "[rejected]";
  }
}

export interface TaskWorkspace {
  readonly taskId: string;
  readonly runId: string;
  readonly piSessionId?: string;
  read(input: { path: string; offset?: number; length?: number }): Promise<WorkspaceReadResult>;
  list(input: { path: string; depth?: number }): Promise<WorkspaceListResult>;
  search(input: { path: string; query: string }): Promise<WorkspaceSearchResult>;
  write(input: { path: string; content: string }): Promise<WorkspaceWriteResult>;
  edit(input: {
    path: string;
    oldText: string;
    newText: string;
    expectedOccurrences: number;
  }): Promise<WorkspaceEditResult>;
  exec(
    input: { executable: string; args: string[]; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<WorkspaceExecResult>;
  dispose(): Promise<void>;
}

class GovernedTaskWorkspace implements TaskWorkspace {
  readonly taskId: string;
  readonly runId: string;
  readonly piSessionId?: string;
  #disposed = false;
  readonly #processes = new WorkspaceProcessRegistry();

  constructor(private readonly context: WorkspaceContext) {
    this.taskId = context.taskId;
    this.runId = context.runId;
    this.piSessionId = context.piSessionId;
  }

  async #audited<T>(
    operation: WorkspaceOperation,
    details: { path?: string; command?: string[] },
    action: () => Promise<T>,
    resultDetails?: (value: T) => Pick<WorkspaceAuditRecord, "result" | "truncated">,
  ): Promise<T> {
    const started = performance.now();
    if (this.#disposed) {
      const error = new WorkspacePolicyError("WORKSPACE_DISPOSED", "Task Workspace is disposed");
      await this.context.audit.record({
        taskId: this.taskId,
        runId: this.runId,
        piSessionId: this.piSessionId,
        operation,
        ...details,
        result: "rejected",
        durationMs: boundedDuration(started),
        truncated: false,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
    try {
      const value = await action();
      const outcome = resultDetails?.(value) ?? { result: "success", truncated: false };
      await this.context.audit.record({
        taskId: this.taskId,
        runId: this.runId,
        piSessionId: this.piSessionId,
        operation,
        ...details,
        ...outcome,
        durationMs: boundedDuration(started),
        timestamp: new Date().toISOString(),
      });
      return value;
    } catch (error) {
      await this.context.audit.record({
        taskId: this.taskId,
        runId: this.runId,
        piSessionId: this.piSessionId,
        operation,
        ...details,
        result: "rejected",
        durationMs: boundedDuration(started),
        truncated: false,
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }

  read(input: { path: string; offset?: number; length?: number }): Promise<WorkspaceReadResult> {
    return this.#audited("read", { path: auditPath(input.path) }, () =>
      readWorkspaceText(this.context, input), (value) => ({
        result: "success",
        truncated: value.truncated,
      }));
  }

  list(input: { path: string; depth?: number }): Promise<WorkspaceListResult> {
    return this.#audited("list", { path: auditPath(input.path) }, () =>
      listWorkspace(this.context, input), (value) => ({
        result: "success",
        truncated: value.truncated,
      }));
  }

  search(input: { path: string; query: string }): Promise<WorkspaceSearchResult> {
    return this.#audited("search", { path: auditPath(input.path) }, () =>
      searchWorkspace(this.context, input), (value) => ({
        result: "success",
        truncated: value.truncated,
      }));
  }

  write(input: { path: string; content: string }): Promise<WorkspaceWriteResult> {
    return this.#audited("write", { path: auditPath(input.path) }, () =>
      writeWorkspaceText(this.context, input));
  }

  edit(input: {
    path: string;
    oldText: string;
    newText: string;
    expectedOccurrences: number;
  }): Promise<WorkspaceEditResult> {
    return this.#audited("edit", { path: auditPath(input.path) }, () =>
      editWorkspaceText(this.context, input));
  }

  exec(
    input: { executable: string; args: string[]; timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<WorkspaceExecResult> {
    return this.#audited(
      "exec",
      { command: sanitizedCommand(input.executable, input.args) },
      () => executeWorkspaceCommand(this.context, input, signal, this.#processes),
      (value) => ({
        result: value.policy === "disabled"
          ? "disabled"
          : value.cancelled
            ? "cancelled"
            : value.timedOut
              ? "timed_out"
              : value.policy === "rejected"
                ? "rejected"
                : "success",
        truncated: value.truncated,
      }),
    );
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.#processes.cancelAll();
  }
}

export async function createTaskWorkspace(config: TaskWorkspaceConfig): Promise<TaskWorkspace> {
  return new GovernedTaskWorkspace(await createWorkspaceContext(config));
}
