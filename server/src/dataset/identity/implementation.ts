import { types } from "node:util";

import { canonicalDigest } from "../adapters/identity.js";

const SHA256_DIGEST = /^[0-9a-f]{64}$/;
const IMPLEMENTATION_IDENTITY_KEYS = new Set([
  "bundleDigest",
  "dependencyDigest",
  "compilerDigest",
  "runtimeDigest",
  "policyDigest",
  "familySpecDigest",
]);

export interface ImplementationIdentityInput {
  readonly bundleDigest: string;
  readonly dependencyDigest: string;
  readonly compilerDigest: string;
  readonly runtimeDigest: string;
  readonly policyDigest: string;
  readonly familySpecDigest: string;
}

function snapshotInput(input: unknown): Record<string, unknown> {
  if (
    typeof input !== "object" || input === null || Array.isArray(input)
    || types.isProxy(input) || !Object.isFrozen(input)
  ) {
    throw new TypeError("implementation identity input must be a frozen plain non-Proxy object");
  }
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("implementation identity input must have a plain object prototype");
  }
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (
    ownKeys.length !== IMPLEMENTATION_IDENTITY_KEYS.size
    || ownKeys.some((key) =>
      typeof key !== "string" || !IMPLEMENTATION_IDENTITY_KEYS.has(key))
  ) {
    throw new TypeError("implementation identity input has unknown or missing fields");
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of ownKeys) {
    const descriptor = descriptors[key as string];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new TypeError(`implementation identity input.${String(key)} must be an enumerable data property`);
    }
    snapshot[key as string] = descriptor.value;
  }
  return snapshot;
}

function parseDigest(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

/**
 * Compute the staging-only implementation identity. This primitive performs no
 * Host admission and does not activate the proposed ADR-039 runtime.
 */
export function computeImplementationIdentityDigest(input: ImplementationIdentityInput): string {
  const snapshot = snapshotInput(input);
  return canonicalDigest({
    bundleDigest: parseDigest(snapshot.bundleDigest, "bundleDigest"),
    compilerDigest: parseDigest(snapshot.compilerDigest, "compilerDigest"),
    dependencyDigest: parseDigest(snapshot.dependencyDigest, "dependencyDigest"),
    familySpecDigest: parseDigest(snapshot.familySpecDigest, "familySpecDigest"),
    policyDigest: parseDigest(snapshot.policyDigest, "policyDigest"),
    runtimeDigest: parseDigest(snapshot.runtimeDigest, "runtimeDigest"),
  });
}
