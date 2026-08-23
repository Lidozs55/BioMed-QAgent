/* eslint-disable react-refresh/only-export-components */
import type { RelationDefinition, TableDefinition, TableRole } from "@biomed/contracts";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import {
  isRelationConnected,
  relationsForTable,
  type TopologyModel,
  type TopologySelection,
} from "./topology-model";

export const CANVAS_WIDTH = 888;
export const LANE_X = { primary: 24, supporting: 324, derived: 624 } as const;
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 112;
export const ROW_HEIGHT = 144;

export const ROLE_LABELS: Record<TableRole, string> = {
  primary: "主表",
  supporting: "支撑表",
  derived: "派生表",
};

const ROLE_BADGE_VARIANTS: Record<TableRole, "default" | "secondary" | "outline"> = {
  primary: "default",
  supporting: "outline",
  derived: "secondary",
};

const CARDINALITY_LABELS: Record<RelationDefinition["cardinality"], string> = {
  one_to_one: "1:1",
  one_to_many: "1:N",
  many_to_one: "N:1",
  many_to_many: "N:N",
};

const MISSING_POLICY_LABELS: Record<RelationDefinition["missing_policy"], string> = {
  reject: "拒绝缺失",
  allow_empty: "允许空表",
  allow_missing: "允许缺失",
  profile_defined: "按配置文件",
};

export interface TopologyMapProps {
  readonly model: TopologyModel;
  readonly selection: TopologySelection;
  readonly onSelect: (selection: TopologySelection, trigger: HTMLElement) => void;
}

export function nodePoint(model: TopologyModel, tableId: string) {
  const lane = model.lanes.find((entry) => entry.tables.some((table) => table.table_id === tableId));
  if (lane === undefined) throw new Error(`Unknown topology table '${tableId}'`);
  const index = lane.tables.findIndex((table) => table.table_id === tableId);
  return { x: LANE_X[lane.role], y: 48 + index * ROW_HEIGHT };
}

