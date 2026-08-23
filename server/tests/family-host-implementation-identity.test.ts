import { describe, expect, test } from "vitest";

import {
  computeImplementationIdentityDigest,
  type ImplementationIdentityInput,
} from "../src/dataset/identity/implementation.js";

const DIGESTS = ["a", "b", "c", "d", "e", "f", "1"]
  .map((character) => character.repeat(64));

function input(
  overrides: Partial<ImplementationIdentityInput> = {},
): Readonly<ImplementationIdentityInput> {
  return Object.freeze({
    bundleDigest: DIGESTS[0]!,
    dependencyDigest: DIGESTS[1]!,
    compilerDigest: DIGESTS[2]!,
    runtimeDigest: DIGESTS[3]!,
    policyDigest: DIGESTS[4]!,
    familySpecDigest: DIGESTS[5]!,
    ...overrides,
  });
}

describe("staging implementation identity", () => {
  test("is stable and changes when any bound component changes", () => {
    const baseline = computeImplementationIdentityDigest(input());
    expect(computeImplementationIdentityDigest(input())).toBe(baseline);
    expect(baseline).toMatch(/^[0-9a-f]{64}$/);

    const components = [
      "bundleDigest",
      "dependencyDigest",
      "compilerDigest",
      "runtimeDigest",
      "policyDigest",
      "familySpecDigest",
    ] as const;
    for (const component of components) {
      expect(computeImplementationIdentityDigest(input({ [component]: DIGESTS[6]! })))
        .not.toBe(baseline);
    }
  });

  test("rejects missing, invalid, and unknown digest fields", () => {
    const missing = { ...input() } as Record<string, unknown>;
    delete missing.bundleDigest;
    expect(() => computeImplementationIdentityDigest(
      Object.freeze(missing) as unknown as ImplementationIdentityInput,
    )).toThrow(/unknown or missing fields/);
    expect(() => computeImplementationIdentityDigest(input({ runtimeDigest: "A".repeat(64) })))
      .toThrow(/runtimeDigest.*lowercase SHA-256/);
    expect(() => computeImplementationIdentityDigest(input({ policyDigest: "f".repeat(63) })))
      .toThrow(/policyDigest.*lowercase SHA-256/);
    expect(() => computeImplementationIdentityDigest(Object.freeze({
      ...input(),
      sourceDigest: DIGESTS[6]!,
    }) as unknown as ImplementationIdentityInput)).toThrow(/unknown or missing fields/);
  });

  test("rejects mutable or exotic objects, proxies, and accessors without reads", () => {
    expect(() => computeImplementationIdentityDigest({ ...input() })).toThrow(/frozen plain/);
    expect(() => computeImplementationIdentityDigest(
      Object.freeze(Object.assign(Object.create(null), input())),
    )).not.toThrow();
    expect(() => computeImplementationIdentityDigest(
      Object.freeze(Object.assign(Object.create({}), input())),
    )).toThrow(/plain object prototype/);

    let reads = 0;
    const accessor = { ...input() } as Record<string, unknown>;
    Object.defineProperty(accessor, "bundleDigest", {
      enumerable: true,
      get() {
        reads += 1;
        return DIGESTS[0]!;
      },
    });
    expect(() => computeImplementationIdentityDigest(
      Object.freeze(accessor) as unknown as ImplementationIdentityInput,
    )).toThrow(/data property/);
    expect(reads).toBe(0);

    const proxy = new Proxy(input(), {
      get() {
        reads += 1;
        return undefined;
      },
    });
    expect(() => computeImplementationIdentityDigest(proxy)).toThrow(/non-Proxy/);
    expect(reads).toBe(0);
  });
});
