import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DatasetManifestV2, TableDefinition } from "@biomed/contracts";

import { FamilyTopologyExplorer } from "@/components/family-host/relations/FamilyTopologyExplorer";

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

const artifact = {
  artifact_id: "artifact_expression",
  role: "primary_dataset" as const,
  relative_path: "tables/expression.csv",
  media_type: "text/csv",
  size_bytes: 42,
  sha256: "a".repeat(64),
};

function manifest(overrides: Partial<DatasetManifestV2> = {}): DatasetManifestV2 {
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
    tables,
    relations: [
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
    ],
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
    ...overrides,
  };
}

describe("FamilyTopologyExplorer", () => {
  it("opens relation and table details from the topology map", () => {
    render(<FamilyTopologyExplorer manifest={manifest()} publication={null} />);

    expect(screen.getByText("4 张表")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expression.*主表/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /quality.*派生表/ })).toBeVisible();
    expect(screen.getByRole("table", { name: "表关系" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /expression_samples/ }));
    expect(screen.getByRole("dialog", { name: "关系详情" })).toBeVisible();
    expect(screen.getByText("dataset_revision_id + sample_id")).toBeVisible();
    expect(screen.getByText("多对一")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /expression.*主表/ }));
    expect(screen.getByRole("dialog", { name: "表详情" })).toBeVisible();
    expect(screen.getByText("schema.expression.v2")).toBeVisible();
    expect(screen.getByText("候选级证据")).toBeVisible();
  });

  it("keeps table nodes visible and explains when no relations are declared", () => {
    render(
      <FamilyTopologyExplorer
        manifest={manifest({
          relations: [],
          candidate_refs: [
            {
              candidate_id: "candidate_topology",
              table_ids: tables.map((table) => table.table_id),
              relation_ids: [],
              provenance_refs: [],
              confidence_refs: [],
              audit_refs: [],
            },
          ],
        })}
        publication={null}
      />,
    );

    expect(screen.getByText("此构建没有声明表关系")).toBeVisible();
    expect(screen.getByRole("button", { name: /expression.*主表/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /quality.*派生表/ })).toBeVisible();
  });
});
