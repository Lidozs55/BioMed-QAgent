import {
  ArrowLeftIcon,
  CheckCircleIcon,
  EyeClosedIcon,
  EyeIcon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react"
import { useCallback, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { ModelInfo, UserSettings } from "@/hooks/useSettings"

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface SettingsPanelProps {
  settings: UserSettings | null
  models: ModelInfo[]
  loading: boolean
  saving: boolean
  modelsLoading: boolean
  error: string | null
  onSave: (payload: {
    base_url?: string
    api_key?: string
    model_name?: string
    max_tokens?: number
  }) => Promise<void>
  onClose: () => void
  onFetchModels: (query?: string) => Promise<void>
}

// ────────────────────────────────────────────────────────────────────────────
// Capability badge component
// ────────────────────────────────────────────────────────────────────────────

function CapabilityBadge({
  label,
  supported,
}: {
  label: string
  supported: boolean
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
        supported
          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
          : "bg-muted text-muted-foreground line-through",
      )}
    >
      {supported ? (
        <CheckCircleIcon weight="fill" className="size-3" />
      ) : (
        <XCircleIcon weight="fill" className="size-3" />
      )}
      {label}
    </span>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Model info card
// ────────────────────────────────────────────────────────────────────────────

function ModelInfoCard({ model }: { model: ModelInfo }) {
  const formatNumber = (n: number) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
    return String(n)
  }

  return (
    <div className="mt-4 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-base font-semibold">{model.name}</h4>
            {model.recommended && (
              <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                推荐
              </span>
            )}
            {model.api_available && (
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                可用
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{model.description}</p>
        </div>
        <span className="shrink-0 rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
          {model.id}
        </span>
      </div>

      <Separator className="my-3" />

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <span className="text-xs text-muted-foreground">上下文窗口</span>
          <p className="mt-0.5 font-medium">{formatNumber(model.context_window)} tokens</p>
        </div>
        <div>
          <span className="text-xs text-muted-foreground">建议输出上限</span>
          <p className="mt-0.5 font-medium">{formatNumber(model.suggested_max_tokens)} tokens</p>
        </div>
      </div>

      <div className="mt-3">
        <span className="text-xs text-muted-foreground">多模态能力</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <CapabilityBadge label="文本" supported={model.capabilities.text} />
          <CapabilityBadge label="图像" supported={model.capabilities.image} />
          <CapabilityBadge label="视频" supported={model.capabilities.video} />
          <CapabilityBadge label="音频" supported={model.capabilities.audio} />
        </div>
      </div>
    </div>
  )
}

// ────────────────────────────────────────────────────────────────────────────
// Main SettingsPanel component
// ────────────────────────────────────────────────────────────────────────────

export function SettingsPanel({
  settings: initialSettings,
  models,
  loading,
  saving,
  modelsLoading,
  error,
  onSave,
  onClose,
  onFetchModels,
}: SettingsPanelProps) {
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [apiKeyInput, setApiKeyInput] = useState("")
  const [modelName, setModelName] = useState("")
  const [maxTokens, setMaxTokens] = useState(8192)
  const [showApiKey, setShowApiKey] = useState(false)
  const [modelSearch, setModelSearch] = useState("")
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [dirty, setDirty] = useState(false)

  // Initialise local state from backend settings
  useEffect(() => {
    if (initialSettings) {
      setBaseUrl(initialSettings.base_url)
      setApiKey(initialSettings.api_key)
      setModelName(initialSettings.model_name)
      setMaxTokens(initialSettings.max_tokens)
    }
  }, [initialSettings])

  const selectedModel = models.find((m) => m.id === modelName)

  const filteredModels = models.filter(
    (m) =>
      m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
      m.id.toLowerCase().includes(modelSearch.toLowerCase()),
  )

  const handleSave = useCallback(async () => {
    const payload: { base_url?: string; api_key?: string; model_name?: string; max_tokens?: number } = {}
    if (baseUrl !== initialSettings?.base_url) payload.base_url = baseUrl
    if (apiKeyInput && apiKeyInput !== initialSettings?.api_key) payload.api_key = apiKeyInput
    if (modelName !== initialSettings?.model_name) payload.model_name = modelName
    if (maxTokens !== initialSettings?.max_tokens) payload.max_tokens = maxTokens
    await onSave(payload)
    setDirty(false)
  }, [baseUrl, apiKeyInput, modelName, maxTokens, initialSettings, onSave])

  const markDirty = useCallback(() => setDirty(true), [])

  const handleModelSelect = useCallback(
    (id: string) => {
      setModelName(id)
      setShowModelDropdown(false)
      setDirty(true)
    },
    [],
  )

  if (loading) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center">
        <Spinner className="size-6" />
        <span className="ml-3 text-sm text-muted-foreground">加载设置中…</span>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="返回对话"
          >
            <ArrowLeftIcon aria-hidden="true" />
          </Button>
          <div>
            <h2 className="text-base font-semibold">模型设置</h2>
            <p className="text-xs text-muted-foreground">配置后端模型接口与参数</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {error && (
            <span className="text-xs text-destructive">{error}</span>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!dirty || saving}
            onClick={() => void handleSave()}
          >
            {saving && <Spinner data-icon="inline-start" className="size-3.5" />}
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-2xl space-y-8 p-6">
          {/* ── API Connection ── */}
          <section>
            <h3 className="text-sm font-semibold text-foreground">API 连接</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              配置模型服务的访问地址和认证密钥。默认为阿里云 DashScope 端点。
            </p>
            <div className="mt-4 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="settings-baseurl">Base URL</Label>
                <Input
                  id="settings-baseurl"
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value)
                    markDirty()
                  }}
                  placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settings-apikey">API Key</Label>
                <div className="relative">
                  <Input
                    id="settings-apikey"
                    type={showApiKey ? "text" : "password"}
                    value={apiKeyInput || apiKey}
                    onChange={(e) => {
                      setApiKeyInput(e.target.value)
                      markDirty()
                    }}
                    placeholder={apiKey ? "已配置（输入新值以更新）" : "sk-..."}
                  />
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowApiKey((v) => !v)}
                    aria-label={showApiKey ? "隐藏API密钥" : "显示API密钥"}
                  >
                    {showApiKey ? (
                      <EyeClosedIcon className="size-4" />
                    ) : (
                      <EyeIcon className="size-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </section>

          <Separator />

          {/* ── Model Selection ── */}
          <section>
            <h3 className="text-sm font-semibold text-foreground">模型选择</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              选择要使用的模型。推荐使用 Qwen Plus 以获得最佳体验。
            </p>
            <div className="mt-4 space-y-1.5">
              <Label htmlFor="settings-model">模型</Label>
              <div className="relative">
                <button
                  type="button"
                  id="settings-model"
                  className="flex h-10 w-full items-center justify-between rounded-lg border bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setShowModelDropdown((v) => !v)}
                >
                  {modelsLoading ? (
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <Spinner className="size-3.5" />
                      加载模型列表中…
                    </span>
                  ) : (
                    <span>
                      {(selectedModel?.name ?? modelName) || "选择模型"}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {models.length} 个可用
                  </span>
                </button>

                {showModelDropdown && (
                  <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border bg-popover shadow-md">
                    <div className="p-2">
                      <Input
                        placeholder="搜索模型…"
                        value={modelSearch}
                        onChange={(e) => setModelSearch(e.target.value)}
                        className="h-9 text-sm"
                        autoFocus
                      />
                    </div>
                    <ScrollArea className="max-h-72">
                      {filteredModels.length === 0 ? (
                        <div className="p-4 text-center text-sm text-muted-foreground">
                          没有匹配的模型
                        </div>
                      ) : (
                        filteredModels.map((model) => (
                          <button
                            key={model.id}
                            type="button"
                            className={cn(
                              "flex w-full items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-accent",
                              model.id === modelName && "bg-accent font-medium",
                            )}
                            onClick={() => handleModelSelect(model.id)}
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
                            <div className="ml-3 flex shrink-0 gap-1.5">
                              {model.capabilities.image && (
                                <TooltipProvider>
                                  <Tooltip>
                                    <TooltipTrigger asChild>
                                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                                        图
                                      </span>
                                    </TooltipTrigger>
                                    <TooltipContent>支持图像</TooltipContent>
                                  </Tooltip>
                                </TooltipProvider>
                              )}
                              {model.capabilities.video && (
                                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                                  视
                                </span>
                              )}
                              {model.capabilities.audio && (
                                <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                                  音
                                </span>
                              )}
                            </div>
                          </button>
                        ))
                      )}
                    </ScrollArea>
                  </div>
                )}
              </div>
            </div>

            {/* Model info card — shows when a model is selected */}
            {selectedModel && <ModelInfoCard model={selectedModel} />}
          </section>

          <Separator />

          {/* ── Generation Parameters ── */}
          <section>
            <h3 className="text-sm font-semibold text-foreground">生成参数</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              控制模型生成的最大 token 数量。
            </p>
            <div className="mt-4 space-y-1.5">
              <Label htmlFor="settings-maxtokens">最大输出 Tokens</Label>
              <div className="flex items-center gap-3">
                <input
                  id="settings-maxtokens"
                  type="range"
                  min={512}
                  max={131072}
                  step={512}
                  value={maxTokens}
                  onChange={(e) => {
                    setMaxTokens(Number(e.target.value))
                    markDirty()
                  }}
                  className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary"
                />
                <span className="w-24 text-right font-mono text-sm tabular-nums text-muted-foreground">
                  {maxTokens.toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between text-[11px] text-muted-foreground">
                <span>512</span>
                <span>131K</span>
              </div>
            </div>
          </section>

          <div className="h-8" />
        </div>
      </ScrollArea>
    </div>
  )
}