function nodeCenter(model: TopologyModel, tableId: string) {
  const point = nodePoint(model, tableId);
  return { x: point.x + NODE_WIDTH / 2, y: point.y + NODE_HEIGHT / 2 };
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface RelationLayout {
  readonly path: string;
  readonly label: Point;
}

function nodeBoundaryPoint(from: Point, toward: Point): Point {
  const deltaX = toward.x - from.x;
  const deltaY = toward.y - from.y;
  const boundaryScale = 1 / Math.max(
    Math.abs(deltaX) / (NODE_WIDTH / 2),
    Math.abs(deltaY) / (NODE_HEIGHT / 2),
  );
  return {
    x: from.x + deltaX * boundaryScale,
    y: from.y + deltaY * boundaryScale,
  };
}

function parallelRelationIndex(model: TopologyModel, relation: RelationDefinition): number {
  const endpoints = [relation.from_table_id, relation.to_table_id].sort().join("\u0000");
  return model.relations
    .filter((candidate) =>
      [candidate.from_table_id, candidate.to_table_id].sort().join("\u0000") === endpoints,
    )
    .findIndex((candidate) => candidate.relation_id === relation.relation_id);
}

function detourClearance(rankOnSide: number): number {
  return 8 + (16 * (rankOnSide + 1)) / (rankOnSide + 2);
}

function selfRelationLayout(center: Point, parallelIndex: number): RelationLayout {
  const direction = center.x <= CANVAS_WIDTH / 2 ? 1 : -1;
  const from = { x: center.x + (NODE_WIDTH / 2) * direction, y: center.y };
  const to = { x: center.x, y: center.y + NODE_HEIGHT / 2 };
  const clearance = 12 + detourClearance(parallelIndex);
  const outsideX = from.x + clearance * direction;
  const outsideY = to.y + clearance;
  return {
    path: `M ${from.x} ${from.y} L ${outsideX} ${from.y} L ${outsideX} ${outsideY} L ${to.x} ${outsideY} L ${to.x} ${to.y}`,
    label: { x: outsideX, y: from.y },
  };
}

function directRelationLayout(from: Point, to: Point): RelationLayout {
  const horizontalDistance = Math.max(48, Math.abs(to.x - from.x) * 0.45);
  const direction = to.x >= from.x ? 1 : -1;
  const firstControlX = from.x + horizontalDistance * direction;
  const secondControlX = to.x - horizontalDistance * direction;
  return {
    path: `M ${from.x} ${from.y} C ${firstControlX} ${from.y}, ${secondControlX} ${to.y}, ${to.x} ${to.y}`,
    label: { x: (from.x + to.x) / 2, y: Math.max(from.y, to.y) + 16 },
  };
}

function horizontalDetourLayout(
  fromCenter: Point,
  toCenter: Point,
  side: "above" | "below",
  clearance: number,
): RelationLayout {
  const boundaryY = side === "above"
    ? fromCenter.y - NODE_HEIGHT / 2
    : fromCenter.y + NODE_HEIGHT / 2;
  const targetBoundaryY = side === "above"
    ? toCenter.y - NODE_HEIGHT / 2
    : toCenter.y + NODE_HEIGHT / 2;
  const routeY = side === "above"
    ? Math.min(boundaryY, targetBoundaryY) - clearance
    : Math.max(boundaryY, targetBoundaryY) + clearance;
  return {
    path: `M ${fromCenter.x} ${boundaryY} L ${fromCenter.x} ${routeY} L ${toCenter.x} ${routeY} L ${toCenter.x} ${targetBoundaryY}`,
    label: { x: (fromCenter.x + toCenter.x) / 2, y: routeY },
  };
}

function verticalDetourLayout(
  fromCenter: Point,
  toCenter: Point,
  side: "left" | "right",
  clearance: number,
): RelationLayout {
  const boundaryX = side === "left"
    ? fromCenter.x - NODE_WIDTH / 2
    : fromCenter.x + NODE_WIDTH / 2;
  const targetBoundaryX = side === "left"
    ? toCenter.x - NODE_WIDTH / 2
    : toCenter.x + NODE_WIDTH / 2;
  const routeX = side === "left"
    ? Math.min(boundaryX, targetBoundaryX) - clearance
    : Math.max(boundaryX, targetBoundaryX) + clearance;
  return {
    path: `M ${boundaryX} ${fromCenter.y} L ${routeX} ${fromCenter.y} L ${routeX} ${toCenter.y} L ${targetBoundaryX} ${toCenter.y}`,
    label: { x: routeX + (side === "left" ? -8 : 8), y: (fromCenter.y + toCenter.y) / 2 },
  };
}

function relationLayout(model: TopologyModel, relation: RelationDefinition): RelationLayout {
  const fromCenter = nodeCenter(model, relation.from_table_id);
  const toCenter = nodeCenter(model, relation.to_table_id);
  const parallelIndex = Math.max(0, parallelRelationIndex(model, relation));
  if (fromCenter.x === toCenter.x && fromCenter.y === toCenter.y) {
    return selfRelationLayout(fromCenter, parallelIndex);
  }

  const sameRow = fromCenter.y === toCenter.y;
  const sameLane = fromCenter.x === toCenter.x;
  const laneDistance = Math.abs(toCenter.x - fromCenter.x) / 300;
  const rowDistance = Math.abs(toCenter.y - fromCenter.y) / ROW_HEIGHT;

  if (sameRow && (laneDistance > 1 || parallelIndex > 0)) {
    const routedIndex = laneDistance > 1 ? parallelIndex : parallelIndex - 1;
    const preferredSide = laneDistance > 1 ? "below" : "above";
    const side = routedIndex % 2 === 0
      ? preferredSide
      : preferredSide === "above" ? "below" : "above";
    return horizontalDetourLayout(
      fromCenter,
      toCenter,
      side,
      detourClearance(Math.floor(routedIndex / 2)),
    );
  }
  if (sameLane && (rowDistance > 1 || parallelIndex > 0)) {
    const routedIndex = rowDistance > 1 ? parallelIndex : parallelIndex - 1;
    const side = routedIndex % 2 === 0 ? "right" : "left";
    return verticalDetourLayout(
      fromCenter,
      toCenter,
      side,
      detourClearance(Math.floor(routedIndex / 2)),
    );
  }

  const from = nodeBoundaryPoint(fromCenter, toCenter);
  const to = nodeBoundaryPoint(toCenter, fromCenter);
  const layout = directRelationLayout(from, to);
  if (sameRow) {
    const point = nodePoint(model, relation.from_table_id);
    return { ...layout, label: { x: layout.label.x, y: point.y + NODE_HEIGHT + 16 } };
  }
  if (sameLane) {
    return { ...layout, label: { x: fromCenter.x + NODE_WIDTH / 2 + 16, y: layout.label.y } };
  }
  return layout;
}

export function relationPath(model: TopologyModel, relation: RelationDefinition): string {
  return relationLayout(model, relation).path;
}

function tableSummary(table: TableDefinition): string {
  return `${table.field_names.length} 个字段 · PK ${table.primary_key.join(" + ")}`;
}

function nodeClassName(
  model: TopologyModel,
  table: TableDefinition,
  selection: TopologySelection,
): string {
  const selected = selection?.kind === "table" && selection.id === table.table_id;
  const connected = relationsForTable(model, table.table_id).some((relation) =>
    isRelationConnected(selection, relation),
  );
  return cn(
    "absolute flex flex-col items-start justify-between gap-1 overflow-hidden rounded-lg border bg-card p-3 text-left shadow-xs",
    selected || connected ? "border-primary ring-2 ring-primary/20" : "border-border",
    selection !== null && !selected && !connected ? "opacity-55" : "opacity-100",
  );
}

function TopologyNode({
  model,
  table,
  selection,
  onSelect,
}: {
  readonly model: TopologyModel;
  readonly table: TableDefinition;
  readonly selection: TopologySelection;
  readonly onSelect: (selection: TopologySelection, trigger: HTMLElement) => void;
}) {
  const selected = selection?.kind === "table" && selection.id === table.table_id;
  const connected = relationsForTable(model, table.table_id).some((relation) =>
    isRelationConnected(selection, relation),
  );
  return (
    <Button
      type="button"
      variant="outline"
      aria-label={`${table.table_id} ${ROLE_LABELS[table.role]}`}
      aria-pressed={selected}
      data-state={selected ? "selected" : connected ? "connected" : "idle"}
      className={nodeClassName(model, table, selection)}
      style={{
        left: LANE_X[table.role],
        top: nodePoint(model, table.table_id).y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      }}
      onClick={(event) => onSelect({ kind: "table", id: table.table_id }, event.currentTarget)}
    >
      <span className="flex w-full min-w-0 items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-xs font-semibold text-foreground">
          {table.table_id}
        </span>
        <Badge variant={ROLE_BADGE_VARIANTS[table.role]}>{ROLE_LABELS[table.role]}</Badge>
      </span>
      <span className="w-full truncate text-[11px] text-muted-foreground">
        Schema · {table.schema_ref}
      </span>
      <span className="flex w-full items-center gap-1.5 text-[11px] text-muted-foreground">
        <Badge variant={table.required ? "secondary" : "outline"}>
          {table.required ? "必需" : "可选"}
        </Badge>
        <Badge variant={table.allow_empty ? "outline" : "secondary"}>
          {table.allow_empty ? "允许空" : "非空"}
        </Badge>
      </span>
      <span className="w-full truncate text-[11px] text-muted-foreground">
        {tableSummary(table)}
      </span>
    </Button>
  );
}

export function TopologyMap({ model, selection, onSelect }: TopologyMapProps) {
  const maxLaneSize = model.lanes.reduce(
    (maximum, lane) => Math.max(maximum, lane.tables.length),
    0,
  );
  const canvasHeight = Math.max(420, maxLaneSize * ROW_HEIGHT + 72);

  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardTitle className="text-sm">表关系拓扑</CardTitle>
        <CardDescription>
          按主表、支撑表和派生表分层展示候选级关系；连接线仅表达清单中的表级关系。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <div className="min-w-0 overflow-x-auto rounded-lg border bg-muted/20">
          <div
            className="relative"
            data-testid="topology-canvas"
            style={{ width: CANVAS_WIDTH, height: canvasHeight }}
          >
            {model.lanes.map((lane) => (
              <div
                key={lane.role}
                className="absolute text-xs font-medium text-muted-foreground"
                style={{ left: LANE_X[lane.role], top: 16, width: NODE_WIDTH }}
              >
                {ROLE_LABELS[lane.role]}
                <span className="ml-1 tabular-nums text-muted-foreground/70">
                  {lane.tables.length}
                </span>
              </div>
            ))}
            <svg
              aria-hidden="true"
              focusable="false"
              className="pointer-events-none absolute inset-0"
              width={CANVAS_WIDTH}
              height={canvasHeight}
              viewBox={`0 0 ${CANVAS_WIDTH} ${canvasHeight}`}
            >
              {model.relations.map((relation, relationIndex) => {
                const connected = isRelationConnected(selection, relation);
                const emphasized = selection === null || connected;
                const layout = relationLayout(model, relation);
                return (
                  <g key={relation.relation_id}>
                    <path
                      data-relation-id={relation.relation_id}
                      d={layout.path}
                      className={cn(
                        "fill-none stroke-border",
                        emphasized ? "opacity-75" : "opacity-30",
                        connected && "stroke-primary opacity-100",
                      )}
                      strokeWidth={connected ? 2.25 : 1.5}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                    <circle
                      cx={layout.label.x}
                      cy={layout.label.y}
                      r={9}
                      className={cn(
                        "fill-background stroke-border",
                        emphasized ? "opacity-90" : "opacity-35",
                        connected && "stroke-primary opacity-100",
                      )}
                      strokeWidth={connected ? 2 : 1}
                      vectorEffect="non-scaling-stroke"
                    />
                    <text
                      data-relation-marker={relation.relation_id}
                      x={layout.label.x}
                      y={layout.label.y}
                      dy="0.35em"
                      textAnchor="middle"
                      className={cn(
                        "fill-muted-foreground text-[8px] font-semibold",
                        emphasized ? "opacity-100" : "opacity-40",
                        connected && "fill-primary opacity-100",
                      )}
                    >
                      {`R${relationIndex + 1}`}
                    </text>
                  </g>
                );
              })}
            </svg>
            {model.lanes.flatMap((lane) =>
              lane.tables.map((table) => (
                <TopologyNode
                  key={table.table_id}
                  model={model}
                  table={table}
                  selection={selection}
                  onSelect={onSelect}
                />
              )),
            )}
          </div>
        </div>
        {model.relations.length > 0 && (
          <div
            aria-hidden="true"
            data-testid="topology-relation-legend"
            className="grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-3"
          >
            {model.relations.map((relation, relationIndex) => (
              <div
                key={relation.relation_id}
                data-relation-label={relation.relation_id}
                data-cardinality={relation.cardinality}
                data-missing-policy={relation.missing_policy}
                className="flex min-w-0 items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 text-[11px]"
              >
                <span className="shrink-0 font-semibold text-primary">R{relationIndex + 1}</span>
                <span className="min-w-0 flex-1 truncate font-mono" title={relation.relation_id}>
                  {relation.relation_id}
                </span>
                <Badge variant="secondary">{CARDINALITY_LABELS[relation.cardinality]}</Badge>
                <Badge variant="outline">{MISSING_POLICY_LABELS[relation.missing_policy]}</Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
