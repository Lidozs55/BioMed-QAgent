import { describe, expect, it } from "vitest";

import {
  PRODUCTION_B3_CONFIGURED_HEAP_BYTES,
  PRODUCTION_B3_CONFIGURED_TEMP_BYTES,
  PRODUCTION_B3_DISK_QUOTA_BYTES_PER_INDEX,
  PRODUCTION_B3_PARITY_PROOF,
  PRODUCTION_B3_RESOURCE_POLICY,
  createProductionB3DiskFactory,
} from "../src/dataset/validation/b3-production-policy.js";
import {
  decideValidatorResources,
  estimateValidatorResources,
} from "../src/dataset/validation/resource-baseline.js";

describe("production B3 resource policy", () => {
  it("is a valid, benchmark-shaped policy with no failure on representative estimates", () => {
    const estimate = estimateValidatorResources({
      rowEstimate: 1_000_000,
      keyEstimates: [{
        keyId: "primary",
        entryEstimate: 1_000_000,
        tupleWidthEstimateBytes: 32,
        tupleFieldCount: 2,
      }],
      configuredHeapBytes: PRODUCTION_B3_CONFIGURED_HEAP_BYTES,
      configuredTempBytes: PRODUCTION_B3_CONFIGURED_TEMP_BYTES,
      diskIndexAvailable: true,
      cancelCapable: true,
    }, PRODUCTION_B3_RESOURCE_POLICY);

    expect(estimate.failureReason).toBeNull();
    expect(estimate.estimatedHeapBytes).toBeGreaterThan(0);
    expect(estimate.estimatedTempBytes).toBe(estimate.estimatedHeapBytes);
  });

  it("stays in memory at or below the threshold and selects disk above it", () => {
    const below = decideValidatorResources({
      rowEstimate: 1,
      keyEstimates: [{
        keyId: "primary",
        entryEstimate: 1,
        tupleWidthEstimateBytes: 8,
        tupleFieldCount: 1,
      }],
      configuredHeapBytes: PRODUCTION_B3_CONFIGURED_HEAP_BYTES,
      configuredTempBytes: PRODUCTION_B3_CONFIGURED_TEMP_BYTES,
      diskIndexAvailable: true,
      cancelCapable: true,
    }, PRODUCTION_B3_RESOURCE_POLICY);
    expect(below.validatorMode).toBe("memory");

    const above = decideValidatorResources({
      rowEstimate: 5_000_000,
      keyEstimates: [{
        keyId: "primary",
        entryEstimate: 5_000_000,
        tupleWidthEstimateBytes: 32,
        tupleFieldCount: 2,
      }],
      configuredHeapBytes: PRODUCTION_B3_CONFIGURED_HEAP_BYTES,
      configuredTempBytes: PRODUCTION_B3_CONFIGURED_TEMP_BYTES,
      diskIndexAvailable: true,
      cancelCapable: true,
    }, PRODUCTION_B3_RESOURCE_POLICY);
    expect(above.validatorMode).toBe("disk");
    expect(above.estimatedTempBytes).toBeGreaterThan(0);
  });

  it("fails closed to reject when the configured temp budget cannot hold the disk estimate", () => {
    const rejected = decideValidatorResources({
      rowEstimate: 60_000_000,
      keyEstimates: [{
        keyId: "primary",
        entryEstimate: 60_000_000,
        tupleWidthEstimateBytes: 48,
        tupleFieldCount: 2,
      }],
      configuredHeapBytes: PRODUCTION_B3_CONFIGURED_HEAP_BYTES,
      configuredTempBytes: PRODUCTION_B3_CONFIGURED_TEMP_BYTES,
      diskIndexAvailable: true,
      cancelCapable: true,
    }, PRODUCTION_B3_RESOURCE_POLICY);
    expect(rejected.validatorMode).toBe("reject");
    expect(rejected.failureReason).toBe("temp_quota_exceeded");
  });

  it("binds the parity proof to the committed evidence ref with a sha256 digest", () => {
    expect(PRODUCTION_B3_PARITY_PROOF.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(PRODUCTION_B3_PARITY_PROOF.ref).toBe(
      "server/tests/fixtures/b3-memory-disk-parity-v1.json",
    );
  });

  it("creates owner-bound disk indexes through the production factory", async () => {
    const factory = createProductionB3DiskFactory();
    expect(factory.factoryId).toMatch(/^[a-z0-9.-]+$/);
    const index = await factory.createIndex({
      owner: { taskId: "task_policy", buildId: "build_policy", generation: 2 },
      quotaBytes: 1024 * 1024,
    });
    try {
      expect(index.ownerBinding()).toEqual({ taskId: "task_policy", generation: 2 });
      expect(index.stats().mode).toBe("disk");
    } finally {
      await index.cleanup();
    }
    expect(PRODUCTION_B3_DISK_QUOTA_BYTES_PER_INDEX).toBeGreaterThan(0);
  });
});
