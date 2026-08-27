import { describe, expect, it } from "vitest";

import { parsePublicationDetail } from "@/lib/apiResponseParsers";

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
    requirement_id: "build_topology",
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

function v1Manifest() {
  const manifest = v2Manifest();
  return {
    manifest_id: manifest.manifest_id,
    task_id: manifest.task_id,
    requirement_id: manifest.requirement_id,
    dataset_family: manifest.dataset_family,
    row_granularity: manifest.row_granularity,
    schema_ref: manifest.schema_ref,
    primary_key: manifest.primary_key,
    row_count: manifest.row_count,
    sha256: manifest.sha256,
    artifacts: manifest.artifacts,
    source_summary: manifest.source_summary,
    validation_summary: manifest.validation_summary,
    confidence_summary: manifest.confidence_summary,
    provenance_summary: manifest.provenance_summary,
  };
}

function detail(manifest: Record<string, unknown> = v2Manifest()) {
  return {
    publication_id: "publication_topology",
    requirement_id: "build_topology",
    run_id: "run_topology",
    task_id: "task_topology",
    manifest_ref: "dataset_runs/run_topology/build_topology/publish/publication_topology/dataset_manifest.json",
    manifest,
    publication: {
      schema_version: "1.1",
      publication_id: "publication_topology",
      manifest_ref: "dataset_manifest.json",
      manifest_sha256: "c".repeat(64),
      validation_result_ref: "validation_result.json",
      published_at: "2026-08-27T00:00:00.000Z",
      supersedes_publication_id: null,
    },
    artifacts: manifest.artifacts,
  };
}

describe("V2 publication manifest parsing", () => {
  it("preserves tables, relations, and candidate refs", () => {
    const parsed = parsePublicationDetail(detail());
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
    expect(() => parsePublicationDetail(detail({ ...v2Manifest(), ...override }))).toThrow();
  });

  it.each([
    ["empty tables", () => ({ tables: [], relations: [], candidate_refs: [] })],
    ["no primary table", () => {
      const manifest = v2Manifest();
      for (const table of manifest.tables) table.role = "supporting";
      return { tables: manifest.tables };
    }],
    ["empty candidate refs", () => ({ candidate_refs: [] })],
  ])("rejects V2 structural invariant violation: %s", (_name, override) => {
    expect(() => parsePublicationDetail(detail({ ...v2Manifest(), ...override() }))).toThrow();
  });

  it("keeps the legacy V1 manifest shape unchanged", () => {
    const parsed = parsePublicationDetail(detail(v1Manifest()));
    expect(parsed.manifest.schema_version).toBeUndefined();
    expect(parsed.manifest).toEqual(v1Manifest());
    expect("tables" in parsed.manifest).toBe(false);
  });

  it.each([
    ["table", () => {
      const manifest = v2Manifest();
      manifest.tables.push({ ...manifest.tables[0] });
      return { tables: manifest.tables };
    }],
    ["relation", () => {
      const manifest = v2Manifest();
      manifest.relations.push({ ...manifest.relations[0] });
      return { relations: manifest.relations };
    }],
    ["candidate", () => {
      const manifest = v2Manifest();
      manifest.candidate_refs.push({ ...manifest.candidate_refs[0] });
      return { candidate_refs: manifest.candidate_refs };
    }],
  ])("rejects duplicate %s IDs", (_name, override) => {
    expect(() => parsePublicationDetail(detail({ ...v2Manifest(), ...override() }))).toThrow();
  });

  it.each([
    ["table role", () => {
      const manifest = v2Manifest();
      manifest.tables[0].role = "invalid";
      return { tables: manifest.tables };
    }],
    ["relation cardinality", () => {
      const manifest = v2Manifest();
      manifest.relations[0].cardinality = "invalid";
      return { relations: manifest.relations };
    }],
    ["relation missing policy", () => {
      const manifest = v2Manifest();
      manifest.relations[0].missing_policy = "invalid";
      return { relations: manifest.relations };
    }],
  ])("rejects invalid %s", (_name, override) => {
    expect(() => parsePublicationDetail(detail({ ...v2Manifest(), ...override() }))).toThrow();
  });
});
