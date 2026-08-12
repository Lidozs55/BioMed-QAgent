/**
 * Shared failure types for the dataset build chain (Python
 * ``app.datasets.build.errors``). The chain is composed of pure,
 * deterministic stages; execution failures raise these types while the
 * compatibility gate and validation profiles report structured rejections.
 */

/** Base class for a failed dataset build step (Python BuildError). */
export class BuildError extends Error {}

/** A source could not be parsed (malformed input, checksum mismatch). */
export class AdapterError extends BuildError {}

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