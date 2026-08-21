import type {
  ProductAssessment,
  ProductBlocker,
  ProductScore,
  ProductScoreDimension,
  ProductStatus,
} from "../product-assessment.js";
import { APIError } from "./errors.js";
import {
  assertArray,
  assertFinite,
  assertNonNegativeInt,
  assertNumber,
  assertObject,
  assertString,
} from "./primitives.js";

const DIMENSIONS = [
  "schema",
  "relations",
  "identifiers",
  "provenance",
  "confidence",
  "reproducibility",
] as const satisfies readonly ProductScoreDimension[];
const STATUSES = ["incomplete", "validated", "publishable"] as const satisfies readonly ProductStatus[];
const BLOCKER_CODES = [
  "missing_entities",
  "missing_relations",
  "missing_evidence",
  "identity_not_closed",
  "cross_reference_not_closed",
  "provenance_incomplete",
  "confidence_below_threshold",
  "human_review_pending",
  "artifact_incomplete",
] as const satisfies readonly ProductBlocker["code"][];
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new APIError(502, `Unexpected field(s) at ${path}: ${extras.join(", ")}`);
}

function safeId(value: unknown, path: string): string {
  const parsed = assertString(value, path, true);
  if (!SAFE_ID.test(parsed)) throw new APIError(502, `Expected safe identifier at ${path}`);
  return parsed;
}

function boundedText(value: unknown, path: string, maxLength: number): string {
  const parsed = assertString(value, path, true);
  if (parsed.length > maxLength || /[\u0000-\u001f\u007f]/u.test(parsed)) {
    throw new APIError(502, `Expected bounded text at ${path}`);
  }
  return parsed;
}

function parseScore(value: unknown, path: string): ProductScore {
  const score = assertObject(value, path);
  exactKeys(score, ["dimension", "score", "satisfied", "required"], path);
  const required = assertNonNegativeInt(score.required, `${path}.required`);
  const satisfied = assertNonNegativeInt(score.satisfied, `${path}.satisfied`);
  const numericScore = assertNumber(score.score, `${path}.score`);
  if (numericScore < 0 || numericScore > 1 || satisfied > required) {
    throw new APIError(502, `${path} contains an invalid score ratio`);
  }
  const expected = required === 0 ? 1 : Number((satisfied / required).toFixed(6));
  if (numericScore !== expected) throw new APIError(502, `${path}.score does not match satisfied/required`);
  return {
    dimension: assertFinite(score.dimension, `${path}.dimension`, DIMENSIONS),
    score: numericScore,
    satisfied,
    required,
  };
}

function parseBlocker(value: unknown, path: string): ProductBlocker {
  const blocker = assertObject(value, path);
  exactKeys(blocker, ["requirement_id", "dimension", "code", "message"], path);
  return {
    requirement_id: safeId(blocker.requirement_id, `${path}.requirement_id`),
    dimension: assertFinite(blocker.dimension, `${path}.dimension`, DIMENSIONS),
    code: assertFinite(blocker.code, `${path}.code`, BLOCKER_CODES),
    message: boundedText(blocker.message, `${path}.message`, 1_024),
  };
}

function compareBlockers(left: ProductBlocker, right: ProductBlocker): number {
  return left.requirement_id.localeCompare(right.requirement_id) ||
    left.dimension.localeCompare(right.dimension) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message);
}

function validateStatus(assessment: ProductAssessment): void {
  const semanticBlockers = assessment.blockers.filter((blocker) => blocker.dimension !== "reproducibility");
  const allScoresClose = assessment.scores.every((score) => score.score === 1);
  if (assessment.product_status === "publishable") {
    if (assessment.blockers.length > 0 || assessment.missing_requirements.length > 0 || !allScoresClose) {
      throw new APIError(502, "A publishable ProductAssessment requires complete scores and no blockers");
    }
    return;
  }
  if (assessment.blockers.length === 0 || assessment.missing_requirements.length === 0) {
    throw new APIError(502, "A non-publishable ProductAssessment requires blockers and missing requirements");
  }
  if (assessment.product_status === "validated" && semanticBlockers.length > 0) {
    throw new APIError(502, "A validated ProductAssessment may contain only reproducibility blockers");
  }
  if (assessment.product_status === "incomplete" && semanticBlockers.length === 0) {
    throw new APIError(502, "An incomplete ProductAssessment requires a semantic blocker");
  }
}

export function parseProductAssessment(value: unknown): ProductAssessment {
  const assessment = assertObject(value, "product assessment");
  exactKeys(assessment, [
    "schema_version",
    "requirement_id",
    "package_id",
    "package_version",
    "product_status",
    "scores",
    "missing_requirements",
    "blockers",
  ], "product assessment");
  if (assessment.schema_version !== "1.0") {
    throw new APIError(502, 'Expected "1.0" at product assessment.schema_version');
  }
  const scores = assertArray(
    assessment.scores,
    "product assessment.scores",
    (entry, index) => parseScore(entry, `product assessment.scores[${index}]`),
  ).sort((left, right) => DIMENSIONS.indexOf(left.dimension) - DIMENSIONS.indexOf(right.dimension));
  if (scores.length !== DIMENSIONS.length || new Set(scores.map((score) => score.dimension)).size !== DIMENSIONS.length ||
      DIMENSIONS.some((dimension) => !scores.some((score) => score.dimension === dimension))) {
    throw new APIError(502, "ProductAssessment scores must contain every dimension exactly once");
  }
  const blockers = assertArray(
    assessment.blockers,
    "product assessment.blockers",
    (entry, index) => parseBlocker(entry, `product assessment.blockers[${index}]`),
  ).sort(compareBlockers);
  const blockerKeys = blockers.map((blocker) => [
    blocker.requirement_id,
    blocker.dimension,
    blocker.code,
    blocker.message,
  ].join("\u0000"));
  if (new Set(blockerKeys).size !== blockerKeys.length) {
    throw new APIError(502, "ProductAssessment blockers must not contain duplicates");
  }
  const missingRequirements = assertArray(
    assessment.missing_requirements,
    "product assessment.missing_requirements",
    (entry, index) => safeId(entry, `product assessment.missing_requirements[${index}]`),
  ).sort();
  if (new Set(missingRequirements).size !== missingRequirements.length) {
    throw new APIError(502, "ProductAssessment missing requirements must not contain duplicates");
  }
  const blockerRequirements = [...new Set(blockers.map((blocker) => blocker.requirement_id))].sort();
  if (missingRequirements.length !== blockerRequirements.length ||
      missingRequirements.some((valueId, index) => valueId !== blockerRequirements[index])) {
    throw new APIError(502, "ProductAssessment missing requirements must match blocker requirement IDs");
  }
  const parsed: ProductAssessment = {
    schema_version: "1.0",
    requirement_id: safeId(assessment.requirement_id, "product assessment.requirement_id"),
    package_id: safeId(assessment.package_id, "product assessment.package_id"),
    package_version: boundedText(assessment.package_version, "product assessment.package_version", 64),
    product_status: assertFinite(assessment.product_status, "product assessment.product_status", STATUSES),
    scores,
    missing_requirements: missingRequirements,
    blockers,
  };
  validateStatus(parsed);
  return parsed;
}
