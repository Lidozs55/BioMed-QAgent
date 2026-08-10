import { useState } from "react";
import { PlusIcon, StarIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ModelImportSheet } from "@/components/settings/model/ModelImportSheet";
import type {
  ManagedModelInfo,
  ModelSettings,
  ProviderInfo,
  SettingsAPIClient,
} from "@/hooks/useAPI";

interface ModelListManagerProps {
  api: SettingsAPIClient;
  providers: ProviderInfo[];
  managedModels: ManagedModelInfo[];
  loading: boolean;
  activeModelName: string | null;
  onActivated: (settings: ModelSettings) => void;
  onChanged: () => void;
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

function sourceLabel(source: ManagedModelInfo["source"]): string {
  if (source === "api") return "API 导入";
  if (source === "catalog") return "目录";
  return "手动";
}

export function ModelListManager({
  api,
  providers,
  managedModels,
  loading,
  activeModelName,
  onActivated,
  onChanged,
}: ModelListManagerProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const openAdd = () => {
    setEditingProviderId(null);
    setEditingModelId(null);
    setSheetOpen(true);
  };

  const openEdit = (model: ManagedModelInfo) => {
    setEditingProviderId(model.provider_id);
    setEditingModelId(model.id);
    setSheetOpen(true);
  };

  const activate = async (model: ManagedModelInfo) => {
    setActivatingId(model.id);
    try {
      const updated = await api.activateManagedModel(model.id);
      onActivated(updated);
      toast.success(`已切换当前模型为 ${model.name}`);
      onChanged();
    } catch (error) {
      toast.error("切换失败", { description: errorText(error) });
    } finally {
      setActivatingId(null);
    }
  };

  const remove = async (model: ManagedModelInfo) => {
    try {
      await api.deleteManagedModel(model.id);
      toast.success(`已移除 ${model.name}`);
      onChanged();
    } catch (error) {
      toast.error("移除失败", { description: errorText(error) });
    } finally {
      setConfirmDeleteId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          维护各供应商下的模型：可从供应商返回的列表导入，也可手动添加。
        </p>
        <Button
          size="sm"
          onClick={openAdd}
          disabled={providers.length === 0}
          title={providers.length === 0 ? "请先添加供应商" : undefined}
        >
          <PlusIcon data-icon="inline-start" />
          添加模型
        </Button>
      </div>
      {providers.length === 0 && (
        <p className="text-xs text-muted-foreground">
          添加第一个供应商后即可添加模型。
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Spinner />
        </div>
      ) : managedModels.length === 0 ? (
        <div className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">
          还没有维护的模型，点击“添加模型”开始。
        </div>
      ) : (
        <ul className="space-y-2">
          {managedModels.map((model) => {
            const isActive = model.model_id === activeModelName;
            return (
              <li
                key={model.id}
                className="flex items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{model.name}</span>
                    <Badge variant="outline" className="shrink-0">
                      {sourceLabel(model.source)}
                    </Badge>
                    {isActive && (
                      <Badge className="shrink-0 gap-1">
                        <StarIcon weight="fill" className="size-3" />
                        当前
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {model.provider_name} · {model.model_id} · 上下文 {formatWindow(model.context_window)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button variant="ghost" size="sm" onClick={() => openEdit(model)}>
                    编辑
                  </Button>
                  <Button
                    variant={isActive ? "outline" : "default"}
                    size="sm"
                    disabled={isActive || activatingId === model.id}
                    onClick={() => void activate(model)}
                  >
                    {activatingId === model.id && <Spinner data-icon="inline-start" />}
                    {isActive ? "当前模型" : "设为当前"}
                  </Button>
                  {confirmDeleteId === model.id ? (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => void remove(model)}
                    >
                      确认删除
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => setConfirmDeleteId(model.id)}
                    >
                      删除
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ModelImportSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        api={api}
        providers={providers}
        managedModels={managedModels}
        onSaved={onChanged}
        initialProviderId={editingProviderId}
        initialModelId={editingModelId}
      />
    </div>
  );
}
