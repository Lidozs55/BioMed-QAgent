import { describe, expect, test } from "vitest";

import type { ProviderRevisionEvidenceV1 } from "@biomed/contracts";

import { parseProviderRevisionEvidenceV1 } from "../src/dataset/contracts/index.js";

const SHA256 = "ab".repeat(32);

function evidence(
  providerRevisionToken: string | null = null,
): ProviderRevisionEvidenceV1 {
  return {
    schema_version: "1.0",
    canonical_accession: "GSE178352",
    provider_snapshot_identity: "geo-series-matrix:GSE178352",
    provider_revision_token: providerRevisionToken,
    source_asset_registration_receipt: {
      schema_version: "1.0",
      receipt_id: "receipt_geo_series_matrix",
      task_id: "task_provider_revision",
      asset_ref: {
        schema_version: "1.0",
        asset_id: `asset_${SHA256}`,
        task_id: "task_provider_revision",
        role: "carrier",
      },
      source_id: "source_geo",
      relative_path: "source_assets/GSE178352_series_matrix.txt.gz",
      sha256: SHA256,
      size_bytes: 1024,
      media_type: "application/gzip",
      registered_at: "2026-08-22T00:00:00Z",
      path_compatibility: {
        schema_version: "1.0",
        mode: "asset_id",
        legacy_path: null,
        telemetry_event: "asset_ref_used",
      },
    },
  };
}

describe("ProviderRevisionEvidenceV1 Core contract", () => {
  test("carries canonical accession, provider snapshot, revision token, and registered bytes", () => {
    const raw = evidence("2026-08-21T18:42:00Z");
    expect(parseProviderRevisionEvidenceV1(raw)).toEqual(raw);
  });

  test("represents an unavailable provider revision token honestly as null", () => {
    const raw = evidence(null);
    expect(parseProviderRevisionEvidenceV1(raw).provider_revision_token).toBeNull();

    const missing = { ...raw } as Partial<ProviderRevisionEvidenceV1>;
    delete missing.provider_revision_token;
    expect(() => parseProviderRevisionEvidenceV1(missing)).toThrow(/missing fields/);
    expect(() => parseProviderRevisionEvidenceV1({
      ...raw,
      provider_revision_token: "",
    })).toThrow(/non-empty/);
  });

  test("is exact-key, bounded, and binds the receipt to its registered asset ref", () => {
    const raw = evidence();
    expect(() => parseProviderRevisionEvidenceV1({
      ...raw,
      build_id: "build_must_not_be_revision_evidence",
    })).toThrow(/unknown/);
    expect(() => parseProviderRevisionEvidenceV1({
      ...raw,
      canonical_accession: "A".repeat(257),
    })).toThrow(/256/);
    expect(() => parseProviderRevisionEvidenceV1({
      ...raw,
      provider_snapshot_identity: "S".repeat(1_025),
    })).toThrow(/1024/);
    expect(() => parseProviderRevisionEvidenceV1({
      ...raw,
      provider_revision_token: "R".repeat(1_025),
    })).toThrow(/1024/);
    expect(() => parseProviderRevisionEvidenceV1({
      ...raw,
      source_asset_registration_receipt: {
        ...raw.source_asset_registration_receipt,
        sha256: "cd".repeat(32),
      },
    })).toThrow(/hash/);
    expect(() => parseProviderRevisionEvidenceV1({
      ...raw,
      source_asset_registration_receipt: {
        ...raw.source_asset_registration_receipt,
        extra: true,
      },
    })).toThrow(/unknown/);
  });

  test("rejects accessors, proxies, symbols, and exotic prototypes without reading them", () => {
    const raw = evidence();
    let reads = 0;
    const accessor = { ...raw } as Record<string, unknown>;
    Object.defineProperty(accessor, "provider_revision_token", {
      enumerable: true,
      get() {
        reads += 1;
        return "build_unsafe_substitution";
      },
    });
    expect(() => parseProviderRevisionEvidenceV1(accessor)).toThrow(/data property/);
    expect(reads).toBe(0);

    const proxy = new Proxy(raw, {
      get() {
        reads += 1;
        return undefined;
      },
    });
    expect(() => parseProviderRevisionEvidenceV1(proxy)).toThrow(/non-Proxy/);
    expect(reads).toBe(0);

    const withSymbol = { ...raw };
    Object.defineProperty(withSymbol, Symbol("hidden"), { value: true, enumerable: true });
    expect(() => parseProviderRevisionEvidenceV1(withSymbol)).toThrow(/unknown/);

    const exotic = Object.assign(Object.create({ inherited: true }) as object, raw);
    expect(() => parseProviderRevisionEvidenceV1(exotic)).toThrow(/prototype/);
  });
});
