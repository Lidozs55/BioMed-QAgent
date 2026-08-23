import type {
  HILKind,
  HILReviewItem,
  HILReviewType,
  HILSubject,
  JsonValue,
} from "@biomed/contracts";

import { canonicalDigest } from "../adapters/identity.js";

export interface HILEvidenceDigestInput {
  readonly kind: HILKind;
  readonly review_type: HILReviewType | null;
  readonly subject: HILSubject;
  readonly review_items: readonly HILReviewItem[];
  readonly summary: string;
  readonly evidence: JsonValue;
  readonly policy_ref: string;
}

export function computeHILEvidenceDigest(input: HILEvidenceDigestInput): string {
  return canonicalDigest({
    kind: input.kind,
    review_type: input.review_type,
    subject: { ...input.subject },
    review_items: input.review_items.map((item) => ({
      ...item,
      subject: { ...item.subject },
      evidence: { ...item.evidence },
    })),
    summary: input.summary,
    evidence: input.evidence,
    policy_ref: input.policy_ref,
  });
}
