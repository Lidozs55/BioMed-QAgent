/**
 * Pure expression compatibility-partition primitives for the Family Host
 * shadow slice. This module is intentionally not wired into the legacy
 * compatibility gate or integration runtime.
 *
 * A semantic partition identifies inputs that may share an integration path.
 * A merge domain additionally binds ``dataset_revision_id`` so equal bare
 * sample/feature identifiers from different source snapshots cannot collide.
 */

import { canonicalDigest } from "../adapters/identity.js";

const SEMANTIC_DIMENSIONS = [
  "schema_ref",
  "row_granularity",
  "taxon_id",
  "organism",
  "feature_namespace",
  "measurement_type",
  "value_semantics",
  "value_scale",
  "expression_unit",
  "normalization_state",
  "reference_namespace",
  "reference_version",
] as const;

const MERGE_DOMAIN_DIMENSIONS = [
  ...SEMANTIC_DIMENSIONS,
  "dataset_revision_id",
] as const;

export type ExpressionCompatibilitySemanticDimension =
  (typeof SEMANTIC_DIMENSIONS)[number];
export type ExpressionCompatibilityDimension =
  (typeof MERGE_DOMAIN_DIMENSIONS)[number];

/**
 * Canonical values supplied by an admitted expression projection.
 *
 * ``null`` means unavailable. Literal source vocabulary such as ``"unknown"``
 * remains a distinct, honest value and is never inferred or promoted here.
 */
export interface ExpressionCompatibilityPartitionInput {
  schema_ref: string;
  row_granularity: string;
  taxon_id: string | null;
  organism: string | null;
  feature_namespace: string | null;
  measurement_type: string;
  value_semantics: string;
  value_scale: string;
  expression_unit: string;
  normalization_state: string;
  reference_namespace: string | null;
  reference_version: string | null;
  dataset_revision_id: string;
}

/** Strict, immutable descriptor accepted by the partition/key/compare API. */
export type ExpressionCompatibilityPartitionDescriptor = Readonly<
  ExpressionCompatibilityPartitionInput
>;

export interface ExpressionCompatibilityPartitionComparison {
  semantic_compatible: boolean;
  same_merge_domain: boolean;
  differing_dimensions: ExpressionCompatibilityDimension[];
}

const NULLABLE_DIMENSIONS = new Set<ExpressionCompatibilityDimension>([
  "taxon_id",
  "organism",
  "feature_namespace",
  "reference_namespace",
  "reference_version",
]);
const DATASET_REVISION_ID_PATTERN = /^dsrev_[0-9a-f]{64}$/;

function assertCanonicalValue(
  input: Readonly<Record<string, unknown>>,
  dimension: ExpressionCompatibilityDimension,
): string | null {
  const value = input[dimension];
  if (value === null && NULLABLE_DIMENSIONS.has(dimension)) return null;
  if (typeof value !== "string") {
    throw new TypeError(`${dimension} must be a canonical string${
      NULLABLE_DIMENSIONS.has(dimension) ? " or null" : ""
    }`);
  }
  if (value.length === 0 || value.trim() !== value || value.normalize("NFC") !== value) {
    throw new TypeError(`${dimension} must be non-blank, NFC-normalized, and already canonical`);
  }
  if ([...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  })) {
    throw new TypeError(`${dimension} must not contain control characters`);
  }
  if (dimension === "dataset_revision_id" && !DATASET_REVISION_ID_PATTERN.test(value)) {
    throw new TypeError("dataset_revision_id must match dsrev_<lowercase sha256>");
  }
  return value;
}

/**
 * Validate an exact descriptor shape without normalizing aliases, case,
 * whitespace, null, or an ``unknown`` vocabulary value.
 */
export function createExpressionCompatibilityPartitionDescriptor(
  input: Readonly<Record<string, unknown>>,
): ExpressionCompatibilityPartitionDescriptor {
  const allowed = new Set<string>(MERGE_DOMAIN_DIMENSIONS);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new TypeError(`unexpected compatibility partition field: ${key}`);
    }
  }

  const descriptor: ExpressionCompatibilityPartitionInput = {
    schema_ref: assertCanonicalValue(input, "schema_ref")!,
    row_granularity: assertCanonicalValue(input, "row_granularity")!,
    taxon_id: assertCanonicalValue(input, "taxon_id"),
    organism: assertCanonicalValue(input, "organism"),
    feature_namespace: assertCanonicalValue(input, "feature_namespace"),
    measurement_type: assertCanonicalValue(input, "measurement_type")!,
    value_semantics: assertCanonicalValue(input, "value_semantics")!,
    value_scale: assertCanonicalValue(input, "value_scale")!,
    expression_unit: assertCanonicalValue(input, "expression_unit")!,
    normalization_state: assertCanonicalValue(input, "normalization_state")!,
    reference_namespace: assertCanonicalValue(input, "reference_namespace"),
    reference_version: assertCanonicalValue(input, "reference_version"),
    dataset_revision_id: assertCanonicalValue(input, "dataset_revision_id")!,
  };
  return Object.freeze(descriptor);
}

function validatedDescriptor(
  descriptor: ExpressionCompatibilityPartitionDescriptor,
): ExpressionCompatibilityPartitionDescriptor {
  return createExpressionCompatibilityPartitionDescriptor(descriptor);
}

function dimensionValues(
  descriptor: ExpressionCompatibilityPartitionDescriptor,
  dimensions: readonly ExpressionCompatibilityDimension[],
): Array<string | null> {
  return dimensions.map((dimension) => descriptor[dimension]);
}

/** Stable semantic key. Revision intentionally does not affect this key. */
export function expressionCompatibilityPartitionKey(
  descriptor: ExpressionCompatibilityPartitionDescriptor,
): string {
  const validated = validatedDescriptor(descriptor);
  return `exprpart_${canonicalDigest(dimensionValues(validated, SEMANTIC_DIMENSIONS))}`;
}

/**
 * Stable collision-isolation key for dedup/conflict state. It extends the
 * semantic partition with ``dataset_revision_id``.
 */
export function expressionCompatibilityMergeDomainKey(
  descriptor: ExpressionCompatibilityPartitionDescriptor,
): string {
  const validated = validatedDescriptor(descriptor);
  return `exprmerge_${canonicalDigest(dimensionValues(validated, MERGE_DOMAIN_DIMENSIONS))}`;
}

/** Exact ordered comparison over all declared dimensions. */
export function compareExpressionCompatibilityPartitions(
  left: ExpressionCompatibilityPartitionDescriptor,
  right: ExpressionCompatibilityPartitionDescriptor,
): ExpressionCompatibilityPartitionComparison {
  const validatedLeft = validatedDescriptor(left);
  const validatedRight = validatedDescriptor(right);
  const differingDimensions = MERGE_DOMAIN_DIMENSIONS.filter(
    (dimension) => validatedLeft[dimension] !== validatedRight[dimension],
  );
  const semanticCompatible = differingDimensions.every(
    (dimension) => dimension === "dataset_revision_id",
  );
  return {
    semantic_compatible: semanticCompatible,
    same_merge_domain: differingDimensions.length === 0,
    differing_dimensions: [...differingDimensions],
  };
}
