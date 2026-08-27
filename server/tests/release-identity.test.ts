import { describe, expect, test, vi } from "vitest";

import {
  CoreReleaseIdentityStartupError,
  resolveCoreReleaseIdentity,
} from "../src/dataset/runtime/release-identity.js";
import {
  verifyFixedOperationCheckpointIdentity,
  type FixedOperationCheckpointIdentity,
} from "../src/dataset/runtime/checkpoint.js";
import {
  computeOperationDigest,
  type DigestScope,
} from "../src/dataset/runtime/digests.js";
import type { OperationSpec } from "../src/dataset/runtime/operations.js";

const SHA256 = "a".repeat(64);
const IMPLEMENTATION_DIGEST = "b".repeat(64);
const operation: OperationSpec = {
  operation_id: "derive:sequence",
  kind: "derive",
  label: "derive sequence",
  category: "derive",
  upstream: ["canonicalize:source"],
};

function scope(coreReleaseIdentity: string, operationIdentity = "derive-1"): DigestScope {
  return {
    requirementId: "build-1",
    upstream: { "canonicalize:source": { digest: "b".repeat(64) } },
    parameterScope: { algorithm: "sequence" },
    coreReleaseIdentity,
    operationIdentities: { [operation.operation_id]: operationIdentity },
  };
}

describe("core release identity", () => {
  test("production and staging fail closed for missing or invalid identity", () => {
    for (const environment of ["production", "staging"] as const) {
      expect(() => resolveCoreReleaseIdentity({ environment })).toThrow(CoreReleaseIdentityStartupError);
      expect(() => resolveCoreReleaseIdentity({ environment, configuredIdentity: "latest" })).toThrow(
        /safe canonical release identity/,
      );
      expect(() => resolveCoreReleaseIdentity({ environment, buildArtifactDigest: "not-a-digest" })).toThrow(
        CoreReleaseIdentityStartupError,
      );
    }
  });

  test("development without an artifact uses a process-unique non-persisted identity", () => {
    const first = resolveCoreReleaseIdentity({ environment: "dev" });
    const second = resolveCoreReleaseIdentity({ environment: "dev" });

    expect(first).toBe(second);
    expect(first).toMatch(/^ref:process-[0-9a-f-]{36}$/);
  });

  test("test environments accept an injected fixed identity", () => {
    const identity = "ref:test-fixture-1";
    expect(resolveCoreReleaseIdentity({ environment: "test", configuredIdentity: identity })).toBe(identity);
    expect(resolveCoreReleaseIdentity({ environment: "test", configuredIdentity: identity })).toBe(identity);
  });

  test("artifact digest must already be canonical lowercase sha256", () => {
    expect(resolveCoreReleaseIdentity({ environment: "production", buildArtifactDigest: SHA256 })).toBe(
      `sha256:${SHA256}`,
    );
    expect(() => resolveCoreReleaseIdentity({
      environment: "production",
      buildArtifactDigest: SHA256.toUpperCase(),
    })).toThrow(CoreReleaseIdentityStartupError);
  });

  test("configured refs are opaque identities, never paths", () => {
    expect(() => resolveCoreReleaseIdentity({
      environment: "production",
      configuredIdentity: "ref:releases/current",
    })).toThrow(CoreReleaseIdentityStartupError);
  });

  test("fixed and derive operation digests compose core release and operation identity", () => {
    const first = computeOperationDigest(operation, scope(`ref:release-a`));
    const second = computeOperationDigest(operation, scope(`ref:release-b`));
    const changedOperation = computeOperationDigest(operation, scope(`ref:release-a`, "derive-2"));

    expect(first).not.toBe(second);
    expect(first).not.toBe(changedOperation);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a reloaded module does not reuse the development identity", async () => {
    vi.resetModules();
    const firstModule = await import("../src/dataset/runtime/release-identity.js");
    const first = firstModule.resolveCoreReleaseIdentity({ environment: "dev" });

    vi.resetModules();
    const secondModule = await import("../src/dataset/runtime/release-identity.js");
    const second = secondModule.resolveCoreReleaseIdentity({ environment: "dev" });

    expect(first).not.toBe(second);
  });
});

function checkpointIdentity(
  overrides: Partial<FixedOperationCheckpointIdentity> = {},
): Readonly<FixedOperationCheckpointIdentity> {
  return Object.freeze({
    core_release_identity: "ref:release-a",
    fixed_operation_implementation_component_digest: IMPLEMENTATION_DIGEST,
    ...overrides,
  });
}

