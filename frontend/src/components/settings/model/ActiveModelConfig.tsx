import { useState } from "react";
import { toast } from "sonner";

import { ContextWindowSelect } from "@/components/ContextWindowSelect";
import { ParameterEditor } from "@/components/settings/model/ParameterEditor";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type {
  ManagedModelInfo,
  ModelSettings,
  SettingsAPIClient,
} from "@/hooks/useAPI";

interface ActiveModelConfigProps {
  api: SettingsAPIClient;
  model: ManagedModelInfo;
  settings: ModelSettings;
  onContextWindowChange: (tokens: number) => void;
  onActivated: (settings: ModelSettings) => void;
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

export function ActiveModelConfig({
  api,
  model,
  settings,
  onContextWindowChange,
  onActivated,
}: ActiveModelConfigProps) {
  const [params, setParams] = useState<Record<string, unknown>>(model.params);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const updated = await api.updateManagedModel(model.id, { params });
      const nextSettings = await api.activateManagedModel(model.id);
      setParams(updated.params);
      onActivated(nextSettings);
      toast.success(`已保存 ${updated.name} 的参数`);
    } catch (error) {
      toast.error("参数保存失败", { description: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="px-5 py-4">
      <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{model.name}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {model.provider_name} · {model.model_id} · 上下文 {formatWindow(model.context_window)}
          </p>
        </div>
        {model.provider_api_key_configured && (
          <span className="shrink-0 text-xs text-muted-foreground">已配置密钥</span>
        )}
      </div>

      <ContextWindowSelect
        value={settings.context_window}
        maxCatalogWindow={model.context_window ?? 0}
        source={settings.context_window_source}
        onChange={onContextWindowChange}
      />

      <div className="mt-4 border-t pt-4">
        <p className="mb-3 text-sm font-medium">模型参数</p>
        <ParameterEditor specs={model.param_specs} params={params} onChange={setParams} />
      </div>

      <div className="mt-4 flex justify-end border-t pt-3">
        <Button onClick={() => void save()} disabled={saving}>
          {saving && <Spinner data-icon="inline-start" />}
          保存参数
        </Button>
      </div>
    </div>
  );
}
