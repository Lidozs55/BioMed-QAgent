import { describe, expect, it } from "vitest";

import {
  createFamilyCatalog,
  inspectFamilyCatalogEntry,
  resolveFamilyCatalogDiscovery,
  resolveFamilyCatalogExecution,
  type FamilyCatalogEntry,
} from "../src/dataset/family-catalog/index.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);

function entry(
  overrides: Partial<FamilyCatalogEntry<string>> = {},
): FamilyCatalogEntry<string> {
  return {
    kind: "dataset_transform",
    scope: "task",
    id: "normalize-expression",
    version: "1.0.0",
    digest: DIGEST_A,
    status: "sandbox_executable",
    value: "fixture-transform",
    ...overrides,
  };
}

describe("family catalog T6 scope-qualified exact resolution", () => {
  it("resolves a production execution only by exact scope, id, version, and digest", () => {
    const created = createFamilyCatalog([
      entry(),
      entry({ scope: "system", digest: DIGEST_B, status: "activated", value: "system-transform" }),
    ]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const resolved = resolveFamilyCatalogExecution(created.catalog, {
      scope: "system",
      id: "normalize-expression",
      version: "1.0.0",
      digest: DIGEST_B,
    }, "production");

    expect(resolved).toEqual({
      ok: true,
      entry: entry({
        scope: "system",
        digest: DIGEST_B,
        status: "activated",
        value: "system-transform",
      }),
    });
    expect(resolveFamilyCatalogExecution(created.catalog, {
      scope: "system",
      id: "normalize-expression",
      version: "1.0.0",
      digest: DIGEST_C,
    }, "production")).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("fails closed when a production execution reference is not exact or has unknown fields", () => {
    const created = createFamilyCatalog([entry()]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(resolveFamilyCatalogExecution(created.catalog, {
      scope: "task",
      id: "normalize-expression",
      version: "1.0.0",
    }, "sandbox")).toMatchObject({ ok: false, error: { code: "invalid_reference" } });

    expect(resolveFamilyCatalogExecution(created.catalog, {
      scope: "task",
      id: "normalize-expression",
      version: "1.0.0",
      digest: DIGEST_A,
      fallbackScope: "system",
    }, "sandbox")).toMatchObject({ ok: false, error: { code: "invalid_reference" } });

    expect(resolveFamilyCatalogExecution(created.catalog, {
      scope: "task",
      id: "normalize-expression",
      version: "1.0.0",
      digest: DIGEST_A,
    }, "unknown")).toMatchObject({
      ok: false,
      error: { code: "invalid_execution_purpose", purpose: "unknown" },
    });
  });

  it("returns explicit ambiguity for an unqualified multi-candidate lookup without scope priority", () => {
    const created = createFamilyCatalog([
      entry({ scope: "curated", status: "activated", value: "curated-transform" }),
      entry({ scope: "task", digest: DIGEST_B, value: "task-transform" }),
    ]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const resolved = resolveFamilyCatalogDiscovery(created.catalog, {
      id: "normalize-expression",
      version: "1.0.0",
    });

    expect(resolved).toMatchObject({
      ok: false,
      error: {
        code: "ambiguous_reference",
        candidates: expect.arrayContaining([
          { scope: "curated", id: "normalize-expression", version: "1.0.0", digest: DIGEST_A },
          { scope: "task", id: "normalize-expression", version: "1.0.0", digest: DIGEST_B },
        ]),
      },
    });
    if (!resolved.ok && resolved.error.code === "ambiguous_reference") {
      expect(resolved.error.candidates).toHaveLength(2);
    }
  });

  it("rejects conflicting digests for the same scope, id, and version", () => {
    const created = createFamilyCatalog([
      entry({ digest: DIGEST_A }),
      entry({ digest: DIGEST_B }),
    ]);

    expect(created).toMatchObject({
      ok: false,
      error: {
        code: "identity_conflict",
        scope: "task",
        id: "normalize-expression",
        version: "1.0.0",
        digests: [DIGEST_A, DIGEST_B],
      },
    });
  });

  it("blocks revoked entries for new execution while preserving exact historical inspection", () => {
    const revoked = entry({ status: "revoked" });
    const created = createFamilyCatalog([revoked]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const ref = { scope: "task", id: revoked.id, version: revoked.version, digest: revoked.digest } as const;
    expect(resolveFamilyCatalogExecution(created.catalog, ref, "sandbox")).toMatchObject({
      ok: false,
      error: { code: "execution_revoked", ref },
    });
    expect(inspectFamilyCatalogEntry(created.catalog, ref)).toEqual({ ok: true, entry: revoked });
  });

  it("keeps scope independent from execution status", () => {
    const sandboxTask = entry({ scope: "task", status: "sandbox_executable" });
    const blockedCurated = entry({
      scope: "curated",
      id: "curated-review-pending",
      status: "submitted",
    });
    const created = createFamilyCatalog([sandboxTask, blockedCurated]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(resolveFamilyCatalogExecution(created.catalog, {
      scope: sandboxTask.scope,
      id: sandboxTask.id,
      version: sandboxTask.version,
      digest: sandboxTask.digest,
    }, "sandbox")).toEqual({ ok: true, entry: sandboxTask });
    expect(resolveFamilyCatalogExecution(created.catalog, {
      scope: blockedCurated.scope,
      id: blockedCurated.id,
      version: blockedCurated.version,
      digest: blockedCurated.digest,
    }, "sandbox")).toMatchObject({
      ok: false,
      error: { code: "status_not_executable", status: "submitted", purpose: "sandbox" },
    });
  });

  it("never executes a FamilySpec catalog entry", () => {
    const familySpec = entry({ kind: "family_spec", status: "activated" });
    const created = createFamilyCatalog([familySpec]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const ref = {
      scope: familySpec.scope,
      id: familySpec.id,
      version: familySpec.version,
      digest: familySpec.digest,
    } as const;
    expect(resolveFamilyCatalogExecution(created.catalog, ref, "production")).toMatchObject({
      ok: false,
      error: { code: "entry_not_executable", ref, kind: "family_spec" },
    });
    expect(inspectFamilyCatalogEntry(created.catalog, ref)).toEqual({ ok: true, entry: familySpec });
  });

  it("never executes example scope even when its status would otherwise be executable", () => {
    const example = entry({ scope: "example", status: "activated" });
    const created = createFamilyCatalog([example]);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const ref = { scope: "example", id: example.id, version: example.version, digest: example.digest } as const;
    expect(resolveFamilyCatalogExecution(created.catalog, ref, "sandbox")).toMatchObject({
      ok: false,
      error: { code: "example_not_executable", ref },
    });
    expect(inspectFamilyCatalogEntry(created.catalog, ref)).toEqual({ ok: true, entry: example });
  });

  it.each(["submitted", "retired"] as const)(
    "fails closed when status %s does not permit a new execution",
    (status) => {
      const blocked = entry({ status });
      const created = createFamilyCatalog([blocked]);
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      expect(resolveFamilyCatalogExecution(created.catalog, {
        scope: blocked.scope,
        id: blocked.id,
        version: blocked.version,
        digest: blocked.digest,
      }, "sandbox")).toMatchObject({
        ok: false,
        error: { code: "status_not_executable", status, purpose: "sandbox" },
      });
    },
  );

  it("enforces separate sandbox, fixture, shadow, and production trust thresholds", () => {
    const statuses = [
      "sandbox_executable",
      "fixture_verified",
      "shadow_verified",
      "trusted_e2e_verified",
      "activated",
    ] as const;
    const created = createFamilyCatalog(statuses.map((status, index) => entry({
      id: `transform-${index}`,
      status,
    })));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const allowedByPurpose = {
      sandbox: new Set(statuses),
      fixture: new Set(statuses.slice(1)),
      shadow: new Set(statuses.slice(2)),
      production: new Set(["activated"]),
    } as const;
    for (const purpose of ["sandbox", "fixture", "shadow", "production"] as const) {
      for (const [index, status] of statuses.entries()) {
        const candidate = entry({ id: `transform-${index}`, status });
        const result = resolveFamilyCatalogExecution(created.catalog, {
          scope: candidate.scope,
          id: candidate.id,
          version: candidate.version,
          digest: candidate.digest,
        }, purpose);
        expect(result.ok, `${status} for ${purpose}`).toBe(
          allowedByPurpose[purpose].has(status),
        );
      }
    }
  });

  it("returns ambiguity candidates in deterministic identity order", () => {
    const left = entry({ scope: "user", digest: DIGEST_C });
    const right = entry({ scope: "curated", digest: DIGEST_B });
    const first = createFamilyCatalog([left, right]);
    const second = createFamilyCatalog([right, left]);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    expect(resolveFamilyCatalogDiscovery(first.catalog, { id: left.id })).toEqual(
      resolveFamilyCatalogDiscovery(second.catalog, { id: left.id }),
    );
  });

  it("validates catalog entries at runtime instead of trusting TypeScript callers", () => {
    for (const malformed of [
      { ...entry(), scope: "workspace" },
      { ...entry(), id: " normalize-expression" },
      { ...entry(), version: "1.0.0\u0000" },
      { ...entry(), id: "normalize-e\u0301xpression" },
    ]) {
      expect(createFamilyCatalog([malformed])).toMatchObject({
        ok: false,
        error: { code: "invalid_entry", index: 0 },
      });
    }
  });
});
