import type {
  HILDecision,
  HumanReviewRecord,
  JsonValue,
} from "@biomed/contracts";

import type { BoundHILRequestInput } from "../../runtime/hil-gate.js";
import { BuildError } from "../adapters/errors.js";
import {
  parseDataBatch,
  parseFieldMapping,
  type DataBatch,
  type FieldMapping,
} from "../contracts/data.js";
import type { NormalizationProfile } from "../contracts/profiles.js";
import type { UnitCorrection } from "../canonicalizer/canonicalizer.js";

export interface DatasetHILGate {
  requestHIL(
    input: BoundHILRequestInput,
    signal?: AbortSignal,
  ): Promise<HumanReviewRecord>;
}

export interface ReviewedBatch {
  batch: DataBatch;
  unitCorrection?: UnitCorrection;
}

function jsonObject(value: JsonValue, path: string): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BuildError(`${path} must be an object`);
  }
  return value;
}

function decisionFailure(decision: HILDecision, subject: string): never {
  const outcome = decision.action === "skip" ? "skipped" : "rejected";
  throw new BuildError(`${subject} was ${outcome} by human review`);
}

interface MappingReviewResult {
  mappings: FieldMapping[];
  corrections: JsonValue[];
}

function applyMappingReview(
  mappings: readonly FieldMapping[],
  review: HumanReviewRecord,
): MappingReviewResult {
  if (review.decision.action === "reject" || review.decision.action === "skip") {
    return decisionFailure(review.decision, "field mapping candidate");
  }
  if (review.decision.action === "approve") {
    throw new BuildError("approve is not valid for field mapping review");
  }
  let corrections: Record<string, JsonValue> | null = null;
  if (review.decision.action === "correct") {
    const correction = jsonObject(review.decision.correction, "mapping correction");
    corrections = jsonObject(correction["mappings"] ?? null, "mapping correction.mappings");
  }
  const structuredCorrections: JsonValue[] = [];
  const reviewedMappings = mappings.map((mapping) => {
    if (
      mapping.mapping_method !== "string_similarity" &&
      mapping.review_status !== "proposed"
    ) return mapping;
    let targetField = mapping.target_field;
    let transform = mapping.transform;
    if (corrections !== null) {
      const original = {
        target_field: mapping.target_field,
        transform: mapping.transform,
      };
      const item = jsonObject(
        corrections[mapping.mapping_id] ?? null,
        `mapping correction.mappings.${mapping.mapping_id}`,
      );
      if (typeof item["target_field"] !== "string" || item["target_field"].trim() === "") {
        throw new BuildError(`mapping correction for ${mapping.mapping_id} needs target_field`);
      }
      targetField = item["target_field"];
      if (item["transform"] !== undefined) {
        if (typeof item["transform"] !== "string") {
          throw new BuildError(`mapping correction for ${mapping.mapping_id} has invalid transform`);
        }
        transform = item["transform"];
      }
      structuredCorrections.push({
        mapping_id: mapping.mapping_id,
        review_id: review.review_id,
        original,
        corrected: { target_field: targetField, transform },
      });
    }
    return parseFieldMapping({
      ...mapping,
      target_field: targetField,
      transform,
      mapping_method: "human_approved",
      review_status: "accepted",
      // Human approval resolves the blocker but does not strengthen evidence.
      confidence_level: mapping.confidence_level,
      evidence: `${mapping.evidence}; human review ${review.review_id} ${review.decision.action}`,
    });
  });
  return { mappings: reviewedMappings, corrections: structuredCorrections };
}

const LINEAR_NUMBER = "([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?)";

