/**
 * Shared tool-result helpers (deduplicated from ``gdc.ts``, ``xena.ts``,
 * ``browser.ts``, ``web-visual-capture.ts``, ``analysis.ts`` and ``pdf.ts``).
 */

import type { BioMedToolResult } from "../contracts.js";

/** Normalize an unknown error to its user-facing text. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Return one bounded, machine-readable failure shape for business tools.
 * Existing callers still receive the stable `error` message, while Agents can
 * distinguish a retryable upstream failure from an input/provider failure.
 */
export function errorResult(error: unknown): BioMedToolResult {
  const record = error !== null && typeof error === "object" && !Array.isArray(error)
    ? error as Record<string, unknown>
    : null;
  const rawCode = record?.code;
  const code = typeof rawCode === "string" && rawCode.length > 0 ? rawCode.slice(0, 128) : "tool_error";
  const rawRetryable = record?.retryable;
  const retryable = typeof rawRetryable === "boolean" ? rawRetryable : false;
  const rawStatus = record?.statusCode ?? record?.status_code;
  const statusCode = typeof rawStatus === "number" && Number.isInteger(rawStatus)
    ? rawStatus
    : null;
  const rawDetail = record?.detail;
  const detail = Array.isArray(rawDetail) && rawDetail.length > 0 ? rawDetail.slice(0, 20) : undefined;
  const stack = firstPartyStack(error);
  const details = {
    error: errorMessage(error).slice(0, 2_000),
    code,
    retryable,
    ...(statusCode === null ? {} : { status_code: statusCode }),
    ...(detail === undefined ? {} : { detail }),
    ...(stack === null ? {} : { stack }),
  };
  return {
    content: JSON.stringify(details),
    details,
    isError: true,
  };
}

/** Pretty-printed JSON result body (Python ``json.dumps(..., indent=2)``). */
export function jsonContent(value: unknown): { content: string } {
  return { content: JSON.stringify(value, null, 2) };
}

/**
 * Bounded stack frames pointing at first-party code only (`server/src/`,
 * `packages/`), so the agent can follow up with the source-reading tools.
 * Node internals and node_modules frames are dropped; at most 8 frames are
 * kept, each truncated to 300 characters.
 */
export function firstPartyStack(error: unknown): string[] | null {
  if (!(error instanceof Error) || typeof error.stack !== "string") return null;
  const frames = error.stack
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => /(?:server\/src\/|packages\/)[\w./-]+:\d+/.test(line))
    .slice(0, 8)
    .map((line) => (line.length > 300 ? line.slice(0, 300) : line));
  return frames.length > 0 ? frames : null;
}