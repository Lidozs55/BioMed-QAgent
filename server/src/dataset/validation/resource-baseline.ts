/**
 * Deterministic B3 resource estimates and validator-mode policy decisions.
 *
 * This module contains no production threshold. Callers must inject a policy,
 * and any policy adjustment requires a representative benchmark produced from
 * the same commit. The synthetic harness in
 * `server/tests/ct4-resource-baseline-bench.run.ts` demonstrates the estimator
 * without allocating a large input; it does not establish a production limit.
 */

export const RESOURCE_BASELINE_TELEMETRY_SCHEMA_VERSION = "b3-resource-telemetry.v1" as const;

export type ValidatorMode = "memory" | "disk" | "reject";

export type ResourceBaselineFailureReason =
  | "invalid_policy"
  | "unknown_estimate"
  | "invalid_estimate"
  | "estimate_overflow"
  | "disk_unavailable"
  | "cancel_unavailable"
  | "temp_quota_exceeded"
  | "measurement_failed";

export interface ResourceKeyEstimate {
  /** Stable identity for one PK/FK/relation tuple index. */
  keyId: string;
  /** Estimated number of entries inserted into this index. */
  entryEstimate: number | null;
  /** Estimated encoded tuple payload width, excluding policy overhead. */
  tupleWidthEstimateBytes: number | null;
  /** Number of fields represented by the tuple. */
  tupleFieldCount: number | null;
}

export interface ResourceBaselineInput {
  rowEstimate: number | null;
  keyEstimates: readonly ResourceKeyEstimate[];
  configuredHeapBytes: number | null;
  configuredTempBytes: number | null;
  diskIndexAvailable: boolean;
  cancelCapable: boolean;
}

export interface ResourceBaselinePolicy {
  policyId: string;
  /** Maximum estimated bytes eligible for the in-memory validator. */
  memoryThresholdBytes: number;
  /** Policy ceiling applied in addition to the caller's configured heap. */
  heapQuotaBytes: number;
  /** Policy ceiling applied in addition to the caller's configured temp quota. */
  tempQuotaBytes: number;
  /** Conservative per-row bookkeeping estimate. */
  rowOverheadBytes: number;
  /** Conservative per-index-entry bookkeeping estimate. */
  keyEntryOverheadBytes: number;
  /** Conservative bookkeeping estimate for each field in an encoded tuple. */
  tupleFieldOverheadBytes: number;
  /** Benchmark-backed hard cap for one decoded delimited row. */
  maxRowCharacters: number;
  /** Benchmark-backed hard cap for one decoded field. */
  maxFieldCharacters: number;
}

export interface ResourceThresholdBasis {
  policyId: string;
  memoryThresholdBytes: number;
  policyHeapQuotaBytes: number;
  configuredHeapBytes: number;
  effectiveMemoryThresholdBytes: number;
  policyTempQuotaBytes: number;
  configuredTempBytes: number;
  effectiveTempQuotaBytes: number;
}

/**
 * Runtime-observed values. Null means that execution has not supplied a
 * measurement; estimates are reported separately on the decision.
 */
export interface ResourceBaselineTelemetry {
  schemaVersion: typeof RESOURCE_BASELINE_TELEMETRY_SCHEMA_VERSION;
  durationMs: number | null;
  heapBytes: number | null;
  tempBytes: number | null;
  failureReason: ResourceBaselineFailureReason | null;
}

export interface ResourceBaselineEstimate {
  /** Estimated memory-mode footprint, or null when estimation failed closed. */
  estimatedHeapBytes: number | null;
  /** Conservative estimated disk-mode temp footprint, or null on failure. */
  estimatedTempBytes: number | null;
  failureReason: Extract<
    ResourceBaselineFailureReason,
    "invalid_policy" | "unknown_estimate" | "invalid_estimate" | "estimate_overflow"
  > | null;
}

