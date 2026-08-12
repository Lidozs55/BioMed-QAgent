import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceOperation } from "./types.js";

export interface WorkspaceAuditRecord {
  taskId: string;
  runId: string;
  piSessionId?: string;
  operation: WorkspaceOperation;
  path?: string;
  command?: string[];
  result: "success" | "rejected" | "disabled" | "cancelled" | "timed_out" | "failed";
  durationMs: number;
  truncated: boolean;
  timestamp: string;
}
export interface WorkspaceAuditSink {
  record(entry: WorkspaceAuditRecord): void | Promise<void>;
}

export class InMemoryWorkspaceAuditSink implements WorkspaceAuditSink {
  readonly records: WorkspaceAuditRecord[] = [];

  record(entry: WorkspaceAuditRecord): void {
    this.records.push(structuredClone(entry));
  }
}

export class AppendOnlyTaskAuditSink implements WorkspaceAuditSink {
  readonly #auditPath: string;

  constructor(taskWorkspaceRoot: string) {
    this.#auditPath = path.join(taskWorkspaceRoot, "logs", "workspace-audit.jsonl");
  }

  async record(entry: WorkspaceAuditRecord): Promise<void> {
    await mkdir(path.dirname(this.#auditPath), { recursive: true });
    await appendFile(this.#auditPath, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  }
}
