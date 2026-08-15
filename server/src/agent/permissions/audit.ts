import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

import type { GrantScope, PermissionCapability, PermissionDecision, ResourceScope } from "./types.js";

/**
 * Permission audit (plan §59).
 *
 * Every permission request is recorded with:
 *
 * ```text
 * permission_request_id, task_id, run_id, capability, scope, resource,
 * decision, grant_scope, timestamp
 * ```
 *
 * Commands additionally record command/cwd. Audit must never become a
 * decision source, and existing secret redaction still applies (command
 * arguments are sanitized upstream before they reach the audit sink).
 */
export interface PermissionAuditRecord {
  permission_request_id: string;
  task_id: string;
  run_id: string;
  capability: PermissionCapability;
  scope: ResourceScope;
  resource: string | null;
  command: string | null;
  cwd: string | null;
  decision: PermissionDecision | "pending";
  grant_scope: GrantScope | null;
  timestamp: string;
}

export interface PermissionAuditSink {
  record(entry: PermissionAuditRecord): void | Promise<void>;
}

export class InMemoryPermissionAuditSink implements PermissionAuditSink {
  readonly records: PermissionAuditRecord[] = [];

  record(entry: PermissionAuditRecord): void {
    this.records.push(structuredClone(entry));
  }
}

/** Appends permission audit lines under ``<taskOutput>/logs/permission-audit.jsonl``. */
export class AppendOnlyPermissionAuditSink implements PermissionAuditSink {
  readonly #auditPath: string;

  constructor(taskOutputRoot: string) {
    this.#auditPath = path.join(taskOutputRoot, "logs", "permission-audit.jsonl");
  }

  async record(entry: PermissionAuditRecord): Promise<void> {
    await mkdir(path.dirname(this.#auditPath), { recursive: true });
    await appendFile(this.#auditPath, `${JSON.stringify(entry)}\n`, {
      encoding: "utf8",
      flag: "a",
    });
  }
}
