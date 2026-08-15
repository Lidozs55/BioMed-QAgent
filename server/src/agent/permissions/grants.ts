import type { GrantScope, PermissionCapability, ResourceScope } from "./types.js";

/**
 * Temporary grants (plan §17, §19).
 *
 * - ``once``: only the approved PermissionRequest executes (inherently once —
 *   it is consumed when the suspended tool call resumes).
 * - ``run``: same capability × scope is auto-allowed for the rest of the run.
 * - ``task``: same capability × scope is auto-allowed for the task, across
 *   subsequent runs.
 * - ``persistent``: not stored here — the broker writes a user rule into the
 *   policy store (plan §36).
 *
 * Temporary grants are in-memory runtime state: a process restart clears them
 * and pending requests are invalidated, never silently re-approved (plan §31).
 */
export interface TemporaryGrant {
  capability: PermissionCapability;
  scope: ResourceScope;
  /** "run" grants bound to a run; "task" grants bound to the task. */
  boundTo: string;
}

export class TemporaryGrantStore {
  private readonly runGrants = new Map<string, Set<string>>();
  private readonly taskGrants = new Map<string, Set<string>>();

  private static key(capability: PermissionCapability, scope: ResourceScope): string {
    return `${capability}:${scope}`;
  }

  add(scope: Exclude<GrantScope, "once" | "persistent">, taskId: string, runId: string, grant: {
    capability: PermissionCapability;
    scope: ResourceScope;
  }): void {
    const key = TemporaryGrantStore.key(grant.capability, grant.scope);
    if (scope === "run") {
      const bucket = this.runGrants.get(runId) ?? new Set<string>();
      bucket.add(key);
      this.runGrants.set(runId, bucket);
      return;
    }
    const bucket = this.taskGrants.get(taskId) ?? new Set<string>();
    bucket.add(key);
    this.taskGrants.set(taskId, bucket);
  }

  /** Match a capability × scope request against active temporary grants. */
  matches(taskId: string, runId: string, capability: PermissionCapability, scope: ResourceScope): boolean {
    const key = TemporaryGrantStore.key(capability, scope);
    if (this.runGrants.get(runId)?.has(key) === true) return true;
    if (this.taskGrants.get(taskId)?.has(key) === true) return true;
    return false;
  }

  clearRun(runId: string): void {
    this.runGrants.delete(runId);
  }

  clearTask(taskId: string): void {
    this.taskGrants.delete(taskId);
  }
}
