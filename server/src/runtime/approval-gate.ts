/**
 * Minimal durable HIL approval primitive (P5-D9, P5-11).
 *
 * A credentialed tool invocation requests approval; the gate emits a durable
 * ``user_input_required`` event (prompt_kind ``api_key_or_credential``), the
 * run transitions to ``awaiting_user_input`` in the reducer, and the tool's
 * promise stays suspended until the user approves/rejects via the existing
 * ``POST .../runs/{run}/resume`` surface. The decision authorizes exactly one
 * tool invocation; secret values never reach the model context.
 *
 * Not a SubagentSupervisor port: no subagent lifecycle, no broker futures —
 * one pending approval per run, rejected on cancel/abort.
 */

import { randomUUID } from "node:crypto";

import type { ToolApprovalGate } from "../agent/tools/tool-hooks.js";
import type { DurableTaskRepository } from "./task-repository.js";

export interface ApprovalGateHandle extends ToolApprovalGate {
  /** Bind to the currently active run (task sessions outlive runs). */
  setRunId(runId: string): void;
  /** Resolve the pending approval for a run with a user decision. */
  resolvePending(runId: string, decision: "approve" | "reject"): boolean;
  /** Reject the pending approval (run cancel / host shutdown). */
  rejectPending(runId: string, error: Error): void;
  /** True when a decision is currently pending for the bound run. */
  hasPending(runId: string): boolean;
}

interface PendingApproval {
  requestId: string;
  resolve: (decision: "approve" | "reject") => void;
  reject: (error: Error) => void;
}

export class DurableApprovalGate implements ApprovalGateHandle {
  private readonly taskId: string;
  private readonly repository: DurableTaskRepository;
  private runId: string | null = null;
  private readonly pending = new Map<string, PendingApproval>();

  constructor(taskId: string, repository: DurableTaskRepository, runId?: string) {
    this.taskId = taskId;
    this.repository = repository;
    this.runId = runId ?? null;
  }

  setRunId(runId: string): void {
    this.runId = runId;
  }

  hasPending(runId: string): boolean {
    return this.pending.has(runId);
  }

  async request(operation: string, signal?: AbortSignal): Promise<"approve" | "reject"> {
    const runId = this.runId;
    if (runId === null) {
      throw new Error("approval gate is not bound to a run");
    }
    if (this.pending.has(runId)) {
      throw new Error("another approval request is already pending for this run");
    }
    const requestId = `approval_${randomUUID()}`;
    const decision = new Promise<"approve" | "reject">((resolve, reject) => {
      const entry: PendingApproval = {
        requestId,
        resolve: (value) => {
          if (this.pending.get(runId)?.requestId === requestId) this.pending.delete(runId);
          resolve(value);
        },
        reject,
      };
      this.pending.set(runId, entry);
      if (signal !== undefined) {
        const abort = (): void => {
          if (this.pending.get(runId)?.requestId === requestId) this.pending.delete(runId);
          reject(new Error("aborted"));
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      }
    });
    await this.repository.appendRunEvent(this.taskId, runId, {
      type: "user_input_required",
      request_id: requestId,
      prompt_kind: "api_key_or_credential",
      summary: `Approve credential use for ${operation}`,
      expires_at: null,
      fixture_exempt: false,
      detail: { operation },
    });
    return decision;
  }

  resolvePending(runId: string, decision: "approve" | "reject"): boolean {
    const pending = this.pending.get(runId);
    if (pending === undefined) return false;
    this.pending.delete(runId);
    pending.resolve(decision);
    return true;
  }

  rejectPending(runId: string, error: Error): void {
    const pending = this.pending.get(runId);
    if (pending === undefined) return;
    this.pending.delete(runId);
    pending.reject(error);
  }
}
