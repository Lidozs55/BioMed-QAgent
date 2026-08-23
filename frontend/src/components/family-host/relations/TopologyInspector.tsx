import type { RelationDefinition, TableDefinition } from "@biomed/contracts";

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
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import {
  relationsForTable,
  type TopologyModel,
  type TopologySelection,
} from "./topology-model";
import { ROLE_LABELS } from "./TopologyMap";

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

export interface TopologyInspectorProps {
  readonly model: TopologyModel;
  readonly selection: TopologySelection;
  readonly finalFocus: () => HTMLElement | null;
  readonly onOpenChange: (open: boolean) => void;
}

function formatFields(fields: readonly string[]): string {
  return fields.join(" + ");
}

function relationTableLabel(
  model: TopologyModel,
  tableId: string,
): string {
  const table = model.tablesById.get(tableId);
  return table === undefined ? tableId : `${tableId} · ${ROLE_LABELS[table.role]}`;
}

function selectedCandidates(model: TopologyModel, selection: TopologySelection) {
  if (selection === null) return [];
  if (selection.kind === "table") {
    return model.evidence.candidates.filter((candidate) => candidate.table_ids.includes(selection.id));
  }
  return model.evidence.candidates.filter((candidate) => candidate.relation_ids.includes(selection.id));
}

function RefList({ label, refs }: { readonly label: string; readonly refs: readonly string[] }) {
  if (refs.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="break-words font-mono text-xs text-foreground">{refs.join(" · ")}</p>
    </div>
  );
}

