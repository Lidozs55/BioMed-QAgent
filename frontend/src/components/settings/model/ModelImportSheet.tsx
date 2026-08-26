import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  MagnifyingGlassIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { formatContextWindow } from "@/lib/tokenFormat";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ParameterEditor } from "@/components/settings/model/ParameterEditor";
import { ModelDetailDialog } from "@/components/settings/model/ModelDetailDialog";
import type {
  DiscoveredModelInfo,
  ManagedModelInfo,
  ParameterSpec,
  ProviderInfo,
  SettingsAPIClient,
} from "@/hooks/useAPI";
import { cn } from "@/lib/utils";

interface ModelImportSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  api: SettingsAPIClient;
  providers: ProviderInfo[];
  managedModels: ManagedModelInfo[];
  onSaved: () => void;
  initialProviderId?: string | null;
  initialModelId?: string | null;
}

interface ManualDraft {
  modelId: string;
  name: string;
  contextWindow: string;
  params: Record<string, unknown>;
}

const EMPTY_MANUAL_DRAFT: ManualDraft = {
  modelId: "",
  name: "",
  contextWindow: "",
  params: {},
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

function defaultParams(discovered: DiscoveredModelInfo): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const spec of discovered.param_specs ?? []) {
    if (spec.default !== undefined) params[spec.key] = spec.default;
  }
  return params;
}

function defaultParamsFromSpecs(specs: ParameterSpec[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const spec of specs) {
    if (spec.default !== undefined) params[spec.key] = spec.default;
  }
  return params;
}

function allParamsJson(
  specs: ParameterSpec[],
  params: Record<string, unknown>,
): string {
  const merged: Record<string, unknown> = {};
  for (const spec of specs) {
    if (spec.default !== undefined) merged[spec.key] = spec.default;
  }
  for (const [key, value] of Object.entries(params)) merged[key] = value;
  return JSON.stringify(merged, null, 2);
}


function capabilityChips(
  capabilities: DiscoveredModelInfo["capabilities"] | undefined,
): ReactNode {
  const caps = capabilities ?? {};
  const labels: Array<[boolean, string]> = [
    [Boolean(caps.text), "文"],
    [Boolean(caps.image), "图"],
    [Boolean(caps.video), "视"],
    [Boolean(caps.audio), "音"],
  ];
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {labels
        .filter(([enabled]) => enabled)
        .map(([, label]) => (
          <span
            key={label}
            className="rounded bg-muted px-1 py-0.5 text-xs font-medium text-muted-foreground"
          >
            {label}
          </span>
        ))}
    </span>
  );
}

