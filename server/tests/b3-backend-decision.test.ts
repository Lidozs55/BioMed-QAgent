import { describe, expect, it } from "vitest";

import {
  decideB3Backend,
  type B3BackendDecisionInput,
  type B3BackendRejectReason,
  type B3RejectDecision,
} from "../src/dataset/validation/b3-backend-decision/index.js";
import * as gateModule from "../src/dataset/validation/b3-backend-decision/index.js";
import {
  RESOURCE_BASELINE_TELEMETRY_SCHEMA_VERSION,
  type ResourceBaselineDecision,
} from "../src/dataset/validation/resource-baseline.js";
import * as validationIndex from "../src/dataset/validation/index.js";

const POLICY_ID = "b3-staging-test-policy";
const MEMORY_THRESHOLD = 1_000;
const TEMP_QUOTA = 10_000;

function measuredDecision(
  overrides: Partial<ResourceBaselineDecision> = {},
): ResourceBaselineDecision {
  return {
    validatorMode: "disk",
    thresholdBasis: {
      policyId: POLICY_ID,
      memoryThresholdBytes: MEMORY_THRESHOLD,
      policyHeapQuotaBytes: 2_000,
      configuredHeapBytes: 2_000,
      effectiveMemoryThresholdBytes: MEMORY_THRESHOLD,
      policyTempQuotaBytes: TEMP_QUOTA,
      configuredTempBytes: TEMP_QUOTA,
      effectiveTempQuotaBytes: TEMP_QUOTA,
    },
    estimatedHeapBytes: MEMORY_THRESHOLD + 1,
    estimatedTempBytes: 2_000,
    failureReason: null,
    telemetry: {
      schemaVersion: RESOURCE_BASELINE_TELEMETRY_SCHEMA_VERSION,
      durationMs: null,
      heapBytes: null,
      tempBytes: null,
      failureReason: null,
    },
    ...overrides,
  };
}

function input(overrides: Partial<B3BackendDecisionInput> = {}): B3BackendDecisionInput {
  return {
    taskId: "task-b3-staging",
    buildId: "build-b3-staging",
    generation: 3,
    measured: measuredDecision(),
    factory: {
      factoryId: "isolated-tuple-index.v1",
      createIndex: () => ({ indexId: "index", close: async () => {} }),
    },
    snapshotImmutable: true,
    parityProof: { digest: "ab".repeat(32), ref: "b3-parity/evidence/1" },
    signal: new AbortController().signal,
    cleanup: { ownerId: "owner-b3-staging", cleanup: async () => {} },
    owner: { taskId: "task-b3-staging", buildId: "build-b3-staging", generation: 3 },
    ...overrides,
  };
}

function abortedSignal(): AbortSignal {
  const controller = new AbortController();
  controller.abort();
  return controller.signal;
}

