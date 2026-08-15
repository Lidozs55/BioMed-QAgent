import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { ModelListManager } from "@/components/settings/model/ModelListManager";
import { ProviderManager } from "@/components/settings/model/ProviderManager";
import { SettingCard, SettingSection } from "@/components/settings/primitives";
import type { ModelSettingsSectionProps } from "@/components/settings/types";
import type { ManagedModelInfo, ParameterSpec, ProviderInfo } from "@/hooks/useAPI";
import { formatContextWindow } from "@/lib/tokenFormat";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

function paramLabel(specs: ParameterSpec[], key: string): string {
  return specs.find((spec) => spec.key === key)?.label ?? key;
}

function formatParamValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (value === null || value === undefined || value === "") return "未设置";
  return String(value);
}

function ParamValueRows({
  params,
  specs,
}: {
  params: Record<string, unknown>;
  specs: ParameterSpec[];
}) {
  const entries = Object.entries(params);
  if (entries.length === 0) {
    return <p className="text-xs text-muted-foreground">该模型暂无参数配置。</p>;
  }
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-center justify-between gap-3">
          <dt className="truncate text-xs text-muted-foreground">{paramLabel(specs, key)}</dt>
          <dd className="truncate text-sm text-foreground">{formatParamValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function ActiveModelInfo({
  model,
  settings,
}: {
  model: ManagedModelInfo;
  settings: NonNullable<ModelSettingsSectionProps["settings"]>;
}) {
  return (
    <div className="px-5 py-4">
      <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{model.name}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {model.provider_name} · {model.model_id} · 上下文 {formatContextWindow(model.context_window)}
          </p>
        </div>
        {model.provider_api_key_configured && (
          <span className="shrink-0 text-xs text-muted-foreground">已配置密钥</span>
        )}
      </div>
      <div className="mt-4">
        <p className="mb-3 text-sm font-medium">当前参数</p>
        <ParamValueRows params={model.params} specs={model.param_specs} />
      </div>
      <div className="mt-4 border-t pt-3">
        <p className="text-xs text-muted-foreground">
          上下文窗口：{formatContextWindow(settings.context_window)} · 参数修改请到“模型列表”中编辑该模型。
        </p>
      </div>
    </div>
  );
}

function LegacyActiveModelInfo({
  settings,
}: {
  settings: NonNullable<ModelSettingsSectionProps["settings"]>;
}) {
  const params: Record<string, unknown> = {
    上下文窗口: formatContextWindow(settings.context_window),
    "最大输出 Tokens": settings.max_tokens,
    Temperature: settings.advanced.temperature ?? 0.7,
    "Top P": settings.advanced.top_p ?? 1,
    联网搜索: settings.advanced.enable_search ?? false,
    思维链模式: settings.advanced.thinking_mode ?? false,
  };
  return (
    <div className="px-5 py-4">
      <div className="flex items-start justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{settings.model_name}</p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{settings.base_url}</p>
        </div>
        {settings.api_key_configured && (
          <span className="shrink-0 text-xs text-muted-foreground">已配置密钥</span>
        )}
      </div>
      <div className="mt-4">
        <p className="mb-3 text-sm font-medium">当前参数</p>
        <ParamValueRows params={params} specs={[]} />
      </div>
      <p className="mt-4 border-t pt-3 text-xs text-muted-foreground">
        该模型不在维护列表中，展示的是当前运行时配置。
      </p>
    </div>
  );
}

export function ModelSettingsSection({
  api,
  settings,
  onActivated,
}: ModelSettingsSectionProps) {
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [managedModels, setManagedModels] = useState<ManagedModelInfo[]>([]);
  const [registryLoading, setRegistryLoading] = useState(true);

  const refreshRegistry = useCallback(async () => {
    try {
      const [nextProviders, nextModels] = await Promise.all([
        api.fetchProviders(),
        api.fetchManagedModels(),
      ]);
      setProviders(nextProviders);
      setManagedModels(nextModels);
    } catch (error) {
      toast.error("模型注册表加载失败", { description: errorText(error) });
    } finally {
      setRegistryLoading(false);
    }
  }, [api]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshRegistry();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshRegistry]);

  const activeModelId = settings?.model_name ?? "";
  const activeManagedModel =
    managedModels.find((model) => model.model_id === activeModelId) ?? null;

  return (
    <div className="space-y-10">
      <SettingSection
        title="供应商管理"
        description="配置模型供应商的代号、Base URL 与 API Key，可从常用供应商快捷填入。"
      >
        <SettingCard>
          <div className="px-5 py-4">
            <ProviderManager
              api={api}
              providers={providers}
              loading={registryLoading}
              onChanged={() => void refreshRegistry()}
            />
          </div>
        </SettingCard>
      </SettingSection>

      <SettingSection
        title="模型列表"
        description="维护各供应商下的模型列表：从供应商返回的模型列表导入，或手动配置。"
      >
        <SettingCard>
          <div className="px-5 py-4">
            <ModelListManager
              api={api}
              providers={providers}
              managedModels={managedModels}
              loading={registryLoading}
              activeModelName={activeModelId || null}
              onActivated={onActivated}
              onChanged={() => void refreshRegistry()}
            />
          </div>
        </SettingCard>
      </SettingSection>

      {settings && activeModelId && (
        <SettingSection
          title="当前模型"
          description="当前任务使用的模型信息，参数请在“模型列表”中维护。"
        >
          <SettingCard>
            {activeManagedModel ? (
              <ActiveModelInfo model={activeManagedModel} settings={settings} />
            ) : (
              <LegacyActiveModelInfo settings={settings} />
            )}
          </SettingCard>
        </SettingSection>
      )}
    </div>
  );
}
