import { describe, expect, test } from "vitest";

import { TransformHostError } from "../src/dataset/transform-host/errors.js";
import { sha256Bytes } from "../src/dataset/transform-host/hashing.js";
import {
  assertExecutionPermitted,
  canonicalSandboxProofClaims,
  evaluateSandboxProof,
  type SandboxProofCanonicalClaimsV1,
  type SandboxProofEvaluation,
  type SandboxProofIdentityV1,
  type SandboxProofIsolationEvidenceV1,
  type SandboxProofWindowsCompletenessV1,
} from "../src/dataset/transform-host/proof-gate.js";

const NOW = new Date("2026-08-22T01:02:03.000Z");
const ISSUED_AT = "2026-08-22T01:00:00.000Z";
const EXPIRES_AT = "2026-08-22T02:00:00.000Z";

const IDENTITY: SandboxProofIdentityV1 = {
  user: "transform",
  uid: 1000,
  gid: 1000,
  privileged: false,
};

const EVIDENCE: SandboxProofIsolationEvidenceV1 = {
  acl: "acl/evidence-1",
  jobObject: "job-object/evidence-1",
  container: "container/evidence-1",
};

const WINDOWS: SandboxProofWindowsCompletenessV1 = {
  serviceAccount: true,
  acl: true,
  jobObject: true,
  networkDeny: true,
};

function claims(
  overrides: Partial<SandboxProofCanonicalClaimsV1> = {},
): SandboxProofCanonicalClaimsV1 {
  return {
    schemaVersion: "1.0",
    backendId: "bwrap-backend-v1",
    backendVersion: "1.2.3",
    identity: IDENTITY,
    networkDenied: true,
    unmounted: { workspace: true, settings: true, publication: true },
    hardKill: true,
    isolationEvidence: EVIDENCE,
    platform: "linux",
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    ...overrides,
  };
}

function proof(
  overrides: Record<string, unknown> = {},
  claimOverrides: Partial<SandboxProofCanonicalClaimsV1> = {},
): Record<string, unknown> {
  const base = claims(claimOverrides);
  return { ...base, proofDigest: sha256Bytes(canonicalSandboxProofClaims(base)), ...overrides };
}

function evaluate(
  input: unknown,
  platform: NodeJS.Platform = "linux",
  now: Date = NOW,
): SandboxProofEvaluation {
  return evaluateSandboxProof(input, { platform, now: () => now });
}

