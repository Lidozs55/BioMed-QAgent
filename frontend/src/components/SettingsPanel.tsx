import { ArrowCounterClockwiseIcon, DatabaseIcon, GearIcon, TrashIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import type { DeclarativeSkillManifest, ModelInfo, ModelSettings, ModelSettingsUpdate, SettingsAPIClient, SkillDetail, SkillManifest, SkillValidation, VendorInfo } from "@/hooks/useAPI";

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: SettingsAPIClient;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

interface DatabaseDraft {
  name: string;
  displayName: string;
  description: string;
  url: string;
  operation: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  query: string;
  headers: string;
  body: string;
}

const EMPTY_DATABASE: DatabaseDraft = { name: "", displayName: "", description: "", url: "", operation: "search", method: "GET", query: "{}", headers: "{}", body: "null" };

function databaseManifest(draft: DatabaseDraft, version = "1.0.0"): DeclarativeSkillManifest {
  return {
    schema_version: "1.0", name: draft.name, display_name: draft.displayName,
    version, category: "discovery", description: draft.description,
    supported_sources: [draft.name], user_selectable: true, pipeline_supported: false,
    operations: [{ name: draft.operation, description: `Search ${draft.displayName}`, method: draft.method, url: draft.url, query: JSON.parse(draft.query) as Record<string, unknown>, headers: JSON.parse(draft.headers) as Record<string, unknown>, body: JSON.parse(draft.body) as unknown }],
  };
}

export function SettingsPanel({ open, onOpenChange, api }: SettingsPanelProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [vendors, setVendors] = useState<VendorInfo[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [maxTokens, setMaxTokens] = useState(8192);
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(1);
  const [enableSearch, setEnableSearch] = useState(false);
  const [thinkingMode, setThinkingMode] = useState(false);
  const [skillFilter, setSkillFilter] = useState("");
  const [databaseDraft, setDatabaseDraft] = useState<DatabaseDraft | null>(null);
  const [editingDatabase, setEditingDatabase] = useState<SkillManifest | null>(null);
  const [pendingUpload, setPendingUpload] = useState<{ file: File; validation: SkillValidation } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: "database" | "skill"; name: string; label: string } | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [uploading, setUploading] = useState(false);

  const refreshSkills = useCallback(async () => setSkills(await api.fetchSkills()), [api]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSettings, nextVendors, nextSkills] = await Promise.all([api.fetchSettings(), api.fetchVendors(), api.fetchSkills()]);
      setSettings(nextSettings); setVendors(nextVendors); setSkills(nextSkills);
      setBaseUrl(nextSettings.base_url); setApiKey(""); setModelName(nextSettings.model_name); setMaxTokens(nextSettings.max_tokens);
      setTemperature(nextSettings.advanced.temperature ?? 0.7); setTopP(nextSettings.advanced.top_p ?? 1);
      setEnableSearch(nextSettings.advanced.enable_search ?? false); setThinkingMode(nextSettings.advanced.thinking_mode ?? false);
    } catch (error) { toast.error("设置加载失败", { description: errorText(error) }); }
    finally { setLoading(false); }
  }, [api]);

  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, open]);

  const databases = useMemo(() => skills.filter((skill) => skill.user_selectable && skill.supported_sources.length > 0), [skills]);
  const filteredSkills = useMemo(() => {
    const query = skillFilter.trim().toLowerCase();
    return skills.filter((skill) => !query || [skill.name, skill.display_name, skill.category, skill.origin].some((value) => value.toLowerCase().includes(query)));
  }, [skillFilter, skills]);

  const saveModel = async () => {
    setSaving(true);
    try {
      const payload: ModelSettingsUpdate = { base_url: baseUrl, model_name: modelName, max_tokens: maxTokens, temperature, top_p: topP, enable_search: enableSearch, thinking_mode: thinkingMode };
      if (apiKey) payload.api_key = apiKey;
      const updated = await api.saveSettings(payload); setSettings(updated); setApiKey("");
      toast.success("模型设置已保存");
    } catch (error) { toast.error("模型设置保存失败", { description: errorText(error) }); }
    finally { setSaving(false); }
  };

  const mutateSkill = async (action: () => Promise<void>, success: string) => {
    try { await action(); await refreshSkills(); toast.success(success); }
    catch (error) { toast.error("操作失败", { description: errorText(error) }); }
  };

  const chooseUpload = async (file: File | undefined) => {
    if (!file) return;
    try { setPendingUpload({ file, validation: await api.validateSkill(file) }); }
    catch (error) { toast.error("文件验证失败", { description: errorText(error) }); }
  };

  const previewModels = async () => {
    setModelsLoading(true);
    try { setModels(await api.fetchModels({ baseUrl, apiKey: apiKey || undefined })); }
    catch (error) { toast.error("模型列表加载失败", { description: errorText(error) }); }
    finally { setModelsLoading(false); }
  };

  const confirmUpload = async () => {
    if (!pendingUpload) return;
    setUploading(true);
    try { await api.uploadSkill(pendingUpload.file); setPendingUpload(null); await refreshSkills(); toast.success("技能已安装"); }
    catch (error) { toast.error("技能安装失败", { description: errorText(error) }); }
    finally { setUploading(false); }
  };

  const saveDatabase = async () => {
    if (!databaseDraft) return;
    try {
      if (editingDatabase) {
        await api.updateDatabase(editingDatabase.name, {
          display_name: databaseDraft.displayName,
          description: databaseDraft.description,
          operation: {
            name: databaseDraft.operation,
            description: `Search ${databaseDraft.displayName}`,
            method: databaseDraft.method,
            url: databaseDraft.url,
            query: JSON.parse(databaseDraft.query) as Record<string, unknown>,
            headers: JSON.parse(databaseDraft.headers) as Record<string, unknown>,
            body: JSON.parse(databaseDraft.body) as unknown,
          },
        });
      } else {
        await api.createDatabase(databaseManifest(databaseDraft));
      }
      setDatabaseDraft(null); setEditingDatabase(null); await refreshSkills(); toast.success("数据库目录已更新");
    } catch (error) { toast.error("数据库保存失败", { description: errorText(error) }); }
  };

  const editDatabase = async (database: SkillManifest) => {
    try {
      const detail = await api.fetchSkill(database.name);
      const manifest = detail.declarative_manifest;
      const operation = manifest?.operations[0];
      if (!manifest || !operation) throw new Error("数据库缺少可编辑的声明式操作");
      setEditingDatabase(database);
      setDatabaseDraft({ name: manifest.name, displayName: manifest.display_name, description: manifest.description, url: operation.url, operation: operation.name, method: operation.method, query: JSON.stringify(operation.query ?? {}), headers: JSON.stringify(operation.headers ?? {}), body: JSON.stringify(operation.body ?? null) });
    } catch (error) { toast.error("数据库详情加载失败", { description: errorText(error) }); }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    await mutateSkill(
      () => target.kind === "database" ? api.deleteDatabase(target.name) : api.deleteSkill(target.name),
      target.kind === "database" ? "数据库已删除" : "技能已删除",
    );
  };

  const showSkillDetail = async (name: string) => {
    try { setSkillDetail(await api.fetchSkill(name)); }
    catch (error) { toast.error("技能详情加载失败", { description: errorText(error) }); }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[calc(100svh-2rem)] min-h-0 w-[min(70rem,calc(100vw-2rem))] max-w-none flex-col" showCloseButton>
          <DialogHeader><DialogTitle>设置</DialogTitle><DialogDescription>管理模型连接、数据库目录和 Agent 技能。</DialogDescription></DialogHeader>
          {loading ? <div className="flex flex-col gap-3"><Skeleton className="h-8 w-72" /><Skeleton className="h-64 w-full" /></div> : (
            <Tabs defaultValue="model" className="min-h-0 flex-1">
              <TabsList><TabsTrigger value="model">Model</TabsTrigger><TabsTrigger value="databases">Databases</TabsTrigger><TabsTrigger value="skills">Skills</TabsTrigger></TabsList>
              <TabsContent value="model" className="min-h-0 overflow-auto py-2">
                <Card><CardHeader><CardTitle>模型连接</CardTitle><CardDescription>新任务会使用保存后的配置；运行中的模型实例保持不变。</CardDescription></CardHeader>
                  <CardContent><FieldGroup>
                    <Field><FieldLabel>Vendor</FieldLabel><div className="flex flex-wrap gap-2">{vendors.map((vendor) => <Button key={vendor.id} type="button" size="sm" variant="outline" onClick={() => setBaseUrl(vendor.base_url)}>{vendor.name}{vendor.recommended ? " · 推荐" : ""}</Button>)}</div></Field>
                    <Field><FieldLabel htmlFor="model-base-url">Base URL</FieldLabel><Input id="model-base-url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} /></Field>
                    <Field><FieldLabel htmlFor="model-api-key">API Key</FieldLabel><Input id="model-api-key" type="password" value={apiKey} placeholder={settings?.api_key_configured ? "已配置；输入新密钥以替换" : "输入 API Key"} onChange={(event) => setApiKey(event.target.value)} /><FieldDescription>为安全起见，已保存的密钥不会回填到输入框。</FieldDescription></Field>
                    <Field><FieldLabel htmlFor="model-name">Model</FieldLabel><div className="flex gap-2"><Input id="model-name" value={modelName} onChange={(event) => setModelName(event.target.value)} /><Button type="button" variant="outline" onClick={() => void previewModels()} disabled={modelsLoading}>{modelsLoading && <Spinner data-icon="inline-start" />}加载模型</Button></div>{models.length > 0 && <div className="flex flex-wrap gap-2">{models.map((model) => <Button key={model.id} type="button" size="sm" variant={model.id === modelName ? "secondary" : "outline"} onClick={() => setModelName(model.id)}>{model.name}</Button>)}</div>}</Field>
                    <Field><FieldLabel htmlFor="max-tokens">Max tokens</FieldLabel><Input id="max-tokens" type="number" value={maxTokens} onChange={(event) => setMaxTokens(Number(event.target.value))} /></Field>
                    <div className="grid gap-4 md:grid-cols-2"><Field><FieldLabel htmlFor="temperature">Temperature</FieldLabel><Input id="temperature" type="number" step="0.1" value={temperature} onChange={(event) => setTemperature(Number(event.target.value))} /></Field><Field><FieldLabel htmlFor="top-p">Top P</FieldLabel><Input id="top-p" type="number" step="0.1" value={topP} onChange={(event) => setTopP(Number(event.target.value))} /></Field></div>
                    <Field><FieldLabel>Advanced</FieldLabel><div className="flex flex-wrap gap-2"><Toggle variant="outline" pressed={enableSearch} onPressedChange={setEnableSearch}>联网搜索</Toggle><Toggle variant="outline" pressed={thinkingMode} onPressedChange={setThinkingMode}>思考模式</Toggle></div></Field>
                  </FieldGroup></CardContent><CardFooter className="justify-end"><Button onClick={() => void saveModel()} disabled={saving}>{saving && <Spinner data-icon="inline-start" />}保存模型设置</Button></CardFooter>
                </Card>
              </TabsContent>
              <TabsContent value="databases" className="min-h-0 overflow-auto py-2">
                <Card><CardHeader><CardTitle>数据库目录</CardTitle><CardDescription>数据库是可选择、声明式的检索技能投影。</CardDescription></CardHeader><CardContent>
                  <div className="mb-3 flex flex-wrap justify-end gap-2"><Field><FieldLabel htmlFor="database-upload" className="sr-only">上传数据库包</FieldLabel><Input id="database-upload" type="file" accept=".json,.yaml,.yml,.zip" onChange={(event) => void chooseUpload(event.target.files?.[0])} /></Field><Button size="sm" onClick={() => { setEditingDatabase(null); setDatabaseDraft(EMPTY_DATABASE); }}><DatabaseIcon data-icon="inline-start" />新建数据库</Button></div>
                  <Table><TableHeader><TableRow><TableHead>名称</TableHead><TableHead>来源</TableHead><TableHead>版本</TableHead><TableHead>可用性</TableHead><TableHead>Pipeline</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{databases.map((database) => <TableRow key={database.name}><TableCell><div className="font-medium">{database.display_name}</div><div className="text-xs text-muted-foreground">{database.description}</div></TableCell><TableCell><Badge variant="outline">{database.origin}</Badge></TableCell><TableCell>{database.version}</TableCell><TableCell><Toggle variant="outline" pressed={database.enabled} disabled={database.origin === "builtin"} aria-label={`${database.enabled ? "停用" : "启用"} ${database.display_name}`} onPressedChange={(pressed) => void mutateSkill(() => api.setSkillEnabled(database.name, pressed), "数据库状态已更新")}>{database.enabled ? "已启用" : "已停用"}</Toggle></TableCell><TableCell><Badge variant={database.pipeline_supported ? "secondary" : "outline"}>{database.pipeline_supported ? "支持" : "Agent"}</Badge></TableCell><TableCell className="text-right">{database.origin === "package" && <div className="flex justify-end gap-1"><Button size="icon-sm" variant="ghost" aria-label={`编辑 ${database.display_name}`} onClick={() => void editDatabase(database)}><GearIcon /></Button><Button size="icon-sm" variant="ghost" aria-label={`删除 ${database.display_name}`} onClick={() => setPendingDelete({ kind: "database", name: database.name, label: database.display_name })}><TrashIcon /></Button></div>}</TableCell></TableRow>)}</TableBody></Table>
                </CardContent></Card>
              </TabsContent>
              <TabsContent value="skills" className="min-h-0 overflow-auto py-2">
                <Card><CardHeader><CardTitle>技能管理</CardTitle><CardDescription>筛选、启停、回滚或安装技能包。</CardDescription></CardHeader><CardContent>
                  <div className="mb-3 flex flex-wrap items-center gap-2"><Input className="max-w-xs" placeholder="筛选技能" value={skillFilter} onChange={(event) => setSkillFilter(event.target.value)} /><Field><FieldLabel htmlFor="skill-upload" className="sr-only">上传技能</FieldLabel><Input id="skill-upload" type="file" accept=".json,.yaml,.yml,.zip" onChange={(event) => void chooseUpload(event.target.files?.[0])} /></Field></div>
                  {filteredSkills.length === 0 ? <Empty><EmptyHeader><EmptyTitle>没有匹配的技能</EmptyTitle><EmptyDescription>调整名称、分类、来源或状态筛选。</EmptyDescription></EmptyHeader></Empty> : <Table><TableHeader><TableRow><TableHead>技能</TableHead><TableHead>分类</TableHead><TableHead>状态</TableHead><TableHead>操作 / 版本</TableHead><TableHead className="text-right">管理</TableHead></TableRow></TableHeader><TableBody>{filteredSkills.map((skill) => <TableRow key={skill.name}><TableCell><div className="font-medium">{skill.display_name}</div><div className="text-xs text-muted-foreground">{skill.description}</div>{skill.load_error && <div className="text-xs text-destructive">{skill.load_error}</div>}</TableCell><TableCell><Badge variant="outline">{skill.category}</Badge> <Badge variant="secondary">{skill.origin}</Badge></TableCell><TableCell>{skill.available === false ? <Badge variant="destructive">不可用</Badge> : <Toggle variant="outline" pressed={skill.enabled} aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.display_name}`} disabled={skill.origin === "builtin"} onPressedChange={(pressed) => void mutateSkill(() => api.setSkillEnabled(skill.name, pressed), "技能状态已更新")}>{skill.enabled ? "已启用" : "已停用"}</Toggle>}</TableCell><TableCell><div>{skill.operations.join(", ") || "无操作"}</div><div className="text-xs text-muted-foreground">v{skill.version}</div></TableCell><TableCell className="text-right"><div className="flex justify-end gap-1"><Button size="sm" variant="ghost" aria-label={`查看 ${skill.display_name}`} onClick={() => void showSkillDetail(skill.name)}>详情</Button>{skill.origin === "package" && <><Button size="icon-sm" variant="ghost" aria-label={`回滚 ${skill.display_name}`} onClick={() => void mutateSkill(() => api.rollbackSkill(skill.name), "技能已回滚")}><ArrowCounterClockwiseIcon /></Button><Button size="icon-sm" variant="ghost" aria-label={`删除 ${skill.display_name}`} onClick={() => setPendingDelete({ kind: "skill", name: skill.name, label: skill.display_name })}><TrashIcon /></Button></>}</div></TableCell></TableRow>)}</TableBody></Table>}
                </CardContent></Card>
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={databaseDraft !== null} onOpenChange={(next) => { if (!next) setDatabaseDraft(null); }}><DialogContent className="max-h-[calc(100svh-2rem)] overflow-auto"><DialogHeader><DialogTitle>{editingDatabase ? "编辑数据库" : "新建数据库"}</DialogTitle><DialogDescription>编辑完整 URL 和基础请求模板；保存时保持声明式操作定义。</DialogDescription></DialogHeader>{databaseDraft && <FieldGroup><Field><FieldLabel htmlFor="database-name">Name</FieldLabel><Input id="database-name" disabled={editingDatabase !== null} value={databaseDraft.name} onChange={(event) => setDatabaseDraft({ ...databaseDraft, name: event.target.value })} /></Field><Field><FieldLabel htmlFor="database-display">Display name</FieldLabel><Input id="database-display" value={databaseDraft.displayName} onChange={(event) => setDatabaseDraft({ ...databaseDraft, displayName: event.target.value })} /></Field><Field><FieldLabel htmlFor="database-description">Description</FieldLabel><Textarea id="database-description" value={databaseDraft.description} onChange={(event) => setDatabaseDraft({ ...databaseDraft, description: event.target.value })} /></Field><Field><FieldLabel htmlFor="database-url">Base URL</FieldLabel><Input id="database-url" value={databaseDraft.url} onChange={(event) => setDatabaseDraft({ ...databaseDraft, url: event.target.value })} /></Field><Field><FieldLabel htmlFor="database-method">Method</FieldLabel><Input id="database-method" value={databaseDraft.method} onChange={(event) => setDatabaseDraft({ ...databaseDraft, method: event.target.value.toUpperCase() as DatabaseDraft["method"] })} /></Field><Field><FieldLabel htmlFor="database-operation">Search operation</FieldLabel><Input id="database-operation" value={databaseDraft.operation} onChange={(event) => setDatabaseDraft({ ...databaseDraft, operation: event.target.value })} /></Field><Field><FieldLabel htmlFor="database-query">Query template</FieldLabel><Textarea id="database-query" value={databaseDraft.query} onChange={(event) => setDatabaseDraft({ ...databaseDraft, query: event.target.value })} /></Field><Field><FieldLabel htmlFor="database-headers">Headers template</FieldLabel><Textarea id="database-headers" value={databaseDraft.headers} onChange={(event) => setDatabaseDraft({ ...databaseDraft, headers: event.target.value })} /></Field><Field><FieldLabel htmlFor="database-body">Body template</FieldLabel><Textarea id="database-body" value={databaseDraft.body} onChange={(event) => setDatabaseDraft({ ...databaseDraft, body: event.target.value })} /></Field></FieldGroup>}<DialogFooter><Button onClick={() => void saveDatabase()}>保存数据库</Button></DialogFooter></DialogContent></Dialog>

      <Dialog open={skillDetail !== null} onOpenChange={(next) => { if (!next) setSkillDetail(null); }}><DialogContent><DialogHeader><DialogTitle>{skillDetail?.manifest.display_name ?? "技能详情"}</DialogTitle><DialogDescription>当前版本、操作与加载状态。</DialogDescription></DialogHeader>{skillDetail && <Card><CardHeader><CardTitle>v{skillDetail.current_version}</CardTitle><CardDescription>{skillDetail.manifest.description}</CardDescription></CardHeader><CardContent><div className="flex flex-col gap-2"><div>操作：{skillDetail.manifest.operations.join(", ") || "无"}</div><div>可用：{skillDetail.available ? "是" : "否"}</div>{skillDetail.load_error && <Alert variant="destructive"><AlertTitle>加载失败</AlertTitle><AlertDescription>{skillDetail.load_error}</AlertDescription></Alert>}</div></CardContent></Card>}</DialogContent></Dialog>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(next) => { if (!next) setPendingDelete(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认删除</AlertDialogTitle><AlertDialogDescription>删除“{pendingDelete?.label}”及其用户版本后无法恢复。内置项目不会提供删除操作。</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>取消</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={(event) => { event.preventDefault(); void confirmDelete(); }}>确认删除</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>

      <AlertDialog open={pendingUpload !== null} onOpenChange={(next) => { if (!next && !uploading) setPendingUpload(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认安装技能</AlertDialogTitle><AlertDialogDescription>已验证 {pendingUpload?.validation.skill.display_name} v{pendingUpload?.validation.skill.version}。</AlertDialogDescription></AlertDialogHeader>{pendingUpload?.validation.warning && <Alert><UploadSimpleIcon /><AlertTitle>本地代码执行警告</AlertTitle><AlertDescription>{pendingUpload.validation.warning}</AlertDescription></Alert>}<AlertDialogFooter><AlertDialogCancel disabled={uploading}>取消</AlertDialogCancel><AlertDialogAction disabled={uploading} onClick={(event) => { event.preventDefault(); void confirmUpload(); }}>{uploading && <Spinner data-icon="inline-start" />}确认安装</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </>
  );
}
