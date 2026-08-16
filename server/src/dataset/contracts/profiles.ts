/**
 * Server-side versioned profiles (Python ``ValidationProfile`` /
 * ``NormalizationProfile`` / ``AcceptancePolicy`` / ``UnitConversionRule``).
 * Acceptance thresholds live here, never in the Agent-supplied spec.
 */

import type { SchemaVersion } from "./primitives.js";
import {
  assertBoolean,
  assertExactKeys,
  assertNonEmptyString,
  assertNonNegativeInt,
  assertRecord,
  assertString,
  assertStringArray,
  parseSchemaVersion,
} from "./primitives.js";
import type { ConfidenceLevel, ValueScale } from "./enums.js";
import { assertConfidenceLevel, assertValueScale } from "./enums.js";

export interface AcceptancePolicy {
  schema_version?: SchemaVersion;
  minimum_valid_rows: number;
  allow_empty_primary_dataset: boolean;
  allow_partial_publish: boolean;
}

const ACCEPTANCE_POLICY_KEYS = [
  "schema_version",
  "minimum_valid_rows",
  "allow_empty_primary_dataset",
  "allow_partial_publish",
] as const;

export function parseAcceptancePolicy(value: unknown): AcceptancePolicy {
  const record = assertRecord(value, "AcceptancePolicy");
  assertExactKeys(record, ACCEPTANCE_POLICY_KEYS, "AcceptancePolicy");
  return {
    schema_version: parseSchemaVersion(record),
    minimum_valid_rows: record.minimum_valid_rows === undefined
      ? 1
      : assertNonNegativeInt(record.minimum_valid_rows, "AcceptancePolicy.minimum_valid_rows"),
    allow_empty_primary_dataset: record.allow_empty_primary_dataset === undefined
      ? false
      : assertBoolean(
          record.allow_empty_primary_dataset,
          "AcceptancePolicy.allow_empty_primary_dataset",
        ),
    allow_partial_publish: record.allow_partial_publish === undefined
      ? true
      : assertBoolean(record.allow_partial_publish, "AcceptancePolicy.allow_partial_publish"),
  };
}

export type RequiredEntityLevel = "gene" | "probe" | "any";

export interface ValidationProfile {
  schema_version?: SchemaVersion;
  profile_id: string;
  dataset_family: string;
  acceptance: AcceptancePolicy;
  description: string;
  required_entity_level: RequiredEntityLevel;
  confidence_gate: ConfidenceGatePolicy;
}

export interface ConfidenceGatePolicy {
  schema_version?: SchemaVersion;
  block_pending_human_review: boolean;
  required_fields_min_level: ConfidenceLevel;
  allow_low_confidence_primary: boolean;
  max_low_confidence_fraction: number | null;
  require_review_for_channels: string[];
}

const CONFIDENCE_GATE_POLICY_KEYS = [
  "schema_version",
  "block_pending_human_review",
  "required_fields_min_level",
  "allow_low_confidence_primary",
  "max_low_confidence_fraction",
  "require_review_for_channels",
] as const;

export function parseConfidenceGatePolicy(value: unknown): ConfidenceGatePolicy {
  const record = assertRecord(value, "ConfidenceGatePolicy");
  assertExactKeys(record, CONFIDENCE_GATE_POLICY_KEYS, "ConfidenceGatePolicy");
  const rawFraction = record.max_low_confidence_fraction;
  let maxLowFraction: number | null = null;
  if (rawFraction !== undefined && rawFraction !== null) {
    if (
      typeof rawFraction !== "number" ||
      !Number.isFinite(rawFraction) ||
      rawFraction < 0 ||
      rawFraction > 1
    ) {
      throw new TypeError(
        "ConfidenceGatePolicy.max_low_confidence_fraction must be between 0 and 1",
      );
    }
    maxLowFraction = rawFraction;
  }
  return {
    schema_version: parseSchemaVersion(record),
    block_pending_human_review: record.block_pending_human_review === undefined
      ? true
      : assertBoolean(
          record.block_pending_human_review,
          "ConfidenceGatePolicy.block_pending_human_review",
        ),
    required_fields_min_level: record.required_fields_min_level === undefined
      ? "medium"
      : assertConfidenceLevel(
          record.required_fields_min_level,
          "ConfidenceGatePolicy.required_fields_min_level",
        ),
    allow_low_confidence_primary: record.allow_low_confidence_primary === undefined
      ? false
      : assertBoolean(
          record.allow_low_confidence_primary,
          "ConfidenceGatePolicy.allow_low_confidence_primary",
        ),
    max_low_confidence_fraction: maxLowFraction,
    require_review_for_channels: record.require_review_for_channels === undefined
      ? ["vlm", "llm", "ocr", "web_extraction"]
      : assertStringArray(
          record.require_review_for_channels,
          "ConfidenceGatePolicy.require_review_for_channels",
        ),
  };
}

const VALIDATION_PROFILE_KEYS = [
  "schema_version",
  "profile_id",
  "dataset_family",
  "acceptance",
  "description",
  "required_entity_level",
  "confidence_gate",
] as const;

