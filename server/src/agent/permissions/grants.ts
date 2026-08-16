import { randomUUID } from "node:crypto";

import { canonicalIsWithin } from "./path-normalizer.js";
import type { GrantScope, PermissionCapability, ResourceScope } from "./types.js";

/**
 * Temporary grants (plan §17, §19; round-3 audit: path-rooted grants).
 *
 * - ``once``: only the approved PermissionRequest executes (inherently once —
 *   it is consumed when the suspended tool call resumes).
 * - ``run``: the approved capability is auto-allowed for the rest of the run,
 *   rooted at the approved canonical resource.
 * - ``task``: the approved capability is auto-allowed for the task, across
 *   subsequent runs, rooted at the approved canonical resource.
 * - ``persistent``: not stored here — the broker writes a user rule into the
 *   policy store (plan §36).
 *
 * Filesystem grants carry the canonical path root of the approved request:
 * they cover that path AND its subtree, never the whole scope. A grant with
 * ``root === null`` covers the entire scope and is only created through the
 * explicit "whole scope" UI choice (round-3 audit: a "本 Task 允许" approval
 * for ``D:\dataset\TCGA\a.csv`` must not silently authorize every external
 * path on the machine). ``process.exec`` has no path — its grants are always
 * scope-wide by nature.
 *
 * Temporary grants are in-memory runtime state: a process restart clears them
 * and pending requests are invalidated, never silently re-approved (plan §31).
 */
export interface TemporaryGrant {
  id: string;
  capability: PermissionCapability;
  scope: ResourceScope;
  /** Canonical resource root (subtree) this grant covers; null = whole scope. */
  root: string | null;
  boundTo: "run" | "task";
  taskId: string;
  runId: string;
  grantedAt: string;
}

export interface TemporaryGrantInput {
  capability: PermissionCapability;
  scope: ResourceScope;
  /** Canonical resource root (subtree) this grant covers; null = whole scope. */
  root: string | null;
}

export class TemporaryGrantStore {
  private readonly grants = new Map<string, TemporaryGrant>();
  /** runId → grant ids (boundTo === "run"). */
  private readonly runIndex = new Map<string, Set<string>>();
  /** taskId → grant ids (boundTo === "task"). */
  private readonly taskIndex = new Map<string, Set<string>>();
  /** `${capability}:${scope}` → grant ids (fast request matching). */
  private readonly scopeIndex = new Map<string, Set<string>>();

  add(
    boundTo: Exclude<GrantScope, "once" | "persistent">,
    taskId: string,
    runId: string,
    grant: TemporaryGrantInput,
  ): string {
    const id = `grant_${randomUUID()}`;
    const entry: TemporaryGrant = {
      id,
      capability: grant.capability,
      scope: grant.scope,
      root: grant.root,
      boundTo,
      taskId,
      runId,
      grantedAt: new Date().toISOString(),
    };
    this.grants.set(id, entry);
    const bucket = boundTo === "run"
      ? (this.runIndex.get(runId) ?? new Set<string>())
      : (this.taskIndex.get(taskId) ?? new Set<string>());
    bucket.add(id);
    if (boundTo === "run") this.runIndex.set(runId, bucket);
    else this.taskIndex.set(taskId, bucket);
    const scopeBucket = this.scopeIndex.get(`${grant.capability}:${grant.scope}`) ?? new Set<string>();
    scopeBucket.add(id);
    this.scopeIndex.set(`${grant.capability}:${grant.scope}`, scopeBucket);
    return id;
  }

  /**
   * Match a request against active temporary grants. Filesystem grants
   * require the canonical target to be within the grant's root (or the grant
   * to be explicitly scope-wide); ``process.exec`` matches scope-wide grants
   * only.
   */
  matches(
    taskId: string,
    runId: string,
    capability: PermissionCapability,
    scope: ResourceScope,
    canonical?: string,
  ): boolean {
    const ids = this.scopeIndex.get(`${capability}:${scope}`);
    if (ids === undefined) return false;
    for (const id of ids) {
      const grant = this.grants.get(id);
      if (grant === undefined) continue;
      if (grant.boundTo === "run" && grant.runId !== runId) continue;
      if (grant.boundTo === "task" && grant.taskId !== taskId) continue;
      if (grant.root === null) return true;
      if (canonical !== undefined && canonicalIsWithin(grant.root, canonical)) return true;
    }
    return false;
  }

  /** Every active temporary grant (settings UI: view/revoke). */
  list(): TemporaryGrant[] {
    return [...this.grants.values()]
      .sort((left, right) => left.grantedAt.localeCompare(right.grantedAt));
  }

  /** Remove one grant by id; returns false when it does not exist. */
  revoke(id: string): boolean {
    const grant = this.grants.get(id);
    if (grant === undefined) return false;
    this.grants.delete(id);
    this.runIndex.get(grant.runId)?.delete(id);
    this.taskIndex.get(grant.taskId)?.delete(id);
    this.scopeIndex.get(`${grant.capability}:${grant.scope}`)?.delete(id);
    return true;
  }

  clearRun(runId: string): void {
    const ids = this.runIndex.get(runId);
    if (ids === undefined) return;
    for (const id of [...ids]) this.revoke(id);
  }

  clearTask(taskId: string): void {
    const ids = this.taskIndex.get(taskId);
    if (ids === undefined) return;
    for (const id of [...ids]) this.revoke(id);
  }
}
