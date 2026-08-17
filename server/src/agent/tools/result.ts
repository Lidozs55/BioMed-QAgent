/**
 * Shared tool-result helpers (deduplicated from ``gdc.ts``, ``xena.ts``,
 * ``browser.ts``, ``web-visual-capture.ts``, ``analysis.ts`` and ``pdf.ts``).
 */

/** Normalize an unknown error to its user-facing text. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** ``{ error: <message> }`` result marked as a tool failure. */
export function errorResult(error: unknown): { content: string; isError: true } {
  return {
    content: JSON.stringify({ error: errorMessage(error) }),
    isError: true,
  };
}

/** Pretty-printed JSON result body (Python ``json.dumps(..., indent=2)``). */
export function jsonContent(value: unknown): { content: string } {
  return { content: JSON.stringify(value, null, 2) };
}