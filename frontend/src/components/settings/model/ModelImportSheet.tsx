import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowSquareInIcon,
  MagnifyingGlassIcon,
  PlusIcon,
} from "@phosphor-icons/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { ParameterEditor } from "@/components/settings/model/ParameterEditor";
import type {
  DiscoveredModelInfo,
  ManagedModelInfo,
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

function formatWindow(tokens: number | null | undefined): string {
  if (!tokens || tokens <= 0) return "未知";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
  return String(tokens);
}

function defaultParams(discovered: DiscoveredModelInfo): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (const spec of discovered.param_specs ?? []) {
    if (spec.default !== undefined) params[spec.key] = spec.default;
  }
  return params;
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
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [manualId, setManualId] = useState("");
  const [manualName, setManualName] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const wasOpenRef = useRef(false);

  const providerModels = useMemo(
    () => managedModels.filter((model) => model.provider_id === providerId),
    [managedModels, providerId],
  );
  const selected = providerModels.find((model) => model.id === selectedId) ?? null;

  const resetForProvider = useCallback((nextProviderId: string) => {
    setProviderId(nextProviderId);
    setDiscovered([]);
    setDiscoverError(null);
    setSearch("");
    setSelectedId(null);
    setParams({});
    setManualId("");
    setManualName("");
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
          const existing = managedModels.find((model) => model.id === initialModelId);
          if (existing) setParams(existing.params);
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
    setSelectedId(item.id);
    setParams(defaultParams(item));
  };

  const importModel = async (item: DiscoveredModelInfo) => {
    if (!providerId) return;
    setSaving(true);
    try {
      const created = await api.createManagedModel({
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
      toast.success(`已导入 ${created.name}`);
      await onSaved();
      setSelectedId(created.id);
      setParams(created.params);
    } catch (error) {
      toast.error("导入失败", { description: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const addManual = async () => {
    const modelId = manualId.trim();
    if (!providerId || !modelId) {
      toast.error("请输入模型名称");
      return;
    }
    setSaving(true);
    try {
      const created = await api.createManagedModel({
        provider_id: providerId,
        model_id: modelId,
        name: manualName.trim() || modelId,
        source: "manual",
      });
      toast.success(`已添加 ${created.name}`);
      await onSaved();
      setSelectedId(created.id);
      setParams(created.params);
      setManualId("");
      setManualName("");
    } catch (error) {
      toast.error("添加失败", { description: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const saveSelected = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const updated = await api.updateManagedModel(selected.id, { params });
      toast.success(`已保存 ${updated.name} 的参数`);
      await onSaved();
      setParams(updated.params);
    } catch (error) {
      toast.error("保存失败", { description: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  const removeModel = async (model: ManagedModelInfo) => {
    try {
      await api.deleteManagedModel(model.id);
      toast.success(`已移除 ${model.name}`);
      await onSaved();
      if (selectedId === model.id) {
        setSelectedId(null);
        setParams({});
      }
    } catch (error) {
      toast.error("移除失败", { description: errorText(error) });
    } finally {
      setConfirmDeleteId(null);
    }
  };

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return discovered;
    return discovered.filter(
      (item) => item.id.toLowerCase().includes(query) || item.name.toLowerCase().includes(query),
    );
  }, [discovered, search]);

  const importedIds = new Set(providerModels.map((model) => model.model_id));
  const selectedSpecs = selected?.param_specs ?? [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle>添加 / 管理模型</SheetTitle>
          <SheetDescription>
            先选择供应商，从左侧导入模型到右侧维护列表，或手动添加模型。
          </SheetDescription>
        </SheetHeader>

        <div className="px-4">
          <Select
            value={providerId}
            onValueChange={(next) => {
              if (!next) return;
              resetForProvider(next);
              void discover(next);
            }}
          >
            <SelectTrigger className="w-full" aria-label="选择供应商">
              <SelectValue placeholder="选择供应商" />
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

        {providerId && (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 px-4 md:grid-cols-2">
            {/* Left: provider returned model list */}
            <div className="flex min-h-0 flex-col rounded-xl border bg-card">
              <div className="flex items-center gap-2 border-b p-3">
                <div className="relative min-w-0 flex-1">
                  <MagnifyingGlassIcon
                    data-icon="inline-start"
                    className="text-muted-foreground"
                  />
                  <Input
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    placeholder="搜索供应商模型..."
                    className="pl-8"
                  />
                </div>
                <Button variant="outline" size="sm" onClick={() => void discover()} disabled={discovering}>
                  {discovering ? <Spinner data-icon="inline-start" /> : null}
                  获取列表
                </Button>
              </div>
              {discoverError && (
                <p className="border-b px-3 py-2 text-xs text-destructive" role="alert">
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
                            "flex items-center justify-between gap-2 px-3 py-2.5",
                            active && "bg-accent",
                          )}
                        >
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => selectDiscovered(item)}
                          >
                            <span className="block truncate text-sm font-medium">{item.name}</span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {item.id} · {formatWindow(item.context_window)}
                            </span>
                          </button>
                          <Button
                            variant={imported ? "ghost" : "outline"}
                            size="sm"
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
            <div className="flex min-h-0 flex-col rounded-xl border bg-card">
              <div className="border-b p-3">
                <p className="text-sm font-medium">
                  已选模型 <span className="text-muted-foreground">({providerModels.length})</span>
                </p>
              </div>
              <ScrollArea className="max-h-40 shrink-0 border-b">
                {providerModels.length === 0 ? (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    还没有维护模型，从左侧导入或手动添加。
                  </div>
                ) : (
                  <ul className="divide-y">
                    {providerModels.map((model) => (
                      <li
                        key={model.id}
                        className={cn(
                          "flex items-center justify-between gap-2 px-3 py-2",
                          selectedId === model.id && "bg-accent",
                        )}
                      >
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => {
                            setSelectedId(model.id);
                            setParams(model.params);
                          }}
                        >
                          <span className="block truncate text-sm">{model.name}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {model.model_id}
                          </span>
                        </button>
                        {confirmDeleteId === model.id ? (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => void removeModel(model)}
                          >
                            确认移除
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="text-destructive"
                            onClick={() => setConfirmDeleteId(model.id)}
                          >
                            移除
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </ScrollArea>

              {selected ? (
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                  <div>
                    <p className="text-sm font-medium">{selected.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {selected.model_id} · 上下文 {formatWindow(selected.context_window)}
                    </p>
                  </div>
                  <ParameterEditor specs={selectedSpecs} params={params} onChange={setParams} />
                </div>
              ) : (
                <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
                  <p className="text-xs text-muted-foreground">
                    选择左侧模型导入后可在此修改参数；也可以手动添加模型：
                  </p>
                  <div className="flex gap-2">
                    <Input
                      value={manualId}
                      onChange={(event) => setManualId(event.target.value)}
                      placeholder="模型名称（如 gpt-4o-mini）"
                      aria-label="手动模型名称"
                    />
                    <Input
                      value={manualName}
                      onChange={(event) => setManualName(event.target.value)}
                      placeholder="显示名（可选）"
                      aria-label="手动模型显示名"
                      className="hidden sm:block"
                    />
                    <Button variant="outline" size="sm" onClick={() => void addManual()} disabled={saving}>
                      <PlusIcon data-icon="inline-start" />
                      添加
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {providerId && selected && (
          <SheetFooter>
            <Button onClick={() => void saveSelected()} disabled={saving}>
              <ArrowSquareInIcon data-icon="inline-start" />
              保存参数
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
