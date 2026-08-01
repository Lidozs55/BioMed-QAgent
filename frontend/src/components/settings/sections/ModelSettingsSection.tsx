import { EyeClosedIcon, EyeIcon, Image, SpeakerHigh, VideoCamera } from "@phosphor-icons/react";

import { ModelInfoCard } from "@/components/model-info-card";
import { ContextWindowSlider } from "@/components/ContextWindowSlider";
import {
  NumberField,
  SettingCard,
  SettingRow,
  SettingSection,
} from "@/components/settings/primitives";
import type { ModelSettingsSectionProps } from "@/components/settings/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

function SelectedModelCapabilities({ model }: { model: NonNullable<ModelSettingsSectionProps["models"]>[number] }) {
  return (
    <div className="mt-1 flex shrink-0 gap-1.5">
      {model.capabilities?.image && (
        <span
          role="img"
          className="text-emerald-600 dark:text-emerald-400"
          title="支持图像"
          aria-label="支持图像"
        >
          <Image weight="fill" className="size-3" />
        </span>
      )}
      {model.capabilities?.video && (
        <span
          role="img"
          className="text-emerald-600 dark:text-emerald-400"
          title="支持视频"
          aria-label="支持视频"
        >
          <VideoCamera weight="fill" className="size-3" />
        </span>
      )}
      {model.capabilities?.audio && (
        <span
          role="img"
          className="text-emerald-600 dark:text-emerald-400"
          title="支持音频"
          aria-label="支持音频"
        >
          <SpeakerHigh weight="fill" className="size-3" />
        </span>
      )}
    </div>
  );
}

