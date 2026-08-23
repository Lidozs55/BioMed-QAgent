import { useCallback, useMemo, useRef, useState } from "react";
import type { DatasetManifestV2, DatasetPublication, RelationDefinition } from "@biomed/contracts";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";

import { TopologyInspector } from "./TopologyInspector";
import { ROLE_LABELS, TopologyMap } from "./TopologyMap";
import {
  buildTopologyModel,
  type TopologyModel,
  type TopologySelection,
} from "./topology-model";

export interface FamilyTopologyExplorerProps {
  readonly manifest: DatasetManifestV2;
  readonly publication: DatasetPublication | null;
}

const CARDINALITY_LABELS: Record<RelationDefinition["cardinality"], string> = {
  one_to_one: "一对一",
  one_to_many: "一对多",
  many_to_one: "多对一",
  many_to_many: "多对多",
};

const MISSING_POLICY_LABELS: Record<RelationDefinition["missing_policy"], string> = {
  reject: "拒绝缺失",
  allow_empty: "允许空表",
  allow_missing: "允许缺失",
  profile_defined: "按配置文件",
};

function coverageLabel(manifest: DatasetManifestV2): string {
  const coverage = manifest.provenance_summary.coverage;
  if (typeof coverage !== "object" || coverage === null || Array.isArray(coverage)) return "未声明";
  const ratio = Reflect.get(coverage, "coverage_ratio");
  return typeof ratio === "number" && Number.isFinite(ratio) ? `${(ratio * 100).toFixed(1)}%` : "未声明";
}

function relationEndpoint(model: TopologyModel, tableId: string, fields: readonly string[]): string {
  const table = model.tablesById.get(tableId);
  const role = table === undefined ? "" : ` · ${ROLE_LABELS[table.role]}`;
  return `${tableId}${role} · ${fields.join(" + ")}`;
}

export function TopologySummary({
  model,
  manifest,
  publication,
}: {
  readonly model: TopologyModel;
  readonly manifest: DatasetManifestV2;
  readonly publication: DatasetPublication | null;
}) {
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <CardTitle className="text-sm">结构拓扑</CardTitle>
          <Badge variant="outline">{manifest.dataset_family}</Badge>
          <Badge variant="outline">{manifest.row_granularity}</Badge>
        </div>
        <CardDescription>
          {manifest.schema_ref} · 构建 {manifest.build_id}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">表数量</p>
            <p className="truncate text-sm font-medium tabular-nums">{model.summary.tables} 张表</p>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">关系数量</p>
            <p className="truncate text-sm font-medium tabular-nums">{model.summary.relations} 条</p>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">主表 / 支撑 / 派生</p>
            <p className="truncate text-sm font-medium tabular-nums">
              {model.summary.primary} / {model.summary.supporting} / {model.summary.derived}
            </p>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">溯源覆盖率</p>
            <p className="truncate text-sm font-medium tabular-nums">{coverageLabel(manifest)}</p>
          </div>
          <div className="min-w-0 sm:col-span-2 lg:col-span-2">
            <p className="text-xs text-muted-foreground">Publication</p>
            {publication === null ? (
              <Badge variant="outline">未发布</Badge>
            ) : (
              <Badge variant="secondary" className="max-w-full truncate">
                已发布 · {publication.publication_id}
              </Badge>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export interface RelationTableProps {
  readonly model: TopologyModel;
  readonly selection: TopologySelection;
  readonly onSelect: (selection: TopologySelection, trigger: HTMLElement) => void;
}

export function RelationTable({ model, selection, onSelect }: RelationTableProps) {
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardTitle className="text-sm">表关系</CardTitle>
        <CardDescription>
          这是拓扑图的可访问文本替代；字段配对来自 manifest relation，不暗示记录级 lineage。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {model.relations.length === 0 && (
          <Empty className="min-h-28 border">
            <EmptyHeader>
              <EmptyTitle>此构建没有声明表关系</EmptyTitle>
              <EmptyDescription>表节点仍按 manifest 的角色和字段定义展示。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        <Separator />
        <Table aria-label="表关系">
          <TableCaption className="sr-only">表关系</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>关系</TableHead>
              <TableHead>来源端点 · 字段</TableHead>
              <TableHead>目标端点 · 字段</TableHead>
              <TableHead>基数</TableHead>
              <TableHead>缺失策略</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {model.relations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-xs text-muted-foreground">
                  暂无 relation 记录
                </TableCell>
              </TableRow>
            ) : (
              model.relations.map((relation) => {
                const selected = selection?.kind === "relation" && selection.id === relation.relation_id;
                return (
                  <TableRow key={relation.relation_id} aria-selected={selected}>
                    <TableCell>
                      <Button
                        type="button"
                        variant="link"
                        size="sm"
                        aria-label={`查看关系 ${relation.relation_id}`}
                        aria-pressed={selected}
                        className="h-auto max-w-full justify-start p-0 text-left font-mono text-xs"
                        onClick={(event) =>
                          onSelect({ kind: "relation", id: relation.relation_id }, event.currentTarget)
                        }
                      >
                        {relation.relation_id}
                      </Button>
                    </TableCell>
                    <TableCell className="max-w-64 whitespace-normal text-xs">
                      {relationEndpoint(model, relation.from_table_id, relation.from_fields)}
                    </TableCell>
                    <TableCell className="max-w-64 whitespace-normal text-xs">
                      {relationEndpoint(model, relation.to_table_id, relation.to_fields)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">基数 · {CARDINALITY_LABELS[relation.cardinality]}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{MISSING_POLICY_LABELS[relation.missing_policy]}</Badge>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function FamilyTopologyExplorer({ manifest, publication }: FamilyTopologyExplorerProps) {
  const model = useMemo(() => buildTopologyModel(manifest), [manifest]);
  const [selection, setSelection] = useState<TopologySelection>(null);
  const focusReturnRef = useRef<HTMLElement | null>(null);
  const finalFocus = useCallback(() => focusReturnRef.current, []);
  const handleSelect = useCallback((nextSelection: TopologySelection, trigger: HTMLElement) => {
    focusReturnRef.current = trigger;
    setSelection(nextSelection);
  }, []);
  const handleInspectorOpenChange = useCallback((open: boolean) => {
    if (open) return;
    setSelection(null);
    queueMicrotask(() => {
      const trigger = focusReturnRef.current;
      if (document.activeElement === document.body && trigger?.isConnected) {
        trigger.focus();
      }
    });
  }, []);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <TopologySummary model={model} manifest={manifest} publication={publication} />
      <TopologyMap model={model} selection={selection} onSelect={handleSelect} />
      <RelationTable model={model} selection={selection} onSelect={handleSelect} />
      <TopologyInspector
        model={model}
        selection={selection}
        finalFocus={finalFocus}
        onOpenChange={handleInspectorOpenChange}
      />
    </div>
  );
}
