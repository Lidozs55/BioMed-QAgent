import { useState } from "react";
import { PlusIcon, StarIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ModelDetailDialog } from "@/components/settings/model/ModelDetailDialogFinal2";
import { ModelImportSheet } from "@/components/settings/model/ModelImportSheetFinal";
import type {
  ManagedModelInfo,
  ModelSettings,
  ProviderInfo,
  SettingsAPIClient,
} from "@/hooks/useAPI";
import { formatContextWindow } from "@/lib/tokenFormat";

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

/** 来源标签：API/目录导入的模型显示供应商名称，手动添加的显示“手动配置”。 */
function sourceBadgeLabel(model: ManagedModelInfo): string {
  return model.source === "manual" ? "手动配置" : model.provider_name;
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
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [detailModel, setDetailModel] = useState<ManagedModelInfo | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const openAdd = () => {
    setSheetOpen(true);
  };

  const openDetail = (model: ManagedModelInfo) => {
    setDetailModel(model);
    setDetailOpen(true);
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
    <div className="flex flex-col gap-3">
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
        <ul className="flex flex-col gap-2">
          {managedModels.map((model) => {
            const isActive = model.model_id === activeModelName;
            return (
              <li key={model.id} className="rounded-xl border bg-card px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{model.name}</span>
                      <Badge variant="outline" className="shrink-0">
                        {sourceBadgeLabel(model)}
                      </Badge>
                      {isActive && (
                        <Badge className="shrink-0 gap-1">
                          <StarIcon weight="fill" className="size-3" />
                          当前
                        </Badge>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {model.provider_name} · {model.model_id} · 上下文{" "}
                      {formatContextWindow(model.context_window)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => openDetail(model)}>
                      详情
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
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <ModelDetailDialog
        key={detailModel?.id ?? "closed"}
          open={detailOpen}
        onOpenChange={(next) => {
            setDetailOpen(next);
            if (!next) setDetailModel(null);
          }}
        model={detailModel}
        api={api}
        onSaved={onChanged}
      />

      <ModelImportSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        api={api}
        providers={providers}
        managedModels={managedModels}
        onSaved={onChanged}
      />
    </div>
  );
}
