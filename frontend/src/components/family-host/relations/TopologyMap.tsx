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

interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

type PortDirection = "top" | "right" | "bottom" | "left";

interface Port {
  readonly boundary: Point;
  readonly outer: Point;
}

const ROUTE_PADDING = 4;
const PORT_DIRECTIONS: readonly PortDirection[] = ["right", "bottom", "left", "top"];

function topologyCanvasHeight(model: TopologyModel): number {
  const maxLaneSize = model.lanes.reduce(
    (maximum, lane) => Math.max(maximum, lane.tables.length),
    0,
  );
  return Math.max(420, maxLaneSize * ROW_HEIGHT + 72);
}

function tableRects(model: TopologyModel): readonly Rect[] {
  return model.lanes.flatMap((lane) =>
    lane.tables.map((table) => {
      const point = nodePoint(model, table.table_id);
      return {
        left: point.x,
        right: point.x + NODE_WIDTH,
        top: point.y,
        bottom: point.y + NODE_HEIGHT,
      };
    }),
  );
}

function inflateRect(rect: Rect): Rect {
  return {
    left: rect.left - ROUTE_PADDING,
    right: rect.right + ROUTE_PADDING,
    top: rect.top - ROUTE_PADDING,
    bottom: rect.bottom + ROUTE_PADDING,
  };
}

function port(center: Point, direction: PortDirection, clearance: number): Port {
  if (direction === "left") {
    return {
      boundary: { x: center.x - NODE_WIDTH / 2, y: center.y },
      outer: { x: center.x - NODE_WIDTH / 2 - clearance, y: center.y },
    };
  }
  if (direction === "right") {
    return {
      boundary: { x: center.x + NODE_WIDTH / 2, y: center.y },
      outer: { x: center.x + NODE_WIDTH / 2 + clearance, y: center.y },
    };
  }
  if (direction === "top") {
    return {
      boundary: { x: center.x, y: center.y - NODE_HEIGHT / 2 },
      outer: { x: center.x, y: center.y - NODE_HEIGHT / 2 - clearance },
    };
  }
  return {
    boundary: { x: center.x, y: center.y + NODE_HEIGHT / 2 },
    outer: { x: center.x, y: center.y + NODE_HEIGHT / 2 + clearance },
  };
}

function pointInsideRect(point: Point, rect: Rect): boolean {
  return point.x > rect.left && point.x < rect.right && point.y > rect.top && point.y < rect.bottom;
}

function segmentCrossesRect(from: Point, to: Point, rect: Rect): boolean {
  if (from.y === to.y) {
    return from.y > rect.top
      && from.y < rect.bottom
      && Math.max(from.x, to.x) > rect.left
      && Math.min(from.x, to.x) < rect.right;
  }
  return from.x > rect.left
    && from.x < rect.right
    && Math.max(from.y, to.y) > rect.top
    && Math.min(from.y, to.y) < rect.bottom;
}

function compressPath(points: readonly Point[]): readonly Point[] {
  const unique = points.filter((point, index) => {
    const previous = points[index - 1];
    return previous === undefined || previous.x !== point.x || previous.y !== point.y;
  });
  const compressed: Point[] = [];
  for (const point of unique) {
    while (compressed.length >= 2) {
      const before = compressed[compressed.length - 2]!;
      const previous = compressed[compressed.length - 1]!;
      const collinear = (before.x === previous.x && previous.x === point.x)
        || (before.y === previous.y && previous.y === point.y);
      if (!collinear) break;
      compressed.pop();
    }
    compressed.push(point);
  }
  return compressed;
}

function gridRoute(
  start: Point,
  end: Point,
  obstacles: readonly Rect[],
  canvasHeight: number,
): readonly Point[] | undefined {
  const xCoordinates = new Set<number>([4, CANVAS_WIDTH - 4, start.x, end.x]);
  const yCoordinates = new Set<number>([4, canvasHeight - 4, start.y, end.y]);
  for (const rect of obstacles) {
    xCoordinates.add(rect.left);
    xCoordinates.add(rect.right);
    yCoordinates.add(rect.top);
    yCoordinates.add(rect.bottom);
  }
  const xs = [...xCoordinates].sort((left, right) => left - right);
  const ys = [...yCoordinates].sort((left, right) => left - right);
  const startX = xs.indexOf(start.x);
  const startY = ys.indexOf(start.y);
  const endX = xs.indexOf(end.x);
  const endY = ys.indexOf(end.y);
  const key = (xIndex: number, yIndex: number) => `${xIndex}:${yIndex}`;
  const startKey = key(startX, startY);
  const endKey = key(endX, endY);
  const queue: Array<readonly [number, number]> = [[startX, startY]];
  const parents = new Map<string, string | null>([[startKey, null]]);
  const indicesByKey = new Map<string, readonly [number, number]>([[startKey, [startX, startY]]]);
  let cursor = 0;

  while (cursor < queue.length && !parents.has(endKey)) {
    const [xIndex, yIndex] = queue[cursor++]!;
    const point = { x: xs[xIndex]!, y: ys[yIndex]! };
    const neighbors: Array<readonly [number, number]> = [
      [xIndex + 1, yIndex],
      [xIndex, yIndex + 1],
      [xIndex - 1, yIndex],
      [xIndex, yIndex - 1],
    ];
    for (const [nextX, nextY] of neighbors) {
      if (nextX < 0 || nextX >= xs.length || nextY < 0 || nextY >= ys.length) continue;
      const nextKey = key(nextX, nextY);
      if (parents.has(nextKey)) continue;
      const nextPoint = { x: xs[nextX]!, y: ys[nextY]! };
      if (obstacles.some((rect) => pointInsideRect(nextPoint, rect))) continue;
      if (obstacles.some((rect) => segmentCrossesRect(point, nextPoint, rect))) continue;
      parents.set(nextKey, key(xIndex, yIndex));
      indicesByKey.set(nextKey, [nextX, nextY]);
      queue.push([nextX, nextY]);
    }
  }

  if (!parents.has(endKey)) return undefined;
  const reversed: Point[] = [];
  let currentKey: string | null = endKey;
  while (currentKey !== null) {
    const indices = indicesByKey.get(currentKey);
    if (indices === undefined) return undefined;
    reversed.push({ x: xs[indices[0]]!, y: ys[indices[1]]! });
    currentKey = parents.get(currentKey) ?? null;
  }
  return reversed.reverse();
}

