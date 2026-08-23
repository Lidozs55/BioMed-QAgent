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

export interface TopologyMapProps {
  readonly model: TopologyModel;
  readonly selection: TopologySelection;
  readonly onSelect: (selection: TopologySelection) => void;
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

export function relationPath(model: TopologyModel, relation: RelationDefinition): string {
  const from = nodeCenter(model, relation.from_table_id);
  const to = nodeCenter(model, relation.to_table_id);
  const horizontalDistance = Math.max(48, Math.abs(to.x - from.x) * 0.45);
  const direction = to.x >= from.x ? 1 : -1;
  const firstControlX = from.x + horizontalDistance * direction;
  const secondControlX = to.x - horizontalDistance * direction;
  return `M ${from.x} ${from.y} C ${firstControlX} ${from.y}, ${secondControlX} ${to.y}, ${to.x} ${to.y}`;
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
  readonly onSelect: (selection: TopologySelection) => void;
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
      onClick={() => onSelect({ kind: "table", id: table.table_id })}
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
      <CardContent>
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
              {model.relations.map((relation) => {
                const connected = isRelationConnected(selection, relation);
                const emphasized = selection === null || connected;
                return (
                  <path
                    key={relation.relation_id}
                    data-relation-id={relation.relation_id}
                    d={relationPath(model, relation)}
                    className={cn(
                      "fill-none stroke-border",
                      emphasized ? "opacity-75" : "opacity-30",
                      connected && "stroke-primary opacity-100",
                    )}
                    strokeWidth={connected ? 2.25 : 1.5}
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  />
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
      </CardContent>
    </Card>
  );
}
