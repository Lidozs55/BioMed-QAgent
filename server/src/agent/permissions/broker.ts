import { randomUUID } from "node:crypto";

import type { EventPayload } from "@biomed/contracts";

import type { PermissionAuditSink } from "./audit.js";
import { PermissionEvaluator } from "./evaluator.js";
import { TemporaryGrantStore } from "./grants.js";
import type { PermissionPolicyStore } from "./policy-store.js";
import {
  PermissionDeniedError,
  type GrantScope,
  type PermissionCapability,
  type PermissionRequest,
  type ResourceScope,
} from "./types.js";

/**
 * PermissionBroker (plan §8–§10, §32–§33).
 *
 * The agent requests permission simply by attempting the operation — there
 * is no ``request_permission`` tool the model must call first. The broker
 * sits between the tool call and execution:
 *
 * ```text
 * Tool Call → PermissionBroker → allow → execute
 *                              → deny  → permission_denied
 *                              → ask   → permission_requested (durable event)
 *                                      → user decision (HTTP)
 *                                      → permission_resolved
 *                                      → original tool call continues
 * ```
 *
 * Pending permission promises are runtime memory state: process restart
 * invalidates them; they are never re-approved silently (plan §31).
 */
export interface BrokerOptions {
  taskId: string;
  runId: string;
  evaluator: PermissionEvaluator;
  grants: TemporaryGrantStore;
  policyStore: PermissionPolicyStore;
  audit: PermissionAuditSink;
  /** Append a durable event to the active run's stream. */
  recordRunEvent: (payload: EventPayload) => Promise<void>;
  /** Pending requests older than this are invalidated on resolve. */
  maxPendingMs?: number;
}

export interface BrokerEvaluateInput {
  capability: PermissionCapability;
  resource?: string;
  canonicalResource?: string;
  command?: string;
  cwd?: string;
  scope: ResourceScope;
  /** Optional AbortSignal: cancelling aborts a suspended ask. */
  signal?: AbortSignal;
}

export interface BrokerDecision {
  decision: "allow" | "deny";
  /** Present when the request was resolved by a user decision. */
  grantScope?: GrantScope;
}

interface PendingRequest {
  request: PermissionRequest;
  resolve: (decision: BrokerDecision) => void;
  reject: (error: Error) => void;
}

export class PermissionBroker {
  private readonly taskId: string;
  private readonly runId: string;
  private readonly evaluator: PermissionEvaluator;
  private readonly grants: TemporaryGrantStore;
  private readonly policyStore: PermissionPolicyStore;
  private readonly audit: PermissionAuditSink;
  private readonly recordRunEvent: (payload: EventPayload) => Promise<void>;
  private readonly maxPendingMs: number;
  private readonly pending = new Map<string, PendingRequest>();

  constructor(options: BrokerOptions) {
    this.taskId = options.taskId;
    this.runId = options.runId;
    this.evaluator = options.evaluator;
    this.grants = options.grants;
    this.policyStore = options.policyStore;
    this.audit = options.audit;
    this.recordRunEvent = options.recordRunEvent;
    this.maxPendingMs = options.maxPendingMs ?? 30 * 60 * 1_000;
  }

  get currentRunId(): string {
    return this.runId;
  }

  /** True when a permission decision is currently pending for the run. */
  hasPending(runId: string): boolean {
    return this.pending.has(runId);
  }

  /**
   * Evaluate a tool request. Returns the final decision; when the policy is
   * ``ask`` the caller's promise stays suspended until the user resolves the
   * request (or the run is cancelled / host shuts down).
   */
  async evaluate(input: BrokerEvaluateInput): Promise<BrokerDecision> {
    const request: PermissionRequest = {
      id: `permission_${randomUUID()}`,
      taskId: this.taskId,
      runId: this.runId,
      capability: input.capability,
      resource: input.resource,
      canonicalResource: input.canonicalResource,
      command: input.command,
      cwd: input.cwd,
      scope: input.scope,
      createdAt: new Date().toISOString(),
    };
    const verdict = await this.evaluator.evaluate(request);
    if (verdict.decision === "allow") {
      await this.audit.record({
        permission_request_id: request.id,
        task_id: request.taskId,
        run_id: request.runId,
        capability: request.capability,
        scope: request.scope,
        resource: request.resource ?? null,
        command: request.command ?? null,
        cwd: request.cwd ?? null,
        decision: "allow",
        grant_scope: null,
        timestamp: request.createdAt,
      });
      return { decision: "allow" };
    }
    if (verdict.decision === "deny") {
      await this.audit.record({
        permission_request_id: request.id,
        task_id: request.taskId,
        run_id: request.runId,
        capability: request.capability,
        scope: request.scope,
        resource: request.resource ?? null,
        command: request.command ?? null,
        cwd: request.cwd ?? null,
        decision: "deny",
        grant_scope: null,
        timestamp: request.createdAt,
      });
      throw new PermissionDeniedError(request);
    }
    return this.suspend(request, input.signal);
  }

