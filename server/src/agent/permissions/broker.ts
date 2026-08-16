import { randomUUID } from "node:crypto";

import type { EventPayload } from "@biomed/contracts";

import type { PermissionAuditSink } from "./audit.js";
import { PermissionEvaluator } from "./evaluator.js";
import { TemporaryGrantStore, type TemporaryGrant } from "./grants.js";
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
  private runId: string;
  private readonly evaluator: PermissionEvaluator;
  private readonly grants: TemporaryGrantStore;
  private readonly policyStore: PermissionPolicyStore;
  private readonly audit: PermissionAuditSink;
  private readonly recordRunEvent: (payload: EventPayload) => Promise<void>;
  private readonly maxPendingMs: number;
  private readonly pending = new Map<string, PendingRequest>();  constructor(options: BrokerOptions) {
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

  /** Bind the broker to the currently active run (sessions outlive runs). */
  bindRun(runId: string): void {
    this.runId = runId;
  }

  /** True when a permission decision is currently pending for the run. */
  hasPending(runId: string): boolean {
    return this.pending.has(runId);
  }

  /** Active temporary grants of this task (settings UI: view/revoke). */
  listTemporaryGrants(): TemporaryGrant[] {
    return this.grants.list();
  }

  /** Revoke one temporary grant by id (settings UI); false when unknown. */
  revokeTemporaryGrant(id: string): boolean {
    return this.grants.revoke(id);
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
        canonical_resource: request.canonicalResource ?? null,
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
        canonical_resource: request.canonicalResource ?? null,
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
    try {
      await this.audit.record({
        permission_request_id: request.id,
        task_id: request.taskId,
        run_id: request.runId,
        capability: request.capability,
        scope: request.scope,
        resource: request.resource ?? null,
        canonical_resource: request.canonicalResource ?? null,
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
    } catch (error) {
      // Audit/event persistence is real file IO and can fail. Never leave an
      // orphaned pending entry or a tool call suspended forever: drop the
      // pending entry and fail the original tool call with the error
      // (audit fix — persistence failure settles the caller).
      const entry = this.pending.get(request.runId);
      if (entry !== undefined && entry.request.id === request.id) {
        this.pending.delete(request.runId);
        entry.reject(toError(error, "permission request could not be recorded"));
      }
      throw error;
    }
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
   * Resolve a pending request with a user decision. The lookup is bound to
   * the runId (from the HTTP URL) and then verified against the requestId,
   * so an old runId cannot be used to approve a live request of a newer run.
   * Returns false when the request is unknown, already resolved, or expired.
   *
   * Round-3 audit: an approval is re-validated against the CURRENT policy
   * before any grant is recorded — a request that was pending when the
   * preset switched to Restricted (or a deny rule appeared) is invalidated,
   * never released. The tool call settles with a structured denial and the
   * resolve returns true (the request WAS handled).
   */
  async resolve(
    runId: string,
    requestId: string,
    decision: "allow" | "deny",
    grantScope?: GrantScope,
    scopeWide = false,
  ): Promise<boolean> {
    const entry = this.pending.get(runId);
    if (entry === undefined || entry.request.id !== requestId) return false;
    const pending = entry.request;
    const ageMs = Date.now() - Date.parse(pending.createdAt);
    if (ageMs > this.maxPendingMs) {
      this.pending.delete(runId);
      entry.reject(new Error("permission request expired"));
      return false;
    }
    this.pending.delete(runId);
    if (decision === "allow") {
      // The policy may have changed while the request was pending (e.g. the
      // user switched to Restricted, or a deny rule was added). Re-evaluate
      // the ORIGINAL request; a deny verdict invalidates the old approval.
      const current = await this.evaluator.evaluate(pending);
      if (current.decision === "deny") {
        try {
          await this.audit.record({
            permission_request_id: pending.id,
            task_id: pending.taskId,
            run_id: pending.runId,
            capability: pending.capability,
            scope: pending.scope,
            resource: pending.resource ?? null,
            canonical_resource: pending.canonicalResource ?? null,
            command: pending.command ?? null,
            cwd: pending.cwd ?? null,
            decision: "deny",
            grant_scope: null,
            timestamp: new Date().toISOString(),
          });
          await this.recordRunEvent({
            type: "permission_resolved",
            request_id: pending.id,
            decision: "deny",
            grant_scope: null,
          });
        } catch {
          // Best-effort: the invalidation itself must not fail the settle.
        }
        entry.reject(new PermissionDeniedError(
          pending,
          "Permission request was superseded by a stricter policy",
        ));
        return true;
      }
    }
    let undo: (() => Promise<void>) | undefined;
    try {
      if (decision === "allow" && grantScope !== undefined) {
        undo = await this.recordGrant(pending, grantScope, scopeWide);
      }
      await this.audit.record({
        permission_request_id: pending.id,
        task_id: pending.taskId,
        run_id: pending.runId,
        capability: pending.capability,
        scope: pending.scope,
        resource: pending.resource ?? null,
        canonical_resource: pending.canonicalResource ?? null,
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
    } catch (error) {
      // A failed grant/audit/event write must NOT leave the original tool
      // call suspended forever (audit fix, fault-injection tested). If a
      // grant was already recorded (e.g. the persistent rule hit the disk
      // before the event write failed), roll it back so no authorization
      // survives a failed resolution (round-3 audit: transactional).
      if (undo !== undefined) {
        try {
          await undo();
        } catch {
          // Best-effort rollback; the security-relevant failure is reported
          // to both the HTTP caller and the tool call below.
        }
      }
      entry.reject(toError(error, "permission decision could not be recorded"));
      throw error;
    }
    if (decision === "deny") {
      // Deny surfaces as a structured permission error to the tool call
      // (plan §8), not as a "successful" decision.
      entry.reject(new PermissionDeniedError(pending, "Permission denied by user"));
      return true;
    }
    entry.resolve({ decision, grantScope });
    return true;
  }

  /** Invalidate all pending requests for a run (cancel / shutdown). */
  rejectPending(runId: string, error: Error): void {
    const entry = this.pending.get(runId);
    if (entry === undefined) return;
    this.pending.delete(runId);
    entry.reject(error);
  }

  /**
   * Invalidate every pending request across all runs of this broker and
   * settle the suspended tool calls. Used when the preset switches to
   * Restricted so stale approval cards cannot be clicked into an effective
   * grant (round-3 audit P0). The timeline stays truthful: each request is
   * recorded as resolved-deny (best-effort).
   */
  async invalidateAllPending(error: Error): Promise<void> {
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [, entry] of entries) {
      const pending = entry.request;
      try {
        await this.audit.record({
          permission_request_id: pending.id,
          task_id: pending.taskId,
          run_id: pending.runId,
          capability: pending.capability,
          scope: pending.scope,
          resource: pending.resource ?? null,
          canonical_resource: pending.canonicalResource ?? null,
          command: pending.command ?? null,
          cwd: pending.cwd ?? null,
          decision: "deny",
          grant_scope: null,
          timestamp: new Date().toISOString(),
        });
        await this.recordRunEvent({
          type: "permission_resolved",
          request_id: pending.id,
          decision: "deny",
          grant_scope: null,
        });
      } catch {
        // Best-effort event/audit writes; the tool call must still settle.
      }
      entry.reject(error);
    }
  }

  /**
   * Record a grant for a resolved request and return an undo function.
   * Filesystem run/task grants bind to the approved canonical resource
   * (path + subtree), never the whole scope (round-3 audit); exec grants
   * are scope-wide (exec has no path).
   */
  private async recordGrant(
    pending: PermissionRequest,
    grantScope: GrantScope,
    scopeWide = false,
  ): Promise<() => Promise<void>> {
    if (grantScope === "once") return async () => undefined;
    if (grantScope === "run" || grantScope === "task") {
      const id = this.grants.add(grantScope, pending.taskId, pending.runId, {
        capability: pending.capability,
        scope: pending.scope,
        root: pending.capability === "process.exec"
          ? null
          : (scopeWide ? null : (pending.canonicalResource ?? null)),
      });
      return async () => {
        this.grants.revoke(id);
      };
    }
    // persistent → user settings rule (plan §17/§36). The undo restores the
    // previous settings on a downstream failure (round-3 audit rollback).
    if (pending.capability === "process.exec") {
      const settings = await this.policyStore.getSettings();
      const previous = settings.persistent_exec_allow;
      await this.policyStore.setPersistentExecAllow(true);
      return async () => {
        await this.policyStore.setPersistentExecAllow(previous);
      };
    }
    if (pending.canonicalResource !== undefined) {
      const ruleId = `rule_${randomUUID()}`;
      await this.policyStore.addRule({
        id: ruleId,
        capability: pending.capability as "fs.read" | "fs.write" | "fs.edit",
        path: pending.canonicalResource,
        recursive: true,
        policy: "allow",
      });
      return async () => {
        await this.policyStore.removeRule(ruleId);
      };
    }
    return async () => undefined;
  }
}

/** Host-level registry of live permission brokers (round-3 audit). */
export class PermissionBrokerRegistry {
  private readonly brokers = new Map<string, PermissionBroker>();

  register(taskId: string, broker: PermissionBroker): void {
    this.brokers.set(taskId, broker);
  }

  unregister(taskId: string): void {
    this.brokers.delete(taskId);
  }

  /** Settle every pending permission across all live brokers. */
  async invalidateAllPending(error: Error): Promise<void> {
    const brokers = [...this.brokers.values()];
    for (const broker of brokers) await broker.invalidateAllPending(error);
  }

  /** Every active temporary grant across all live tasks. */
  listTemporaryGrants(): TemporaryGrant[] {
    return [...this.brokers.values()].flatMap((broker) => broker.listTemporaryGrants());
  }

  /** Revoke one temporary grant by id across all live tasks. */
  revokeTemporaryGrant(id: string): boolean {
    for (const broker of this.brokers.values()) {
      if (broker.revokeTemporaryGrant(id)) return true;
    }
    return false;
  }
}

function toError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
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
