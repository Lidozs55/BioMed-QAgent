import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type {
  DatasetManifestV2,
  RelationDefinition,
  TableDefinition,
} from "@biomed/contracts";

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

interface PathPoint {
  readonly x: number;
  readonly y: number;
}

function samplePath(path: string): readonly PathPoint[] {
  const tokens = path.match(/[MLC]|-?\d+(?:\.\d+)?/g);
  if (tokens === null) throw new Error(`empty path '${path}'`);

  let index = 0;
  let current: PathPoint | undefined;
  const points: PathPoint[] = [];
  const readNumber = (): number => {
    const token = tokens[index];
    index += 1;
    if (token === undefined || token === "M" || token === "L" || token === "C") {
      throw new Error(`missing path coordinate in '${path}'`);
    }
    return Number(token);
  };

  while (index < tokens.length) {
    const command = tokens[index];
    index += 1;
    if (command === "M") {
      current = { x: readNumber(), y: readNumber() };
      points.push(current);
      continue;
    }
    if (current === undefined) throw new Error(`path '${path}' does not start with M`);

    if (command === "L") {
      const end = { x: readNumber(), y: readNumber() };
      const start = current;
      for (let step = 1; step <= 24; step += 1) {
        const ratio = step / 24;
        points.push({
          x: start.x + (end.x - start.x) * ratio,
          y: start.y + (end.y - start.y) * ratio,
        });
      }
      current = end;
      continue;
    }

    if (command === "C") {
      const firstControl = { x: readNumber(), y: readNumber() };
      const secondControl = { x: readNumber(), y: readNumber() };
      const end = { x: readNumber(), y: readNumber() };
      const start = current;
      for (let step = 1; step <= 96; step += 1) {
        const ratio = step / 96;
        const inverse = 1 - ratio;
        points.push({
          x:
            inverse ** 3 * start.x
            + 3 * inverse ** 2 * ratio * firstControl.x
            + 3 * inverse * ratio ** 2 * secondControl.x
            + ratio ** 3 * end.x,
          y:
            inverse ** 3 * start.y
            + 3 * inverse ** 2 * ratio * firstControl.y
            + 3 * inverse * ratio ** 2 * secondControl.y
            + ratio ** 3 * end.y,
        });
      }
      current = end;
      continue;
    }

    throw new Error(`unsupported path command '${command}' in '${path}'`);
  }

  return points;
}

function cardBounds(model: ReturnType<typeof buildTopologyModel>, tableId: string) {
  const point = nodePoint(model, tableId);
  return {
    left: point.x,
    right: point.x + 240,
    top: point.y,
    bottom: point.y + 112,
  };
}

function isOnCardBoundary(point: PathPoint, bounds: ReturnType<typeof cardBounds>): boolean {
  const withinX = point.x >= bounds.left && point.x <= bounds.right;
  const withinY = point.y >= bounds.top && point.y <= bounds.bottom;
  return (
    (withinY && (point.x === bounds.left || point.x === bounds.right))
    || (withinX && (point.y === bounds.top || point.y === bounds.bottom))
  );
}

