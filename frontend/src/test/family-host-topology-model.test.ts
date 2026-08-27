import { describe, expect, it } from "vitest";

import type {
  DatasetManifestV2,
  RelationDefinition,
  TableDefinition,
} from "@biomed/contracts";

import {
  buildTopologyModel,
  isRelationConnected,
  relationsForTable,
} from "@/components/family-host/relations/topology-model";
import type { TopologySelection } from "@/components/family-host/relations/topology-model";

const tables: TableDefinition[] = [
  {
    table_id: "quality",
    schema_ref: "schema.quality.v2",
    role: "derived",
    required: false,
    allow_empty: true,
    primary_key: ["dataset_revision_id", "sample_id"],
    field_names: ["dataset_revision_id", "sample_id", "quality_score"],
  },
  {
    table_id: "sources",
    schema_ref: "schema.sources.v2",
    role: "supporting",
    required: true,
    allow_empty: false,
    primary_key: ["source_id"],
    field_names: ["source_id", "source_name"],
  },
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
];

const relations: RelationDefinition[] = [
  {
    relation_id: "expression_quality",
    from_table_id: "expression",
    from_fields: ["dataset_revision_id", "sample_id"],
    to_table_id: "quality",
    to_fields: ["dataset_revision_id", "sample_id"],
    cardinality: "one_to_one",
    missing_policy: "allow_empty",
  },
  {
    relation_id: "samples_sources",
    from_table_id: "samples",
    from_fields: ["source_id"],
    to_table_id: "sources",
    to_fields: ["source_id"],
    cardinality: "many_to_one",
    missing_policy: "reject",
  },
  {
    relation_id: "expression_samples",
    from_table_id: "expression",
    from_fields: ["dataset_revision_id", "sample_id"],
    to_table_id: "samples",
    to_fields: ["dataset_revision_id", "sample_id"],
    cardinality: "many_to_one",
    missing_policy: "reject",
  },
];

const manifest: DatasetManifestV2 = {
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
  artifacts: [
    {
      artifact_id: "artifact_expression",
      role: "primary_dataset",
      relative_path: "tables/expression.csv",
      media_type: "text/csv",
      size_bytes: 42,
      sha256: "a".repeat(64),
    },
  ],
  source_summary: { asset_source: { asset_id: "asset_source" } },
  validation_summary: { status: "passed" },
  confidence_summary: {},
  provenance_summary: { coverage: { coverage_ratio: 1 } },
  tables,
  relations,
  candidate_refs: [
    {
      candidate_id: "candidate_topology",
      table_ids: ["expression", "samples", "sources", "quality"],
      relation_ids: ["expression_samples", "expression_quality", "samples_sources"],
      provenance_refs: ["result_provenance"],
      confidence_refs: ["result_confidence"],
      audit_refs: [],
    },
  ],
};

describe("family host topology model", () => {
  it("projects authoritative roles into deterministic lanes and counts", () => {
    const model = buildTopologyModel(manifest);

    expect(model.lanes.map((lane) => lane.role)).toEqual(["primary", "supporting", "derived"]);
    expect(model.lanes[0]?.tables.map((table) => table.table_id)).toEqual(["expression"]);
    expect(model.lanes[1]?.tables.map((table) => table.table_id)).toEqual(["samples", "sources"]);
    expect(model.lanes[2]?.tables.map((table) => table.table_id)).toEqual(["quality"]);
    expect(model.summary).toEqual({ tables: 4, relations: 3, primary: 1, supporting: 2, derived: 1 });
  });

  it("sorts table and relation indexes without changing manifest input", () => {
    const model = buildTopologyModel(manifest);

    expect(model.relations.map((relation) => relation.relation_id)).toEqual([
      "expression_quality",
      "expression_samples",
      "samples_sources",
    ]);
    expect([...model.tablesById.keys()]).toEqual(["expression", "quality", "samples", "sources"]);
    expect([...model.relationsById.keys()]).toEqual([
      "expression_quality",
      "expression_samples",
      "samples_sources",
    ]);
    expect(manifest.tables.map((table) => table.table_id)).toEqual([
      "quality",
      "sources",
      "expression",
      "samples",
    ]);
    expect(manifest.relations.map((relation) => relation.relation_id)).toEqual([
      "expression_quality",
      "samples_sources",
      "expression_samples",
    ]);
  });

  it("finds endpoint relations and marks connected selections", () => {
    const model = buildTopologyModel(manifest);
    const expressionSamples = model.relationsById.get("expression_samples");
    const samplesSources = model.relationsById.get("samples_sources");

    if (expressionSamples === undefined || samplesSources === undefined) {
      throw new Error("expected fixture relations");
    }

    expect(relationsForTable(model, "expression").map((relation) => relation.relation_id)).toEqual([
      "expression_samples",
      "expression_quality",
    ]);
    expect(relationsForTable(model, "sources").map((relation) => relation.relation_id)).toEqual([
      "samples_sources",
    ]);
    expect(relationsForTable(model, "missing")).toEqual([]);

    const tableSelection: TopologySelection = { kind: "table", id: "expression" };
    const relationSelection: TopologySelection = { kind: "relation", id: "expression_samples" };
    expect(isRelationConnected(tableSelection, expressionSamples)).toBe(true);
    expect(isRelationConnected(tableSelection, samplesSources)).toBe(false);
    expect(isRelationConnected(relationSelection, expressionSamples)).toBe(true);
    expect(isRelationConnected(relationSelection, samplesSources)).toBe(false);
    expect(isRelationConnected(null, expressionSamples)).toBe(false);
  });

  it("keeps candidate and artifact evidence at manifest scope", () => {
    const model = buildTopologyModel(manifest);

    expect(model.evidence.candidates).toEqual(manifest.candidate_refs);
    expect(model.evidence.candidates[0]?.provenance_refs).toEqual(["result_provenance"]);
    expect(model.evidence.artifacts).toEqual(manifest.artifacts);
  });
});
