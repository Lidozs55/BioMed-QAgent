import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, UploadSimpleIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { SettingsSearch } from "@/components/settings/SettingsSearch";
import {
  DEFAULT_SETTINGS_SECTION,
  getSettingsNavItem,
  SETTINGS_NAV_GROUPS,
} from "@/components/settings/settingsNavConfig";
import { AppearanceSettingsSection } from "@/components/settings/sections/AppearanceSettingsSection";
import { DatabaseSettingsSection } from "@/components/settings/sections/DatabaseSettingsSection";
import { GeneralSettingsSection } from "@/components/settings/sections/GeneralSettingsSection";
import { ModelSettingsSection } from "@/components/settings/sections/ModelSettingsSection";
import { SkillsSettingsSection } from "@/components/settings/sections/SkillsSettingsSection";
import type { ModelDraftState } from "@/components/settings/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { RichModelInfo } from "@/components/model-info-card";
import {
  EMPTY_DATABASE,
  databaseManifest,
  hasDatabaseErrors,
  parseHttpMethod,
  parseJsonBody,
  parseJsonTemplate,
  validateDatabaseDraft,
  type DatabaseDraft,
} from "@/lib/databaseDraft";
import { cn } from "@/lib/utils";
import type {
  ModelSettings,
  ModelSettingsUpdate,
  SettingsAPIClient,
  SkillDetail,
  SkillManifest,
  SkillValidation,
  VendorInfo,
} from "@/hooks/useAPI";

export interface SettingsPageProps {
  api: SettingsAPIClient;
  onClose: () => void;
  onExportCache?: () => void;
}

