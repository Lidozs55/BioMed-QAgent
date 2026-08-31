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

/**
 * Explicit literature semantic-profile rejection thrown only by
 * ``validateLiteratureExperimentChartProfile`` after it has decided the
 * candidate fails the semantic profile closure.
 */
export class LiteratureProfileRejectionError extends Error {
  readonly reason: string;

  constructor(message: string) {
    super(message);
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
export class DynamicProductNotPublishableError extends Error {
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
export class PublicationAcceptanceRejectedError extends Error {
  readonly action: "reject" | "skip";
  readonly reason: string | null;

  constructor(action: "reject" | "skip", reason: string | null) {
    super(
      action === "reject"
        ? "dynamic publication review was not accepted: reject"
        : "dynamic publication review was not accepted: skip",
    );
    this.name = "PublicationAcceptanceRejectedError";
    this.action = action;
    this.reason = reason;
  }
}
