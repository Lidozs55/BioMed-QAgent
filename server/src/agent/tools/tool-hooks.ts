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

/** Shared download-progress payload metadata across acquisition tools. */
export interface DownloadProgressMeta {
  /** Data-source key (e.g. ``xena`` / ``gdc`` / ``pubmed``). */
  source: string;
  /** Dataset/file accession echoed into the progress payload. */
  accession: string;
  filename: string;
  /** Optional records/platform refinements (e.g. GEO platform annotation). */
  records?: number;
  platform?: string;
}

export interface DownloadProgressOptions {
  /** Minimum interval between emissions in ms (default 1000). */
  intervalMs?: number;
  /** Emit when this many new bytes arrive (default 8 MiB). */
  bytesStep?: number;
}

/**
 * Byte-level download progress reporter (P5-D3 parity with the Python
 * ``_report_progress``): bridges ``acquireSource`` byte callbacks into
 * ``operation_progress`` (``downloaded_bytes``) events. Every acquisition tool
 * shares this one implementation so the payload shape stays consistent for the
 * frontend reducer, which binds progress to the owning tool call via
 * ``detail.accession``.
 *
 * The returned function is throttled (interval OR byte step). ``finalize`` is
 * a terminal sink that bypasses throttling and is invoked automatically by
 * ``acquireSource`` once on success (see ``AcquisitionProgress`` in
 * ``external/acquisition/downloader.ts``), so the UI reaches 100% instead of
 * freezing on the last throttled tick. Tools never call ``finalize`` directly.
 */
export interface DownloadProgressReporter {
  (bytesReceived: number, declared: number | null): void;
  /** Called by ``acquireSource`` on success; bypasses throttling. */
  finalize(bytesReceived: number, total: number): void;
}

export function createDownloadProgressReporter(
  hooks: ToolHooks | undefined,
  meta: DownloadProgressMeta,
  options: DownloadProgressOptions = {},
): DownloadProgressReporter {
  const intervalMs = options.intervalMs ?? 1000;
  const bytesStep = options.bytesStep ?? 8 * 1024 * 1024;
  let lastAt = 0;
  let lastBytes = 0;
  const report = (bytesReceived: number, declared: number | null): void => {
    const now = Date.now();
    if (now - lastAt < intervalMs && bytesReceived - lastBytes < bytesStep) {
      return;
    }
    lastAt = now;
    lastBytes = bytesReceived;
    noopHooks(hooks).onProgress("acquisition", "downloaded_bytes", {
      current: bytesReceived,
      total: declared,
      ...meta,
    });
  };
  report.finalize = (bytesReceived: number, total: number): void => {
    noopHooks(hooks).onProgress("acquisition", "downloaded_bytes", {
      current: bytesReceived,
      total,
      ...meta,
    });
  };
  return report;
}
