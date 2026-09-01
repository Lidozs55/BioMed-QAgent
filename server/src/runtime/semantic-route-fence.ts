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
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "../persistence/atomic-json.js";

const STATIC_STATE = {
  schema_version: "1.0" as const,
  route: "static" as const,
};
const DYNAMIC_STATE = {
  schema_version: "1.0" as const,
  route: "dynamic_family" as const,
};

type PersistedRouteState = typeof STATIC_STATE | typeof DYNAMIC_STATE;

/** Non-retryable static-route rejection raised once the dynamic route is committed. */
export class SemanticRouteFenceError extends Error {
  readonly code = "route_fenced_dynamic";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "SemanticRouteFenceError";
  }
}

/** Non-retryable startup failure for missing, corrupt, or unsafe route state. */
export class SemanticRouteFenceStateError extends Error {
  readonly code = "route_fence_state_invalid";
  readonly retryable = false;

  constructor(message: string) {
    super(message);
    this.name = "SemanticRouteFenceStateError";
  }
}

export interface SemanticRouteFenceOptions {
  /** Task-owned state file. Omit for an in-memory test fence. */
  readonly stateFile?: string;
  /** Task root used to reject symlinked state-path components. */
  readonly taskRoot?: string;
}

function stateRoot(options: SemanticRouteFenceOptions): string | null {
  if (options.stateFile === undefined) return null;
  return path.resolve(options.taskRoot ?? path.dirname(path.dirname(options.stateFile)));
}

function assertSafeStatePath(options: SemanticRouteFenceOptions): string {
  if (options.stateFile === undefined) {
    throw new SemanticRouteFenceStateError("semantic route state file is required for a durable fence");
  }
  const file = path.resolve(options.stateFile);
  const root = stateRoot(options)!;
  const relative = path.relative(root, file);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new SemanticRouteFenceStateError("semantic route state path escaped its task root");
  }

  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new SemanticRouteFenceStateError("semantic route state path contains a symlink");
      }
    } catch (error) {
      if (error instanceof SemanticRouteFenceStateError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new SemanticRouteFenceStateError(
          `semantic route state path could not be inspected: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      break;
    }
  }

  try {
    const canonicalRoot = realpathSync(root);
    const canonicalParent = realpathSync(path.dirname(file));
    const canonicalRelative = path.relative(canonicalRoot, canonicalParent);
    if (canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
      throw new SemanticRouteFenceStateError("semantic route state parent escaped its task root");
    }
  } catch (error) {
    if (error instanceof SemanticRouteFenceStateError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SemanticRouteFenceStateError(
        `semantic route state path could not be resolved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return file;
}

function parseState(value: unknown, stateFile: string): PersistedRouteState {
  if (
    value === null || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2
    || (value as Record<string, unknown>).schema_version !== "1.0"
    || ((value as Record<string, unknown>).route !== STATIC_STATE.route
      && (value as Record<string, unknown>).route !== DYNAMIC_STATE.route)
  ) {
    throw new SemanticRouteFenceStateError(`semantic route state is invalid: ${stateFile}`);
  }
  return (value as Record<string, unknown>).route === DYNAMIC_STATE.route
    ? DYNAMIC_STATE
    : STATIC_STATE;
}

function loadState(options: SemanticRouteFenceOptions): PersistedRouteState {
  const stateFile = assertSafeStatePath(options);
  try {
    return parseState(JSON.parse(readFileSync(stateFile, "utf8")), stateFile);
  } catch (error) {
    if (error instanceof SemanticRouteFenceStateError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SemanticRouteFenceStateError(
        `semantic route state is missing for an existing task: ${stateFile}`,
      );
    }
    throw new SemanticRouteFenceStateError(
      `semantic route state could not be read: ${stateFile}`,
    );
  }
}

/** Persist the explicit initial static route for a newly created task. */
export async function initializeSemanticRouteState(
  options: SemanticRouteFenceOptions,
): Promise<void> {
  const stateFile = assertSafeStatePath(options);
  try {
    parseState(JSON.parse(readFileSync(stateFile, "utf8")), stateFile);
    return;
  } catch (error) {
    if (error instanceof SemanticRouteFenceStateError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new SemanticRouteFenceStateError(
        `semantic route state could not be initialized: ${stateFile}`,
      );
    }
  }
  await writeJsonAtomic(stateFile, STATIC_STATE);
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

export function createSemanticRouteFence(
  options: SemanticRouteFenceOptions = {},
): SemanticRouteFence {
  const stateFile = options.stateFile === undefined
    ? undefined
    : assertSafeStatePath(options);
  let committed = stateFile === undefined
    ? false
    : loadState({ ...options, stateFile }).route === DYNAMIC_STATE.route;
  let commitPromise: Promise<void> | null = null;

  return {
    async commitDynamicRoute(): Promise<void> {
      if (stateFile === undefined) {
        committed = true;
        return;
      }
      if (committed) {
        if (commitPromise !== null) await commitPromise;
        return;
      }
      // Set the in-memory fence before scheduling the write. A failed write
      // remains fenced for this process, and the rejected promise is shared by
      // concurrent callers so no caller can proceed before durable commit.
      committed = true;
      commitPromise = writeJsonAtomic(stateFile, DYNAMIC_STATE);
      await commitPromise;
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