describe("evaluateSandboxProof", () => {
  test("rejects a missing proof", () => {
    for (const missing of [undefined, null, 0, "", "proof", [], new Proxy({}, {})]) {
      const evaluation = evaluate(missing);
      expect(evaluation.permitted).toBe(false);
      expect(evaluation.status).toBe("sandbox_unavailable");
      expect(evaluation.reason).toBe("proof_missing");
      expect(evaluation.platform).toBe("linux");
      expect(evaluation.detail).toEqual(expect.any(String));
    }
  });

  test("rejects unknown fields so a caller cannot smuggle extra capability claims", () => {
    expect(evaluate(proof({ extraCapabilities: ["network"] })).reason).toBe("unknown_field");
    expect(evaluate(proof({ privileged: true })).reason).toBe("unknown_field");
    expect(evaluate(proof({ identity: { ...IDENTITY, admin: true } })).reason).toBe("unknown_field");
    expect(
      evaluate(proof({ unmounted: { ...claims().unmounted, repo: true } })).reason,
    ).toBe("unknown_field");
    expect(
      evaluate(proof({ isolationEvidence: { ...EVIDENCE, device: "/dev/zero" } })).reason,
    ).toBe("unknown_field");
  });

  test("rejects a proof missing any required field", () => {
    const required = [
      "schemaVersion",
      "backendId",
      "backendVersion",
      "identity",
      "networkDenied",
      "unmounted",
      "hardKill",
      "isolationEvidence",
      "proofDigest",
      "platform",
      "issuedAt",
      "expiresAt",
    ];
    for (const key of required) {
      const partial = proof();
      delete partial[key];
      const evaluation = evaluate(partial);
      expect(evaluation.permitted).toBe(false);
      expect(evaluation.reason).toBe("missing_field");
      expect(evaluation.detail).toContain(key);
    }
  });

  test("rejects caller privilege escalation claims", () => {
    expect(evaluate(proof({ identity: { ...IDENTITY, uid: 0 } })).reason).toBe("privilege_escalation");
    expect(evaluate(proof({ identity: { ...IDENTITY, gid: 0 } })).reason).toBe("privilege_escalation");
    expect(evaluate(proof({ identity: { ...IDENTITY, user: "root" } })).reason).toBe("privilege_escalation");
    expect(evaluate(proof({ identity: { ...IDENTITY, user: "Administrator" } })).reason).toBe(
      "privilege_escalation",
    );
    expect(evaluate(proof({ identity: { ...IDENTITY, privileged: true } })).reason).toBe(
      "privilege_escalation",
    );
  });

  test("rejects isolation claims that are not exactly satisfied", () => {
    expect(evaluate(proof({ networkDenied: false })).reason).toBe("network_not_denied");
    expect(evaluate(proof({ networkDenied: "true" })).reason).toBe("network_not_denied");
    expect(
      evaluate(proof({ unmounted: { workspace: false, settings: true, publication: true } })).reason,
    ).toBe("mount_violation");
    expect(evaluate(proof({ hardKill: false })).reason).toBe("hard_kill_missing");
    expect(evaluate(proof({ isolationEvidence: { acl: "acl/1", container: "c/1" } })).reason).toBe(
      "isolation_evidence_missing",
    );
  });

  test("rejects a proof for a different platform", () => {
    const evaluation = evaluate(proof({ platform: "darwin" }));
    expect(evaluation.reason).toBe("platform_mismatch");
    expect(evaluation.detail).toContain("darwin");
    expect(evaluation.detail).toContain("linux");
  });

  test("rejects incomplete Windows isolation claims and stays disabled for complete ones", () => {
    // Missing windows completeness evidence on a win32 proof.
    expect(evaluate(proof({}, { platform: "win32" }), "win32").reason).toBe("windows_incomplete");
    // Partial windows evidence (windows_incomplete fires before the digest check).
    expect(
      evaluate(proof({ platform: "win32", windows: { ...WINDOWS, jobObject: false } }), "win32")
        .reason,
    ).toBe("windows_incomplete");
    // Complete windows evidence is still disabled: the proof is caller-reported.
    const complete = evaluate(proof({}, { platform: "win32", windows: WINDOWS }), "win32");
    expect(complete.permitted).toBe(false);
    expect(complete.reason).toBe("self_reported");
    // Windows claims on a non-Windows proof are invalid.
    expect(evaluate(proof({ windows: WINDOWS })).reason).toBe("field_invalid");
  });

  test("rejects expired, not-yet-valid, and misordered proofs", () => {
    expect(evaluate(proof(), "linux", new Date("2026-08-22T03:00:00.000Z")).reason).toBe(
      "proof_expired",
    );
    expect(evaluate(proof(), "linux", new Date("2026-08-22T00:30:00.000Z")).reason).toBe(
      "proof_not_yet_valid",
    );
    expect(evaluate(proof({ issuedAt: EXPIRES_AT, expiresAt: ISSUED_AT })).reason).toBe(
      "field_invalid",
    );
  });

  test("rejects any proof digest mutation", () => {
    expect(evaluate(proof({ proofDigest: "f".repeat(64) })).reason).toBe("digest_mismatch");

    const mutatedClaim = proof();
    mutatedClaim.backendVersion = "9.9.9"; // Claim changed after the digest was computed.
    expect(evaluate(mutatedClaim).reason).toBe("digest_mismatch");

    const mutatedNested = proof();
    (mutatedNested.isolationEvidence as Record<string, unknown>).acl = "acl/tampered";
    expect(evaluate(mutatedNested).reason).toBe("digest_mismatch");
  });

  test("is deterministic for identical input and gate options", () => {
    const first = evaluate(proof());
    const second = evaluate(proof());
    expect(first).toEqual(second);
    // Same structural proof inside the validity window yields the same result
    // regardless of the exact evaluation time.
    expect(evaluate(proof(), "linux", new Date("2026-08-22T01:30:00.000Z"))).toEqual(first);
    expect(evaluate(proof(), "linux", new Date("2026-08-22T01:59:59.000Z"))).toEqual(first);
    // Denials are stable too.
    expect(evaluate(proof({ platform: "darwin" }))).toEqual(evaluate(proof({ platform: "darwin" })));
  });

  test("never produces an enabled receipt for any input", () => {
    const inputs: unknown[] = [
      undefined,
      proof(),
      proof({ platform: "darwin" }),
      proof({ identity: { ...IDENTITY, uid: 0 } }),
      proof({ networkDenied: false }),
      proof({ proofDigest: "f".repeat(64) }),
      proof({}, { platform: "win32", windows: WINDOWS }),
      proof({ issuedAt: "2026-08-22T01:00:00.000Z", expiresAt: "2026-08-22T00:30:00.000Z" }),
    ];
    for (const input of inputs) {
      const evaluation = evaluate(input, "linux");
      expect(evaluation.permitted).toBe(false);
      expect(evaluation.status).toBe("sandbox_unavailable");
      expect(Object.isFrozen(evaluation)).toBe(true);
    }
  });

  test("never throws for hostile inputs", () => {
    const hostile: unknown[] = [
      undefined,
      null,
      0,
      42,
      "sandbox proof",
      [],
      [1, 2],
      { schemaVersion: 1 },
      { __proto__: null, backendId: "x" },
      Object.create({ inherited: true }),
      new Proxy({}, {}),
    ];
    for (const input of hostile) {
      expect(() => evaluate(input)).not.toThrow();
      expect(evaluate(input).permitted).toBe(false);
    }
  });
});

describe("assertExecutionPermitted", () => {
  test("throws a typed sandbox_unavailable error even for a structurally valid proof", () => {
    let caught: unknown;
    try {
      assertExecutionPermitted(proof(), { platform: "linux", now: () => NOW });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TransformHostError);
    const hostError = caught as TransformHostError;
    expect(hostError.code).toBe("sandbox_unavailable");
    expect(hostError.message).toContain("disabled");
    expect(hostError.cause).toMatchObject({
      permitted: false,
      status: "sandbox_unavailable",
      reason: "self_reported",
    });
  });

  test("throws for every denial without ever permitting", () => {
    for (const input of [
      undefined,
      proof({ platform: "darwin" }),
      proof({ hardKill: false }),
      proof({ proofDigest: "f".repeat(64) }),
    ]) {
      expect(() => assertExecutionPermitted(input, { platform: "linux", now: () => NOW })).toThrowError(
        TransformHostError,
      );
    }
  });
});
