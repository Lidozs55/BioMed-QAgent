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

/**
 * Upstream HTTP failure surfaced to the agent with request context, so the
 * model can tell a rate limit from a bad query parameter. Fields are
 * duck-read by the tool-layer ``errorResult`` (``code`` / ``retryable`` /
 * ``statusCode``) without instanceof coupling.
 */
export class ToolHttpError extends Error {
  readonly code = "upstream_http_error";
  readonly retryable: boolean;

  constructor(
    readonly url: string,
    readonly statusCode: number,
    bodyExcerpt: string | null = null,
  ) {
    super(
      `GET ${url} → HTTP ${statusCode}${bodyExcerpt === null ? "" : `: ${bodyExcerpt}`}`,
    );
    this.name = "ToolHttpError";
    this.retryable = statusCode === 429 || statusCode >= 500;
  }
}

/** Acquirer-facing failure carrying a stable contract ErrorCode. */
export class AcquisitionError extends Error {
  constructor(
    readonly code:
      | "network_error"
      | "dns_failure"
      | "tls_failure"
      | "connect_refused"
      | "connect_timeout"
      | "connection_reset"
      | "http_server_error"
      | "http_client_error"
      | "media_mismatch"
      | "size_exceeded"
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

/**
 * Classify a raw transport error (Node errno / fetch TypeError, walking the
 * cause chain) into a fine-grained acquisition error code. Returns null when
 * nothing transport-specific is recognized (callers keep their own fallback,
 * e.g. internal_error for filesystem failures).
 */
export function classifyTransportFailure(error: unknown): AcquisitionError["code"] | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const errno = (current as { code?: unknown }).code;
    if (typeof errno === "string") {
      if (errno === "ENOTFOUND" || errno === "EAI_AGAIN") return "dns_failure";
      if (errno === "ECONNREFUSED") return "connect_refused";
      if (errno === "ETIMEDOUT" || errno === "EHOSTUNREACH" || errno === "ENETUNREACH") return "connect_timeout";
      if (errno === "ECONNRESET" || errno === "EPIPE" || errno === "ECONNABORTED") return "connection_reset";
      if (errno.startsWith("ERR_TLS") || errno.startsWith("ERR_SSL") || errno.startsWith("CERT_")
        || errno === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || errno === "DEPTH_ZERO_SELF_SIGNED_CERT"
        || errno === "SELF_SIGNED_CERT_IN_CHAIN") return "tls_failure";
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** HTTP status → retryable server-side class vs deterministic client error. */
export function httpFailureCode(status: number): AcquisitionError["code"] {
  return status === 408 || status === 429 || status >= 500 ? "http_server_error" : "http_client_error";
}

export function isAbortError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