function isInsideCard(point: PathPoint, bounds: ReturnType<typeof cardBounds>): boolean {
  return (
    point.x > bounds.left
    && point.x < bounds.right
    && point.y > bounds.top
    && point.y < bounds.bottom
  );
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

  it("keeps forward, reverse, vertical, diagonal, cross-lane, and self paths outside every card", () => {
    const lastSupportingTable: TableDefinition = {
      table_id: "z_audits",
      schema_ref: "schema.audits.v2",
      role: "supporting",
      required: false,
      allow_empty: true,
      primary_key: ["sample_id"],
      field_names: ["sample_id", "audit_status"],
    };
    const laterDerivedTables: TableDefinition[] = [
      {
        table_id: "y_quality",
        schema_ref: "schema.quality.v2",
        role: "derived",
        required: false,
        allow_empty: true,
        primary_key: ["sample_id"],
        field_names: ["sample_id", "quality_score"],
      },
      {
        table_id: "z_quality",
        schema_ref: "schema.quality.v2",
        role: "derived",
        required: false,
        allow_empty: true,
        primary_key: ["sample_id"],
        field_names: ["sample_id", "quality_score"],
      },
    ];
    const geometryTables = [...tables, lastSupportingTable, ...laterDerivedTables];
    const geometryRelations: RelationDefinition[] = [
      {
        relation_id: "forward_horizontal",
        from_table_id: "expression",
        from_fields: ["sample_id"],
        to_table_id: "samples",
        to_fields: ["sample_id"],
        cardinality: "many_to_one",
        missing_policy: "reject",
      },
      {
        relation_id: "reverse_horizontal",
        from_table_id: "samples",
        from_fields: ["sample_id"],
        to_table_id: "expression",
        to_fields: ["sample_id"],
        cardinality: "one_to_many",
        missing_policy: "reject",
      },
      {
        relation_id: "forward_vertical",
        from_table_id: "samples",
        from_fields: ["source_id"],
        to_table_id: "sources",
        to_fields: ["source_id"],
        cardinality: "many_to_one",
        missing_policy: "reject",
      },
      {
        relation_id: "reverse_vertical",
        from_table_id: "sources",
        from_fields: ["source_id"],
        to_table_id: "samples",
        to_fields: ["source_id"],
        cardinality: "one_to_many",
        missing_policy: "reject",
      },
      {
        relation_id: "skip_middle_vertical",
        from_table_id: "samples",
        from_fields: ["sample_id"],
        to_table_id: "z_audits",
        to_fields: ["sample_id"],
        cardinality: "one_to_many",
        missing_policy: "allow_missing",
      },
      {
        relation_id: "forward_diagonal",
        from_table_id: "expression",
        from_fields: ["sample_id"],
        to_table_id: "sources",
        to_fields: ["source_id"],
        cardinality: "many_to_one",
        missing_policy: "allow_missing",
      },
      {
        relation_id: "reverse_diagonal",
        from_table_id: "sources",
        from_fields: ["source_id"],
        to_table_id: "expression",
        to_fields: ["sample_id"],
        cardinality: "one_to_many",
        missing_policy: "allow_missing",
      },
      {
        relation_id: "cross_middle_lane",
        from_table_id: "expression",
        from_fields: ["sample_id"],
        to_table_id: "quality",
        to_fields: ["sample_id"],
        cardinality: "one_to_one",
        missing_policy: "allow_empty",
      },
      {
        relation_id: "cross_rows_and_lanes",
        from_table_id: "expression",
        from_fields: ["sample_id"],
        to_table_id: "z_quality",
        to_fields: ["sample_id"],
        cardinality: "one_to_many",
        missing_policy: "allow_missing",
      },
      {
        relation_id: "left_self",
        from_table_id: "expression",
        from_fields: ["sample_id"],
        to_table_id: "expression",
        to_fields: ["sample_id"],
        cardinality: "one_to_one",
        missing_policy: "reject",
      },
      {
        relation_id: "right_self",
        from_table_id: "quality",
        from_fields: ["sample_id"],
        to_table_id: "quality",
        to_fields: ["sample_id"],
        cardinality: "one_to_one",
        missing_policy: "allow_empty",
      },
    ];
    const model = buildTopologyModel(manifest({ tables: geometryTables, relations: geometryRelations }));

    expect(nodePoint(model, "expression")).toEqual({ x: 24, y: 48 });
    expect(nodePoint(model, "samples")).toEqual({ x: 324, y: 48 });
    expect(nodePoint(model, "sources")).toEqual({ x: 324, y: 192 });
    expect(nodePoint(model, "z_audits")).toEqual({ x: 324, y: 336 });
    expect(nodePoint(model, "quality")).toEqual({ x: 624, y: 48 });
    expect(nodePoint(model, "z_quality")).toEqual({ x: 624, y: 336 });

    for (const relation of model.relations) {
      const path = relationPath(model, relation);
      const samples = samplePath(path);
      const first = samples[0];
      const last = samples[samples.length - 1];
      expect(path).not.toMatch(/NaN|Infinity/);
      expect(first).toBeDefined();
      expect(last).toBeDefined();
      expect(
        isOnCardBoundary(first!, cardBounds(model, relation.from_table_id)),
        `${relation.relation_id} must start on its source card boundary`,
      ).toBe(true);
      expect(
        isOnCardBoundary(last!, cardBounds(model, relation.to_table_id)),
        `${relation.relation_id} must end on its target card boundary`,
      ).toBe(true);

      for (const table of geometryTables) {
        const interiorSamples = samples.filter((point) =>
          isInsideCard(point, cardBounds(model, table.table_id)),
        );
        expect(
          interiorSamples,
          `${relation.relation_id} must not enter ${table.table_id}`,
        ).toEqual([]);
      }
    }
  });

  it("uses deterministic separated routes for multiple relations with the same endpoints", () => {
    const parallelRelations: RelationDefinition[] = [
      {
        relation_id: "parallel_a",
        from_table_id: "expression",
        from_fields: ["sample_id"],
        to_table_id: "samples",
        to_fields: ["sample_id"],
        cardinality: "many_to_one",
        missing_policy: "reject",
      },
      {
        relation_id: "parallel_b",
        from_table_id: "samples",
        from_fields: ["sample_id"],
        to_table_id: "expression",
        to_fields: ["sample_id"],
        cardinality: "one_to_many",
        missing_policy: "allow_missing",
      },
      {
        relation_id: "parallel_c",
        from_table_id: "expression",
        from_fields: ["dataset_revision_id"],
        to_table_id: "samples",
        to_fields: ["dataset_revision_id"],
        cardinality: "one_to_one",
        missing_policy: "allow_empty",
      },
      {
        relation_id: "parallel_d",
        from_table_id: "samples",
        from_fields: ["dataset_revision_id"],
        to_table_id: "expression",
        to_fields: ["dataset_revision_id"],
        cardinality: "many_to_many",
        missing_policy: "profile_defined",
      },
      {
        relation_id: "wide_parallel_a",
        from_table_id: "expression",
        from_fields: ["dataset_revision_id"],
        to_table_id: "quality",
        to_fields: ["dataset_revision_id"],
        cardinality: "one_to_one",
        missing_policy: "reject",
      },
      {
        relation_id: "wide_parallel_b",
        from_table_id: "quality",
        from_fields: ["dataset_revision_id"],
        to_table_id: "expression",
        to_fields: ["dataset_revision_id"],
        cardinality: "one_to_one",
        missing_policy: "allow_empty",
      },
      ...["a", "b", "c", "d"].map((suffix): RelationDefinition => ({
        relation_id: `self_parallel_${suffix}`,
        from_table_id: "samples",
        from_fields: ["sample_id"],
        to_table_id: "samples",
        to_fields: ["sample_id"],
        cardinality: "one_to_one",
        missing_policy: "allow_empty",
      })),
    ];
    const model = buildTopologyModel(manifest({ relations: parallelRelations }));
    const paths = model.relations.map((relation) => relationPath(model, relation));

    expect(new Set(paths)).toHaveLength(parallelRelations.length);
    expect(model.relations.map((relation) => relationPath(model, relation))).toEqual(paths);
  });

  it("shows deterministic edge markers and complete presentational labels for every relation", () => {
    render(<FamilyTopologyExplorer manifest={manifest()} publication={null} />);

    const svg = document.querySelector('svg[aria-hidden="true"]');
    const markers = [...(svg?.querySelectorAll("[data-relation-marker]") ?? [])];
    expect(markers.map((marker) => marker.textContent)).toEqual(["R1", "R2", "R3"]);
    for (const marker of markers) {
      expect(marker.getAttribute("x") ?? "").not.toMatch(/NaN|Infinity/);
      expect(marker.getAttribute("y") ?? "").not.toMatch(/NaN|Infinity/);
    }

    const legend = screen.getByTestId("topology-relation-legend");
    const labels = [...legend.querySelectorAll("[data-relation-label]")];
    expect(labels.map((label) => label.getAttribute("data-relation-label"))).toEqual([
      "expression_quality",
      "expression_samples",
      "samples_sources",
    ]);
    expect(labels.map((label) => label.getAttribute("data-cardinality"))).toEqual([
      "one_to_one",
      "many_to_one",
      "many_to_one",
    ]);
    expect(labels.map((label) => label.getAttribute("data-missing-policy"))).toEqual([
      "allow_empty",
      "reject",
      "reject",
    ]);
    expect(labels[0]).toHaveTextContent("expression_quality");
    expect(labels[0]).toHaveTextContent("1:1");
    expect(labels[0]).toHaveTextContent("允许空表");
  });
});
