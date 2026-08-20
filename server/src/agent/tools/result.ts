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
  const details = {
    error: errorMessage(error).slice(0, 2_000),
    code,
    retryable,
    ...(statusCode === null ? {} : { status_code: statusCode }),
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