function parallelRelationIndex(model: TopologyModel, relation: RelationDefinition): number {
  const endpoints = [relation.from_table_id, relation.to_table_id].sort().join("\u0000");
  return model.relations
    .filter((candidate) =>
      [candidate.from_table_id, candidate.to_table_id].sort().join("\u0000") === endpoints,
    )
    .findIndex((candidate) => candidate.relation_id === relation.relation_id);
}

function portClearance(parallelIndex: number): number {
  return 8 + (8 * (parallelIndex + 1)) / (parallelIndex + 2);
}

function opposite(direction: PortDirection): PortDirection {
  if (direction === "left") return "right";
  if (direction === "right") return "left";
  if (direction === "top") return "bottom";
  return "top";
}

function preferredDirections(from: Point, to: Point): readonly PortDirection[] {
  const horizontal: PortDirection = to.x >= from.x ? "right" : "left";
  const vertical: PortDirection = to.y >= from.y ? "bottom" : "top";
  return Math.abs(to.x - from.x) >= Math.abs(to.y - from.y)
    ? [horizontal, vertical, opposite(vertical), opposite(horizontal)]
    : [vertical, horizontal, opposite(horizontal), opposite(vertical)];
}

function relationPortPairs(
  fromCenter: Point,
  toCenter: Point,
  selfRelation: boolean,
  parallelIndex: number,
): readonly (readonly [PortDirection, PortDirection])[] {
  const fromDirections = selfRelation
    ? PORT_DIRECTIONS
    : preferredDirections(fromCenter, toCenter);
  const toDirections = selfRelation
    ? PORT_DIRECTIONS
    : preferredDirections(toCenter, fromCenter);
  const pairs = fromDirections.flatMap((fromDirection, fromIndex) =>
    toDirections.map((toDirection, toIndex) => ({
      fromDirection,
      toDirection,
      score: fromIndex + toIndex,
    })),
  )
    .filter(({ fromDirection, toDirection }) => !selfRelation || fromDirection !== toDirection)
    .sort((left, right) =>
      left.score - right.score
      || left.fromDirection.localeCompare(right.fromDirection)
      || left.toDirection.localeCompare(right.toDirection),
    )
    .map(({ fromDirection, toDirection }) => [fromDirection, toDirection] as const);
  const offset = parallelIndex % pairs.length;
  return [...pairs.slice(offset), ...pairs.slice(0, offset)];
}

function pathLabel(points: readonly Point[], canvasHeight: number): Point {
  let label = points[0] ?? { x: CANVAS_WIDTH / 2, y: canvasHeight / 2 };
  let longest = -1;
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]!;
    const to = points[index]!;
    const length = Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
    if (length <= longest) continue;
    longest = length;
    label = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  }
  return {
    x: Math.min(CANVAS_WIDTH - 10, Math.max(10, label.x)),
    y: Math.min(canvasHeight - 10, Math.max(10, label.y)),
  };
}

function relationLayout(model: TopologyModel, relation: RelationDefinition): RelationLayout {
  const fromCenter = nodeCenter(model, relation.from_table_id);
  const toCenter = nodeCenter(model, relation.to_table_id);
  const parallelIndex = Math.max(0, parallelRelationIndex(model, relation));
  const selfRelation = relation.from_table_id === relation.to_table_id;
  const clearance = portClearance(parallelIndex);
  const obstacles = tableRects(model).map(inflateRect);
  const canvasHeight = topologyCanvasHeight(model);
  for (const [fromDirection, toDirection] of relationPortPairs(
    fromCenter,
    toCenter,
    selfRelation,
    parallelIndex,
  )) {
    const fromPort = port(fromCenter, fromDirection, clearance);
    const toPort = port(toCenter, toDirection, clearance);
    const route = gridRoute(fromPort.outer, toPort.outer, obstacles, canvasHeight);
    if (route === undefined) continue;
    const points = compressPath([fromPort.boundary, ...route, toPort.boundary]);
    return {
      path: points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" "),
      label: pathLabel(points, canvasHeight),
    };
  }
  throw new Error(`Unable to route topology relation '${relation.relation_id}'`);
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
