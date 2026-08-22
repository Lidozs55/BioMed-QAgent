import { describe, expect, test, vi } from "vitest";

import {
  CoreReleaseIdentityStartupError,
  resolveCoreReleaseIdentity,
} from "../src/dataset/runtime/release-identity.js";
import {
  computeOperationDigest,
  type DigestScope,
} from "../src/dataset/runtime/digests.js";
import type { OperationSpec } from "../src/dataset/runtime/operations.js";

const SHA256 = "a".repeat(64);
const operation: OperationSpec = {
  operation_id: "derive:sequence",
  kind: "derive",
  label: "derive sequence",
  category: "derive",
  upstream: ["canonicalize:source"],
};

function scope(coreReleaseIdentity: string, operationIdentity = "derive-1"): DigestScope {
  return {
    buildId: "build-1",
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

  test("artifact digest is normalized to a canonical sha256 identity", () => {
    expect(resolveCoreReleaseIdentity({ environment: "production", buildArtifactDigest: SHA256.toUpperCase() })).toBe(
      `sha256:${SHA256}`,
    );
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
