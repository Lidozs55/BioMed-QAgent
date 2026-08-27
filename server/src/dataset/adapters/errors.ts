/**
 * Shared failure types for the dataset build chain (Python
 * ``app.datasets.build.errors``). The chain is composed of pure,
 * deterministic stages; execution failures raise these types while the
 * compatibility gate and validation profiles report structured rejections.
 */

/** Base class for a failed dataset build step (Python ExecutionError). */
export class ExecutionError extends Error {}

/** A source could not be parsed (malformed input, checksum mismatch). */
export class AdapterError extends ExecutionError {}

/**
 * A source file parsed to zero data rows (header-only input). Carries the
 * structured ``reason_code="no_primary_data"`` (Python EmptySourceError) so
 * the executor can propagate it without substring-matching error text.
 */
export class EmptySourceError extends AdapterError {
  readonly reason_code: string;

  constructor(message: string) {
    super(message);
    this.name = "EmptySourceError";
    this.reason_code = "no_primary_data";
  }
}

/**
 * One source binding is rejected during phase A (Phase 5 T7 D5).  Raised by
 * the runner when a binding canonicalized to zero usable rows (or, for
 * gene-required builds, to zero publishable gene rows) after its parse
 * succeeded.  The executor catches it per-binding — the binding's remaining
 * phase-A operations are skipped and phase B only receives the bindings that
 * did not raise (Python ``BindingRejectedError``).
 */
export class BindingRejectedError extends ExecutionError {
  readonly rejection: { binding_id: string; kind: "no_primary" | "error"; reason_code: string; message: string };

  constructor(rejection: {
    binding_id: string;
    kind: "no_primary" | "error";
    reason_code: string;
    message: string;
  }) {
    super(rejection.message);
    this.name = "BindingRejectedError";
    this.rejection = rejection;
  }
}