function EvidenceCards({ model, selection }: { readonly model: TopologyModel; readonly selection: TopologySelection }) {
  const candidates = selectedCandidates(model, selection);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Card size="sm" className="min-w-0">
        <CardHeader>
          <CardTitle className="text-sm">候选级证据</CardTitle>
          <CardDescription>
            这些引用属于 manifest candidate，不表示记录级或单表级血缘。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">未找到与当前选择关联的候选引用。</p>
          ) : (
            <div className="flex min-w-0 flex-col gap-3">
              {candidates.map((candidate) => (
                <div key={candidate.candidate_id} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-xs font-medium">
                      {candidate.candidate_id}
                    </span>
                    <Badge variant="outline">候选引用</Badge>
                  </div>
                  <RefList label="表引用" refs={candidate.table_ids} />
                  <RefList label="关系引用" refs={candidate.relation_ids} />
                  <RefList label="溯源引用" refs={candidate.provenance_refs} />
                  <RefList label="置信度引用" refs={candidate.confidence_refs} />
                  <RefList label="审计引用" refs={candidate.audit_refs} />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <Card size="sm" className="min-w-0">
        <CardHeader>
          <CardTitle className="text-sm">Manifest 产物</CardTitle>
          <CardDescription>独立列出清单声明的 artifacts，不与候选级证据混用。</CardDescription>
        </CardHeader>
        <CardContent>
          {model.evidence.artifacts.length === 0 ? (
            <p className="text-sm text-muted-foreground">此 manifest 没有声明产物。</p>
          ) : (
            <ul className="flex min-w-0 flex-col gap-2" aria-label="Manifest 产物列表">
              {model.evidence.artifacts.map((artifact) => (
                <li key={artifact.artifact_id} className="flex min-w-0 flex-col gap-1 rounded-lg border p-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <span className="min-w-0 truncate font-mono text-xs font-medium">
                      {artifact.artifact_id}
                    </span>
                    <Badge variant="outline">{artifact.role}</Badge>
                  </div>
                  <span className="break-words text-xs text-muted-foreground">
                    {artifact.relative_path}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TableFields({ table }: { readonly table: TableDefinition }) {
  const primaryKey = new Set(table.primary_key);
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardTitle className="text-sm">字段清单</CardTitle>
        <CardDescription>完整字段列表；PK 标记来自 manifest table definition。</CardDescription>
      </CardHeader>
      <CardContent>
        <Table aria-label={`${table.table_id} 字段`}>
          <TableHeader>
            <TableRow>
              <TableHead>字段</TableHead>
              <TableHead>类型角色</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {table.field_names.map((field) => (
              <TableRow key={field}>
                <TableCell className="font-mono text-xs">{field}</TableCell>
                <TableCell>
                  {primaryKey.has(field) ? <Badge variant="secondary">PK</Badge> : <span className="text-xs text-muted-foreground">字段</span>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ConnectedRelations({ model, table }: { readonly model: TopologyModel; readonly table: TableDefinition }) {
  const relations = relationsForTable(model, table.table_id);
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardTitle className="text-sm">连接关系</CardTitle>
        <CardDescription>与当前表相连的 manifest relation。</CardDescription>
      </CardHeader>
      <CardContent>
        {relations.length === 0 ? (
          <p className="text-sm text-muted-foreground">此表没有声明连接关系。</p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-2" aria-label="连接关系列表">
            {relations.map((relation) => (
              <li key={relation.relation_id} className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border p-3">
                <span className="min-w-0 truncate font-mono text-xs font-medium">{relation.relation_id}</span>
                <Badge variant="outline">{CARDINALITY_LABELS[relation.cardinality]}</Badge>
                <Badge variant="outline">{MISSING_POLICY_LABELS[relation.missing_policy]}</Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function TableInspector({ model, table }: { readonly model: TopologyModel; readonly table: TableDefinition }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 p-4">
      <Card size="sm" className="min-w-0">
        <CardHeader>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <CardTitle className="text-sm">{table.table_id}</CardTitle>
            <Badge variant="outline">{ROLE_LABELS[table.role]}</Badge>
          </div>
          <CardDescription>schema_ref</CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-3">
          <p className="break-words font-mono text-xs text-foreground">{table.schema_ref}</p>
          <Separator />
          <div className="grid grid-cols-2 gap-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">必需状态</p>
              <Badge variant={table.required ? "secondary" : "outline"}>{table.required ? "必需" : "可选"}</Badge>
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">空表策略</p>
              <Badge variant={table.allow_empty ? "outline" : "secondary"}>{table.allow_empty ? "允许空" : "非空"}</Badge>
            </div>
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">主键字段</p>
            <p className="break-words font-mono text-xs text-foreground">{formatFields(table.primary_key)}</p>
          </div>
        </CardContent>
      </Card>
      <TableFields table={table} />
      <ConnectedRelations model={model} table={table} />
      <EvidenceCards model={model} selection={{ kind: "table", id: table.table_id }} />
    </div>
  );
}

function RelationPairs({ model, relation }: { readonly model: TopologyModel; readonly relation: RelationDefinition }) {
  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <CardTitle className="text-sm">端点字段配对</CardTitle>
        <CardDescription>按 relation 声明的顺序展示字段配对，不推断记录级 lineage。</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">字段键映射摘要</p>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs">
            <code className="break-words text-foreground">{formatFields(relation.from_fields)}</code>
            <span aria-hidden="true" className="text-muted-foreground">→</span>
            <code className="break-words text-foreground">目标 · {formatFields(relation.to_fields)}</code>
          </div>
        </div>
        <Separator />
        <Table aria-label={`${relation.relation_id} 字段配对`}>
          <TableHeader>
            <TableRow>
              <TableHead>来源端点</TableHead>
              <TableHead>目标端点</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {relation.from_fields.map((fromField, index) => {
              const toField = relation.to_fields[index];
              if (toField === undefined) return null;
              return (
                <TableRow key={`${fromField}-${toField}-${index}`}>
                  <TableCell>
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="truncate text-xs text-muted-foreground">
                        {relationTableLabel(model, relation.from_table_id)}
                      </span>
                      <code className="break-words text-xs text-foreground">{fromField}</code>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="truncate text-xs text-muted-foreground">
                        {relationTableLabel(model, relation.to_table_id)}
                      </span>
                      <code className="break-words text-xs text-foreground">{toField}</code>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function RelationInspector({ model, relation }: { readonly model: TopologyModel; readonly relation: RelationDefinition }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 p-4">
      <Card size="sm" className="min-w-0">
        <CardHeader>
          <CardTitle className="text-sm">{relation.relation_id}</CardTitle>
          <CardDescription>
            {relationTableLabel(model, relation.from_table_id)} → {relationTableLabel(model, relation.to_table_id)}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-wrap gap-1.5">
          <Badge variant="secondary">{CARDINALITY_LABELS[relation.cardinality]}</Badge>
          <Badge variant="outline">{MISSING_POLICY_LABELS[relation.missing_policy]}</Badge>
        </CardContent>
      </Card>
      <RelationPairs model={model} relation={relation} />
      <EvidenceCards model={model} selection={{ kind: "relation", id: relation.relation_id }} />
    </div>
  );
}

export function TopologyInspector({ model, selection, finalFocus, onOpenChange }: TopologyInspectorProps) {
  const table = selection?.kind === "table" ? model.tablesById.get(selection.id) : undefined;
  const relation = selection?.kind === "relation" ? model.relationsById.get(selection.id) : undefined;
  const isRelation = relation !== undefined;

  return (
    <Sheet modal={false} open={selection !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showOverlay={false}
        finalFocus={finalFocus}
        className="gap-0 overflow-y-auto sm:max-w-xl"
      >
        <SheetHeader className="border-b">
          <SheetTitle>{isRelation ? "关系详情" : "表详情"}</SheetTitle>
          <SheetDescription>
            {isRelation ? "查看关系端点、字段配对、基数和缺失策略。" : "查看表定义、字段和连接关系。"}
          </SheetDescription>
        </SheetHeader>
        {relation !== undefined ? (
          <RelationInspector model={model} relation={relation} />
        ) : table !== undefined ? (
          <TableInspector model={model} table={table} />
        ) : (
          <Empty className="m-4 min-h-40">
            <EmptyHeader>
              <EmptyTitle>没有可查看的选择</EmptyTitle>
              <EmptyDescription>从拓扑图或表关系中选择一个表或关系。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </SheetContent>
    </Sheet>
  );
}
