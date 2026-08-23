import { describe, expect, it } from "vitest";

import { parseBuildDetail } from "@/lib/apiResponseParsers";

const artifact = {
  artifact_id: "artifact_expression",
  role: "primary_dataset",
  relative_path: "tables/expression.csv",
  media_type: "text/csv",
  size_bytes: 42,
  sha256: "a".repeat(64),
} as const;

function v2Manifest() {
  return {
    schema_version: "2.0",
    manifest_id: "manifest_topology",
    task_id: "task_topology",
    build_id: "build_topology",
    dataset_family: "gene_expression",
    row_granularity: "measurement_by_sample",
    schema_ref: "schema.expression.v2",
    primary_key: ["dataset_revision_id", "sample_id", "feature_id"],
    row_count: 42,
    sha256: "b".repeat(64),
    artifacts: [artifact],
    source_summary: { asset_source: { asset_id: "asset_source" } },
    validation_summary: { status: "passed" },
    confidence_summary: {},
    provenance_summary: { coverage: { coverage_ratio: 1 } },
    tables: [
      {
        table_id: "expression",
        schema_ref: "schema.expression.v2",
        role: "primary",
        required: true,
        allow_empty: false,
        primary_key: ["dataset_revision_id", "sample_id", "feature_id"],
        field_names: ["dataset_revision_id", "sample_id", "feature_id", "value"],
      },
      {
        table_id: "samples",
        schema_ref: "schema.samples.v2",
        role: "supporting",
        required: true,
        allow_empty: false,
        primary_key: ["dataset_revision_id", "sample_id"],
        field_names: ["dataset_revision_id", "sample_id", "condition"],
      },
    ],
    relations: [
      {
        relation_id: "expression_samples",
        from_table_id: "expression",
        from_fields: ["dataset_revision_id", "sample_id"],
        to_table_id: "samples",
        to_fields: ["dataset_revision_id", "sample_id"],
        cardinality: "many_to_one",
        missing_policy: "reject",
      },
    ],
    candidate_refs: [
      {
        candidate_id: "candidate_topology",
        table_ids: ["expression", "samples"],
        relation_ids: ["expression_samples"],
        provenance_refs: ["result_provenance"],
        confidence_refs: ["result_confidence"],
        audit_refs: [],
      },
    ],
  };
}

function detail(manifest = v2Manifest()) {
  return {
    build_id: "build_topology",
    task_id: "task_topology",
    manifest_ref: "datasets_build/build_topology/dataset_manifest.json",
    build_result: null,
    manifest,
    publication: null,
    artifacts: manifest.artifacts,
  };
}

describe("V2 build manifest parsing", () => {
  it("preserves tables, relations, and candidate refs", () => {
    const parsed = parseBuildDetail(detail());
    expect(parsed.manifest.schema_version).toBe("2.0");
    if (parsed.manifest.schema_version !== "2.0") throw new Error("expected V2");
    expect(parsed.manifest.tables.map((table) => table.table_id)).toEqual(["expression", "samples"]);
    expect(parsed.manifest.relations[0]?.cardinality).toBe("many_to_one");
    expect(parsed.manifest.candidate_refs[0]?.candidate_id).toBe("candidate_topology");
  });

  it.each([
    { relations: [{ ...v2Manifest().relations[0], to_table_id: "missing" }] },
    { relations: [{ ...v2Manifest().relations[0], from_fields: ["missing_field"] }] },
    { relations: [{ ...v2Manifest().relations[0], to_fields: ["dataset_revision_id"] }] },
    { candidate_refs: [{ ...v2Manifest().candidate_refs[0], relation_ids: ["missing_relation"] }] },
  ])("rejects malformed topology references", (override) => {
    expect(() => parseBuildDetail(detail({ ...v2Manifest(), ...override }))).toThrow();
  });
});