export interface ResourceBaselineDecision {
  validatorMode: ValidatorMode;
  thresholdBasis: ResourceThresholdBasis | null;
  estimatedHeapBytes: number | null;
  estimatedTempBytes: number | null;
  failureReason: ResourceBaselineFailureReason | null;
  telemetry: ResourceBaselineTelemetry;
}

export const MULTITABLE_RESOURCE_PREFLIGHT_TELEMETRY_SCHEMA_VERSION =
  "b3-multitable-resource-preflight.v2" as const;

export const MULTITABLE_RESOURCE_MEASUREMENT_SOURCE =
  "core_receipted_table_scan.v1" as const;
export const MULTITABLE_RESOURCE_CONFIGURATION_SOURCE =
  "configuration_precheck.v1" as const;
export type MultiTableResourceMeasurementSource =
  | typeof MULTITABLE_RESOURCE_MEASUREMENT_SOURCE
  | typeof MULTITABLE_RESOURCE_CONFIGURATION_SOURCE;

/** Core-receipted file identity used by the bounded measurement pass. */
export interface MultiTableMeasuredInput {
  tableId: string;
  resultManifestId: string;
  relativePath: string;
  sizeBytes: number;
  sha256: string;
}

export interface MultiTableMeasuredResources {
  measuredInputs: readonly MultiTableMeasuredInput[];
  rowEstimate: number;
  keyEstimates: readonly ResourceKeyEstimate[];
}

/**
 * One auditable record emitted after a bounded measurement pass and before the
 * validator allocates PK/FK Maps. Decision fields are deterministic for the
 * receipted bytes and policy. Observed fields are runtime samples:
 * durationMs covers measurement plus decision, heapBytes is process.heapUsed
 * at emission (not an attributed peak), and tempBytes remains null until an
 * instrumented disk index exists.
 */
export interface MultiTableResourcePreflightTelemetry {
  schemaVersion: typeof MULTITABLE_RESOURCE_PREFLIGHT_TELEMETRY_SCHEMA_VERSION;
  measurementSource: MultiTableResourceMeasurementSource;
  measuredInputs: readonly MultiTableMeasuredInput[];
  /** False means row/key values are a sufficient lower bound after early rejection. */
  measurementComplete: boolean;
  validatorMode: ValidatorMode;
  thresholdBasis: ResourceThresholdBasis | null;
  rowEstimate: number | null;
  keyEstimates: readonly ResourceKeyEstimate[];
  configuredHeapBytes: number | null;
  configuredTempBytes: number | null;
  estimatedHeapBytes: number | null;
  estimatedTempBytes: number | null;
  durationMs: number;
  heapBytes: number;
  /** Null means unmeasured; it must not be interpreted as zero bytes. */
  tempBytes: null;
  failureReason: ResourceBaselineFailureReason | null;
}

export type MultiTableResourceTelemetrySink = (
  telemetry: MultiTableResourcePreflightTelemetry,
) => void | Promise<void>;

export interface MultiTableResourceValidationOptions {
  /**
   * Required caller-injected policy. No global or production default exists;
   * the caller owns the representative benchmark evidence behind its values.
   */
  policy: ResourceBaselinePolicy;
  /** Runtime heap ceiling supplied by the Core composition boundary. */
  configuredHeapBytes: number | null;
  /** Runtime temp ceiling supplied by the Core composition boundary. */
  configuredTempBytes: number | null;
  /** Required audit boundary. A sink error fails closed before Map allocation. */
  telemetrySink: MultiTableResourceTelemetrySink;
}

/**
 * Explicit C-T4 opt-in for validateMultiTableCandidate. Omitting this object
 * preserves the legacy small-input path and return shape, but that path is not
 * Family Host large-input admission.
 */
