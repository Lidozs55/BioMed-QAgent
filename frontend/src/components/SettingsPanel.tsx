import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowCounterClockwiseIcon, DatabaseIcon, EyeClosedIcon, EyeIcon, GearIcon, Image, SpeakerHigh, TrashIcon, UploadSimpleIcon, VideoCamera } from "@phosphor-icons/react";
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
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Toggle } from "@/components/ui/toggle";
import { RichModelInfo, ModelInfoCard } from "@/components/model-info-card";
import { EMPTY_DATABASE, databaseManifest, hasDatabaseErrors, parseHttpMethod, parseJsonBody, parseJsonTemplate, validateDatabaseDraft, type DatabaseDraft } from "@/lib/databaseDraft";
import { cn } from "@/lib/utils";
import type { ModelSettings, ModelSettingsUpdate, SettingsAPIClient, SkillDetail, SkillManifest, SkillValidation, VendorInfo } from "@/hooks/useAPI";

/* ------------------------------------------------------------------ */
/*  Props                                                             */
/* ------------------------------------------------------------------ */
interface SettingsPanelProps {
  open: boolean; onOpenChange: (open: boolean) => void; api: SettingsAPIClient;
}

/* ------------------------------------------------------------------ */
/*  Error helpers                                                     */
/* ------------------------------------------------------------------ */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : "请求失败";
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */
export function SettingsPanel({ open, onOpenChange, api }: SettingsPanelProps) {
  /* ---- refs ---- */
  const apiKeyDirtyRef = useRef(false);
  const saveSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  /* ---- core state ---- */
  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [vendors, setVendors] = useState<VendorInfo[]>([]);
  const [models, setModels] = useState<RichModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);

  /* ---- inline model form state ---- */
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [maxTokens, setMaxTokens] = useState(8192);
  const [temperature, setTemperature] = useState(0.7);
  const [topP, setTopP] = useState(1);
  const [enableSearch, setEnableSearch] = useState(false);
  const [thinkingMode, setThinkingMode] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /* ---- skill / database state ---- */
  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [skillFilter, setSkillFilter] = useState("");
  const [databaseDraft, setDatabaseDraft] = useState<DatabaseDraft | null>(null);
  const [editingDatabase, setEditingDatabase] = useState<SkillManifest | null>(null);
  const [pendingUpload, setPendingUpload] = useState<{ file: File; validation: SkillValidation } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ kind: "database" | "skill"; name: string; label: string } | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [uploading, setUploading] = useState(false);

  /* ---- computed ---- */
  const databases = skills.filter((s) => s.user_selectable && s.supported_sources.length > 0);

  const filteredSkills = skills.filter((s) => {
    const q = skillFilter.trim().toLowerCase();
    return !q || [s.name, s.display_name, s.category, s.origin].some((v) => v.toLowerCase().includes(q));
  });

  const filteredModels = models.filter((m) => {
    const q = modelSearch.trim().toLowerCase();
    return !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
  });

  const selectedModel = models.find((m) => m.id === modelName) ?? null;

  /* ---- dirty tracker ---- */
  const markDirty = useCallback(() => setDirty(true), []);

  /* ---- data loading ---- */
  const refreshSkills = useCallback(async () => setSkills(await api.fetchSkills()), [api]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSettings, nextVendors, nextSkills] = await Promise.all([api.fetchSettings(), api.fetchVendors(), api.fetchSkills()]);
      setSettings(nextSettings);
      setVendors(nextVendors);
      setSkills(nextSkills);
      setBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1");
      setApiKey("");
      apiKeyDirtyRef.current = false;
      setModelName(nextSettings.model_name);
      setMaxTokens(nextSettings.max_tokens);
      setTemperature(nextSettings.advanced.temperature ?? 0.7);
      setTopP(nextSettings.advanced.top_p ?? 1);
      setEnableSearch(nextSettings.advanced.enable_search ?? false);
      setThinkingMode(nextSettings.advanced.thinking_mode ?? false);
      setModels([]);
      setModelSearch("");
      setShowModelDropdown(false);
      setDirty(false);
      setModelError(null);
    } catch (error) {
      toast.error("设置加载失败", { description: errorText(error) });
    } finally {
      setLoading(false);
    }
    abortRef.current = null;
  }, [api]);

  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setTimeout(() => {
      setModelsLoaded(false);
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, open, setModelsLoaded]);

  /* ---- model form save with key-clear semantics ---- */
  const saveModel = async () => {
    if (!modelName.trim()) {
      setModelError("请填写模型名称，例如 qwen-plus");
      return;
    }
    if (models.length > 0 && !models.find((m) => m.id === modelName)) {
      setModelError(`模型名称 "${modelName}" 不在可用列表中，请检查拼写是否正确，或从下拉菜单中选择`);
      return;
    }
    setModelError(null);

    const seq = ++saveSeqRef.current;
    setSaving(true);
    try {
      // Verify API key works with current base URL
      try {
        await api.fetchModels({ baseUrl, apiKey });
      } catch {
        setSaving(false);
        setModelError("API 密钥验证失败，请检查密钥是否正确或与 Base URL 是否匹配");
        return;
      }

      const payload: Record<string, unknown> = {};
      if (baseUrl !== settings?.base_url) payload.base_url = baseUrl;
      if (modelName !== settings?.model_name) payload.model_name = modelName;
      if (maxTokens !== settings?.max_tokens) payload.max_tokens = maxTokens;
      if (temperature !== (settings?.advanced.temperature ?? 0.7)) payload.temperature = temperature;
      if (topP !== (settings?.advanced.top_p ?? 1)) payload.top_p = topP;
      if (enableSearch !== (settings?.advanced.enable_search ?? false)) payload.enable_search = enableSearch;
      if (thinkingMode !== (settings?.advanced.thinking_mode ?? false)) payload.thinking_mode = thinkingMode;

      if (Object.keys(payload).length === 0) {
        setDirty(false);
        onOpenChange(false);
        return;
      }

      const updated = await api.saveSettings(payload as ModelSettingsUpdate);
      if (saveSeqRef.current !== seq) return; // superseded

      setSettings(updated);
      setApiKey("");
      setModelSearch("");
      setShowModelDropdown(false);
      apiKeyDirtyRef.current = false;
      setDirty(false);
      setModelsLoaded(true);

      toast.success("模型设置已保存");
      onOpenChange(false);

      // Model discovery — non-blocking after save
      setModelsLoading(true);
      try {
        const freshModels = (await api.fetchModels({ baseUrl: updated.base_url })) as RichModelInfo[];
        if (saveSeqRef.current === seq) setModels(freshModels);
      } catch {
        // Discovery failure must not revert the save success
      } finally {
        if (saveSeqRef.current === seq) setModelsLoading(false);
      }
    } catch (error) {
      const msg = errorText(error);
      setModelError(msg);
      toast.error("模型设置保存失败", { description: msg });
    } finally {
      if (saveSeqRef.current === seq) setSaving(false);
    }
  };

  /* ---- preview models ---- */
  const previewModels = useCallback(async () => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setModelsLoading(true);
    try {
      const fresh = (await api.fetchModels({ baseUrl, apiKey: apiKeyDirtyRef.current ? apiKey : undefined })) as RichModelInfo[];
      if (!abort.signal.aborted) { setModels(fresh); setModelsLoaded(true); }
    } catch (error) {
      if (!abort.signal.aborted) toast.error("模型列表加载失败", { description: errorText(error) });
    } finally {
      if (!abort.signal.aborted) setModelsLoading(false);
    }
  }, [api, baseUrl, apiKey, setModelsLoaded]);

  /* ---- model search / select ---- */
  const handleModelSearchChange = useCallback((value: string) => {
    setModelSearch(value);
    setShowModelDropdown(true);
  }, []);

  const handleModelSelect = useCallback((id: string) => {
    setModelName(id);
    setModelSearch("");
    setShowModelDropdown(false);
    markDirty();
    setModelError(null);
  }, [markDirty]);

  /* ---- database / skill handlers ---- */
  const mutateSkill = async (action: () => Promise<void>, success: string) => {
    try {
      await action();
      await refreshSkills();
      toast.success(success);
    } catch (error) {
      toast.error("操作失败", { description: errorText(error) });
    }
  };

  const chooseUpload = async (file: File | undefined) => {
    if (!file) return;
    try {
      setPendingUpload({ file, validation: await api.validateSkill(file) });
    } catch (error) {
      toast.error("文件验证失败", { description: errorText(error) });
    }
  };

  const confirmUpload = async () => {
    if (!pendingUpload) return;
    setUploading(true);
    try {
      await api.uploadSkill(pendingUpload.file);
      setPendingUpload(null);
      await refreshSkills();
      toast.success("技能已安装");
    } catch (e) { toast.error("技能安装失败", { description: errorText(e) }); }
    finally { setUploading(false); }
  };

  const editDatabase = async (db: SkillManifest) => {
    try {
      const detail = await api.fetchSkill(db.name);
      const op = detail.declarative_manifest?.operations[0];
      if (!detail.declarative_manifest || !op) throw new Error("缺少操作");
      setEditingDatabase(db);
      setDatabaseDraft({
        name: detail.declarative_manifest.name, displayName: detail.declarative_manifest.display_name,
        description: detail.declarative_manifest.description, url: op.url, operation: op.name,
        method: op.method, query: JSON.stringify(op.query ?? {}),
        headers: JSON.stringify(op.headers ?? {}), body: JSON.stringify(op.body ?? null),
      });
    } catch (e) { toast.error("数据库详情加载失败", { description: errorText(e) }); }
  };

  const showSkillDetail = async (name: string) => {
    try {
      setSkillDetail(await api.fetchSkill(name));
    } catch (error) {
      toast.error("技能详情加载失败", { description: errorText(error) });
    }
  };

  const saveDatabase = async () => {
    if (!databaseDraft) return;
    try {
      const errors = hasDatabaseErrors(validateDatabaseDraft(databaseDraft));
      if (errors) throw new Error("请先修正字段错误");
      if (editingDatabase) {
        await api.updateDatabase(editingDatabase.name, {
          display_name: databaseDraft.displayName, description: databaseDraft.description,
          operation: {
            name: databaseDraft.operation, description: `Search ${databaseDraft.displayName}`,
            method: parseHttpMethod(databaseDraft.method), url: databaseDraft.url,
            query: parseJsonTemplate(databaseDraft.query), headers: parseJsonTemplate(databaseDraft.headers),
            body: parseJsonBody(databaseDraft.body),
          },
        });
      } else {
        await api.createDatabase(databaseManifest(databaseDraft));
      }
      setDatabaseDraft(null);
      setEditingDatabase(null);
      await refreshSkills();
      toast.success("数据库目录已更新");
    } catch (error) {
      toast.error("数据库保存失败", { description: errorText(error) });
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const t = pendingDelete;
    setPendingDelete(null);
    await mutateSkill(
      () => t.kind === "database" ? api.deleteDatabase(t.name) : api.deleteSkill(t.name),
      t.kind === "database" ? "数据库已删除" : "技能已删除",
    );
  };

  /* ================================================================== */
  /*  Render                                                            */
  /* ================================================================== */
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[calc(100svh-2rem)] min-h-0 w-[min(90rem,calc(100vw-2rem))] max-w-none sm:max-w-none flex-col" showCloseButton>
          <DialogHeader>
            <DialogTitle>设置</DialogTitle>
            <DialogDescription>管理模型连接、数据库目录和 Agent 技能。</DialogDescription>
          </DialogHeader>

          {loading ? (
            <div className="flex flex-col gap-3">
              <Skeleton className="h-8 w-72" />
              <Skeleton className="h-64 w-full" />
            </div>
          ) : (
            <Tabs defaultValue="model" className="min-h-0 flex-1">
              <TabsList>
                <TabsTrigger value="model">Model</TabsTrigger>
                <TabsTrigger value="databases">Databases</TabsTrigger>
                <TabsTrigger value="skills">Skills</TabsTrigger>
              </TabsList>

              {/* =========================================================
                  MODEL TAB
                  ========================================================= */}
              <TabsContent value="model" className="min-h-0 overflow-auto py-2">
                <Card>
                  <CardHeader>
                    <CardTitle>模型连接</CardTitle>
                    <CardDescription>新任务会使用保存后的配置；运行中的模型实例保持不变。</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <FieldGroup>
                      {/* Vendor quick-select */}
                      <Field>
                        <FieldLabel>Vendor</FieldLabel>
                        <div className="flex flex-wrap gap-2">
                          {vendors.map((vendor) => (
                            <Button
                              key={vendor.id}
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => { setBaseUrl(vendor.base_url); markDirty(); }}
                            >
                              {vendor.name}{vendor.recommended ? " · 推荐" : ""}
                            </Button>
                          ))}
                        </div>
                      </Field>

                      {/* Base URL */}
                      <Field>
                        <FieldLabel htmlFor="settings-baseurl">Base URL</FieldLabel>
                        <div className="relative">
                          <Input
                            id="settings-baseurl"
                            value={baseUrl}
                            onChange={(e) => { setBaseUrl(e.target.value); markDirty(); }}
                            placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                          />
                          {!baseUrl && (
                            <button
                              type="button"
                              className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-medium text-primary hover:text-primary/80"
                              onClick={() => { setBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1"); markDirty(); }}
                            >
                              填入默认
                            </button>
                          )}
                        </div>
                      </Field>

                      {/* API Key */}
                      <Field>
                        <FieldLabel htmlFor="settings-apikey">API Key</FieldLabel>
                        <div className="relative">
                          <Input
                            id="settings-apikey"
                            type={showApiKey ? "text" : "password"}
                            value={apiKey}
                            onChange={(e) => { setApiKey(e.target.value); apiKeyDirtyRef.current = true; markDirty(); }}
                            placeholder={settings?.api_key_configured ? "输入新值覆盖已配置密钥" : "sk-..."}
                          />
                          <button
                            type="button"
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                            onClick={() => setShowApiKey((v) => !v)}
                            tabIndex={-1}
                          >
                            {showApiKey ? <EyeClosedIcon className="size-4" /> : <EyeIcon className="size-4" />}
                          </button>
                        </div>
                        <FieldDescription>
                          已保存的密钥不会回填输入框。留空并保存，可将密钥清除。
                        </FieldDescription>
                      </Field>

                      {/* Model — bounded scrollable dropdown */}
                      <Field>
                        <FieldLabel htmlFor="settings-model">Model</FieldLabel>
                        <div className="flex gap-2">
                          <div className="relative flex-1">
                            {models.length === 0 ? (
                              <Input
                                id="settings-model"
                                value={modelsLoaded ? modelName : ""}
                                onChange={(e) => { setModelName(e.target.value); markDirty(); setModelError(null); }}
                                placeholder="输入模型名称（如 qwen-plus）"
                              />
                            ) : (
                              <>
                                <button
                                  type="button"
                                  id="settings-model"
                                  className="flex h-10 w-full items-center justify-between rounded-lg border bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                  onClick={() => setShowModelDropdown((v) => !v)}
                                >
                                  {modelsLoading ? (
                                    <span className="flex items-center gap-2 text-muted-foreground">
                                      <Spinner className="size-3.5" />
                                      加载模型列表中...
                                    </span>
                                  ) : (
                                    <span>
                                      {selectedModel ? selectedModel.name : "选择模型"}
                                    </span>
                                  )}
                                  <span className="text-xs text-muted-foreground">
                                    {models.length > 0 ? `${models.length} 个可用` : ""}
                                  </span>
                                </button>

                                {showModelDropdown && (
                                  <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border bg-popover shadow-md">
                                    <div className="p-2">
                                      <Input
                                        placeholder="搜索模型..."
                                        value={modelSearch}
                                        onChange={(e) => handleModelSearchChange(e.target.value)}
                                        className="h-9 text-sm"
                                        autoFocus
                                      />
                                    </div>
                                    <ScrollArea className="h-72">
                                      {filteredModels.length === 0 ? (
                                        <div className="p-4 text-center text-sm text-muted-foreground">
                                          没有匹配的模型
                                        </div>
                                      ) : filteredModels.map((model) => (
                                        <button
                                          key={model.id}
                                          type="button"
                                          className={cn(
                                            "flex w-full items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-accent",
                                            model.id === modelName && "bg-accent font-medium",
                                          )}
                                          onClick={() => handleModelSelect(model.id)}
                                        >
                                          <div className="min-w-0">
                                            <div className="flex items-center gap-2">
                                              <span className="truncate">{model.name}</span>
                                              {model.recommended && (
                                                <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                                                  推荐
                                                </span>
                                              )}
                                            </div>
                                            <p className="truncate text-xs text-muted-foreground">{model.description}</p>
                                          </div>
                                          <div className="ml-3 flex shrink-0 gap-1.5">
                                            {model.capabilities?.image && (
                                              <span role="img" className="text-emerald-600 dark:text-emerald-400" title="支持图像" aria-label="支持图像">
                                                <Image weight="fill" className="size-3" />
                                              </span>
                                            )}
                                            {model.capabilities?.video && (
                                              <span role="img" className="text-emerald-600 dark:text-emerald-400" title="支持视频" aria-label="支持视频">
                                                <VideoCamera weight="fill" className="size-3" />
                                              </span>
                                            )}
                                            {model.capabilities?.audio && (
                                              <span role="img" className="text-emerald-600 dark:text-emerald-400" title="支持音频" aria-label="支持音频">
                                                <SpeakerHigh weight="fill" className="size-3" />
                                              </span>
                                            )}
                                          </div>
                                        </button>
                                      ))}
                                    </ScrollArea>
                                  </div>
                                )}
                              </>
                            )}
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void previewModels()}
                            disabled={modelsLoading}
                          >
                            {modelsLoading && <Spinner data-icon="inline-start" />}
                            加载模型
                          </Button>
                        </div>
                        {selectedModel && <ModelInfoCard model={selectedModel} />}
                        {modelError && (
                          <p className="mt-2 text-xs text-destructive">{modelError}</p>
                        )}
                      </Field>

                      {/* Max tokens slider */}
                      <Field>
                        <FieldLabel htmlFor="settings-maxtokens">最大输出 Tokens</FieldLabel>
                        <div className="flex items-center gap-3">
                          <input
                            id="settings-maxtokens"
                            type="range"
                            min={512}
                            max={131072}
                            step={512}
                            value={maxTokens}
                            onChange={(e) => { setMaxTokens(Number(e.target.value)); markDirty(); }}
                            className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
                          />
                          <span className="w-24 text-right font-mono text-sm tabular-nums text-muted-foreground">
                            {maxTokens.toLocaleString()}
                          </span>
                        </div>
                        <div className="flex justify-between text-[11px] text-muted-foreground">
                          <span>512</span>
                          <span>131K</span>
                        </div>
                      </Field>

                      {/* Temperature + Top P */}
                      <div className="grid gap-4 md:grid-cols-2">
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label htmlFor="settings-temperature">Temperature</Label>
                            <span className="font-mono text-xs tabular-nums text-muted-foreground">{temperature.toFixed(1)}</span>
                          </div>
                          <input
                            id="settings-temperature"
                            type="range"
                            min={0}
                            max={2}
                            step={0.1}
                            value={temperature}
                            onChange={(e) => { setTemperature(Number(e.target.value)); markDirty(); }}
                            className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
                          />
                          <div className="flex justify-between text-[10px] text-muted-foreground">
                            <span>精确 (0)</span>
                            <span>平衡 (1)</span>
                            <span>创意 (2)</span>
                          </div>
                        </div>
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label htmlFor="settings-topp">Top P</Label>
                            <span className="font-mono text-xs tabular-nums text-muted-foreground">{topP.toFixed(2)}</span>
                          </div>
                          <input
                            id="settings-topp"
                            type="range"
                            min={0}
                            max={1}
                            step={0.05}
                            value={topP}
                            onChange={(e) => { setTopP(Number(e.target.value)); markDirty(); }}
                            className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
                          />
                          <div className="flex justify-between text-[10px] text-muted-foreground">
                            <span>严格 (0)</span>
                            <span>默认 (1)</span>
                          </div>
                        </div>
                      </div>

                      {/* Advanced switches */}
                      <div className="space-y-3 pt-2">
                        {selectedModel?.id?.startsWith("qwq") && (
                          <div className="flex items-center justify-between">
                            <div>
                              <Label htmlFor="settings-thinking" className="text-sm">思维链模式</Label>
                              <p className="text-xs text-muted-foreground">为推理模型启用/禁用长思考过程</p>
                            </div>
                            <Switch
                              id="settings-thinking"
                              checked={thinkingMode}
                              onCheckedChange={(v) => { setThinkingMode(v); markDirty(); }}
                            />
                          </div>
                        )}
                        <div className="flex items-center justify-between">
                          <div>
                            <Label htmlFor="settings-search" className="text-sm">联网搜索</Label>
                            <p className="text-xs text-muted-foreground">让模型在需要时自动检索互联网</p>
                          </div>
                          <Switch
                            id="settings-search"
                            checked={enableSearch}
                            onCheckedChange={(v) => { setEnableSearch(v); markDirty(); }}
                          />
                        </div>
                      </div>
                    </FieldGroup>
                  </CardContent>
                  <CardFooter className="justify-end">
                    <Button onClick={() => void saveModel()} disabled={!dirty || saving || !apiKey.trim()}>
                      {saving && <Spinner data-icon="inline-start" />}
                      保存模型设置
                    </Button>
                  </CardFooter>
                </Card>
              </TabsContent>

              {/* =========================================================
                  DATABASES TAB
                  ========================================================= */}
              <TabsContent value="databases" className="min-h-0 overflow-auto py-2">
                <Card>
                  <CardHeader>
                    <CardTitle>数据库目录</CardTitle>
                    <CardDescription>数据库是可选择、声明式的检索技能投影。</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="mb-3 flex flex-wrap justify-end gap-2">
                      <Field>
                        <FieldLabel htmlFor="database-upload" className="sr-only">上传数据库包</FieldLabel>
                        <Input id="database-upload" type="file" accept=".json,.yaml,.yml,.zip" onChange={(event) => void chooseUpload(event.target.files?.[0])} />
                      </Field>
                      <Button size="sm" onClick={() => { setEditingDatabase(null); setDatabaseDraft(EMPTY_DATABASE); }}>
                        <DatabaseIcon data-icon="inline-start" />
                        新建数据库
                      </Button>
                    </div>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>名称</TableHead>
                          <TableHead>来源</TableHead>
                          <TableHead>版本</TableHead>
                          <TableHead>可用性</TableHead>
                          <TableHead>Pipeline</TableHead>
                          <TableHead className="text-right">操作</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {databases.map((database) => (
                          <TableRow key={database.name}>
                            <TableCell>
                              <div className="font-medium">{database.display_name}</div>
                              <div className="text-xs text-muted-foreground">{database.description}</div>
                            </TableCell>
                            <TableCell><Badge variant="outline">{database.origin}</Badge></TableCell>
                            <TableCell>{database.version}</TableCell>
                            <TableCell>
                              <Toggle
                                variant="outline"
                                pressed={database.enabled}
                                disabled={database.origin === "builtin"}
                                aria-label={`${database.enabled ? "停用" : "启用"} ${database.display_name}`}
                                onPressedChange={(pressed) => void mutateSkill(() => api.setSkillEnabled(database.name, pressed), "数据库状态已更新")}
                              >
                                {database.enabled ? "已启用" : "已停用"}
                              </Toggle>
                            </TableCell>
                            <TableCell>
                              <Badge variant={database.pipeline_supported ? "secondary" : "outline"}>
                                {database.pipeline_supported ? "支持" : "Agent"}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right">
                              {database.origin === "package" && (
                                <div className="flex justify-end gap-1">
                                  <Button size="icon-sm" variant="ghost" aria-label={`编辑 ${database.display_name}`} onClick={() => void editDatabase(database)}>
                                    <GearIcon />
                                  </Button>
                                  <Button size="icon-sm" variant="ghost" aria-label={`删除 ${database.display_name}`} onClick={() => setPendingDelete({ kind: "database", name: database.name, label: database.display_name })}>
                                    <TrashIcon />
                                  </Button>
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* =========================================================
                  SKILLS TAB
                  ========================================================= */}
              <TabsContent value="skills" className="min-h-0 overflow-auto py-2">
                <Card>
                  <CardHeader>
                    <CardTitle>技能管理</CardTitle>
                    <CardDescription>筛选、启停、回滚或安装技能包。</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <Input className="max-w-xs" placeholder="筛选技能" value={skillFilter} onChange={(event) => setSkillFilter(event.target.value)} />
                      <Field>
                        <FieldLabel htmlFor="skill-upload" className="sr-only">上传技能</FieldLabel>
                        <Input id="skill-upload" type="file" accept=".json,.yaml,.yml,.zip" onChange={(event) => void chooseUpload(event.target.files?.[0])} />
                      </Field>
                    </div>
                    {filteredSkills.length === 0 ? (
                      <Empty>
                        <EmptyHeader>
                          <EmptyTitle>没有匹配的技能</EmptyTitle>
                          <EmptyDescription>调整名称、分类、来源或状态筛选。</EmptyDescription>
                        </EmptyHeader>
                      </Empty>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>技能</TableHead>
                            <TableHead>分类</TableHead>
                            <TableHead>状态</TableHead>
                            <TableHead>操作 / 版本</TableHead>
                            <TableHead className="text-right">管理</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {filteredSkills.map((skill) => (
                            <TableRow key={skill.name}>
                              <TableCell>
                                <div className="font-medium">{skill.display_name}</div>
                                <div className="text-xs text-muted-foreground">{skill.description}</div>
                                {skill.load_error && <div className="text-xs text-destructive">{skill.load_error}</div>}
                              </TableCell>
                              <TableCell>
                                <Badge variant="outline">{skill.category}</Badge>
                                <Badge variant="secondary">{skill.origin}</Badge>
                              </TableCell>
                              <TableCell>
                                {skill.available === false ? (
                                  <Badge variant="destructive">不可用</Badge>
                                ) : (
                                  <Toggle
                                    variant="outline"
                                    pressed={skill.enabled}
                                    aria-label={`${skill.enabled ? "停用" : "启用"} ${skill.display_name}`}
                                    disabled={skill.origin === "builtin"}
                                    onPressedChange={(pressed) => void mutateSkill(() => api.setSkillEnabled(skill.name, pressed), "技能状态已更新")}
                                  >
                                    {skill.enabled ? "已启用" : "已停用"}
                                  </Toggle>
                                )}
                              </TableCell>
                              <TableCell>
                                <div>{skill.operations.join(", ") || "无操作"}</div>
                                <div className="text-xs text-muted-foreground">v{skill.version}</div>
                              </TableCell>
                              <TableCell className="text-right">
                                <div className="flex justify-end gap-1">
                                  <Button size="sm" variant="ghost" aria-label={`查看 ${skill.display_name}`} onClick={() => void showSkillDetail(skill.name)}>
                                    详情
                                  </Button>
                                  {skill.origin === "package" && (
                                    <>
                                      <Button size="icon-sm" variant="ghost" aria-label={`回滚 ${skill.display_name}`} onClick={() => void mutateSkill(() => api.rollbackSkill(skill.name), "技能已回滚")}>
                                        <ArrowCounterClockwiseIcon />
                                      </Button>
                                      <Button size="icon-sm" variant="ghost" aria-label={`删除 ${skill.display_name}`} onClick={() => setPendingDelete({ kind: "skill", name: skill.name, label: skill.display_name })}>
                                        <TrashIcon />
                                      </Button>
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
              </TabsContent>
            </Tabs>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- Database editor dialog ---- */}
      <Dialog open={databaseDraft !== null} onOpenChange={(next) => { if (!next) setDatabaseDraft(null); }}>
        <DialogContent className="max-h-[calc(100svh-2rem)] overflow-auto">
          <DialogHeader>
            <DialogTitle>{editingDatabase ? "编辑数据库" : "新建数据库"}</DialogTitle>
            <DialogDescription>编辑完整 URL 和基础请求模板；保存时保持声明式操作定义。</DialogDescription>
          </DialogHeader>
          {databaseDraft && (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="database-name">Name</FieldLabel>
                <Input id="database-name" disabled={editingDatabase !== null} value={databaseDraft.name} onChange={(event) => setDatabaseDraft({ ...databaseDraft, name: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-display">Display name</FieldLabel>
                <Input id="database-display" value={databaseDraft.displayName} onChange={(event) => setDatabaseDraft({ ...databaseDraft, displayName: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-description">Description</FieldLabel>
                <Textarea id="database-description" value={databaseDraft.description} onChange={(event) => setDatabaseDraft({ ...databaseDraft, description: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-url">Base URL</FieldLabel>
                <Input id="database-url" value={databaseDraft.url} onChange={(event) => setDatabaseDraft({ ...databaseDraft, url: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-method">Method</FieldLabel>
                <Input id="database-method" value={databaseDraft.method} onChange={(event) => setDatabaseDraft({ ...databaseDraft, method: event.target.value.toUpperCase() as DatabaseDraft["method"] })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-operation">Search operation</FieldLabel>
                <Input id="database-operation" value={databaseDraft.operation} onChange={(event) => setDatabaseDraft({ ...databaseDraft, operation: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-query">Query template</FieldLabel>
                <Textarea id="database-query" value={databaseDraft.query} onChange={(event) => setDatabaseDraft({ ...databaseDraft, query: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-headers">Headers template</FieldLabel>
                <Textarea id="database-headers" value={databaseDraft.headers} onChange={(event) => setDatabaseDraft({ ...databaseDraft, headers: event.target.value })} />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-body">Body template</FieldLabel>
                <Textarea id="database-body" value={databaseDraft.body} onChange={(event) => setDatabaseDraft({ ...databaseDraft, body: event.target.value })} />
              </Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDatabaseDraft(null)}>取消</Button>
                <Button onClick={() => void saveDatabase()}>保存数据库</Button>
              </DialogFooter>
            </FieldGroup>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- Skill detail dialog ---- */}
      <Dialog open={skillDetail !== null} onOpenChange={(next) => { if (!next) setSkillDetail(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{skillDetail?.manifest.display_name ?? "技能详情"}</DialogTitle>
            <DialogDescription>当前版本、操作与加载状态。</DialogDescription>
          </DialogHeader>
          {skillDetail && (
            <Card>
              <CardHeader>
                <CardTitle>v{skillDetail.current_version}</CardTitle>
                <CardDescription>{skillDetail.manifest.description}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col gap-2">
                  <div>操作：{skillDetail.manifest.operations.join(", ") || "无"}</div>
                  <div>可用：{skillDetail.available ? "是" : "否"}</div>
                  {skillDetail.load_error && (
                    <Alert variant="destructive">
                      <AlertTitle>加载失败</AlertTitle>
                      <AlertDescription>{skillDetail.load_error}</AlertDescription>
                    </Alert>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- Delete confirmation dialog ---- */}
      <AlertDialog open={pendingDelete !== null} onOpenChange={(next) => { if (!next) setPendingDelete(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              删除“{pendingDelete?.label}”及其用户版本后无法恢复。内置项目不会提供删除操作。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={(event) => { event.preventDefault(); void confirmDelete(); }}>
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---- Upload confirmation dialog ---- */}
      <AlertDialog open={pendingUpload !== null} onOpenChange={(next) => { if (!next && !uploading) setPendingUpload(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认安装技能</AlertDialogTitle>
            <AlertDialogDescription>
              已验证 {pendingUpload?.validation.skill.display_name} v{pendingUpload?.validation.skill.version}。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {pendingUpload?.validation.warning && (
            <Alert>
              <UploadSimpleIcon />
              <AlertTitle>本地代码执行警告</AlertTitle>
              <AlertDescription>{pendingUpload.validation.warning}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={uploading}>取消</AlertDialogCancel>
            <AlertDialogAction disabled={uploading} onClick={(event) => { event.preventDefault(); void confirmUpload(); }}>
              {uploading && <Spinner data-icon="inline-start" />}
              确认安装
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
