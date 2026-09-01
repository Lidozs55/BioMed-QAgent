/**
 * Host-owned semantic route fence (R5).
 *
 * Closes the Gold6 R3/R4 escape: after a run selects Dynamic Family, a
 * changed `requirement_id` must not reopen the static
 * validate/execute_dataset_execution route. The fence is intentionally
 * one-way and task-scoped — it never keys on `requirement_id`, so it cannot
 * be sidestepped by switching identifiers, and it never unlocks after a
 * dynamic rejection. A genuinely fresh run (new task) gets a new fence and
 * stays independent.
 *
 * Persistence mirrors `dynamic-family-preflight-coordinator.ts`: a small
 * task-owned state file under `<taskRoot>/state/`, written atomically, so
 * the committed route survives restart and run replay. The state file is
 * read synchronously at construction so a fence recreated for a later run
 * observes the committed route before any tool call.
 */
import { readFileSync } from "node:fs";

import { writeJsonAtomic } from "../persistence/atomic-json.js";

const PERSISTED_STATE = {
  schema_version: "1.0" as const,
  route: "dynamic_family" as const,
};

/** Non-retryable static-route rejection raised once the dynamic route is committed. */
export class SemanticRouteFenceError extends Error {
  readonly code = "route_fenced_dynamic";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "SemanticRouteFenceError";
  }
}

export interface SemanticRouteFenceOptions {
  /** Task-owned state file. Omit for an in-memory test fence. */
  readonly stateFile?: string;
}

export interface SemanticRouteFence {
  /**
   * Commit the run to the Dynamic Family route. Called no later than the
   * first formal dynamic prepare/scaffold boundary; idempotent.
   */
  commitDynamicRoute(): Promise<void>;
  /** True once the dynamic route has been committed for this task. */
  isDynamicRouteCommitted(): boolean;
  /**
   * Throw `SemanticRouteFenceError` when the dynamic route is committed.
   * Called by static validate/execute before any acquisition or filesystem
   * write; inspection tools never call this and stay non-committing.
   */
  assertStaticRouteAllowed(): void;
}

function loadCommitted(stateFile: string): boolean {
  try {
    const value: unknown = JSON.parse(readFileSync(stateFile, "utf8"));
    return (
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      (value as Record<string, unknown>).route === PERSISTED_STATE.route
    );
  } catch {
    // Missing (fresh task) or unreadable state: the static route stays open,
    // matching readJsonFileOrNull semantics used by sibling state files.
    return false;
  }
}

export function createSemanticRouteFence(
  options: SemanticRouteFenceOptions = {},
): SemanticRouteFence {
  let committed = options.stateFile === undefined ? false : loadCommitted(options.stateFile);
  let writeChain: Promise<void> = Promise.resolve();

  return {
    async commitDynamicRoute(): Promise<void> {
      if (committed) return;
      committed = true;
      if (options.stateFile === undefined) return;
      const write = writeChain.then(() => writeJsonAtomic(options.stateFile!, PERSISTED_STATE));
      // Chain continuation must not reject on an earlier failed write; the
      // awaited `write` below still propagates the error to this caller.
      writeChain = write.catch(() => undefined);
      await write;
      // On write failure the in-memory `committed` flag intentionally stays
      // true (fail-closed for the static route) and the error propagates,
      // aborting the dynamic boundary that called commitDynamicRoute.
    },

    isDynamicRouteCommitted(): boolean {
      return committed;
    },

    assertStaticRouteAllowed(): void {
      if (committed) {
        throw new SemanticRouteFenceError(
          "this task already selected the Dynamic Family route; static validate/execute is fenced. " +
            "Continue on the dynamic route (prepare_dynamic_family_publication → submit_dynamic_family_publication); " +
            "a changed requirement_id does not reopen the static route.",
        );
      }
    },
  };
}