const SECTION_DESCRIPTIONS: Record<string, string> = {
  model: "配置模型连接、上下文窗口与生成参数。",
  databases: "管理可选择的声明式检索数据库。",
  skills: "筛选、启停、回滚或安装 Agent 技能包。",
  appearance: "调整主题模式、强调色与界面字体。",
  general: "管理本地数据与查看版本信息。",
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

const INITIAL_DRAFT: ModelDraftState = {
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  apiKey: "",
  modelName: "",
  maxTokens: 8192,
  temperature: 0.7,
  topP: 1,
  enableSearch: false,
  thinkingMode: false,
  modelSearch: "",
  showModelDropdown: false,
  showApiKey: false,
};

export function SettingsPage({ api, onClose, onExportCache }: SettingsPageProps) {
  const apiKeyDirtyRef = useRef(false);
  const saveSeqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  const [loading, setLoading] = useState(true);
  const [settings, setSettings] = useState<ModelSettings | null>(null);
  const [vendors, setVendors] = useState<VendorInfo[]>([]);
  const [models, setModels] = useState<RichModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);

  const [draft, setDraft] = useState<ModelDraftState>(INITIAL_DRAFT);
  const [dirty, setDirty] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [skills, setSkills] = useState<SkillManifest[]>([]);
  const [skillFilter, setSkillFilter] = useState("");
  const [databaseDraft, setDatabaseDraft] = useState<DatabaseDraft | null>(null);
  const [editingDatabase, setEditingDatabase] = useState<SkillManifest | null>(null);
  const [pendingUpload, setPendingUpload] = useState<{
    file: File;
    validation: SkillValidation;
  } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{
    kind: "database" | "skill";
    name: string;
    label: string;
  } | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [uploading, setUploading] = useState(false);

  const [activeSection, setActiveSection] = useState(DEFAULT_SETTINGS_SECTION);
  const [highlight, setHighlight] = useState<{ anchor: string; nonce: number } | null>(null);

  const databases = useMemo(
    () => skills.filter((skill) => skill.user_selectable && skill.supported_sources.length > 0),
    [skills],
  );

  const filteredSkills = useMemo(() => {
    const query = skillFilter.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter((skill) =>
      [skill.name, skill.display_name, skill.category, skill.origin].some((value) =>
        value.toLowerCase().includes(query),
      ),
    );
  }, [skills, skillFilter]);

  const refreshSkills = useCallback(async () => {
    setSkills(await api.fetchSkills());
  }, [api]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSettings, nextVendors, nextSkills] = await Promise.all([
        api.fetchSettings(),
        api.fetchVendors(),
        api.fetchSkills(),
      ]);
      setSettings(nextSettings);
      setVendors(nextVendors);
      setSkills(nextSkills);
      setDraft({
        ...INITIAL_DRAFT,
        modelName: nextSettings.model_name,
        maxTokens: nextSettings.max_tokens,
        temperature: nextSettings.advanced.temperature ?? 0.7,
        topP: nextSettings.advanced.top_p ?? 1,
        enableSearch: nextSettings.advanced.enable_search ?? false,
        thinkingMode: nextSettings.advanced.thinking_mode ?? false,
      });
      apiKeyDirtyRef.current = false;
      setModels([]);
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
    const timer = window.setTimeout(() => {
      setModelsLoaded(false);
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const patchDraft = useCallback(
    (patch: Partial<ModelDraftState>) => {
      if (patch.apiKey !== undefined) apiKeyDirtyRef.current = true;
      setDraft((previous) => ({ ...previous, ...patch }));
      setDirty(true);
      setModelError(null);
      if (patch.modelName !== undefined && patch.modelName !== draft.modelName) {
        setDraft((previous) => ({ ...previous, modelSearch: "", showModelDropdown: false }));
        const model = models.find((item) => item.id === patch.modelName);
        if (model && model.context_window > 0) {
          void api
            .saveSettings({ model_name: patch.modelName, context_window: model.context_window })
            .then((updated) => setSettings(updated))
            .catch(() => {
              // Save is retried on the explicit save action.
            });
        }
      }
    },
    [api, draft.modelName, models],
  );

  const patchUi = useCallback((patch: Partial<ModelDraftState>) => {
    setDraft((previous) => ({ ...previous, ...patch }));
  }, []);

  const previewModels = useCallback(async () => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setModelsLoading(true);
    try {
      const fresh = (await api.fetchModels({
        baseUrl: draft.baseUrl,
        apiKey: apiKeyDirtyRef.current ? draft.apiKey : undefined,
      })) as RichModelInfo[];
      if (!abort.signal.aborted) {
        setModels(fresh);
        setModelsLoaded(true);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        toast.error("模型列表加载失败", { description: errorText(error) });
      }
    } finally {
      if (!abort.signal.aborted) setModelsLoading(false);
    }
  }, [api, draft.baseUrl, draft.apiKey]);

  const saveModel = async () => {
    if (!draft.modelName.trim()) {
      setModelError("请填写模型名称，例如 qwen-plus");
      return;
    }
    if (models.length > 0 && !models.find((model) => model.id === draft.modelName)) {
      setModelError(`模型名称 "${draft.modelName}" 不在可用列表中，请检查拼写是否正确，或从下拉菜单中选择`);
      return;
    }
    setModelError(null);

    const seq = ++saveSeqRef.current;
    setSaving(true);
    try {
      try {
        await api.fetchModels({ baseUrl: draft.baseUrl, apiKey: draft.apiKey });
      } catch {
        setSaving(false);
        setModelError("API 密钥验证失败，请检查密钥是否正确或与 Base URL 是否匹配");
        return;
      }

      const payload: Record<string, unknown> = {};
      if (apiKeyDirtyRef.current) payload.api_key = draft.apiKey;
      if (draft.baseUrl !== settings?.base_url) payload.base_url = draft.baseUrl;
      if (draft.modelName !== settings?.model_name) payload.model_name = draft.modelName;
      if (draft.maxTokens !== settings?.max_tokens) payload.max_tokens = draft.maxTokens;
      if (draft.temperature !== (settings?.advanced.temperature ?? 0.7)) {
        payload.temperature = draft.temperature;
      }
      if (draft.topP !== (settings?.advanced.top_p ?? 1)) payload.top_p = draft.topP;
      if (draft.enableSearch !== (settings?.advanced.enable_search ?? false)) {
        payload.enable_search = draft.enableSearch;
      }
      if (draft.thinkingMode !== (settings?.advanced.thinking_mode ?? false)) {
        payload.thinking_mode = draft.thinkingMode;
      }

      if (Object.keys(payload).length === 0) {
        setDirty(false);
        return;
      }

      const updated = await api.saveSettings(payload as ModelSettingsUpdate);
      if (saveSeqRef.current !== seq) return;

      setSettings(updated);
      setDraft((previous) => ({ ...previous, apiKey: "" }));
      apiKeyDirtyRef.current = false;
      setDirty(false);
      setModelsLoaded(true);
      toast.success("模型设置已保存");

      setModelsLoading(true);
      try {
        const freshModels = (await api.fetchModels({
          baseUrl: updated.base_url,
        })) as RichModelInfo[];
        if (saveSeqRef.current === seq) setModels(freshModels);
      } catch {
        // Discovery failure must not revert the save success.
      } finally {
        if (saveSeqRef.current === seq) setModelsLoading(false);
      }
    } catch (error) {
      const message = errorText(error);
      setModelError(message);
      toast.error("模型设置保存失败", { description: message });
    } finally {
      if (saveSeqRef.current === seq) setSaving(false);
    }
  };

  const handleContextWindowChange = useCallback(
    (tokens: number) => {
      void api
        .saveSettings({ context_window: tokens })
        .then((updated) => {
          setSettings(updated);
          toast.success(`上下文窗口已调整为 ${tokens.toLocaleString()} tokens`);
        })
        .catch((error) => {
          toast.error("调整失败", { description: errorText(error) });
        });
    },
    [api],
  );

  const mutateSkill = useCallback(
    async (action: () => Promise<void>, success: string) => {
      try {
        await action();
        await refreshSkills();
        toast.success(success);
      } catch (error) {
        toast.error("操作失败", { description: errorText(error) });
      }
    },
    [refreshSkills],
  );

  const chooseUpload = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      try {
        setPendingUpload({ file, validation: await api.validateSkill(file) });
      } catch (error) {
        toast.error("文件验证失败", { description: errorText(error) });
      }
    },
    [api],
  );

  const confirmUpload = useCallback(async () => {
    if (!pendingUpload) return;
    setUploading(true);
    try {
      await api.uploadSkill(pendingUpload.file);
      setPendingUpload(null);
      await refreshSkills();
      toast.success("技能已安装");
    } catch (error) {
      toast.error("技能安装失败", { description: errorText(error) });
    } finally {
      setUploading(false);
    }
  }, [api, pendingUpload, refreshSkills]);

  const editDatabase = useCallback(
    async (database: SkillManifest) => {
      try {
        const detail = await api.fetchSkill(database.name);
        const operation = detail.declarative_manifest?.operations[0];
        if (!detail.declarative_manifest || !operation) throw new Error("缺少操作");
        setEditingDatabase(database);
        setDatabaseDraft({
          name: detail.declarative_manifest.name,
          displayName: detail.declarative_manifest.display_name,
          description: detail.declarative_manifest.description,
          url: operation.url,
          operation: operation.name,
          method: operation.method,
          query: JSON.stringify(operation.query ?? {}),
          headers: JSON.stringify(operation.headers ?? {}),
          body: JSON.stringify(operation.body ?? null),
        });
      } catch (error) {
        toast.error("数据库详情加载失败", { description: errorText(error) });
      }
    },
    [api],
  );

  const showSkillDetail = useCallback(
    async (name: string) => {
      try {
        setSkillDetail(await api.fetchSkill(name));
      } catch (error) {
        toast.error("技能详情加载失败", { description: errorText(error) });
      }
    },
    [api],
  );

  const saveDatabase = useCallback(async () => {
    if (!databaseDraft) return;
    try {
      if (hasDatabaseErrors(validateDatabaseDraft(databaseDraft))) {
        throw new Error("请先修正字段错误");
      }
      if (editingDatabase) {
        await api.updateDatabase(editingDatabase.name, {
          display_name: databaseDraft.displayName,
          description: databaseDraft.description,
          operation: {
            name: databaseDraft.operation,
            description: `Search ${databaseDraft.displayName}`,
            method: parseHttpMethod(databaseDraft.method),
            url: databaseDraft.url,
            query: parseJsonTemplate(databaseDraft.query),
            headers: parseJsonTemplate(databaseDraft.headers),
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
  }, [api, databaseDraft, editingDatabase, refreshSkills]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    await mutateSkill(
      () =>
        target.kind === "database"
          ? api.deleteDatabase(target.name)
          : api.deleteSkill(target.name),
      target.kind === "database" ? "数据库已删除" : "技能已删除",
    );
  }, [api, mutateSkill, pendingDelete]);

  const navigate = useCallback((section: string, anchor?: string) => {
    setActiveSection(section);
    if (anchor) {
      const nonce = Date.now();
      setHighlight({ anchor, nonce });
      window.setTimeout(() => {
        document
          .querySelector(`[data-anchor="${anchor}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 80);
    }
  }, []);

  const currentItem = getSettingsNavItem(activeSection);
  const sectionDescription = SECTION_DESCRIPTIONS[activeSection] ?? "";

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
    >
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <Button variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeftIcon data-icon="inline-start" />
          返回应用
        </Button>
        <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />
        <h1 className="truncate text-sm font-semibold">{currentItem?.label ?? "设置"}</h1>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r bg-muted/25 p-3 md:flex">
          <SettingsSearch onNavigate={navigate} className="mb-5" />
          <nav aria-label="设置分类" className="space-y-5">
            {SETTINGS_NAV_GROUPS.map((group) => (
              <div key={group.id}>
                <p className="px-2 pb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const active = activeSection === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        aria-current={active ? "page" : undefined}
                        onClick={() => navigate(item.id)}
                        className={cn(
                          "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                          active
                            ? "bg-primary/10 font-medium text-primary"
                            : "text-foreground hover:bg-muted",
                        )}
                      >
                        <Icon className="size-4 shrink-0" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex gap-1 overflow-x-auto border-b px-3 py-2 md:hidden">
            {SETTINGS_NAV_GROUPS.flatMap((group) =>
              group.items.map((item) => {
                const Icon = item.icon;
                const active = activeSection === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => navigate(item.id)}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium",
                      active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted",
                    )}
                  >
                    <Icon className="size-3.5" />
                    {item.label}
                  </button>
                );
              }),
            )}
          </div>

          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-8">
              <header className="mb-8">
                <h2 className="text-2xl font-semibold tracking-tight">
                  {currentItem?.label ?? "设置"}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">{sectionDescription}</p>
              </header>

              {loading ? (
                <div className="space-y-4">
                  <Skeleton className="h-8 w-64" />
                  <Skeleton className="h-72 w-full" />
                  <Skeleton className="h-48 w-full" />
                </div>
              ) : (
                <>
                  {activeSection === "model" && (
                    <ModelSettingsSection
                      settings={settings}
                      vendors={vendors}
                      models={models}
                      modelsLoading={modelsLoading}
                      modelsLoaded={modelsLoaded}
                      draft={draft}
                      dirty={dirty}
                      saving={saving}
                      modelError={modelError}
                      highlightAnchor={highlight?.anchor ?? null}
                      highlightNonce={highlight?.nonce ?? 0}
                      onDraftChange={patchDraft}
                      onUiChange={patchUi}
                      onPreviewModels={() => void previewModels()}
                      onContextWindowChange={handleContextWindowChange}
                      onSave={() => void saveModel()}
                    />
                  )}
                  {activeSection === "databases" && (
                    <DatabaseSettingsSection
                      databases={databases}
                      highlightAnchor={highlight?.anchor ?? null}
                      highlightNonce={highlight?.nonce ?? 0}
                      onUploadFile={(file) => void chooseUpload(file)}
                      onNewDatabase={() => {
                        setEditingDatabase(null);
                        setDatabaseDraft(EMPTY_DATABASE);
                      }}
                      onEditDatabase={(database) => void editDatabase(database)}
                      onToggleEnabled={(database, enabled) =>
                        void mutateSkill(
                          () => api.setSkillEnabled(database.name, enabled),
                          "数据库状态已更新",
                        )
                      }
                      onDeleteDatabase={(database) =>
                        setPendingDelete({
                          kind: "database",
                          name: database.name,
                          label: database.display_name,
                        })
                      }
                    />
                  )}
                  {activeSection === "skills" && (
                    <SkillsSettingsSection
                      skills={filteredSkills}
                      filter={skillFilter}
                      highlightAnchor={highlight?.anchor ?? null}
                      highlightNonce={highlight?.nonce ?? 0}
                      onFilterChange={setSkillFilter}
                      onInstallFile={(file) => void chooseUpload(file)}
                      onToggleEnabled={(skill, enabled) =>
                        void mutateSkill(
                          () => api.setSkillEnabled(skill.name, enabled),
                          "技能状态已更新",
                        )
                      }
                      onShowDetail={(name) => void showSkillDetail(name)}
                      onRollback={(skill) =>
                        void mutateSkill(
                          () => api.rollbackSkill(skill.name),
                          "技能已回滚",
                        )
                      }
                      onDeleteSkill={(skill) =>
                        setPendingDelete({
                          kind: "skill",
                          name: skill.name,
                          label: skill.display_name,
                        })
                      }
                    />
                  )}
                  {activeSection === "appearance" && <AppearanceSettingsSection />}
                  {activeSection === "general" && (
                    <GeneralSettingsSection onExportCache={onExportCache ?? (() => undefined)} />
                  )}
                </>
              )}
            </div>
          </main>
        </div>
      </div>

      {/* ---- Database editor dialog ---- */}
      <Dialog
        open={databaseDraft !== null}
        onOpenChange={(next) => {
          if (!next) setDatabaseDraft(null);
        }}
      >
        <DialogContent className="max-h-[calc(100svh-2rem)] overflow-auto">
          <DialogHeader>
            <DialogTitle>{editingDatabase ? "编辑数据库" : "新建数据库"}</DialogTitle>
            <DialogDescription>
              编辑完整 URL 和基础请求模板；保存时保持声明式操作定义。
            </DialogDescription>
          </DialogHeader>
          {databaseDraft && (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="database-name">Name</FieldLabel>
                <Input
                  id="database-name"
                  disabled={editingDatabase !== null}
                  value={databaseDraft.name}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, name: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-display">Display name</FieldLabel>
                <Input
                  id="database-display"
                  value={databaseDraft.displayName}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, displayName: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-description">Description</FieldLabel>
                <Textarea
                  id="database-description"
                  value={databaseDraft.description}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, description: event.target.value })
                  }
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="database-url">Base URL</FieldLabel>
                <Input
                  id="database-url"
                  value={databaseDraft.url}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, url: event.target.value })
                  }
                />
              </Field>
              <Field data-invalid={validateDatabaseDraft(databaseDraft).method !== null || undefined}>
                <FieldLabel htmlFor="database-method">Method</FieldLabel>
                <Input
                  id="database-method"
                  value={databaseDraft.method}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, method: event.target.value })
                  }
                  aria-invalid={validateDatabaseDraft(databaseDraft).method !== null || undefined}
                />
                {validateDatabaseDraft(databaseDraft).method && (
                  <FieldError>{validateDatabaseDraft(databaseDraft).method}</FieldError>
                )}
              </Field>
              <Field>
                <FieldLabel htmlFor="database-operation">Search operation</FieldLabel>
                <Input
                  id="database-operation"
                  value={databaseDraft.operation}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, operation: event.target.value })
                  }
                />
              </Field>
              <Field data-invalid={validateDatabaseDraft(databaseDraft).query !== null || undefined}>
                <FieldLabel htmlFor="database-query">Query template</FieldLabel>
                <Textarea
                  id="database-query"
                  value={databaseDraft.query}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, query: event.target.value })
                  }
                  aria-invalid={validateDatabaseDraft(databaseDraft).query !== null || undefined}
                />
                {validateDatabaseDraft(databaseDraft).query && (
                  <FieldError>{validateDatabaseDraft(databaseDraft).query}</FieldError>
                )}
              </Field>
              <Field data-invalid={validateDatabaseDraft(databaseDraft).headers !== null || undefined}>
                <FieldLabel htmlFor="database-headers">Headers template</FieldLabel>
                <Textarea
                  id="database-headers"
                  value={databaseDraft.headers}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, headers: event.target.value })
                  }
                  aria-invalid={validateDatabaseDraft(databaseDraft).headers !== null || undefined}
                />
                {validateDatabaseDraft(databaseDraft).headers && (
                  <FieldError>{validateDatabaseDraft(databaseDraft).headers}</FieldError>
                )}
              </Field>
              <Field data-invalid={validateDatabaseDraft(databaseDraft).body !== null || undefined}>
                <FieldLabel htmlFor="database-body">Body template</FieldLabel>
                <Textarea
                  id="database-body"
                  value={databaseDraft.body}
                  onChange={(event) =>
                    setDatabaseDraft({ ...databaseDraft, body: event.target.value })
                  }
                  aria-invalid={validateDatabaseDraft(databaseDraft).body !== null || undefined}
                />
                {validateDatabaseDraft(databaseDraft).body && (
                  <FieldError>{validateDatabaseDraft(databaseDraft).body}</FieldError>
                )}
              </Field>
              <DialogFooter>
                <Button variant="outline" onClick={() => setDatabaseDraft(null)}>
                  取消
                </Button>
                <Button
                  disabled={hasDatabaseErrors(validateDatabaseDraft(databaseDraft))}
                  onClick={() => void saveDatabase()}
                >
                  保存数据库
                </Button>
              </DialogFooter>
            </FieldGroup>
          )}
        </DialogContent>
      </Dialog>

      {/* ---- Skill detail dialog ---- */}
      <Dialog
        open={skillDetail !== null}
        onOpenChange={(next) => {
          if (!next) setSkillDetail(null);
        }}
      >
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
      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认删除</AlertDialogTitle>
            <AlertDialogDescription>
              删除“{pendingDelete?.label}”及其用户版本后无法恢复。内置项目不会提供删除操作。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---- Upload confirmation dialog ---- */}
      <AlertDialog
        open={pendingUpload !== null}
        onOpenChange={(next) => {
          if (!next && !uploading) setPendingUpload(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确认安装技能</AlertDialogTitle>
            <AlertDialogDescription>
              已验证 {pendingUpload?.validation.skill.display_name} v
              {pendingUpload?.validation.skill.version}。
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
            <AlertDialogAction
              disabled={uploading}
              onClick={(event) => {
                event.preventDefault();
                void confirmUpload();
              }}
            >
              {uploading && <Spinner data-icon="inline-start" />}
              确认安装
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
