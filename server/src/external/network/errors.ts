/**
 * Outbound network safety errors (Python ``app/tools/network_safety.py``
 * parity). Message text is stable contract: fixture tests and live callers
 * compare against it.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** Acquirer-facing failure carrying a stable contract ErrorCode. */
export class AcquisitionError extends Error {
  constructor(
    readonly code:
      | "network_error"
      | "timeout"
      | "download_incomplete"
      | "checksum_mismatch"
      | "parse_error"
      | "validation_error"
      | "cancelled"
      | "internal_error",
    message: string,
  ) {
    super(message);
    this.name = "AcquisitionError";
  }
}

export function isAbortError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
