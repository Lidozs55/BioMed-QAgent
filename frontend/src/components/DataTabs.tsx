import { ArrowCounterClockwiseIcon, DatabaseIcon, TrashIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Toggle } from "@/components/ui/toggle";
import type { SettingsAPIClient, SkillManifest } from "@/hooks/useAPI";

/* ------------------------------------------------------------------ */
/*  Database tab                                                       */
/* ------------------------------------------------------------------ */
export function DatabasesTabContent({
  databases, api, onRefresh, onEditDB, onDeleteDB, onNewDB, onUploadValidation,
}: {
  databases: SkillManifest[]; api: SettingsAPIClient;
  onRefresh: () => Promise<void>;
  onEditDB: (db: SkillManifest) => void;
  onDeleteDB: (db: SkillManifest) => void;
  onNewDB: () => void;
  onUploadValidation: (file: File) => Promise<void>;
}) {
  const mutate = async (action: () => Promise<void>, msg: string) => {
    try { await action(); await onRefresh(); toast.success(msg); }
    catch (e) { toast.error("操作失败", { description: e instanceof Error ? e.message : String(e) }); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>数据库目录</CardTitle>
        <CardDescription>数据库是可选择、声明式的检索技能投影。</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap justify-end gap-2">
          <Field><FieldLabel htmlFor="database-upload" className="sr-only">上传数据库包</FieldLabel>
            <Input id="database-upload" type="file" accept=".json,.yaml,.yml,.zip" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              await onUploadValidation(file);
            }} />
          </Field>
          <Button size="sm" onClick={onNewDB}>
            <DatabaseIcon data-icon="inline-start" />新建数据库
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名称</TableHead><TableHead>来源</TableHead><TableHead>版本</TableHead>
              <TableHead>可用性</TableHead><TableHead>Pipeline</TableHead><TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {databases.map((db) => (
              <TableRow key={db.name}>
                <TableCell>
                  <div className="font-medium">{db.display_name}</div>
                  <div className="text-xs text-muted-foreground">{db.description}</div>
                </TableCell>
                <TableCell><Badge variant="outline">{db.origin}</Badge></TableCell>
                <TableCell>{db.version}</TableCell>
                <TableCell>
                  <Toggle variant="outline" pressed={db.enabled} disabled={db.origin === "builtin"}
                    aria-label={`${db.enabled ? "停用" : "启用"} ${db.display_name}`}
                    onPressedChange={(p) => void mutate(() => api.setSkillEnabled(db.name, p), "数据库状态已更新")}
                  >{db.enabled ? "已启用" : "已停用"}</Toggle>
                </TableCell>
                <TableCell><Badge variant={db.pipeline_supported ? "secondary" : "outline"}>{db.pipeline_supported ? "支持" : "Agent"}</Badge></TableCell>
                <TableCell className="text-right">
                  {db.origin === "package" && (
                    <div className="flex justify-end gap-1">
                      <Button size="icon-sm" variant="ghost" aria-label={`编辑 ${db.display_name}`} onClick={() => onEditDB(db)}><DatabaseIcon /></Button>
                      <Button size="icon-sm" variant="ghost" aria-label={`删除 ${db.display_name}`} onClick={() => onDeleteDB(db)}><TrashIcon /></Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/*  Skills tab                                                         */
/* ------------------------------------------------------------------ */
export function SkillsTabContent({
  skills, skillFilter, onFilterChange, api, onRefresh, onViewDetail, onDeleteSkill, onUploadValidation,
}: {
  skills: SkillManifest[]; skillFilter: string;
  onFilterChange: (v: string) => void;
  api: SettingsAPIClient; onRefresh: () => Promise<void>;
  onViewDetail: (sk: SkillManifest) => void;
  onDeleteSkill: (sk: SkillManifest) => void;
  onUploadValidation: (file: File) => Promise<void>;
}) {
  const filtered = skills.filter((s) => {
    const q = skillFilter.trim().toLowerCase();
    return !q || [s.name, s.display_name, s.category, s.origin].some((v) => v.toLowerCase().includes(q));
  });
  const mutate = async (action: () => Promise<void>, msg: string) => {
    try { await action(); await onRefresh(); toast.success(msg); }
    catch (e) { toast.error("操作失败", { description: e instanceof Error ? e.message : String(e) }); }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>技能管理</CardTitle>
        <CardDescription>筛选、启停、回滚或安装技能包。</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input className="max-w-xs" placeholder="筛选技能" value={skillFilter} onChange={(e) => onFilterChange(e.target.value)} />
          <Field><FieldLabel htmlFor="skill-upload" className="sr-only">上传技能</FieldLabel>
            <Input id="skill-upload" type="file" accept=".json,.yaml,.yml,.zip" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              await onUploadValidation(file);
            }} />
          </Field>
        </div>
        {filtered.length === 0 ? (
          <Empty><EmptyHeader><EmptyTitle>没有匹配的技能</EmptyTitle><EmptyDescription>调整名称、分类、来源或状态筛选。</EmptyDescription></EmptyHeader></Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>技能</TableHead><TableHead>分类</TableHead><TableHead>状态</TableHead>
                <TableHead>操作 / 版本</TableHead><TableHead className="text-right">管理</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((sk) => (
                <TableRow key={sk.name}>
                  <TableCell>
                    <div className="font-medium">{sk.display_name}</div>
                    <div className="text-xs text-muted-foreground">{sk.description}</div>
                    {sk.load_error && <div className="text-xs text-destructive">{sk.load_error}</div>}
                  </TableCell>
                  <TableCell><Badge variant="outline">{sk.category}</Badge><Badge variant="secondary">{sk.origin}</Badge></TableCell>
                  <TableCell>
                    {sk.available === false ? <Badge variant="destructive">不可用</Badge> : (
                      <Toggle variant="outline" pressed={sk.enabled}
                        aria-label={`${sk.enabled ? "停用" : "启用"} ${sk.display_name}`}
                        disabled={sk.origin === "builtin"}
                        onPressedChange={(p) => void mutate(() => api.setSkillEnabled(sk.name, p), "技能状态已更新")}
                      >{sk.enabled ? "已启用" : "已停用"}</Toggle>
                    )}
                  </TableCell>
                  <TableCell>
                    <div>{sk.operations.join(", ") || "无操作"}</div>
                    <div className="text-xs text-muted-foreground">v{sk.version}</div>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="ghost" aria-label={`查看 ${sk.display_name}`} onClick={() => onViewDetail(sk)}>详情</Button>
                      {sk.origin === "package" && (
                        <>
                          <Button size="icon-sm" variant="ghost" aria-label={`回滚 ${sk.display_name}`}
                            onClick={() => void mutate(() => api.rollbackSkill(sk.name), "技能已回滚")}
                          ><ArrowCounterClockwiseIcon /></Button>
                          <Button size="icon-sm" variant="ghost" aria-label={`删除 ${sk.display_name}`}
                            onClick={() => onDeleteSkill(sk)}><TrashIcon /></Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
