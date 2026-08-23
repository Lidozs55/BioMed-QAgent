import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { DatasetManifestV2, TableDefinition } from "@biomed/contracts";

import { FamilyTopologyExplorer } from "@/components/family-host/relations/FamilyTopologyExplorer";
import { nodePoint, relationPath } from "@/components/family-host/relations/TopologyMap";
import { buildTopologyModel } from "@/components/family-host/relations/topology-model";
import { restoreTopologyFocus } from "@/components/family-host/relations/topology-focus";

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
  it("restores focus to a connected topology trigger", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    const other = document.createElement("button");
    document.body.append(other);
    other.focus();

    restoreTopologyFocus(trigger);

    expect(document.activeElement).toBe(trigger);
  });

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
    expect(screen.getByText("Manifest 产物")).toBeVisible();
    expect(screen.getByText("candidate_topology")).toBeVisible();
    expect(screen.getByText("artifact_expression")).toBeVisible();
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
    expect(screen.getByRole("button", { name: /samples.*支撑表/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /sources.*支撑表/ })).toBeVisible();
  });

  it("keeps the map keyboard-ready without a blocking inspector overlay", () => {
    render(<FamilyTopologyExplorer manifest={manifest()} publication={null} />);

    const tableButton = screen.getByRole("button", { name: /expression.*主表/ });
    const relationButton = screen.getByRole("button", { name: /expression_samples/ });
    expect(tableButton.tagName).toBe("BUTTON");
    expect(tableButton).toHaveClass("focus-visible:ring-3");
    expect(relationButton.tagName).toBe("BUTTON");
    expect(relationButton).toHaveClass("focus-visible:ring-3");

    const svg = document.querySelector('svg[aria-hidden="true"]');
    expect(svg).toBeInTheDocument();
    expect(svg?.querySelectorAll("[data-relation-id]")).toHaveLength(3);

    fireEvent.click(relationButton);
    expect(screen.getByRole("dialog", { name: "关系详情" })).toBeVisible();
    expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeInTheDocument();
    expect(document.querySelector('svg[aria-hidden="true"]')?.querySelectorAll("[data-relation-id]")).toHaveLength(3);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "关系详情" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expression.*主表/ })).toHaveAttribute("aria-pressed", "false");
  });

  it("returns focus to the latest triggering node or relation button after Escape closes the inspector", async () => {
    render(<FamilyTopologyExplorer manifest={manifest()} publication={null} />);

    const tableButton = screen.getByRole("button", { name: /expression.*主表/ });
    const relationButton = screen.getByRole("button", { name: /查看关系 expression_samples/ });
    tableButton.focus();
    expect(document.activeElement).toBe(tableButton);

    fireEvent.click(tableButton);
    expect(screen.getByRole("dialog", { name: "表详情" })).toBeVisible();
    relationButton.focus();
    fireEvent.click(relationButton);
    expect(screen.getByRole("dialog", { name: "关系详情" })).toBeVisible();
    const closeButton = screen.getByRole("button", { name: "Close" });
    closeButton.focus();
    expect(document.activeElement).toBe(closeButton);
    fireEvent.keyDown(closeButton, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "关系详情" })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(relationButton));
  });

  it("returns focus to a table trigger when switching from relation details before Escape", async () => {
    render(<FamilyTopologyExplorer manifest={manifest()} publication={null} />);

    const relationButton = screen.getByRole("button", { name: /查看关系 expression_samples/ });
    const tableButton = screen.getByRole("button", { name: /expression.*主表/ });
    relationButton.focus();
    expect(document.activeElement).toBe(relationButton);

    fireEvent.click(relationButton);
    expect(screen.getByRole("dialog", { name: "关系详情" })).toBeVisible();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" })));
    fireEvent.pointerDown(tableButton);
    tableButton.focus();
    fireEvent.click(tableButton);
    expect(screen.getByRole("dialog", { name: "表详情" })).toBeVisible();
    const closeButton = screen.getByRole("button", { name: "Close" });
    closeButton.focus();
    closeButton.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "表详情" })).not.toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 1400));
    await waitFor(() => expect(document.activeElement).toBe(tableButton));
  });

  it("renders one source and target field pair per relation row", () => {
    render(<FamilyTopologyExplorer manifest={manifest()} publication={null} />);

    fireEvent.click(screen.getByRole("button", { name: /expression_samples/ }));
    const pairTable = screen.getByRole("table", { name: "expression_samples 字段配对" });
    const rows = within(pairTable).getAllByRole("row");
    expect(rows).toHaveLength(3);

    const firstPairCells = within(rows[1]!).getAllByRole("cell");
    expect(firstPairCells[0]).toHaveTextContent("expression");
    expect(firstPairCells[0]).toHaveTextContent("dataset_revision_id");
    expect(firstPairCells[0]).not.toHaveTextContent("sample_id");
    expect(firstPairCells[1]).toHaveTextContent("samples");
    expect(firstPairCells[1]).toHaveTextContent("dataset_revision_id");
    expect(firstPairCells[1]).not.toHaveTextContent("sample_id");
    expect(within(rows[1]!).queryByText("dataset_revision_id + sample_id", { exact: true })).not.toBeInTheDocument();

    const secondPairCells = within(rows[2]!).getAllByRole("cell");
    expect(secondPairCells[0]).toHaveTextContent("sample_id");
    expect(secondPairCells[1]).toHaveTextContent("sample_id");
    expect(within(rows[2]!).queryByText("dataset_revision_id + sample_id", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByText("dataset_revision_id + sample_id", { exact: true })).toBeVisible();
  });

  it("keeps exported topology geometry deterministic", () => {
    const model = buildTopologyModel(manifest());
    expect(nodePoint(model, "expression")).toEqual({ x: 24, y: 48 });
    expect(nodePoint(model, "samples")).toEqual({ x: 324, y: 48 });
    expect(nodePoint(model, "sources")).toEqual({ x: 324, y: 192 });
    expect(nodePoint(model, "quality")).toEqual({ x: 624, y: 48 });

    const relation = model.relationsById.get("expression_samples");
    if (relation === undefined) throw new Error("expected expression_samples relation");
    expect(relationPath(model, relation)).toMatch(/^M 144 104 C /);
    expect(relationPath(model, relation)).toMatch(/ 444 104$/);
  });
});
