export type TransformHostErrorCode =
  | "source_invalid"
  | "source_policy_violation"
  | "descriptor_mismatch"
  | "bundle_conflict"
  | "quarantine_violation"
  | "protocol_invalid"
  | "sandbox_unavailable";

/** Stable fail-closed error used only by the non-production Transform Host slice. */
export class TransformHostError extends Error {
  readonly code: TransformHostErrorCode;

  constructor(code: TransformHostErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransformHostError";
    this.code = code;
  }
}
