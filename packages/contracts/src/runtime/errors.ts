/**
 * Cross-process protocol error type.
 *
 * Shared by every wire parser in this package so frontend and backend reject
 * malformed payloads with the same error contract. The frontend re-exports it
 * as ``APIError`` (see ``frontend/src/api/errors.ts``); the HTTP client uses
 * ``status`` for the HTTP status the error is attributed to (502 for
 * unparseable upstream responses, the real status for HTTP-level failures).
 */

/** Check if a value has a string `msg` property. */
function hasMsg(v: unknown): v is object & { msg: string } {
  return v !== null && typeof v === "object" && "msg" in v && typeof Reflect.get(v, "msg") === "string";
}

/** Check if a value has a `detail` property (for nested error wrapping). */
function hasDetail(v: unknown): v is object & { detail: unknown } {
  return v !== null && typeof v === "object" && "detail" in v;
}

/** Normalize an API error detail into a readable message. */
export function normalizeErrorDetail(status: number, detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages: string[] = [];
    for (const item of detail) {
      if (hasMsg(item)) messages.push(item.msg);
    }
    if (messages.length > 0) return messages.join("; ");
  }
  if (hasDetail(detail)) {
    return normalizeErrorDetail(status, Reflect.get(detail, "detail"));
  }
  return `API request failed (${status})`;
}

export class APIError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detail: unknown) {
    super(normalizeErrorDetail(status, detail));
    this.name = "APIError";
    this.status = status;
    this.detail = detail;
  }
}
