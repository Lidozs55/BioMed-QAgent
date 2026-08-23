export type TransformHostErrorCode =
  | "source_invalid"
  | "source_policy_violation"
  | "descriptor_mismatch"
  | "bundle_conflict"
  | "quarantine_violation"
  | "protocol_invalid"
  | "sandbox_unavailable"
  | "runtime_invalid"
  | "resource_limit_exceeded"
  | "invocation_cancelled";

/** Stable fail-closed error used by the staged Transform Host slices. */
export class TransformHostError extends Error {
  readonly code: TransformHostErrorCode;

  constructor(code: TransformHostErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransformHostError";
    this.code = code;
  }
}