export function ModelSettingsSection({
  settings,
  vendors,
  models,
  modelsLoading,
  modelsLoaded,
  draft,
  dirty,
  saving,
  modelError,
  highlightAnchor,
  onDraftChange,
  onUiChange,
  onPreviewModels,
  onContextWindowChange,
  onSave,
}: ModelSettingsSectionProps) {
  const selectedVendor = vendors.find((vendor) => vendor.base_url === draft.baseUrl);
  const selectedModel = models.find((model) => model.id === draft.modelName) ?? null;
  const showThinking = selectedModel?.id.startsWith("qwq") ?? false;
  const saveDisabled =
    !dirty ||
    saving ||
    (!draft.apiKey.trim() && !settings?.api_key_configured) ||
    !modelsLoaded;

  return (
    <div className="space-y-8">
      <SettingSection
        title="模型连接"
        description="新任务会使用保存后的配置；运行中的模型实例保持不变。"
      >
        <SettingCard>
          <SettingRow
            id="settings-vendor"
            title="服务商"
            description="快速填充兼容 OpenAI 协议的接口地址。"
            highlight={highlightAnchor === "settings-vendor"}
            control={
              <Select
                value={selectedVendor?.id ?? undefined}
                onValueChange={(vendorId) => {
                  const vendor = vendors.find((item) => item.id === vendorId);
                  if (vendor) onDraftChange({ baseUrl: vendor.base_url });
                }}
              >
                <SelectTrigger className="w-56" aria-label="服务商">
                  <SelectValue placeholder="选择服务商" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {vendors.map((vendor) => (
                      <SelectItem key={vendor.id} value={vendor.id}>
                        {vendor.name}
                        {vendor.recommended ? " · 推荐" : ""}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            }
          />
          <SettingRow
            id="settings-baseurl"
            title="Base URL"
            description="OpenAI 兼容模式的接口根地址。"
            controlId="settings-baseurl"
            highlight={highlightAnchor === "settings-baseurl"}
            controlClassName="w-full sm:w-96"
            control={
              <Input
                id="settings-baseurl"
                value={draft.baseUrl}
                onChange={(event) => onDraftChange({ baseUrl: event.target.value })}
                placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                className="w-full"
              />
            }
          />
          <SettingRow
            id="settings-apikey"
            title="API Key"
            description="已保存的密钥不会回填输入框。留空并保存，可清除密钥。"
            controlId="settings-apikey"
            highlight={highlightAnchor === "settings-apikey"}
            controlClassName="w-full sm:w-96"
            control={
              <div className="relative w-full">
                <Input
                  id="settings-apikey"
                  type={draft.showApiKey ? "text" : "password"}
                  value={draft.apiKey}
                  onChange={(event) => onDraftChange({ apiKey: event.target.value })}
                  placeholder={settings?.api_key_configured ? "输入新值以覆盖已配置密钥" : "sk-..."}
                  className="w-full pr-8"
                />
                <button
                  type="button"
                  className="absolute top-1/2 right-2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  onClick={() => onUiChange({ showApiKey: !draft.showApiKey })}
                  tabIndex={-1}
                  aria-label={draft.showApiKey ? "隐藏 API Key" : "显示 API Key"}
                >
                  {draft.showApiKey ? <EyeClosedIcon className="size-4" /> : <EyeIcon className="size-4" />}
                </button>
              </div>
            }
          />
          <SettingRow
            id="settings-model"
            title="模型"
            description="从接口发现列表中选择，或手动输入模型名称。"
            highlight={highlightAnchor === "settings-model"}
            controlClassName="w-full sm:w-96"
            control={
              <div className="w-full">
                <div className="flex gap-2">
                  <div className="relative min-w-0 flex-1">
                    {models.length === 0 ? (
                      <Input
                        id="settings-model"
                        value={modelsLoaded ? draft.modelName : ""}
                        onChange={(event) => {
                          onDraftChange({ modelName: event.target.value });
                        }}
                        placeholder="输入模型名称（如 qwen-plus）"
                        className="w-full"
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          id="settings-model"
                          className="flex h-8 w-full items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-2.5 text-sm ring-offset-background focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                          onClick={() => onUiChange({ showModelDropdown: !draft.showModelDropdown })}
                        >
                          {modelsLoading ? (
                            <span className="flex items-center gap-2 text-muted-foreground">
                              <Spinner className="size-3.5" />
                              正在加载模型列表...
                            </span>
                          ) : (
                            <span className="truncate">
                              {selectedModel ? selectedModel.name : "选择模型"}
                            </span>
                          )}
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {models.length > 0 ? `${models.length} 个可用` : ""}
                          </span>
                        </button>

                        {draft.showModelDropdown && (
                          <div className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-lg border bg-popover shadow-md">
                            <div className="p-2">
                              <Input
                                placeholder="搜索模型..."
                                value={draft.modelSearch}
                                onChange={(event) => onUiChange({ modelSearch: event.target.value })}
                                className="h-9 text-sm"
                                autoFocus
                              />
                            </div>
                            <ScrollArea className="h-72">
                              {models.length === 0 ? (
                                <div className="p-4 text-center text-sm text-muted-foreground">
                                  没有匹配的模型
                                </div>
                              ) : (
                                models
                                  .filter((model) => {
                                    const query = draft.modelSearch.trim().toLowerCase();
                                    return (
                                      !query ||
                                      model.name.toLowerCase().includes(query) ||
                                      model.id.toLowerCase().includes(query)
                                    );
                                  })
                                  .map((model) => (
                                    <button
                                      key={model.id}
                                      type="button"
                                      className={cn(
                                        "flex w-full items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-accent",
                                        model.id === draft.modelName && "bg-accent font-medium",
                                      )}
                                      onClick={() => onDraftChange({ modelName: model.id })}
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
                                        <p className="truncate text-xs text-muted-foreground">
                                          {model.description}
                                        </p>
                                      </div>
                                      <div className="ml-3 flex shrink-0 items-center">
                                        <SelectedModelCapabilities model={model} />
                                      </div>
                                    </button>
                                  ))
                              )}
                            </ScrollArea>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onPreviewModels}
                    disabled={modelsLoading}
                  >
                    {modelsLoading && <Spinner data-icon="inline-start" />}
                    加载模型
                  </Button>
                </div>
                {modelError && (
                  <p className="mt-2 text-xs text-destructive" role="alert">
                    {modelError}
                  </p>
                )}
              </div>
            }
          />
        </SettingCard>
        {selectedModel && <ModelInfoCard model={selectedModel} />}
      </SettingSection>

      <SettingSection
        title="上下文与输出"
        description="控制单次任务可用的输入窗口与生成长度上限。"
      >
        <SettingCard>
          <div className="px-5 py-4">
            <ContextWindowSlider
              value={settings?.context_window ?? 0}
              maxCatalogWindow={selectedModel?.context_window ?? 0}
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
          保存前会先验证连接；保存后新任务使用新配置。
        </p>
        <Button onClick={onSave} disabled={saveDisabled}>
          {saving && <Spinner data-icon="inline-start" />}
          保存模型设置
        </Button>
      </div>
    </div>
  );
}
