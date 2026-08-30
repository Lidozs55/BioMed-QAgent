import { describe, expect, expectTypeOf, it } from "vitest";

import {
  parseDiscoveryQueryRecord,
  parseSourceCoverageReport,
  SOURCE_COVERAGE_REPORT_SCHEMA_VERSION,
  SOURCE_COVERAGE_SCOPE_NOTE,
  SOURCE_COVERAGE_UNIVERSE_SCOPE,
  type DiscoveryQueryRecord,
  type SourceCoverageReport,
} from "../src/index";

const SHA256 = "a".repeat(64);

function validReport(): Record<string, unknown> {
  return {
    schema_version: SOURCE_COVERAGE_REPORT_SCHEMA_VERSION,
    task_id: "task_unit",
    requirement_id: "req_unit",
    universe_scope: SOURCE_COVERAGE_UNIVERSE_SCOPE,
    scope_note: SOURCE_COVERAGE_SCOPE_NOTE,
    query_plan: [
      {
        binding_id: "b1",
        source: "geo",
        mode: "builtin",
        provider_id: "geo.files.v1",
        recipe_ref: null,
        adapter_id: "geo_expression",
        accession: "GSE1",
        parameters: { platform: "GPL1" },
      },
    ],
    acquisition_coverage: [
      {
        binding_id: "b1",
        source: "geo",
        status: "acquired",
        asset: {
          asset_id: `asset_${SHA256}`,
          sha256: SHA256,
          size_bytes: 12,
          media_type: "text/csv",
          registered_at: "2026-08-30T00:00:00.000Z",
        },
        rows: { parsed: 10, canonical_kept: 8, canonical_rejected: 2 },
        exclusion_reasons: ["canonicalization_rejected_rows:2"],
      },
    ],
    discovery_queries: [
      {
        operation_id: "tool:pubmed:query:1",
        source: "pubmed",
        query: "egfr",
        status: "success",
        result_count: 3,
        requested_limit: null,
        retrieved_at: "2026-08-30T00:00:01.000Z",
      },
    ],
    summary: {
      universe_total: 1,
      acquired: 1,
      failed: 0,
      not_attempted: 0,
      integrated_rows: 8,
      discovery_total: 1,
      discovery_failed: 0,
    },
  };
}

function validDiscoveryRecord(): Record<string, unknown> {
  return {
    operation_id: "tool:pubmed:query:1",
    source: "pubmed",
    query: "egfr",
    status: "success",
    result_count: 3,
    requested_limit: null,
    retrieved_at: "2026-08-30T00:00:01.000Z",
  };
}

describe("source coverage wire contracts", () => {
  it("parses a valid report and keeps the DTO shape frozen", () => {
    const report = parseSourceCoverageReport(validReport());
    expect(report.universe_scope).toBe("spec_source_bindings");
    expect(report.query_plan).toHaveLength(1);
    expect(report.acquisition_coverage[0]?.rows).toEqual({
      parsed: 10,
      canonical_kept: 8,
      canonical_rejected: 2,
    });
    expect(report.discovery_queries).toHaveLength(1);
    expectTypeOf<SourceCoverageReport["universe_scope"]>().toEqualTypeOf<"spec_source_bindings">();
    expectTypeOf<DiscoveryQueryRecord["status"]>().toEqualTypeOf<
      "success" | "not_found" | "failed" | "skipped" | "page_fallback"
    >();
  });

  it("accepts null discovery sections and null evidence fields", () => {
    const value = validReport();
    value.discovery_queries = null;
    const entry = (value.acquisition_coverage as Record<string, unknown>[])[0]!;
    entry.asset = null;
    entry.rows = null;
    entry.exclusion_reasons = [];
    entry.status = "not_attempted";
    (value.summary as Record<string, unknown>).discovery_total = 0;
    (value.summary as Record<string, unknown>).acquired = 0;
    (value.summary as Record<string, unknown>).not_attempted = 1;
    (value.summary as Record<string, unknown>).integrated_rows = null;
    const report = parseSourceCoverageReport(value);
    expect(report.discovery_queries).toBeNull();
    expect(report.acquisition_coverage[0]?.asset).toBeNull();
    expect(report.acquisition_coverage[0]?.rows).toBeNull();
    expect(report.summary.discovery_total).toBe(0);
  });

  it("rejects a summary that disagrees with the coverage entries", () => {
    const value = validReport();
    (value.summary as Record<string, unknown>).failed = 1;
    expect(() => parseSourceCoverageReport(value)).toThrow(/does not match the coverage entries/);
  });

  it.each([
    ["missing schema_version", (value: Record<string, unknown>) => delete value.schema_version],
    ["wrong universe_scope", (value: Record<string, unknown>) => { value.universe_scope = "whole_web"; }],
    ["bad status enum", (value: Record<string, unknown>) => {
      (value.acquisition_coverage as Record<string, unknown>[])[0]!.status = "promised";
    }],
    ["non-hex asset sha256", (value: Record<string, unknown>) => {
      ((value.acquisition_coverage as Record<string, unknown>[])[0]!.asset as Record<string, unknown>).sha256 = "zz";
    }],
    ["negative row count", (value: Record<string, unknown>) => {
      (value.summary as Record<string, unknown>).universe_total = -1;
    }],
    ["query_plan not an array", (value: Record<string, unknown>) => { value.query_plan = {}; }],
    ["missing scope_note", (value: Record<string, unknown>) => delete value.scope_note],
  ])("rejects hostile wire: %s", (_name, mutate) => {
    const value = validReport();
    mutate(value);
    expect(() => parseSourceCoverageReport(value)).toThrow();
  });

  it("parses discovery records and rejects hostile ones", () => {
    expect(parseDiscoveryQueryRecord(validDiscoveryRecord()).source).toBe("pubmed");
    expect(() => parseDiscoveryQueryRecord({ ...validDiscoveryRecord(), status: "vibes" })).toThrow();
    expect(() => parseDiscoveryQueryRecord({ ...validDiscoveryRecord(), result_count: -1 })).toThrow();
    expect(() => parseDiscoveryQueryRecord({ ...validDiscoveryRecord(), operation_id: "" })).toThrow();
  });
});
