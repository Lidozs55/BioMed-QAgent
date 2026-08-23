import { describe, expect, test } from "vitest";

import {
  createAuthoritativeDatasetIdentityContext,
  type AuthoritativeDatasetIdentityInput,
  type SourceAssetRegistrationFact,
} from "../src/dataset/identity/authoritative.js";
import { buildGeneExpressionSchemaV2, buildProbeExpressionSchemaV2 } from "../src/dataset/schema/expression.js";

const A = "a".repeat(64);
const B = "b".repeat(64);

function fact(overrides: Partial<SourceAssetRegistrationFact> = {}): Readonly<SourceAssetRegistrationFact> {
  const sha256 = overrides.sha256 ?? A;
  return Object.freeze({
    bindingId: "binding_geo",
    source: "geo",
    role: "source",
    assetId: `asset_${sha256}`,
    sha256,
    sizeBytes: 100,
    taskId: "task_identity",
    buildId: "build_one",
    generation: 3,
    providerSnapshot: "geo:2026-08-22T00:00:00Z",
    revisionToken: "2026-08-22T00:00:00Z",
    accession: "GSE1",
    ...overrides,
  });
}

function input(overrides: Partial<AuthoritativeDatasetIdentityInput> = {}): Readonly<AuthoritativeDatasetIdentityInput> {
  return Object.freeze({
    sourceNamespace: "geo",
    canonicalAccessions: Object.freeze(["GSE1"]),
    taskId: "task_identity",
    buildId: "build_one",
    generation: 3,
    schemaRef: "gene_expression.long.v2",
    facts: Object.freeze([fact()]),
    ...overrides,
  });
}

describe("authoritative expression identity context", () => {
  test("binds existing unregistered V2 schemas and revision-scoped keys", () => {
    const gene = createAuthoritativeDatasetIdentityContext(input());
    expect(gene.schemaRef).toBe(buildGeneExpressionSchemaV2().schema_id);
    expect(gene.primaryKey).toEqual([
      "dataset_revision_id", "sample_id", "gene_id", "measurement_type",
    ]);
    const probe = createAuthoritativeDatasetIdentityContext(input({
      schemaRef: "gene_expression.probe_long.v2",
    }));
    expect(probe.schemaRef).toBe(buildProbeExpressionSchemaV2().schema_id);
    expect(probe.primaryKey).toEqual([
      "dataset_revision_id", "probe_id", "platform_id", "sample_id",
    ]);
  });

  test("build identity is ownership-only and never changes dataset identity", () => {
    const first = createAuthoritativeDatasetIdentityContext(input());
    const second = createAuthoritativeDatasetIdentityContext(input({
      buildId: "build_two",
      facts: Object.freeze([fact({ buildId: "build_two" })]),
    }));
    expect(second.datasetId).toBe(first.datasetId);
    expect(second.datasetRevisionId).toBe(first.datasetRevisionId);
  });

  test("carrier bytes, revision, provider snapshot, and accession split identity deterministically", () => {
    const base = createAuthoritativeDatasetIdentityContext(input());
    const carrier = createAuthoritativeDatasetIdentityContext(input({
      facts: Object.freeze([fact({ sha256: B, assetId: `asset_${B}` })]),
    }));
    const revision = createAuthoritativeDatasetIdentityContext(input({
      facts: Object.freeze([fact({ revisionToken: "2026-08-23T00:00:00Z" })]),
    }));
    const provider = createAuthoritativeDatasetIdentityContext(input({
      facts: Object.freeze([fact({ providerSnapshot: "geo:2026-08-23T00:00:00Z" })]),
    }));
    const accession = createAuthoritativeDatasetIdentityContext(input({
      canonicalAccessions: Object.freeze(["GSE2"]),
      facts: Object.freeze([fact({ accession: "GSE2" })]),
    }));
    expect(carrier.datasetRevisionId).not.toBe(base.datasetRevisionId);
    expect(revision.datasetRevisionId).not.toBe(base.datasetRevisionId);
    expect(provider.datasetRevisionId).not.toBe(base.datasetRevisionId);
    expect(accession.datasetId).not.toBe(base.datasetId);
  });

  test("carrier order is invariant but duplicate asset receipts fail closed", () => {
    const source = fact();
    const mapping = fact({
      bindingId: "binding_mapping",
      role: "mapping",
      sha256: B,
      assetId: `asset_${B}`,
    });
    const left = createAuthoritativeDatasetIdentityContext(input({
      facts: Object.freeze([source, mapping]),
    }));
    const right = createAuthoritativeDatasetIdentityContext(input({
      facts: Object.freeze([mapping, source]),
    }));
    expect(right.datasetRevisionId).toBe(left.datasetRevisionId);
    expect(() => createAuthoritativeDatasetIdentityContext(input({
      facts: Object.freeze([source, source]),
    }))).toThrow(/unique/);
  });

  test("fails closed on missing facts and ownership or digest mismatch", () => {
    expect(() => createAuthoritativeDatasetIdentityContext(input({ facts: Object.freeze([]) })))
      .toThrow(/non-empty/);
    expect(() => createAuthoritativeDatasetIdentityContext(input({
      facts: Object.freeze([fact({ taskId: "other_task" })]),
    }))).toThrow(/ownership/);
    expect(() => createAuthoritativeDatasetIdentityContext(input({
      facts: Object.freeze([fact({ generation: 4 })]),
    }))).toThrow(/ownership/);
    expect(() => createAuthoritativeDatasetIdentityContext(input({
      facts: Object.freeze([fact({ assetId: `asset_${B}` })]),
    }))).toThrow(/byte digest/);
  });

  test("rejects unknown fields, accessors, proxies, and mutable arrays without reads", () => {
    let reads = 0;
    const accessor = { ...input() } as Record<string, unknown>;
    Object.defineProperty(accessor, "taskId", {
      enumerable: true,
      get() {
        reads += 1;
        return "task_identity";
      },
    });
    Object.freeze(accessor);
    expect(() => createAuthoritativeDatasetIdentityContext(
      accessor as unknown as AuthoritativeDatasetIdentityInput,
    )).toThrow(/data property/);
    expect(reads).toBe(0);
    const proxied = new Proxy(input(), {
      get() {
        reads += 1;
        return undefined;
      },
    });
    expect(() => createAuthoritativeDatasetIdentityContext(proxied)).toThrow(/non-Proxy/);
    expect(reads).toBe(0);
    expect(() => createAuthoritativeDatasetIdentityContext(Object.freeze({
      ...input(),
      extra: true,
    }) as unknown as AuthoritativeDatasetIdentityInput)).toThrow(/unknown/);
    expect(() => createAuthoritativeDatasetIdentityContext(Object.freeze({
      ...input(),
      facts: [fact()],
    }))).toThrow(/frozen array/);
  });
});
