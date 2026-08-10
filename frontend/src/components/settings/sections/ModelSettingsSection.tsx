import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { ContextWindowSelect } from "@/components/ContextWindowSelect";
import { ActiveModelConfig } from "@/components/settings/model/ActiveModelConfig";
import { ModelListManager } from "@/components/settings/model/ModelListManager";
import { ProviderManager } from "@/components/settings/model/ProviderManager";
import {
  NumberField,
  SettingCard,
  SettingRow,
  SettingSection,
} from "@/components/settings/primitives";
import type { ModelSettingsSectionProps } from "@/components/settings/types";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import type { ManagedModelInfo, ProviderInfo } from "@/hooks/useAPI";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

export function ModelSettingsSection({
  api,
  settings,
  draft,
  dirty,
  saving,
  modelError,
  highlightAnchor,
  onDraftChange,
  onContextWindowChange,
  onSave,
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
  const showThinking = activeModelId.startsWith("qwq");
  const saveDisabled = !dirty || saving;
  const hasActiveModel = Boolean(settings && activeModelId);

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

      {settings && activeModelId && activeManagedModel && (
        <SettingSection
          title="当前模型"
          description="当前任务使用的模型，参数来自该模型的配置，保存后立即生效。"
        >
          <SettingCard>
            <ActiveModelConfig
              key={activeManagedModel.id}
              api={api}
              model={activeManagedModel}
              settings={settings}
              onContextWindowChange={onContextWindowChange}
              onActivated={onActivated}
            />
          </SettingCard>
        </SettingSection>
      )}

      {hasActiveModel && !activeManagedModel && (
        <>
          <SettingSection
            title="当前模型"
            description="当前任务使用的模型与生成参数，通过“模型列表”中的“设为当前”切换模型。"
          >
            <SettingCard>
              <div className="px-5 py-4">
                <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border bg-muted/30 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {activeModelId || "未选择模型"}
                    </p>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {settings?.base_url ?? ""}
                    </p>
                  </div>
                  {settings?.api_key_configured && (
                    <span className="shrink-0 text-xs text-muted-foreground">已配置密钥</span>
                  )}
                </div>
                <ContextWindowSelect
                  value={settings?.context_window ?? 0}
                  maxCatalogWindow={0}
                  source={settings?.context_window_source ?? "unknown"}
                  onChange={onContextWindowChange}
                />
              </div>
              <SettingRow
                id="settings-maxtokens"
                title="最大输出 Tokens"
                description="限制单次生成的 token 数量，超出部分会被截断。"
                controlId="settings-maxtokens"
                highlight={highlightAnchor === "settings-maxtokens"}
                control={
                  <NumberField
                    id="settings-maxtokens"
                    ariaLabel="最大输出 Tokens"
                    value={draft.maxTokens}
                    min={512}
                    max={131072}
                    step={512}
                    onChange={(value) => onDraftChange({ maxTokens: value })}
                  />
                }
              />
            </SettingCard>
          </SettingSection>

          <SettingSection
            title="生成参数"
            description="采样参数影响输出的随机性与多样性。"
          >
            <SettingCard>
              <SettingRow
                id="settings-temperature"
                title="Temperature"
                description="数值越高，输出越随机；越低则越稳定。"
                controlId="settings-temperature"
                highlight={highlightAnchor === "settings-temperature"}
                control={
                  <NumberField
                    id="settings-temperature"
                    ariaLabel="Temperature"
                    value={draft.temperature}
                    min={0}
                    max={2}
                    step={0.1}
                    onChange={(value) => onDraftChange({ temperature: value })}
                    marks={[
                      { value: 0, label: "精确" },
                      { value: 1, label: "平衡" },
                      { value: 2, label: "创意" },
                    ]}
                  />
                }
              />
              <SettingRow
                id="settings-topp"
                title="Top P"
                description="按累积概率截断候选词，越小越聚焦。"
                controlId="settings-topp"
                highlight={highlightAnchor === "settings-topp"}
                control={
                  <NumberField
                    id="settings-topp"
                    ariaLabel="Top P"
                    value={draft.topP}
                    min={0}
                    max={1}
                    step={0.05}
                    onChange={(value) => onDraftChange({ topP: value })}
                    marks={[
                      { value: 0, label: "严格" },
                      { value: 1, label: "默认" },
                    ]}
                  />
                }
              />
            </SettingCard>
          </SettingSection>

          <SettingSection
            title="联网与工具"
            description="按需启用检索与推理相关能力。"
          >
            <SettingCard>
              <SettingRow
                id="settings-search"
                title="联网搜索"
                description="让模型在需要时自动检索互联网。"
                controlId="settings-search"
                highlight={highlightAnchor === "settings-search"}
                control={
                  <Switch
                    id="settings-search"
                    checked={draft.enableSearch}
                    aria-label="联网搜索"
                    onCheckedChange={(checked) => onDraftChange({ enableSearch: checked })}
                  />
                }
              />
              {showThinking && (
                <SettingRow
                  id="settings-thinking"
                  title="思维链模式"
                  description="为推理模型启用更长的思考过程。"
                  controlId="settings-thinking"
                  highlight={highlightAnchor === "settings-thinking"}
                  control={
                    <Switch
                      id="settings-thinking"
                      checked={draft.thinkingMode}
                      aria-label="思维链模式"
                      onCheckedChange={(checked) => onDraftChange({ thinkingMode: checked })}
                    />
                  }
                />
              )}
            </SettingCard>
          </SettingSection>

          <div className="flex items-center justify-between gap-4 rounded-xl border bg-muted/40 px-5 py-3">
            <p className="min-w-0 text-xs leading-relaxed text-muted-foreground">
              {modelError ? (
                <span className="text-destructive" role="alert">
                  {modelError}
                </span>
              ) : (
                "保存后新任务使用新的生成参数。"
              )}
            </p>
            <Button onClick={onSave} disabled={saveDisabled}>
              {saving && <Spinner data-icon="inline-start" />}
              保存模型设置
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
