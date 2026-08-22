import { describe, expect, it } from "vitest";

import {
  decideValidatorResources,
  RESOURCE_BASELINE_TELEMETRY_SCHEMA_VERSION,
  type ResourceBaselineInput,
  type ResourceBaselinePolicy,
} from "../src/dataset/validation/resource-baseline.js";

const policy: ResourceBaselinePolicy = {
  policyId: "ct4-test-policy",
  memoryThresholdBytes: 1_000,
  heapQuotaBytes: 2_000,
  tempQuotaBytes: 10_000,
  rowOverheadBytes: 10,
  keyEntryOverheadBytes: 5,
  tupleFieldOverheadBytes: 2,
};

function input(overrides: Partial<ResourceBaselineInput> = {}): ResourceBaselineInput {
  return {
    rowEstimate: 10,
    keyEstimates: [
      { keyId: "primary", entryEstimate: 10, tupleWidthEstimateBytes: 4, tupleFieldCount: 1 },
    ],
    configuredHeapBytes: 2_000,
    configuredTempBytes: 10_000,
    diskIndexAvailable: true,
    cancelCapable: true,
    ...overrides,
  };
}

describe("C-T4 deterministic resource baseline", () => {
  it("keeps the exact memory boundary in memory and sends the first byte above it to disk", () => {
    const exact = decideValidatorResources(input({
      rowEstimate: 0,
      keyEstimates: [
        { keyId: "primary", entryEstimate: 1, tupleWidthEstimateBytes: 993, tupleFieldCount: 1 },
      ],
    }), policy);
    const above = decideValidatorResources(input({
      rowEstimate: 0,
      keyEstimates: [
        { keyId: "primary", entryEstimate: 1, tupleWidthEstimateBytes: 994, tupleFieldCount: 1 },
      ],
    }), policy);

    expect(exact.validatorMode).toBe("memory");
    expect(exact.estimatedHeapBytes).toBe(1_000);
    expect(above.validatorMode).toBe("disk");
    expect(above.estimatedHeapBytes).toBe(1_001);
    expect(above.thresholdBasis).toEqual(expect.objectContaining({
      policyId: "ct4-test-policy",
      memoryThresholdBytes: 1_000,
      effectiveMemoryThresholdBytes: 1_000,
    }));
  });

  it("also applies configured heap and temp quota boundaries", () => {
    const heapLimitedAtExactTemp = decideValidatorResources(input({
      rowEstimate: 0,
      keyEstimates: [
        { keyId: "primary", entryEstimate: 1, tupleWidthEstimateBytes: 993, tupleFieldCount: 1 },
      ],
      configuredHeapBytes: 999,
      configuredTempBytes: 1_000,
    }), policy);
    const aboveTemp = decideValidatorResources(input({
      rowEstimate: 0,
      keyEstimates: [
        { keyId: "primary", entryEstimate: 1, tupleWidthEstimateBytes: 993, tupleFieldCount: 1 },
      ],
      configuredHeapBytes: 999,
      configuredTempBytes: 999,
    }), policy);

    expect(heapLimitedAtExactTemp).toEqual(expect.objectContaining({
      validatorMode: "disk",
      estimatedHeapBytes: 1_000,
    }));
    expect(heapLimitedAtExactTemp.thresholdBasis?.effectiveMemoryThresholdBytes).toBe(999);
    expect(aboveTemp).toEqual(expect.objectContaining({
      validatorMode: "reject",
      failureReason: "temp_quota_exceeded",
    }));
  });

  it("never defaults over-threshold work to memory when disk mode is unavailable", () => {
    const decision = decideValidatorResources(input({
      rowEstimate: 100,
      diskIndexAvailable: false,
    }), policy);

    expect(decision.validatorMode).toBe("reject");
    expect(decision.failureReason).toBe("disk_unavailable");
  });

  it("rejects disk mode when cancellation or temp quota cannot support it", () => {
    const noCancel = decideValidatorResources(input({ rowEstimate: 100, cancelCapable: false }), policy);
    const noTemp = decideValidatorResources(input({ rowEstimate: 100, configuredTempBytes: 500 }), policy);

    expect(noCancel).toEqual(expect.objectContaining({
      validatorMode: "reject",
      failureReason: "cancel_unavailable",
    }));
    expect(noTemp).toEqual(expect.objectContaining({
      validatorMode: "reject",
      failureReason: "temp_quota_exceeded",
    }));
  });

  it.each([
    ["unknown row estimate", { rowEstimate: null }, "unknown_estimate"],
    ["unknown tuple width", {
      keyEstimates: [{ keyId: "primary", entryEstimate: 1, tupleWidthEstimateBytes: null, tupleFieldCount: 1 }],
    }, "unknown_estimate"],
    ["negative estimate", { rowEstimate: -1 }, "invalid_estimate"],
    ["unsafe estimate", { rowEstimate: Number.MAX_SAFE_INTEGER + 1 }, "invalid_estimate"],
  ] as const)("fails closed for %s", (_label, overrides, reason) => {
    const decision = decideValidatorResources(input(overrides), policy);

    expect(decision.validatorMode).toBe("reject");
    expect(decision.failureReason).toBe(reason);
    expect(decision.estimatedHeapBytes).toBeNull();
    expect(decision.estimatedTempBytes).toBeNull();
  });

  it("fails closed when otherwise safe integer inputs overflow byte arithmetic", () => {
    const decision = decideValidatorResources(input({
      rowEstimate: Number.MAX_SAFE_INTEGER,
      keyEstimates: [],
    }), policy);

    expect(decision).toEqual(expect.objectContaining({
      validatorMode: "reject",
      estimatedHeapBytes: null,
      estimatedTempBytes: null,
      failureReason: "estimate_overflow",
    }));
  });

  it("produces the same estimate for differently ordered key estimates", () => {
    const alpha = { keyId: "alpha", entryEstimate: 25, tupleWidthEstimateBytes: 8, tupleFieldCount: 2 };
    const beta = { keyId: "beta", entryEstimate: 15, tupleWidthEstimateBytes: 16, tupleFieldCount: 1 };

    const forward = decideValidatorResources(input({ keyEstimates: [alpha, beta] }), policy);
    const reverse = decideValidatorResources(input({ keyEstimates: [beta, alpha] }), policy);

    expect(forward).toEqual(reverse);
  });

  it("fails closed for duplicate key estimate identities", () => {
    const decision = decideValidatorResources(input({
      keyEstimates: [
        { keyId: "duplicate", entryEstimate: 1, tupleWidthEstimateBytes: 1, tupleFieldCount: 1 },
        { keyId: "duplicate", entryEstimate: 2, tupleWidthEstimateBytes: 2, tupleFieldCount: 1 },
      ],
    }), policy);

    expect(decision).toEqual(expect.objectContaining({
      validatorMode: "reject",
      failureReason: "invalid_estimate",
    }));
  });

  it("reports a stable telemetry schema without claiming runtime measurements", () => {
    const decision = decideValidatorResources(input(), policy);

    expect(decision.telemetry).toEqual({
      schemaVersion: RESOURCE_BASELINE_TELEMETRY_SCHEMA_VERSION,
      durationMs: null,
      heapBytes: null,
      tempBytes: null,
      failureReason: null,
    });
  });

  it("fails closed when the injected policy is invalid instead of treating it as production fact", () => {
    const decision = decideValidatorResources(input(), {
      ...policy,
      memoryThresholdBytes: -1,
    });

    expect(decision).toEqual(expect.objectContaining({
      validatorMode: "reject",
      failureReason: "invalid_policy",
    }));
  });
});