function registeredUnitCorrection(
  sourceUnit: string,
  profile: NormalizationProfile,
): UnitCorrection | null {
  const candidates = profile.unit_conversions.filter(
    (rule) => rule.from_unit === sourceUnit && profile.allowed_units.includes(rule.to_unit),
  );
  if (candidates.length === 0) return null;
  if (candidates.length > 1) {
    throw new BuildError(`multiple registered unit rules match '${sourceUnit}'`);
  }
  const rule = candidates[0];
  const formula = rule.formula.trim().toLowerCase();
  let factor = 1;
  let offset = 0;
  let match: RegExpExecArray | null;
  if (formula === "value") {
    // identity
  } else if ((match = new RegExp(`^value\\s*\\*\\s*${LINEAR_NUMBER}(?:\\s*([+-])\\s*${LINEAR_NUMBER})?$`, "i").exec(formula)) !== null) {
    factor = Number(match[1]);
    if (match[2] !== undefined && match[3] !== undefined) {
      offset = (match[2] === "-" ? -1 : 1) * Number(match[3]);
    }
  } else if ((match = new RegExp(`^${LINEAR_NUMBER}\\s*\\*\\s*value(?:\\s*([+-])\\s*${LINEAR_NUMBER})?$`, "i").exec(formula)) !== null) {
    factor = Number(match[1]);
    if (match[2] !== undefined && match[3] !== undefined) {
      offset = (match[2] === "-" ? -1 : 1) * Number(match[3]);
    }
  } else if ((match = new RegExp(`^value\\s*\\/\\s*${LINEAR_NUMBER}(?:\\s*([+-])\\s*${LINEAR_NUMBER})?$`, "i").exec(formula)) !== null) {
    const divisor = Number(match[1]);
    if (divisor === 0) throw new BuildError(`registered unit rule '${rule.rule_id}' divides by zero`);
    factor = 1 / divisor;
    if (match[2] !== undefined && match[3] !== undefined) {
      offset = (match[2] === "-" ? -1 : 1) * Number(match[3]);
    }
  } else if ((match = new RegExp(`^value\\s*([+-])\\s*${LINEAR_NUMBER}$`, "i").exec(formula)) !== null) {
    offset = (match[1] === "-" ? -1 : 1) * Number(match[2]);
  } else {
    throw new BuildError(
      `registered unit rule '${rule.rule_id}' must use a safe linear formula`,
    );
  }
  if (!Number.isFinite(factor) || !Number.isFinite(offset)) {
    throw new BuildError(`registered unit rule '${rule.rule_id}' is not finite`);
  }
  return {
    method: "registered_rule",
    rule_id: rule.rule_id,
    from_unit: rule.from_unit,
    to_unit: rule.to_unit,
    factor,
    offset,
    evidence: rule.evidence,
    review_id: null,
  };
}

function parseUnitCorrection(
  decision: HILDecision,
  sourceUnit: string,
  profile: NormalizationProfile,
  reviewId: string,
): UnitCorrection {
  if (decision.action === "reject" || decision.action === "skip") {
    return decisionFailure(decision, "unit conversion candidate");
  }
  if (decision.action !== "correct") {
    throw new BuildError("unknown units require a structured correction");
  }
  const root = jsonObject(decision.correction, "unit correction");
  const correction = jsonObject(
    root["unit_conversion"] ?? null,
    "unit correction.unit_conversion",
  );
  const fromUnit = correction["from_unit"];
  const toUnit = correction["to_unit"];
  const factor = correction["factor"];
  const offset = correction["offset"];
  const evidence = correction["evidence"];
  if (fromUnit !== sourceUnit) {
    throw new BuildError("unit correction.from_unit does not match the reviewed evidence");
  }
  if (typeof toUnit !== "string" || !profile.allowed_units.includes(toUnit)) {
    throw new BuildError("unit correction.to_unit is not allowed by the normalization profile");
  }
  if (typeof factor !== "number" || !Number.isFinite(factor)) {
    throw new BuildError("unit correction.factor must be a finite number");
  }
  if (typeof offset !== "number" || !Number.isFinite(offset)) {
    throw new BuildError("unit correction.offset must be a finite number");
  }
  if (typeof evidence !== "string" || evidence.trim() === "") {
    throw new BuildError("unit correction.evidence must be a non-empty string");
  }
  return {
    method: "human_correction",
    rule_id: null,
    from_unit: fromUnit,
    to_unit: toUnit,
    factor,
    offset,
    evidence,
    review_id: reviewId,
  };
}

