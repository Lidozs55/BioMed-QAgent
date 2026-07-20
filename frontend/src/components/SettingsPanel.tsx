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
import type { ModelInfo, ModelSettings, SettingsAPIClient, SkillManifest, SkillValidation, VendorInfo } from "@/hooks/useAPI";

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
  baseUrl: string;
  operation: string;
}

const EMPTY_DATABASE: DatabaseDraft = { name: "", displayName: "", description: "", baseUrl: "", operation: "search" };

function databaseManifest(draft: DatabaseDraft, version = "1.0.0"): Record<string, unknown> {
  return {
    schema_version: "1.0", name: draft.name, display_name: draft.displayName,
    version, category: "discovery", description: draft.description,
    supported_sources: [draft.name], user_selectable: true, pipeline_supported: false,
    operations: [{ name: draft.operation, description: `Search ${draft.displayName}`, method: "GET", url: `${draft.baseUrl.replace(/\/$/, "")}/{query}` }],
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
      const payload: Record<string, unknown> = { base_url: baseUrl, model_name: modelName, max_tokens: maxTokens, temperature, top_p: topP, enable_search: enableSearch, thinking_mode: thinkingMode };
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
      const manifest = databaseManifest(databaseDraft, editingDatabase?.version ?? "1.0.0");
      if (editingDatabase) await api.updateDatabase(editingDatabase.name, manifest); else await api.createDatabase(manifest);
      setDatabaseDraft(null); setEditingDatabase(null); await refreshSkills(); toast.success("数据库目录已更新");
    } catch (error) { toast.error("数据库保存失败", { description: errorText(error) }); }
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
                  <Table><TableHeader><TableRow><TableHead>名称</TableHead><TableHead>来源</TableHead><TableHead>版本</TableHead><TableHead>可用性</TableHead><TableHead>Pipeline</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader><TableBody>{databases.map((database) => <TableRow key={database.name}><TableCell><div className="font-medium">{database.display_name}</div><div className="text-xs text-muted-foreground">{database.description}</div></TableCell><TableCell><Badge variant="outline">{database.origin}</Badge></TableCell><TableCell>{database.version}</TableCell><TableCell><Toggle variant="outline" pressed={database.enabled} aria-label={`${database.enabled ? "停用" : "启用"} ${database.display_name}`} onPressedChange={(pressed) => void mutateSkill(() => api.setSkillEnabled(database.name, pressed), "数据库状态已更新")}>{database.enabled ? "已启用" : "已停用"}</Toggle></TableCell><TableCell><Badge variant={database.pipeline_supported ? "secondary" : "outline"}>{database.pipeline_supported ? "支持" : "Agent"}</Badge></TableCell><TableCell className="text-right">{database.origin === "package" && <div className="flex justify-end gap-1"><Button size="icon-sm" variant="ghost" aria-label={`编辑 ${database.display_name}`} onClick={() => { setEditingDatabase(database); setDatabaseDraft({ name: database.name, displayName: database.display_name, description: database.description, baseUrl: "https://example.com", operation: database.operations[0] ?? "search" }); }}><GearIcon /></Button><Button size="icon-sm" variant="ghost" aria-label={`删除 ${database.display_name}`} onClick={() => void mutateSkill(() => api.deleteDatabase(database.name), "数据库已删除")}><TrashIcon /></Button></div>}</TableCell></TableRow>)}</TableBody></Table>
                </CardContent></Card>
              </TabsContent>
              <TabsContent value="skills" className="min-h-0 overflow-auto py-2">
                <Card><CardHeader><CardTitle>技能管理</CardTitle><CardDescription>筛选、启停、回滚或安装技能包。</CardDescription></CardHeader><CardContent>
                  <div className="mb-3 flex flex-wrap items-center gap-2"><Input className="max-w-xs" placeholder="筛选技能" value={skillFilter} onChange={(event) => setSkillFilter(event.target.value)} /><Field><FieldLabel htmlFor="skill-upload" className="sr-only">上传技能</FieldLabel><Input id="skill-upload" type="file" accept=".json,.yaml,.yml,.zip" onChange={(event) => void chooseUpload(event.target.files?.[0])} /></Field></div>
                  {filteredSkills.length === 0 ? <Empty><EmptyHeader><EmptyTitle>没有匹配的技能</EmptyTitle><EmptyDescription>调整名称、分类、来源或状态筛选。</EmptyDescription></EmptyHeader></Empty> : <Table><TableHeader><TableRow><TableHead>技能</TableHead><TableHead>分类</TableHead><TableHead>状态</TableHead><TableHead>操作 / 版本</TableHead><TableHead className="text-right">管理</TableHead></TableRow></TableHeader><TableBody>{filteredSkills.map((skill) => <TableRow key={skill.name}><TableCell><div className="font-medium">{skill.display_name}</div><div className="text-xs text-muted-foreground">{skill.description}</div></TableCell><TableCell><Badge variant="outline">{skill.category}</Badge> <Badge variant="secondary">{skill.origin}</Badge></TableCell><TableCell><Toggle variant="outline" pressed={skill.enabled} aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.display_name}`} disabled={skill.origin === "builtin"} onPressedChange={(pressed) => void mutateSkill(() => api.setSkillEnabled(skill.name, pressed), "技能状态已更新")}>{skill.enabled ? "已启用" : "已停用"}</Toggle></TableCell><TableCell><div>{skill.operations.join(", ") || "无操作"}</div><div className="text-xs text-muted-foreground">v{skill.version}</div></TableCell><TableCell className="text-right">{skill.origin === "package" && <div className="flex justify-end gap-1"><Button size="icon-sm" variant="ghost" aria-label={`回滚 ${skill.display_name}`} onClick={() => void mutateSkill(() => api.rollbackSkill(skill.name), "技能已回滚")}><ArrowCounterClockwiseIcon /></Button><Button size="icon-sm" variant="ghost" aria-label={`删除 ${skill.display_name}`} onClick={() => void mutateSkill(() => api.deleteSkill(skill.name), "技能已删除")}><TrashIcon /></Button></div>}</TableCell></TableRow>)}</TableBody></Table>}
                </CardContent></Card>
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={databaseDraft !== null} onOpenChange={(next) => { if (!next) setDatabaseDraft(null); }}><DialogContent><DialogHeader><DialogTitle>{editingDatabase ? "编辑数据库" : "新建数据库"}</DialogTitle><DialogDescription>创建一个仅包含基础 GET 搜索操作的声明式目录项。</DialogDescription></DialogHeader>{databaseDraft && <FieldGroup><Field><FieldLabel htmlFor="database-name">Name</FieldLabel><Input id="database-name" disabled={editingDatabase !== null} value={databaseDraft.name} onChange={(event) => setDatabaseDraft({ ...databaseDraft, name: event.target.value })} /></Field><Field><FieldLabel htmlFor="database-display">Display name</FieldLabel><Input id="database-display" value={databaseDraft.displayName} onChange={(event) => setDatabaseDraft({ ...databaseDraft, displayName: event.target.value })} /></Field><Field><FieldLabel htmlFor="database-description">Description</FieldLabel><Textarea id="database-description" value={databaseDraft.description} onChange={(event) => setDatabaseDraft({ ...databaseDraft, description: event.target.value })} /></Field><Field><FieldLabel htmlFor="database-url">Base URL</FieldLabel><Input id="database-url" value={databaseDraft.baseUrl} onChange={(event) => setDatabaseDraft({ ...databaseDraft, baseUrl: event.target.value })} /></Field><Field><FieldLabel htmlFor="database-operation">Search operation</FieldLabel><Input id="database-operation" value={databaseDraft.operation} onChange={(event) => setDatabaseDraft({ ...databaseDraft, operation: event.target.value })} /></Field></FieldGroup>}<DialogFooter><Button onClick={() => void saveDatabase()}>保存数据库</Button></DialogFooter></DialogContent></Dialog>

      <AlertDialog open={pendingUpload !== null} onOpenChange={(next) => { if (!next && !uploading) setPendingUpload(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>确认安装技能</AlertDialogTitle><AlertDialogDescription>已验证 {pendingUpload?.validation.skill.display_name} v{pendingUpload?.validation.skill.version}。</AlertDialogDescription></AlertDialogHeader>{pendingUpload?.validation.warning && <Alert><UploadSimpleIcon /><AlertTitle>本地代码执行警告</AlertTitle><AlertDescription>{pendingUpload.validation.warning}</AlertDescription></Alert>}<AlertDialogFooter><AlertDialogCancel disabled={uploading}>取消</AlertDialogCancel><AlertDialogAction disabled={uploading} onClick={(event) => { event.preventDefault(); void confirmUpload(); }}>{uploading && <Spinner data-icon="inline-start" />}确认安装</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </>
  );
}