export function parseValidationProfile(value: unknown): ValidationProfile {
  const record = assertRecord(value, "ValidationProfile");
  assertExactKeys(record, VALIDATION_PROFILE_KEYS, "ValidationProfile");
  const requiredEntityLevel = assertString(
    record.required_entity_level,
    "ValidationProfile.required_entity_level",
  );
  if (requiredEntityLevel !== "gene" && requiredEntityLevel !== "probe" && requiredEntityLevel !== "any") {
    throw new TypeError(
      "ValidationProfile.required_entity_level must be one of gene, probe, any",
    );
  }
  return {
    schema_version: parseSchemaVersion(record),
    profile_id: assertNonEmptyString(record.profile_id, "ValidationProfile.profile_id"),
    dataset_family: assertNonEmptyString(
      record.dataset_family,
      "ValidationProfile.dataset_family",
    ),
    acceptance: record.acceptance === undefined
      ? parseAcceptancePolicy({})
      : parseAcceptancePolicy(record.acceptance),
    description: assertString(record.description, "ValidationProfile.description"),
    required_entity_level: requiredEntityLevel,
    confidence_gate: record.confidence_gate === undefined
      ? parseConfidenceGatePolicy({})
      : parseConfidenceGatePolicy(record.confidence_gate),
  };
}

export interface UnitConversionRule {
  schema_version?: SchemaVersion;
  rule_id: string;
  from_unit: string;
  to_unit: string;
  formula: string;
  evidence: string;
}

const UNIT_CONVERSION_RULE_KEYS = [
  "schema_version",
  "rule_id",
  "from_unit",
  "to_unit",
  "formula",
  "evidence",
] as const;

export function parseUnitConversionRule(value: unknown): UnitConversionRule {
  const record = assertRecord(value, "UnitConversionRule");
  assertExactKeys(record, UNIT_CONVERSION_RULE_KEYS, "UnitConversionRule");
  return {
    schema_version: parseSchemaVersion(record),
    rule_id: assertNonEmptyString(record.rule_id, "UnitConversionRule.rule_id"),
    from_unit: assertNonEmptyString(record.from_unit, "UnitConversionRule.from_unit"),
    to_unit: assertNonEmptyString(record.to_unit, "UnitConversionRule.to_unit"),
    formula: assertNonEmptyString(record.formula, "UnitConversionRule.formula"),
    evidence: assertNonEmptyString(record.evidence, "UnitConversionRule.evidence"),
  };
}

export interface NormalizationProfile {
  schema_version?: SchemaVersion;
  profile_id: string;
  dataset_family: string;
  allowed_namespaces: string[];
  allowed_units: string[];
  allowed_semantics: string[];
  allowed_value_scales: ValueScale[];
  unit_conversions: UnitConversionRule[];
  aggregation_policy: string;
  description: string;
}

const NORMALIZATION_PROFILE_KEYS = [
  "schema_version",
  "profile_id",
  "dataset_family",
  "allowed_namespaces",
  "allowed_units",
  "allowed_semantics",
  "allowed_value_scales",
  "unit_conversions",
  "aggregation_policy",
  "description",
] as const;

function nonEmptyStringArray(value: unknown, name: string): string[] {
  const items = assertStringArray(value, name);
  if (items.length === 0) throw new TypeError(`${name} must be a non-empty array`);
  return items;
}

export function parseNormalizationProfile(value: unknown): NormalizationProfile {
  const record = assertRecord(value, "NormalizationProfile");
  assertExactKeys(record, NORMALIZATION_PROFILE_KEYS, "NormalizationProfile");
  const valueScales = (() => {
    if (!Array.isArray(record.allowed_value_scales)) {
      throw new TypeError("NormalizationProfile.allowed_value_scales must be an array");
    }
    const scales = record.allowed_value_scales.map((scale, index) =>
      assertValueScale(scale, `NormalizationProfile.allowed_value_scales[${index}]`),
    );
    if (scales.length === 0) {
      throw new TypeError(
        "NormalizationProfile.allowed_value_scales must be a non-empty array",
      );
    }
    return scales;
  })();
  return {
    schema_version: parseSchemaVersion(record),
    profile_id: assertNonEmptyString(record.profile_id, "NormalizationProfile.profile_id"),
    dataset_family: assertNonEmptyString(
      record.dataset_family,
      "NormalizationProfile.dataset_family",
    ),
    allowed_namespaces: nonEmptyStringArray(
      record.allowed_namespaces,
      "NormalizationProfile.allowed_namespaces",
    ),
    allowed_units: nonEmptyStringArray(
      record.allowed_units,
      "NormalizationProfile.allowed_units",
    ),
    allowed_semantics: nonEmptyStringArray(
      record.allowed_semantics,
      "NormalizationProfile.allowed_semantics",
    ),
    allowed_value_scales: valueScales,
    unit_conversions: record.unit_conversions === undefined
      ? []
      : (() => {
          if (!Array.isArray(record.unit_conversions)) {
            throw new TypeError("NormalizationProfile.unit_conversions must be an array");
          }
          return record.unit_conversions.map((rule) => parseUnitConversionRule(rule));
        })(),
    aggregation_policy: record.aggregation_policy === undefined
      ? "keep_all"
      : assertNonEmptyString(
          record.aggregation_policy,
          "NormalizationProfile.aggregation_policy",
        ),
    description: assertString(record.description, "NormalizationProfile.description"),
  };
}