describe("C-T4/T11 B3 backend decision gate", () => {
  it("keeps the exact threshold boundary in memory", () => {
    const exact = decideB3Backend(input({
      measured: measuredDecision({
        validatorMode: "memory",
        estimatedHeapBytes: MEMORY_THRESHOLD,
      }),
    }));
    expect(exact).toEqual({
      outcome: "memory",
      taskId: "task-b3-staging",
      buildId: "build-b3-staging",
      generation: 3,
      estimatedHeapBytes: MEMORY_THRESHOLD,
      effectiveMemoryThresholdBytes: MEMORY_THRESHOLD,
    });
  });

  it("rejects when the measured memory decision sits above the threshold", () => {
    const above = decideB3Backend(input({
      measured: measuredDecision({
        validatorMode: "memory",
        estimatedHeapBytes: MEMORY_THRESHOLD + 1,
      }),
    }));
    expect(above).toEqual({
      outcome: "reject",
      reason: "threshold_exceeded",
      detail: expect.stringContaining(`${MEMORY_THRESHOLD + 1}`),
    } satisfies B3RejectDecision);
  });

  it("accepts disk when factory, snapshot, parity proof and all capabilities exist", () => {
    const decision = decideB3Backend(input());
    expect(decision).toEqual({
      outcome: "disk",
      taskId: "task-b3-staging",
      buildId: "build-b3-staging",
      generation: 3,
      factoryId: "isolated-tuple-index.v1",
      parityProofRef: "b3-parity/evidence/1",
      estimatedTempBytes: 2_000,
      effectiveTempQuotaBytes: TEMP_QUOTA,
    });
  });

  it("rejects disk on any missing, malformed or failed capability", () => {
    const cases: Array<{
      name: string;
      overrides: Partial<B3BackendDecisionInput>;
      reason: B3BackendRejectReason;
    }> = [
      { name: "missing factory", overrides: { factory: null }, reason: "disk_unavailable" },
      {
        name: "empty factory id",
        overrides: { factory: { factoryId: " ", createIndex: () => ({ indexId: "i", close: async () => {} }) } },
        reason: "disk_unavailable",
      },
      { name: "missing parity proof", overrides: { parityProof: null }, reason: "parity_proof_missing" },
      {
        name: "malformed parity digest",
        overrides: { parityProof: { digest: "not-a-sha256", ref: "b3-parity/evidence/1" } },
        reason: "parity_proof_missing",
      },
      {
        name: "empty parity ref",
        overrides: { parityProof: { digest: "ab".repeat(32), ref: "  " } },
        reason: "parity_proof_missing",
      },
      { name: "mutable snapshot", overrides: { snapshotImmutable: false }, reason: "snapshot_mutable" },
      { name: "missing owner", overrides: { owner: null }, reason: "owner_mismatch" },
      {
        name: "owner task mismatch",
        overrides: { owner: { taskId: "task-other", buildId: "build-b3-staging", generation: 3 } },
        reason: "owner_mismatch",
      },
      {
        name: "owner build mismatch",
        overrides: { owner: { taskId: "task-b3-staging", buildId: "build-other", generation: 3 } },
        reason: "owner_mismatch",
      },
      {
        name: "late owner generation",
        overrides: { owner: { taskId: "task-b3-staging", buildId: "build-b3-staging", generation: 2 } },
        reason: "late_generation",
      },
      { name: "no cancel signal", overrides: { signal: null }, reason: "cancel_unavailable" },
      { name: "aborted cancel signal", overrides: { signal: abortedSignal() }, reason: "cancel_unavailable" },
      { name: "missing cleanup", overrides: { cleanup: null }, reason: "cleanup_unavailable" },
      {
        name: "unbound cleanup",
        overrides: { cleanup: { ownerId: "  ", cleanup: async () => {} } },
        reason: "cleanup_unavailable",
      },
      {
        name: "temp quota exceeded",
        overrides: { measured: measuredDecision({ estimatedTempBytes: TEMP_QUOTA + 1 }) },
        reason: "temp_quota_exceeded",
      },
      {
        name: "measured rejection",
        overrides: { measured: measuredDecision({ validatorMode: "reject", failureReason: "unknown_estimate" }) },
        reason: "measured_rejected",
      },
      {
        name: "invalid identity",
        overrides: { taskId: "  " },
        reason: "invalid_input",
      },
    ];
    for (const testCase of cases) {
      const decision = decideB3Backend(input(testCase.overrides));
      expect(decision.outcome, testCase.name).toBe("reject");
      expect((decision as B3RejectDecision).reason, testCase.name).toBe(testCase.reason);
    }
  });

  it("never falls back to memory when disk is requested but cannot be granted", () => {
    const decision = decideB3Backend(input({ factory: null }));
    expect(decision).toEqual({
      outcome: "reject",
      reason: "disk_unavailable",
      detail: expect.any(String),
    } satisfies B3RejectDecision);
  });

  it("is deterministic and serializable for identical inputs", () => {
    const first = decideB3Backend(input());
    const second = decideB3Backend(input());
    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);

    const memory = input({ measured: measuredDecision({ validatorMode: "memory", estimatedHeapBytes: 1 }) });
    expect(decideB3Backend(memory)).toEqual(decideB3Backend(memory));

    const rejected = input({ parityProof: null });
    expect(decideB3Backend(rejected)).toEqual(decideB3Backend(rejected));
  });

  it("exposes no publication or OperationResult semantics", () => {
    // Pure value decision: the module exports only the gate function.
    expect(Object.keys(gateModule)).toEqual(["decideB3Backend"]);

    // Legacy callers cannot reach the gate through the validation barrel.
    expect("decideB3Backend" in validationIndex).toBe(false);

    // Decision values carry no publication/manifest/receipt semantics.
    const forbiddenKeys = ["publication", "operation_result", "manifest", "receipt", "artifact"];
    const decisions = [
      decideB3Backend(input({ measured: measuredDecision({ validatorMode: "memory", estimatedHeapBytes: 1 }) })),
      decideB3Backend(input()),
      decideB3Backend(input({ factory: null })),
    ];
    for (const decision of decisions) {
      expect(Object.keys(decision).filter((key) => forbiddenKeys.includes(key))).toEqual([]);
    }
  });
});