export interface MultiTableValidationOptions {
  resourceBaseline: MultiTableResourceValidationOptions;
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function blankTelemetry(
  failureReason: ResourceBaselineFailureReason | null,
): ResourceBaselineTelemetry {
  return {
    schemaVersion: RESOURCE_BASELINE_TELEMETRY_SCHEMA_VERSION,
    durationMs: null,
    heapBytes: null,
    tempBytes: null,
    failureReason,
  };
}

function rejection(
  failureReason: ResourceBaselineFailureReason,
  thresholdBasis: ResourceThresholdBasis | null = null,
  estimatedHeapBytes: number | null = null,
  estimatedTempBytes: number | null = null,
): ResourceBaselineDecision {
  return {
    validatorMode: "reject",
    thresholdBasis,
    estimatedHeapBytes,
    estimatedTempBytes,
    failureReason,
    telemetry: blankTelemetry(failureReason),
  };
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validPolicy(policy: ResourceBaselinePolicy): boolean {
  return policy.policyId.trim().length > 0 &&
    isNonNegativeSafeInteger(policy.memoryThresholdBytes) &&
    isNonNegativeSafeInteger(policy.heapQuotaBytes) &&
    isNonNegativeSafeInteger(policy.tempQuotaBytes) &&
    isNonNegativeSafeInteger(policy.rowOverheadBytes) &&
    isNonNegativeSafeInteger(policy.keyEntryOverheadBytes) &&
    isNonNegativeSafeInteger(policy.tupleFieldOverheadBytes) &&
    Number.isSafeInteger(policy.maxRowCharacters) &&
    policy.maxRowCharacters > 0 &&
    Number.isSafeInteger(policy.maxFieldCharacters) &&
    policy.maxFieldCharacters > 0 &&
    policy.maxFieldCharacters <= policy.maxRowCharacters;
}

function unknownInput(input: ResourceBaselineInput): boolean {
  return input.rowEstimate === null ||
    input.configuredHeapBytes === null ||
    input.configuredTempBytes === null ||
    input.keyEstimates.some((estimate) =>
      estimate.entryEstimate === null ||
      estimate.tupleWidthEstimateBytes === null ||
      estimate.tupleFieldCount === null,
    );
}

function validInput(input: ResourceBaselineInput): boolean {
  if (
    input.rowEstimate === null ||
    input.configuredHeapBytes === null ||
    input.configuredTempBytes === null ||
    !isNonNegativeSafeInteger(input.rowEstimate) ||
    !isNonNegativeSafeInteger(input.configuredHeapBytes) ||
    !isNonNegativeSafeInteger(input.configuredTempBytes)
  ) {
    return false;
  }
  const keyIds = new Set<string>();
  for (const estimate of input.keyEstimates) {
    if (
      estimate.keyId.trim().length === 0 ||
      keyIds.has(estimate.keyId) ||
      estimate.entryEstimate === null ||
      estimate.tupleWidthEstimateBytes === null ||
      estimate.tupleFieldCount === null ||
      !isNonNegativeSafeInteger(estimate.entryEstimate) ||
      !isNonNegativeSafeInteger(estimate.tupleWidthEstimateBytes) ||
      !Number.isSafeInteger(estimate.tupleFieldCount) ||
      estimate.tupleFieldCount < 1
    ) {
      return false;
    }
    keyIds.add(estimate.keyId);
  }
  return true;
}

function safeNumber(value: bigint): number | null {
  return value <= MAX_SAFE_BIGINT ? Number(value) : null;
}

function estimateBytes(
  input: ResourceBaselineInput,
  policy: ResourceBaselinePolicy,
): { heapBytes: number; tempBytes: number } | null {
  const rowEstimate = BigInt(input.rowEstimate as number);
  let keyBytes = 0n;
  for (const estimate of input.keyEstimates) {
    const tupleEntryBytes =
      BigInt(estimate.tupleWidthEstimateBytes as number) +
      BigInt(policy.keyEntryOverheadBytes) +
      BigInt(estimate.tupleFieldCount as number) * BigInt(policy.tupleFieldOverheadBytes);
    keyBytes += BigInt(estimate.entryEstimate as number) * tupleEntryBytes;
  }
  const rowBytes = rowEstimate * BigInt(policy.rowOverheadBytes);
  const heapBytes = safeNumber(rowBytes + keyBytes);
  // Disk mode conservatively accounts for row bookkeeping plus tuple indexes in
  // temp storage. A future DiskBackedIndex may tighten this only with benchmark
  // evidence from the same commit as the policy change.
  const tempBytes = safeNumber(rowBytes + keyBytes);
  return heapBytes === null || tempBytes === null ? null : { heapBytes, tempBytes };
}

/** Estimate bytes without allocating rows or index entries. */
export function estimateValidatorResources(
  input: ResourceBaselineInput,
  policy: ResourceBaselinePolicy,
): ResourceBaselineEstimate {
  if (!validPolicy(policy)) {
    return { estimatedHeapBytes: null, estimatedTempBytes: null, failureReason: "invalid_policy" };
  }
  if (unknownInput(input)) {
    return { estimatedHeapBytes: null, estimatedTempBytes: null, failureReason: "unknown_estimate" };
  }
  if (!validInput(input)) {
    return { estimatedHeapBytes: null, estimatedTempBytes: null, failureReason: "invalid_estimate" };
  }
  const estimated = estimateBytes(input, policy);
  if (estimated === null) {
    return { estimatedHeapBytes: null, estimatedTempBytes: null, failureReason: "estimate_overflow" };
  }
  return {
    estimatedHeapBytes: estimated.heapBytes,
    estimatedTempBytes: estimated.tempBytes,
    failureReason: null,
  };
}

/**
 * Select memory only when the deterministic estimate is at or below every
 * injected heap threshold. Above that boundary the result is disk or reject;
 * memory is never the fallback.
 */
export function decideValidatorResources(
  input: ResourceBaselineInput,
  policy: ResourceBaselinePolicy,
): ResourceBaselineDecision {
  const estimate = estimateValidatorResources(input, policy);
  if (estimate.failureReason !== null) return rejection(estimate.failureReason);

  const configuredHeapBytes = input.configuredHeapBytes as number;
  const configuredTempBytes = input.configuredTempBytes as number;
  const thresholdBasis: ResourceThresholdBasis = {
    policyId: policy.policyId,
    memoryThresholdBytes: policy.memoryThresholdBytes,
    policyHeapQuotaBytes: policy.heapQuotaBytes,
    configuredHeapBytes,
    effectiveMemoryThresholdBytes: Math.min(
      policy.memoryThresholdBytes,
      policy.heapQuotaBytes,
      configuredHeapBytes,
    ),
    policyTempQuotaBytes: policy.tempQuotaBytes,
    configuredTempBytes,
    effectiveTempQuotaBytes: Math.min(policy.tempQuotaBytes, configuredTempBytes),
  };
  const estimatedHeapBytes = estimate.estimatedHeapBytes as number;
  const estimatedTempBytes = estimate.estimatedTempBytes as number;
  if (estimatedHeapBytes <= thresholdBasis.effectiveMemoryThresholdBytes) {
    return {
      validatorMode: "memory",
      thresholdBasis,
      estimatedHeapBytes,
      estimatedTempBytes,
      failureReason: null,
      telemetry: blankTelemetry(null),
    };
  }
  if (!input.diskIndexAvailable) {
    return rejection("disk_unavailable", thresholdBasis, estimatedHeapBytes, estimatedTempBytes);
  }
  if (!input.cancelCapable) {
    return rejection("cancel_unavailable", thresholdBasis, estimatedHeapBytes, estimatedTempBytes);
  }
  if (estimatedTempBytes > thresholdBasis.effectiveTempQuotaBytes) {
    return rejection("temp_quota_exceeded", thresholdBasis, estimatedHeapBytes, estimatedTempBytes);
  }
  return {
    validatorMode: "disk",
    thresholdBasis,
    estimatedHeapBytes,
    estimatedTempBytes,
    failureReason: null,
    telemetry: blankTelemetry(null),
  };
}
