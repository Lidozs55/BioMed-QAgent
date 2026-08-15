/**
 * Shared hook surface for migrated business tools (P5-03+).
 *
 * The legacy Python tools log queries (QueryStatus: success|not_found|failed|
 * skipped|page_fallback) and emit stage progress events. TS tools accept these
 * optional hooks so the P5-12 formal runtime can project them onto the durable
 * event log without business modules knowing about events.
 */

export type QueryStatus = "success" | "not_found" | "failed" | "skipped" | "page_fallback";

export interface ToolHooks {
  /**
   * Query lifecycle start (parity with the V2 operation lifecycle, Design
   * §15.1). Emitted once per query at its beginning so the runtime can open
   * an ``operation_started`` event; the matching ``onQuery`` call at the end
   * closes it with ``operation_completed``/``operation_failed``.
   */
  onQueryStarted?: (query: string, source: string) => void;
  /** Python run_ctx.log_query parity. */
  onQuery?: (query: string, source: string, status: QueryStatus, recordsCount?: number) => void;
  /** Python stage progress parity (stage, kind, payload). */
  onProgress?: (stage: string, kind: string, payload: Record<string, unknown>) => void;
}

/** Common dependency surface every networked business tool needs. */
export interface ToolServiceDeps {
  /** Absolute task root (TaskWorkDir root). */
  taskRoot: string;
  hooks?: ToolHooks;
}

/**
 * Minimal durable HIL approval primitive (P5-D9). A credentialed tool
 * invocation asks the gate; the run pauses on a durable user_input_required
 * event and resumes when the user decides. The decision applies to exactly
 * one tool invocation and the secret value is never exposed to the model.
 */
export interface ToolApprovalGate {
  request(operation: string, signal?: AbortSignal): Promise<"approve" | "reject">;
}

export function noopHooks(hooks?: ToolHooks): Required<ToolHooks> {
  return {
    onQueryStarted: hooks?.onQueryStarted ?? (() => undefined),
    onQuery: hooks?.onQuery ?? (() => undefined),
    onProgress: hooks?.onProgress ?? (() => undefined),
  };
}