describe("fixed operation checkpoint reuse identity", () => {
  const coreReleaseIdentity = resolveCoreReleaseIdentity({
    environment: "staging",
    configuredIdentity: "ref:release-a",
  });
  const expectedIdentity = (implementationComponentDigest: string | null | undefined) =>
    Object.freeze({
    coreReleaseIdentity,
    implementationComponentDigest,
  });

  test("reuses only when the validated Core release and implementation component match", () => {
    const result = verifyFixedOperationCheckpointIdentity(
      checkpointIdentity(),
      expectedIdentity(IMPLEMENTATION_DIGEST),
    );
    expect(result).toEqual({
      kind: "reusable",
      identity_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("fails closed with typed not-reusable results for missing identity components", () => {
    expect(verifyFixedOperationCheckpointIdentity(null, expectedIdentity(IMPLEMENTATION_DIGEST))).toEqual({
      kind: "not_reusable",
      code: "CHECKPOINT_REUSE_IDENTITY_MISSING",
    });
    expect(verifyFixedOperationCheckpointIdentity(checkpointIdentity({
      fixed_operation_implementation_component_digest: null,
    }), expectedIdentity(IMPLEMENTATION_DIGEST))).toEqual({
      kind: "not_reusable",
      code: "CHECKPOINT_REUSE_IDENTITY_MISSING",
    });
    expect(verifyFixedOperationCheckpointIdentity(
      checkpointIdentity(),
      expectedIdentity(undefined),
    )).toEqual({
      kind: "not_reusable",
      code: "CHECKPOINT_REUSE_IDENTITY_MISSING",
    });
  });

  test("fails closed with typed mismatch results when either bound identity changes", () => {
    expect(verifyFixedOperationCheckpointIdentity(checkpointIdentity({
      core_release_identity: "ref:release-b",
    }), expectedIdentity(IMPLEMENTATION_DIGEST))).toEqual({
      kind: "not_reusable",
      code: "CHECKPOINT_CORE_RELEASE_IDENTITY_MISMATCH",
    });
    expect(verifyFixedOperationCheckpointIdentity(checkpointIdentity({
      fixed_operation_implementation_component_digest: "c".repeat(64),
    }), expectedIdentity(IMPLEMENTATION_DIGEST))).toEqual({
      kind: "not_reusable",
      code: "CHECKPOINT_OPERATION_IMPLEMENTATION_DIGEST_MISMATCH",
    });
  });

  test("rejects mutable, accessor, Proxy, symbol, and unknown records without reads", () => {
    expect(() => verifyFixedOperationCheckpointIdentity(
      { ...checkpointIdentity() },
      expectedIdentity(IMPLEMENTATION_DIGEST),
    )).toThrow(/frozen plain/);

    let reads = 0;
    const accessor = { ...checkpointIdentity() } as Record<string, unknown>;
    Object.defineProperty(accessor, "core_release_identity", {
      enumerable: true,
      get() { reads += 1; return "ref:release-a"; },
    });
    Object.freeze(accessor);
    expect(() => verifyFixedOperationCheckpointIdentity(
      accessor as unknown as FixedOperationCheckpointIdentity,
      expectedIdentity(IMPLEMENTATION_DIGEST),
    )).toThrow(/data property/);
    expect(reads).toBe(0);

    const proxy = new Proxy(checkpointIdentity(), {
      get() { reads += 1; return undefined; },
    });
    expect(() => verifyFixedOperationCheckpointIdentity(proxy, expectedIdentity(IMPLEMENTATION_DIGEST)))
      .toThrow(/non-Proxy/);
    expect(reads).toBe(0);

    expect(() => verifyFixedOperationCheckpointIdentity(Object.freeze({
      ...checkpointIdentity(), extra: true,
    }) as unknown as FixedOperationCheckpointIdentity, expectedIdentity(IMPLEMENTATION_DIGEST))).toThrow(/unknown/);
    expect(() => verifyFixedOperationCheckpointIdentity(Object.freeze({
      ...checkpointIdentity(), [Symbol("hidden")]: true,
    }) as unknown as FixedOperationCheckpointIdentity, expectedIdentity(IMPLEMENTATION_DIGEST))).toThrow(/unknown/);
  });
});
