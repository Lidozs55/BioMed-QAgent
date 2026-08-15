import { useState } from "react";
import { PlusIcon, StarIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ModelImportSheet } from "@/components/settings/model/ModelImportSheet";
import { ParameterEditor } from "@/components/settings/model/ParameterEditor";
import type {
  ManagedModelInfo,
  ModelCapabilities,
  ModelSettings,
  ParameterSpec,
  ProviderInfo,
  SettingsAPIClient,
} from "@/hooks/useAPI";
import { formatContextWindow } from "@/lib/tokenFormat";
import { cn } from "@/lib/utils";

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

function capabilitiesLabel(capabilities: ModelCapabilities): string {
  const labels: string[] = [];
  if (capabilities.text) labels.push("文本");
  if (capabilities.image) labels.push("图像");
  if (capabilities.video) labels.push("视频");
  if (capabilities.audio) labels.push("音频");
  return labels.length > 0 ? labels.join("、") : "—";
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editParams, setEditParams] = useState<Record<string, unknown>>({});
  const [editJsonOpen, setEditJsonOpen] = useState(false);
  const [editJsonText, setEditJsonText] = useState("");
  const [editJsonError, setEditJsonError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const editingModel = managedModels.find((model) => model.id === editingId) ?? null;

  const openAdd = () => {
    setSheetOpen(true);
  };

  const toggleEdit = (model: ManagedModelInfo) => {
    if (editingId === model.id) {
      setEditingId(null);
      return;
    }
    setEditingId(model.id);
    setEditParams({ ...model.params });
    setEditJsonOpen(false);
    setEditJsonError(null);
  };

  const openEditJson = () => {
    if (!editingModel) return;
    setEditJsonText(allParamsJson(editingModel.param_specs, editParams));
    setEditJsonError(null);
    setEditJsonOpen(true);
  };

  const formatEditJson = () => {
    try {
      const parsed: unknown = JSON.parse(editJsonText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("配置必须是 JSON 对象");
      }
      setEditJsonText(JSON.stringify(parsed, null, 2));
      setEditJsonError(null);
    } catch (error) {
      setEditJsonError(error instanceof Error ? error.message : "JSON 格式错误");
    }
  };

  const restoreEditJson = () => {
    if (!editingModel) return;
    setEditJsonText(allParamsJson(editingModel.param_specs, {}));
    setEditJsonError(null);
    toast.success("已恢复为默认参数");
  };

  const applyEditJson = () => {
    try {
      const parsed: unknown = JSON.parse(editJsonText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("配置必须是 JSON 对象");
      }
      setEditParams(parsed as Record<string, unknown>);
      setEditJsonOpen(false);
      setEditJsonError(null);
      toast.success("JSON 配置已应用，记得保存参数");
    } catch (error) {
      setEditJsonError(error instanceof Error ? error.message : "JSON 格式错误");
    }
  };

  const saveEdit = async (model: ManagedModelInfo) => {
    setSavingEdit(true);
    try {
      await api.updateManagedModel(model.id, { params: editParams });
      toast.success(`已保存 ${model.name} 的参数`);
      setEditingId(null);
      onChanged();
    } catch (error) {
      toast.error("保存失败", { description: errorText(error) });
    } finally {
      setSavingEdit(false);
    }
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
            const editing = editingId === model.id;
            return (
              <li key={model.id} className="overflow-hidden rounded-xl border bg-card">
                <div className="flex items-center justify-between gap-3 px-4 py-3">
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
                    <Button variant="ghost" size="sm" onClick={() => toggleEdit(model)}>
                      {editing ? "收起" : "编辑"}
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
                {editing && (
                  <div className="border-t bg-muted/30 px-4 py-4">
                    <div className="grid gap-5 md:grid-cols-2">
                      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                        <dt className="text-muted-foreground">供应商</dt>
                        <dd className="truncate">{model.provider_name}</dd>
                        <dt className="text-muted-foreground">模型 ID</dt>
                        <dd className="truncate">{model.model_id}</dd>
                        <dt className="text-muted-foreground">上下文窗口</dt>
                        <dd>{formatContextWindow(model.context_window)}</dd>
                        <dt className="text-muted-foreground">最大输出</dt>
                        <dd>{formatContextWindow(model.max_output_tokens)}</dd>
                        <dt className="text-muted-foreground">能力</dt>
                        <dd>{capabilitiesLabel(model.capabilities)}</dd>
                        <dt className="text-muted-foreground">来源</dt>
                        <dd>{sourceBadgeLabel(model)}</dd>
                      </dl>
                      <div>
                        {editJsonOpen ? (
                          <div className="space-y-2">
                            <Textarea
                              value={editJsonText}
                              onChange={(event) => {
                                setEditJsonText(event.target.value);
                                setEditJsonError(null);
                              }}
                              className="h-56 w-full resize-none font-mono text-xs"
                              spellCheck={false}
                              aria-label="配置 JSON"
                            />
                            {editJsonError && (
                              <p className="text-xs text-destructive" role="alert">
                                {editJsonError}
                              </p>
                            )}
                            <div className="flex items-center gap-2">
                              <Button variant="outline" size="sm" onClick={restoreEditJson}>
                                恢复默认
                              </Button>
                              <Button variant="outline" size="sm" onClick={formatEditJson}>
                                格式化
                              </Button>
                              <Button size="sm" onClick={applyEditJson}>
                                应用
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <ParameterEditor
                            specs={model.param_specs}
                            params={editParams}
                            onChange={setEditParams}
                          />
                        )}
                      </div>
                    </div>
                    <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3">
                      {model.source !== "manual" && (
                        <p className="text-xs text-amber-600 dark:text-amber-400">
                          官方提供的参数，请谨慎修改
                        </p>
                      )}
                      <div
                        className={cn(
                          "flex items-center gap-2",
                          model.source === "manual" && "ml-auto",
                        )}
                      >
                        <Button variant="outline" size="sm" onClick={openEditJson}>
                          {editJsonOpen ? "返回图形编辑" : "配置 JSON"}
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => void saveEdit(model)}
                          disabled={savingEdit}
                        >
                          {savingEdit && <Spinner data-icon="inline-start" />}
                          保存参数
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
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
      />
    </div>
  );
}