export function ModelImportSheet({
  open,
  onOpenChange,
  api,
  providers,
  managedModels,
  onSaved,
  initialProviderId,
  initialModelId,
}: ModelImportSheetProps) {
  const [providerId, setProviderId] = useState<string>("");
  const [discovered, setDiscovered] = useState<DiscoveredModelInfo[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [multiSelect, setMultiSelect] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [detailModel, setDetailModel] = useState<ManagedModelInfo | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const [manualOpen, setManualOpen] = useState(false);
  const [manualLoading, setManualLoading] = useState(false);
  const [manualSpecs, setManualSpecs] = useState<ParameterSpec[]>([]);
  const [manualDraft, setManualDraft] = useState<ManualDraft>(EMPTY_MANUAL_DRAFT);
  const wasOpenRef = useRef(false);
    const [manualJsonOpen, setManualJsonOpen] = useState(false);
    const [manualJsonText, setManualJsonText] = useState("");
    const [manualJsonError, setManualJsonError] = useState<string | null>(null);
    
    
    

  const selectedProvider = providers.find((provider) => provider.id === providerId) ?? null;
  const providerModels = useMemo(
    () => managedModels.filter((model) => model.provider_id === providerId),
    [managedModels, providerId],
  );

  const resetForProvider = useCallback((nextProviderId: string) => {
    setProviderId(nextProviderId);
    setDiscovered([]);
    setDiscoverError(null);
    setSearch("");
    setSelectedId(null);
    setSelectedIds(new Set());
    setMultiSelect(false);
    setDetailModel(null);
    setDetailOpen(false);
    setManualOpen(false);
    setManualDraft(EMPTY_MANUAL_DRAFT);
    setManualJsonOpen(false);
    setManualJsonText("");
    setManualJsonError(null);
  }, []);

  const discover = useCallback(
    async (providerIdOverride?: string) => {
      const targetId = providerIdOverride ?? providerId;
      if (!targetId) return;
      setDiscovering(true);
      setDiscoverError(null);
      try {
        const items = await api.discoverProviderModels(targetId);
        setDiscovered(items);
        if (items.length === 0) {
          toast.info("供应商没有返回模型列表，可手动添加");
        }
      } catch (error) {
        setDiscoverError(errorText(error));
        toast.error("模型列表获取失败", { description: errorText(error) });
      } finally {
        setDiscovering(false);
      }
    },
    [api, providerId],
  );

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    const timer = window.setTimeout(() => {
      if (
        initialProviderId &&
        providers.some((provider) => provider.id === initialProviderId)
      ) {
        resetForProvider(initialProviderId);
        void discover(initialProviderId);
        if (initialModelId) {
          setSelectedId(initialModelId);
        }
      } else if (providers.length === 1) {
        const singleId = providers[0].id;
        resetForProvider(singleId);
        void discover(singleId);
      } else {
        resetForProvider("");
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [
    open,
    providers,
    initialProviderId,
    initialModelId,
    managedModels,
    resetForProvider,
    discover,
  ]);

  const selectDiscovered = (item: DiscoveredModelInfo) => {
    const imported = providerModels.find((model) => model.model_id === item.id);
    setSelectedId(imported?.id ?? item.id);
  };

  const openManual = async () => {
    if (!providerId) return;
    setManualOpen(true);
    setManualLoading(true);
    setManualDraft(EMPTY_MANUAL_DRAFT);
    setManualJsonOpen(false);
    setManualJsonText("");
    
    setManualJsonError(null);
    try {
      const specs = await api.fetchProviderParamSpecs(providerId);
      setManualSpecs(specs);
      setManualDraft((previous) => ({
        ...previous,
        params: defaultParamsFromSpecs(specs),
      }));
    } catch (error) {
      setManualSpecs([]);
      toast.error("模型参数加载失败", { description: errorText(error) });
    } finally {
      setManualLoading(false);
    }
  };

    const toggleManualJson = () => {
      if (manualJsonOpen) {
        setManualJsonOpen(false);
        return;
      }
      setManualJsonText(allParamsJson(manualSpecs, manualDraft.params));
      setManualJsonError(null);
      setManualJsonOpen(true);
    };

    const formatManualJson = () => {
      try {
        const parsed: unknown = JSON.parse(manualJsonText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("配置必须是 JSON 对象");
        }
        setManualJsonText(JSON.stringify(parsed, null, 2));
        setManualJsonError(null);
      } catch (error) {
        setManualJsonError(error instanceof Error ? error.message : "JSON 格式错误");
      }
    };

    const restoreManualJson = () => {
      setManualJsonText(allParamsJson(manualSpecs, {}));
      setManualJsonError(null);
      toast.success("已恢复为默认参数");
    };

    const applyManualJson = () => {
      try {
        const parsed: unknown = JSON.parse(manualJsonText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("配置必须是 JSON 对象");
        }
        setManualDraft({ ...manualDraft, params: parsed as Record<string, unknown> });
        setManualJsonOpen(false);
        setManualJsonError(null);
        toast.success("JSON 配置已应用");
      } catch (error) {
        setManualJsonError(error instanceof Error ? error.message : "JSON 格式错误");
      }
    };


  const saveManual = async () => {
    const modelId = manualDraft.modelId.trim();
    if (!providerId || !modelId) {
      toast.error("请输入模型 ID");
      return;
    }
    setSaving(true);
    try {
      const rawWindow = manualDraft.contextWindow.trim();
      const parsedWindow = rawWindow === "" ? null : Number(rawWindow);
      const created = await api.createManagedModel({
        provider_id: providerId,
        model_id: modelId,
        name: manualDraft.name.trim() || modelId,
        context_window:
          parsedWindow !== null && Number.isFinite(parsedWindow) && parsedWindow > 0
            ? parsedWindow
            : null,
        source: "manual",
        params: manualDraft.params,
      });
      toast.success(`已添加 ${created.name}`);
      await onSaved();
      setSelectedId(created.id);
      setManualOpen(false);
      setManualDraft(EMPTY_MANUAL_DRAFT);
    } catch (error) {
      toast.error("添加失败", { description: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const removeModel = async (model: ManagedModelInfo) => {
    try {
      await api.deleteManagedModel(model.id);
      toast.success(`已移除 ${model.name}`);
      await onSaved();
      if (selectedId === model.id || detailModel?.id === model.id) {
        setSelectedId(null);
        setDetailModel(null);
        setDetailOpen(false);
      }
    } catch (error) {
      toast.error("移除失败", { description: errorText(error) });
    } finally {
      setConfirmDeleteId(null);
    }
  };

  const selectModel = (model: ManagedModelInfo) => {
    setSelectedId(model.id);
  };

  const openDetail = (model: ManagedModelInfo) => {
    setDetailModel(model);
    setDetailOpen(true);
  };

  const createFromDiscovered = async (
    item: DiscoveredModelInfo,
  ): Promise<ManagedModelInfo> => {
    if (!providerId) throw new Error("未选择供应商");
    return api.createManagedModel({
      provider_id: providerId,
      model_id: item.id,
      name: item.name || item.id,
      description: item.description,
      context_window: item.context_window ?? null,
      max_output_tokens: item.max_output_tokens ?? item.suggested_max_tokens ?? null,
      suggested_max_tokens: item.suggested_max_tokens ?? null,
      source: "api",
      params: defaultParams(item),
    });
  };

  const importModel = async (item: DiscoveredModelInfo) => {
    setSaving(true);
    try {
      const created = await createFromDiscovered(item);
      toast.success(`已导入 ${created.name}`);
      await onSaved();
      setSelectedId(created.id);
      setSelectedIds(new Set());
    } catch (error) {
      toast.error("导入失败", { description: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const toggleSelect = (modelId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  };

  const importSelected = async () => {
    const pending = filtered.filter(
      (item) => selectedIds.has(item.id) && !importedIds.has(item.id),
    );
    if (pending.length === 0) {
      toast.info("所选模型均已导入");
      setSelectedIds(new Set());
      return;
    }
    setSaving(true);
    try {
      let last: ManagedModelInfo | null = null;
      for (const item of pending) {
        last = await createFromDiscovered(item);
      }
      toast.success(`已导入 ${pending.length} 个模型`);
      await onSaved();
      if (last) {
        setSelectedId(last.id);
      }
      setSelectedIds(new Set());
    } catch (error) {
      toast.error("批量导入失败", { description: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  
    // eslint-disable-next-line react-hooks/preserve-manual-memoization
    const filtered = useMemo(() => {
      const query = search.trim().toLowerCase();
    if (!query) return discovered;
    return discovered.filter(
      (item) => item.id.toLowerCase().includes(query) || item.name.toLowerCase().includes(query),
    );
    }, [discovered, search]);
  

  const importedIds = new Set(providerModels.map((model) => model.model_id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100svh-2rem)] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>添加 / 管理模型</DialogTitle>
          <DialogDescription>
            先选择供应商，从左侧导入模型到右侧维护列表，或手动添加模型。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-end gap-2 border-b px-5 py-3">
          <div className="min-w-0 flex-1">
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">供应商</p>
            <Select
              value={providerId}
              onValueChange={(next) => {
                if (!next) return;
                resetForProvider(next);
                void discover(next);
              }}
            >
              <SelectTrigger className="w-full" aria-label="选择供应商">
                <span className="truncate">
                  {selectedProvider?.name ?? "选择供应商"}
                </span>
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectItem key={provider.id} value={provider.id}>
                    {provider.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {providerId && (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 overflow-hidden px-5 py-4 md:grid-cols-2">
            {/* Left: provider returned model list */}
            <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card">
              <div className="flex shrink-0 items-center gap-2 border-b p-3">
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    className="size-3.5 cursor-pointer"
                    checked={multiSelect}
                    onChange={(event) => {
                      setMultiSelect(event.target.checked);
                      if (!event.target.checked) setSelectedIds(new Set());
                    }}
                    aria-label="复选"
                  />
                  复选
                </label>
                <div className="relative min-w-0 flex-1">
                  <MagnifyingGlassIcon
                    data-icon="inline-start"
                    className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
                  />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索供应商模型..."
                    className="pl-8"
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => void discover()}
                  disabled={discovering}
                >
                  {discovering ? <Spinner data-icon="inline-start" /> : null}
                  获取列表
                </Button>
                {selectedIds.size > 0 && (
                  <Button
                    size="sm"
                    className="shrink-0"
                    disabled={saving}
                    onClick={() => void importSelected()}
                  >
                    导入所选 ({selectedIds.size})
                  </Button>
                )}
              </div>
              {discoverError && (
                <p className="shrink-0 border-b px-3 py-2 text-xs text-destructive" role="alert">
                  {discoverError}
                </p>
              )}
              <ScrollArea className="min-h-64 flex-1">
                {discovering ? (
                  <div className="flex items-center justify-center py-10 text-muted-foreground">
                    <Spinner />
                  </div>
                ) : filtered.length === 0 ? (
                  <div className="p-6 text-center text-sm text-muted-foreground">
                    {discovered.length === 0
                      ? "点击“获取列表”拉取供应商返回的模型"
                      : "没有匹配的模型"}
                  </div>
                ) : (
                  <ul className="divide-y">
                    {filtered.map((item) => {
                      const imported = importedIds.has(item.id);
                      const active = selectedId === item.id;
                      return (
                        <li
                          key={item.id}
                          className={cn(
                            "flex items-center gap-2 px-3 py-2.5",
                            active && "bg-accent",
                          )}
                        >
                          {multiSelect && (
                            <input
                              type="checkbox"
                              className="size-4 shrink-0 cursor-pointer"
                              checked={selectedIds.has(item.id)}
                              onChange={() => toggleSelect(item.id)}
                              aria-label={`选择 ${item.name}`}
                            />
                          )}
                          <button
                            type="button"
                            className="min-w-0 flex-1 truncate text-left"
                            onClick={() => selectDiscovered(item)}
                          >
                            <span className="truncate text-sm font-medium">{item.name}</span>
                          </button>
                          <div className="flex shrink-0 items-center gap-2">
                            <span className="text-xs text-muted-foreground">
                              {formatContextWindow(item.context_window)}
                            </span>
                            {capabilityChips(item.capabilities)}
                          </div>
                          <Button
                            variant={imported ? "ghost" : "outline"}
                            size="sm"
                            className="shrink-0"
                            disabled={imported || saving}
                            onClick={() => void importModel(item)}
                          >
                            {imported ? "已导入" : "导入"}
                          </Button>
                        </li>
                    );
                      
                    })}
                  </ul>
                )}
              </ScrollArea>
            </div>

            {/* Right: selected / maintained models */}
            <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card">
              <div className="flex shrink-0 items-center justify-between gap-3 border-b p-3">
                <p className="text-sm font-medium">
                  已选模型{" "}
                  <span className="text-muted-foreground">({providerModels.length})</span>
                </p>
                <Button
                  size="sm"
                  className="shrink-0"
                  onClick={() => void openManual()}
                  disabled={!providerId || saving}
                >
                  <PlusIcon data-icon="inline-start" />
                  添加模型
                </Button>
              </div>
              <ScrollArea className="min-h-0 flex-1">
                {providerModels.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    还没有维护模型，从左侧导入或手动添加。
                  </div>
                ) : (
                  <ul className="divide-y">
                    {providerModels.map((model) => (
                      <li key={model.id}>
                        <div className="flex items-center justify-between gap-2 px-3 py-2">
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => selectModel(model)}
                          >
                            <span className="truncate text-sm">{model.name}</span>
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {model.model_id}
                            </span>
                          </button>
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="shrink-0"
                              onClick={() => openDetail(model)}
                            >
                              详情
                            </Button>
                            {confirmDeleteId === model.id ? (
                              <Button
                                variant="destructive"
                                size="sm"
                                className="shrink-0"
                                onClick={() => void removeModel(model)}
                              >
                                确认移除
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="shrink-0 text-destructive"
                                onClick={() => setConfirmDeleteId(model.id)}
                              >
                                移除
                              </Button>
                            )}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </ScrollArea>
            </div>
          </div>
        )}
      </DialogContent>

      <ModelDetailDialog
        key={detailModel?.id ?? "closed"}
          open={detailOpen}
        onOpenChange={(next) => {
            setDetailOpen(next);
            if (!next) setDetailModel(null);
          }}
        model={detailModel}
        api={api}
        onSaved={onSaved}
      />

      <Dialog open={manualOpen} onOpenChange={setManualOpen}>
        <DialogContent className="max-h-[calc(100svh-2rem)] overflow-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>手动添加模型</DialogTitle>
            <DialogDescription>填写模型信息与支持的参数；带 * 为必填。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="manual-model-id">模型 ID *</FieldLabel>
              <Input
                id="manual-model-id"
                value={manualDraft.modelId}
                onChange={(event) =>
                  setManualDraft({ ...manualDraft, modelId: event.target.value })
                }
                placeholder="如 gpt-4o-mini"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-model-name">显示名（可选）</FieldLabel>
              <Input
                id="manual-model-name"
                value={manualDraft.name}
                onChange={(event) =>
                  setManualDraft({ ...manualDraft, name: event.target.value })
                }
                placeholder="如 GPT-4o Mini"
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="manual-context-window">上下文窗口（Tokens，可选）</FieldLabel>
              <Input
                id="manual-context-window"
                type="number"
                min={1}
                value={manualDraft.contextWindow}
                onChange={(event) =>
                  setManualDraft({ ...manualDraft, contextWindow: event.target.value })
                }
                placeholder="如 131072"
              />
            </Field>
            <div className="border-t pt-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">模型参数</p>
                  <Button variant="outline" size="sm" onClick={toggleManualJson}>
                    {manualJsonOpen ? "返回图形编辑" : "配置 JSON"}
                  </Button>
                </div>
              {manualLoading ? (
                <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
                  <Spinner />
                  正在加载参数...
                </div>
                ) : manualJsonOpen ? (
                  <div className="flex flex-col gap-2">
                    <Textarea
                      value={manualJsonText}
                      onChange={(event) => {
                        setManualJsonText(event.target.value);
                        setManualJsonError(null);
                      }}
                      className="h-56 w-full resize-none font-mono text-xs"
                      spellCheck={false}
                      aria-label="配置 JSON"
                    />
                    {manualJsonError && (
                      <p className="text-xs text-destructive" role="alert">
                        {manualJsonError}
                      </p>
                    )}
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={restoreManualJson}>
                        恢复默认
                      </Button>
                      <Button variant="outline" size="sm" onClick={formatManualJson}>
                        格式化
                      </Button>
                      <Button size="sm" onClick={applyManualJson}>
                        应用
                      </Button>
                    </div>
                  </div>
              ) : (
                <ParameterEditor
                  specs={manualSpecs}
                  params={manualDraft.params}
                  onChange={(next) => setManualDraft({ ...manualDraft, params: next })}
                />
              )}
            </div>
          </FieldGroup>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManualOpen(false)}>
              取消
            </Button>
            <Button
              onClick={() => void saveManual()}
              disabled={saving || !manualDraft.modelId.trim()}
            >
              {saving && <Spinner data-icon="inline-start" />}
              添加
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