  private async suspend(
    request: PermissionRequest,
    signal?: AbortSignal,
  ): Promise<BrokerDecision> {
    if (this.pending.has(request.runId)) {
      throw new PermissionDeniedError(request, "Another permission request is already pending");
    }
    const decision = new Promise<BrokerDecision>((resolve, reject) => {
      this.pending.set(request.runId, { request, resolve, reject });
    });
    void decision.catch(() => undefined);
    await this.audit.record({
      permission_request_id: request.id,
      task_id: request.taskId,
      run_id: request.runId,
      capability: request.capability,
      scope: request.scope,
      resource: request.resource ?? null,
      command: request.command ?? null,
      cwd: request.cwd ?? null,
      decision: "pending",
      grant_scope: null,
      timestamp: request.createdAt,
    });
    await this.recordRunEvent({
      type: "permission_requested",
      request_id: request.id,
      capability: request.capability,
      scope: request.scope,
      resource: request.resource ?? null,
      canonical_resource: request.canonicalResource ?? null,
      command: request.command ?? null,
      cwd: request.cwd ?? null,
      summary: summarize(request),
    });
    const abort = (): void => {
      const entry = this.pending.get(request.runId);
      if (entry === undefined || entry.request.id !== request.id) return;
      this.pending.delete(request.runId);
      entry.reject(new Error("permission request aborted"));
    };
    if (signal !== undefined) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    try {
      return await decision;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  /**
   * Resolve a pending request with a user decision. Returns false when the
   * request is unknown, already resolved, or expired.
   */
  async resolve(
    requestId: string,
    decision: "allow" | "deny",
    grantScope?: GrantScope,
  ): Promise<boolean> {
    for (const entry of this.pending.values()) {
      const pending = entry.request;
      if (pending.id !== requestId) continue;
      const ageMs = Date.now() - Date.parse(pending.createdAt);
      if (ageMs > this.maxPendingMs) {
        this.pending.delete(pending.runId);
        entry.reject(new Error("permission request expired"));
        return false;
      }
      this.pending.delete(pending.runId);
      if (decision === "allow" && grantScope !== undefined) {
        await this.recordGrant(pending, grantScope);
      }
      await this.audit.record({
        permission_request_id: pending.id,
        task_id: pending.taskId,
        run_id: pending.runId,
        capability: pending.capability,
        scope: pending.scope,
        resource: pending.resource ?? null,
        command: pending.command ?? null,
        cwd: pending.cwd ?? null,
        decision,
        grant_scope: grantScope ?? null,
        timestamp: new Date().toISOString(),
      });
      await this.recordRunEvent({
        type: "permission_resolved",
        request_id: pending.id,
        decision,
        grant_scope: grantScope ?? null,
      });
      entry.resolve({ decision, grantScope });
      return true;
    }
    return false;
  }

  /** Invalidate all pending requests for a run (cancel / shutdown). */
  rejectPending(runId: string, error: Error): void {
    const entry = this.pending.get(runId);
    if (entry === undefined) return;
    this.pending.delete(runId);
    entry.reject(error);
  }

  private async recordGrant(pending: PermissionRequest, grantScope: GrantScope): Promise<void> {
    if (grantScope === "once") return;
    if (grantScope === "run") {
      this.grants.add("run", pending.taskId, pending.runId, {
        capability: pending.capability,
        scope: pending.scope,
      });
      return;
    }
    if (grantScope === "task") {
      this.grants.add("task", pending.taskId, pending.runId, {
        capability: pending.capability,
        scope: pending.scope,
      });
      return;
    }
    // persistent → user settings rule (plan §17/§36).
    if (pending.capability === "process.exec") {
      await this.policyStore.setPersistentExecAllow(true);
      return;
    }
    if (pending.canonicalResource !== undefined) {
      await this.policyStore.addRule({
        capability: pending.capability,
        path: pending.canonicalResource,
        recursive: true,
        policy: "allow",
      });
    }
  }
}

export function summarize(request: PermissionRequest): string {
  if (request.capability === "process.exec") {
    return `执行命令 ${request.command ?? ""}`.trim();
  }
  const action = request.capability === "fs.read"
    ? "读取文件"
    : request.capability === "fs.write"
      ? "写入文件"
      : "修改文件";
  return `${action} ${request.resource ?? ""}`.trim();
}
