import { describe, expect, test } from "vitest";

import {
  admitFixedTransformSlot,
  type FixedTransformSlotInput,
} from "../src/dataset/transform-slot/index.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

function input(overrides: Partial<FixedTransformSlotInput> = {}): Readonly<FixedTransformSlotInput> {
  return Object.freeze({
    slotId: "family_transform.fixed.v1",
    taskId: "task_slot",
    buildId: "build_slot",
    generation: 3,
    expectedGeneration: 3,
    capability: Object.freeze({
      scope: "curated",
      id: "transform_slot",
      version: "1.0.0",
      digest: A,
      status: "activated",
    }),
    familySpecDigest: A,
    projectionDigest: B,
    policyDigests: Object.freeze([A, B]),
    inputAssetIds: Object.freeze([`asset_${A}`]),
    upstreamResultManifestIds: Object.freeze(["result_manifest_one"]),
    deadline: "2026-08-23T00:00:00Z",
    cancelFence: "cancel_slot",
    ...overrides,
  });
}

describe("fixed transform slot admission", () => {
  test("creates a deterministic staging-only decision", () => {
    const first = admitFixedTransformSlot(input());
    const second = admitFixedTransformSlot(input());
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      decisionKind: "fixed_transform_slot.v1",
      capabilityRef: `curated:transform_slot:1.0.0:${A}`,
      executable: false,
      runtimeWired: false,
      decisionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(first).not.toHaveProperty("operationResult");
    expect(first).not.toHaveProperty("publication");
  });

  test.each([
    ["unknown slot", { slotId: "agent.slot" }, /server-registered/],
    ["stale generation", { expectedGeneration: 4 }, /generation/],
    ["example scope", { capability: Object.freeze({ ...input().capability, scope: "example" as const }) }, /scope/],
    ["revoked", { capability: Object.freeze({ ...input().capability, status: "revoked" as const }) }, /activated/],
    ["unactivated", { capability: Object.freeze({ ...input().capability, status: "shadow_verified" as const }) }, /activated/],
    ["invalid digest", { projectionDigest: "ABC" }, /sha256/],
    ["invalid asset", { inputAssetIds: Object.freeze(["build_1"]) }, /content-addressed/],
  ] as const)("rejects %s", (_label, overrides, message) => {
    expect(() => admitFixedTransformSlot(input(overrides))).toThrow(message);
  });

  test("rejects Agent-authored DAG, policy, threshold, resource, or publication choices as unknown fields", () => {
    for (const field of ["dag", "mergeWinner", "validationThreshold", "resourceLimit", "publicationChoice"]) {
      expect(() => admitFixedTransformSlot(Object.freeze({
        ...input(),
        [field]: true,
      }) as unknown as FixedTransformSlotInput)).toThrow(/unknown/);
    }
  });

  test("rejects getters, proxies, symbols, hidden fields, and mutable arrays without reads", () => {
    let reads = 0;
    const accessor = { ...input() } as Record<string, unknown>;
    Object.defineProperty(accessor, "taskId", {
      enumerable: true,
      get() { reads += 1; return "task_slot"; },
    });
    Object.freeze(accessor);
    expect(() => admitFixedTransformSlot(accessor as unknown as FixedTransformSlotInput)).toThrow(/data property/);
    expect(reads).toBe(0);
    const proxy = new Proxy(input(), { get() { reads += 1; return undefined; } });
    expect(() => admitFixedTransformSlot(proxy)).toThrow(/non-Proxy/);
    expect(reads).toBe(0);
    expect(() => admitFixedTransformSlot(Object.freeze({
      ...input(),
      policyDigests: [A],
    }))).toThrow(/frozen array/);
    const hidden = { ...input() };
    Object.defineProperty(hidden, "hidden", { value: true, enumerable: false });
    Object.freeze(hidden);
    expect(() => admitFixedTransformSlot(hidden)).toThrow(/unknown/);
    const symbol = Object.freeze({ ...input(), [Symbol("hidden")]: true });
    expect(() => admitFixedTransformSlot(symbol)).toThrow(/unknown/);
  });
});