export async function reviewBatchForHIL(options: {
  batch: DataBatch;
  profile: NormalizationProfile;
  gate: DatasetHILGate | null;
  buildId: string;
  signal?: AbortSignal;
}): Promise<ReviewedBatch> {
  let batch = options.batch;
  const proposed = batch.declared_mappings.filter(
    (mapping) =>
      mapping.mapping_method === "string_similarity" ||
      mapping.review_status === "proposed",
  );
  if (proposed.length > 0) {
    if (options.gate === null) {
      throw new BuildError("proposed field mappings require a durable HIL gate");
    }
    const review = await options.gate.requestHIL({
      build_id: options.buildId,
      kind: "semantic_review",
      review_type: "field_mapping",
      blocking: true,
      subject: {
        binding_id: batch.binding_id,
        mapping_ids: proposed.map((mapping) => mapping.mapping_id),
      },
      review_items: proposed.map((mapping) => ({
        item_id: mapping.mapping_id,
        summary: `${mapping.source_field} → ${mapping.target_field}`,
        subject: { mapping_ids: [mapping.mapping_id] },
        evidence: {
          source_field: mapping.source_field,
          proposed_target: mapping.target_field,
          mapping_method: mapping.mapping_method,
          evidence: mapping.evidence,
        },
        proposed_value: mapping.target_field,
        confidence_level: mapping.confidence_level,
      })),
      summary: `${proposed.length} proposed field mapping(s) require review`,
      evidence: {
        batch_id: batch.batch_id,
        mappings: proposed.map((mapping) => ({
          mapping_id: mapping.mapping_id,
          source_field: mapping.source_field,
          target_field: mapping.target_field,
          mapping_method: mapping.mapping_method,
          confidence_level: mapping.confidence_level,
          evidence: mapping.evidence,
        })),
      },
      policy_ref: "dataset.field_mapping.v1",
      idempotency_key: `${options.buildId}:${batch.binding_id}:field_mapping`,
    }, options.signal);
    const mappingReview = applyMappingReview(batch.declared_mappings, review);
    batch = parseDataBatch({
      ...batch,
      declared_mappings: mappingReview.mappings,
      statistics: {
        ...batch.statistics,
        mapping_human_review_state:
          review.decision.action === "correct" ? "corrected" : "accepted",
        mapping_human_review: {
          review_id: review.review_id,
          decision: review.decision.action,
        },
        human_mapping_corrections: mappingReview.corrections,
      },
    });
  }

  const declaredUnit = batch.statistics["expression_unit"];
  if (
    typeof declaredUnit === "string" &&
    declaredUnit !== "" &&
    !options.profile.allowed_units.includes(declaredUnit)
  ) {
    const registeredCorrection = registeredUnitCorrection(declaredUnit, options.profile);
    if (registeredCorrection !== null) {
      batch = parseDataBatch({
        ...batch,
        statistics: {
          ...batch.statistics,
          registered_unit_conversion: registeredCorrection,
        },
      });
      return { batch, unitCorrection: registeredCorrection };
    }
    if (options.gate === null) {
      throw new BuildError(`unknown unit '${declaredUnit}' requires a durable HIL gate`);
    }
    const review = await options.gate.requestHIL({
      build_id: options.buildId,
      kind: "semantic_review",
      review_type: "unit_conversion",
      blocking: true,
      subject: { binding_id: batch.binding_id },
      review_items: [{
        item_id: `unit_${batch.binding_id}`,
        summary: `Resolve unit '${declaredUnit}'`,
        subject: { binding_id: batch.binding_id },
        evidence: {
          declared_unit: declaredUnit,
          allowed_units: options.profile.allowed_units,
        },
        proposed_value: null,
        confidence_level: "low",
      }],
      summary: `Unit '${declaredUnit}' has no registered conversion rule`,
      evidence: {
        batch_id: batch.batch_id,
        declared_unit: declaredUnit,
        allowed_units: options.profile.allowed_units,
      },
      policy_ref: "dataset.unit_conversion.v1",
      idempotency_key: `${options.buildId}:${batch.binding_id}:unit_conversion:${declaredUnit}`,
    }, options.signal);
    const unitCorrection = parseUnitCorrection(
      review.decision,
      declaredUnit,
      options.profile,
      review.review_id,
    );
    batch = parseDataBatch({
      ...batch,
      statistics: {
        ...batch.statistics,
        human_unit_correction: unitCorrection,
      },
    });
    return { batch, unitCorrection };
  }
  return { batch };
}
