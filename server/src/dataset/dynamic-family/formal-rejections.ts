/**
 * Gold6 R4 typed formal-publication rejections (dataset-layer, fail-closed
 * fallback allowlist).
 *
 * Only these explicitly typed rejections are eligible for the automatic
 * untrusted-artifact fallback. Every other failure mode (cancellation/abort,
 * timeout/resource baseline, filesystem/copy/hash/path errors, stale
 * generation/fence/lock loss, HIL request errors, identity mismatch, and any
 * unknown error) propagates unchanged with zero fallback.
 */
import type { MultiTableValidationCheck } from "../contracts/validation.js";

export interface UntrustedFallbackReceiptSummary {
  readonly submission_id: string;
  readonly table_id: string;
  readonly name: string;
  readonly media_type: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly authoritative: false;
  readonly trust: "untrusted";
}

/**
 * Shared structured carrier for an intentional product rejection. The formal
 * rejection object is preserved whether fallback succeeds or fails; the Host
 * may attach either verified ua_* summaries or one bounded failure diagnostic.
 */
export abstract class FormalPublicationRejectionError extends Error {
  readonly formal_status = "rejected" as const;
  #untrustedArtifacts: readonly UntrustedFallbackReceiptSummary[] = Object.freeze([]);
  #fallbackFailure: string | null = null;

  protected constructor(message: string, options?: ErrorOptions) {
    super(message, options);
  }

  get untrusted_artifacts(): readonly UntrustedFallbackReceiptSummary[] {
    return this.#untrustedArtifacts;
  }

  get fallback_failure(): string | null {
    return this.#fallbackFailure;
  }

  attachUntrustedArtifacts(receipts: readonly UntrustedFallbackReceiptSummary[]): void {
    if (this.#fallbackFailure !== null || this.#untrustedArtifacts.length > 0) {
      throw new TypeError("formal rejection fallback outcome is already recorded");
    }
    if (receipts.length === 0) {
      throw new TypeError("formal rejection fallback requires at least one ua_* receipt");
    }
    this.#untrustedArtifacts = Object.freeze(receipts.map((receipt) => Object.freeze({ ...receipt })));
  }

  recordFallbackFailure(detail: string): void {
    if (this.#untrustedArtifacts.length > 0 || this.#fallbackFailure !== null) {
      throw new TypeError("formal rejection fallback outcome is already recorded");
    }
    this.#fallbackFailure = detail.slice(0, 400);
  }
}

/**
 * Explicit literature semantic-profile rejection thrown only after
 * ``validateLiteratureExperimentChartProfile`` has decided the candidate fails
 * the semantic profile closure.
 */
export class LiteratureProfileRejectionError extends FormalPublicationRejectionError {
  readonly reason: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LiteratureProfileRejectionError";
    this.reason = message;
  }
}

/**
 * Explicit final product rejection thrown when the completed B3 check closure
 * or the ProductAssessment decides the dynamic product is not publishable.
 * Carries the exact failed B3 checks for bounded projection into the fallback
 * receipts' ``source_note``.
 */
export class DynamicProductNotPublishableError extends FormalPublicationRejectionError {
  readonly failedChecks: MultiTableValidationCheck[];

  constructor(message: string, failedChecks: readonly MultiTableValidationCheck[]) {
    super(message);
    this.name = "DynamicProductNotPublishableError";
    this.failedChecks = [...failedChecks];
  }
}

/**
 * Explicit ``publication_acceptance`` human reject/skip. Thrown only when a
 * resolved durable review record carries a non-accept decision for the
 * evidence-bound dynamic candidate.
 */
export class PublicationAcceptanceRejectedError extends FormalPublicationRejectionError {
  readonly action: "reject" | "skip";
  readonly reason: string | null;

  constructor(action: "reject" | "skip", reason: string | null) {
    const base = action === "reject"
      ? "dynamic publication review was not accepted: reject"
      : "dynamic publication review was not accepted: skip";
    super(reason === null ? base : `${base}; reviewer reason: ${reason.slice(0, 2000)}`);
    this.name = "PublicationAcceptanceRejectedError";
    this.action = action;
    this.reason = reason;
  }
}
