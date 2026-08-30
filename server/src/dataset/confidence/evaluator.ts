import type {
  ConfidenceComponents,
  ConfidenceRecord,
  ConfidenceReliability,
  HumanReviewState,
} from "../contracts/data.js";
import type { ConfidenceLevel } from "../contracts/enums.js";
import { parseConfidenceRecord } from "../contracts/data.js";
import type { DigitAnomalyResult } from "./digit-anomaly.js";

const NONDETERMINISTIC_CHANNELS = new Set([
  "vlm",
  "llm",
  "ocr",
  "web_extraction",
]);

const LEVEL_RANK: Record<ConfidenceLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

export interface EvaluateConfidenceInput {
  confidence_id: string;
  batch_id: string;
  record_id: string;
  channel: string;
  components: Omit<ConfidenceComponents, "schema_version"> | ConfidenceComponents;
  reasons?: string[];
  /** Fixed-code digit-regularity screen result; "flagged" forces low. */
  digitAnomaly?: DigitAnomalyResult;
}

export interface MappingConfidenceInput {
  mapping_method: string;
  confidence_level: ConfidenceLevel;
  review_status: string;
}

export interface MappingConfidenceResult {
  reliability: ConfidenceReliability;
  human_review_state: HumanReviewState;
  reasons: string[];
}

function lowerLevel(left: ConfidenceLevel, right: ConfidenceLevel): ConfidenceLevel {
  return LEVEL_RANK[left] <= LEVEL_RANK[right] ? left : right;
}

export function evaluateConfidence(input: EvaluateConfidenceInput): ConfidenceRecord {
  const components = input.components;
  const applicable = [
    components.source_reliability,
    components.extraction_reliability,
    components.mapping_reliability,
  ].filter((level): level is ConfidenceLevel => level !== "not_applicable");
  let level: ConfidenceLevel = applicable.length === 0
    ? "low"
    : applicable.reduce(lowerLevel, "high" as ConfidenceLevel);
  const reasons = [...(input.reasons ?? [])];

  if (components.cross_source_consistency === "conflicting") {
    level = "low";
    reasons.push("independent source values conflict");
  } else if (components.cross_source_consistency === "partially_consistent") {
    level = lowerLevel(level, "medium");
    reasons.push("sources are only partially consistent");
  }
  if (components.human_review_state === "rejected") {
    level = "low";
    reasons.push("human reviewer rejected the candidate");
  }
  if (NONDETERMINISTIC_CHANNELS.has(input.channel) && level === "high") {
    level = "medium";
    reasons.push(`${input.channel} extraction is capped at medium`);
  }
  if (input.digitAnomaly !== undefined && input.digitAnomaly.verdict === "flagged") {
    level = "low";
    reasons.push(...input.digitAnomaly.reasons);
  }
  if (applicable.length === 0) reasons.push("no applicable evidence reliability was supplied");

  return parseConfidenceRecord({
    confidence_id: input.confidence_id,
    batch_id: input.batch_id,
    record_id: input.record_id,
    level,
    channel: input.channel,
    components,
    reasons: [...new Set(reasons)],
  });
}

export function requiresHumanReview(record: ConfidenceRecord): boolean {
  return record.components.human_review_state === "pending";
}

export function mappingConfidence(
  mappings: readonly MappingConfidenceInput[],
): MappingConfidenceResult {
  if (mappings.length === 0) {
    return {
      reliability: "not_applicable",
      human_review_state: "not_required",
      reasons: [],
    };
  }
  let reliability: ConfidenceReliability = "high";
  let reviewState: HumanReviewState = "not_required";
  const reasons: string[] = [];
  for (const mapping of mappings) {
    if (
      mapping.mapping_method === "string_similarity" ||
      mapping.review_status === "proposed"
    ) {
      reliability = "low";
      reviewState = "pending";
      reasons.push("proposed string-similarity mapping requires human review");
      continue;
    }
    if (mapping.mapping_method === "human_approved") {
      reviewState = reviewState === "pending" ? "pending" : "accepted";
    }
    reliability = lowerLevel(reliability, mapping.confidence_level);
  }
  return { reliability, human_review_state: reviewState, reasons: [...new Set(reasons)] };
}
