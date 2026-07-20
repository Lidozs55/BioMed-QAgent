import {
 ArrowLeftIcon,
 CheckCircleIcon,
 EyeClosedIcon,
 EyeIcon,
  Image,
 SlidersIcon,
  SpeakerHigh,
  VideoCamera,
 XCircleIcon,
} from "@phosphor-icons/react"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type {
  ModelInfo,
  UserSettings,
  VendorInfo,
} from "@/hooks/useSettings"

interface SettingsPanelProps {
  settings: UserSettings | null
  models: ModelInfo[]
  vendors: VendorInfo[]
  loading: boolean
  saving: boolean
  modelsLoading: boolean
  error: string | null
  onSave: (payload: Record<string, unknown>) => Promise<void>
  onClose: () => void
  onFetchModels: (query?: string, baseUrl?: string, apiKey?: string) => Promise<void>
}

function CapabilityBadge({ label, supported, icon: Icon }: { label: string; supported: boolean; icon?: React.ElementType }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
      supported
        ? "text-emerald-600 dark:text-emerald-400"
        : "bg-muted text-muted-foreground line-through",
    )}>
      {Icon ? <Icon weight="fill" className="size-3" /> : (supported ? <CheckCircleIcon weight="fill" className="size-3" /> : <XCircleIcon weight="fill" className="size-3" />)}
      {label}
    </span>
  )
}

function ModelInfoCard({ model }: { model: ModelInfo }) {
  const fn = (n: number) => n >= 1000000 ? `${(n / 1000000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(0)}K` : String(n)
  return (
    <div className="mt-4 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h4 className="text-base font-semibold">{model.name}</h4>
            {model.recommended && <span className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">推荐</span>}
            {model.api_available && <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">可用</span>}
            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {model.capability_source === "api" ? "接口验证" : model.capability_source === "inferred" ? "名称推断" : "内置数据"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{model.description}</p>
        </div>
        <span className="shrink-0 rounded-md bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">{model.id}</span>
      </div>
      <Separator className="my-3" />
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div><span className="text-xs text-muted-foreground">上下文窗口</span><p className="mt-0.5 font-medium">{fn(model.context_window)} tokens</p></div>
        <div><span className="text-xs text-muted-foreground">建议输出上限</span><p className="mt-0.5 font-medium">{fn(model.suggested_max_tokens)} tokens</p></div>
      </div>
      <div className="mt-3">
        <span className="text-xs text-muted-foreground">多模态能力</span>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
         <CapabilityBadge label="文本" supported={model.capabilities.text} />
          <CapabilityBadge icon={Image} label="图像" supported={model.capabilities.image} />
          <CapabilityBadge icon={VideoCamera} label="视频" supported={model.capabilities.video} />
          <CapabilityBadge icon={SpeakerHigh} label="音频" supported={model.capabilities.audio} />
        </div>
      </div>
    </div>
  )
}

export function SettingsPanel({
  settings: initialSettings, models, vendors, loading, saving,
  modelsLoading, error, onSave, onClose, onFetchModels,
}: SettingsPanelProps) {
  const [baseUrl, setBaseUrl] = useState("")
  const [apiKey, setApiKey] = useState("")
  const [apiKeyInput, setApiKeyInput] = useState("")
  const [modelName, setModelName] = useState("")
  const [maxTokens, setMaxTokens] = useState(8192)
  const [showApiKey, setShowApiKey] = useState(false)
  const [modelSearch, setModelSearch] = useState("")
  const [showModelDropdown, setShowModelDropdown] = useState(false)
  const [enableSearch, setEnableSearch] = useState(false)
  const [thinkingMode, setThinkingMode] = useState(false)
  const [temperature, setTemperature] = useState(0.7)
  const [topP, setTopP] = useState(1.0)
  const [repPenalty, setRepPenalty] = useState(1.0)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [selectedVendor, setSelectedVendor] = useState<string | null>(null)

  useEffect(() => {
   if (initialSettings) {
     setBaseUrl(initialSettings.base_url)
     setApiKey(initialSettings.api_key)
      setApiKeyInput(initialSettings.api_key ?? "")
     setModelName(initialSettings.model_name)
     setMaxTokens(initialSettings.max_tokens)
     setTemperature(initialSettings.advanced?.temperature ?? 0.7)
     setTopP(initialSettings.advanced?.top_p ?? 1.0)
     setRepPenalty(initialSettings.advanced?.repetition_penalty ?? 1.0)
     setEnableSearch(initialSettings.advanced?.enable_search ?? false)
     setThinkingMode(initialSettings.advanced?.thinking_mode ?? false)
   }
 }, [initialSettings])

  useEffect(() => {
    const matched = vendors.find((v) => v.base_url.replace(/\/$/, "") === baseUrl.replace(/\/$/, ""))
    setSelectedVendor(matched?.id ?? "custom")
    // Fetch models with current input values (empty = no models shown)
    // Fetch models only when user actively edits the API key (not pre-filled masked key).
    // Saved models are already loaded by refreshModels() after save.
    if (apiKeyInput && apiKeyInput !== initialSettings?.api_key) {
      void onFetchModels(undefined, baseUrl || "", apiKeyInput)
    }
  }, [baseUrl, vendors, apiKeyInput, initialSettings?.api_key])

  const selectedModel = models.find((m) => m.id === modelName)
  const filteredModels = models.filter((m) =>
    m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
    m.id.toLowerCase().includes(modelSearch.toLowerCase()),
  )

  

  const handleSave = useCallback(async () => {
    if (!modelName.trim()) {
      setModelError("请填写模型名称，例如 qwen-plus")
      return
    }
    if (models.length > 0 && !models.find(m => m.id === modelName)) {
      setModelError(`模型名称 "${modelName}" 不在可用列表中，请检查拼写是否正确，或从下拉菜单中选择`)
      return
    }
    setModelError(null)
    const payload: Record<string, unknown> = {}
    if (baseUrl !== initialSettings?.base_url) payload.base_url = baseUrl
    // Only send API key if user typed a new value (not the pre-filled masked key)
    if (apiKeyInput && apiKeyInput !== initialSettings?.api_key) payload.api_key = apiKeyInput
    if (modelName !== initialSettings?.model_name) payload.model_name = modelName
    if (maxTokens !== initialSettings?.max_tokens) payload.max_tokens = maxTokens
    if (temperature !== (initialSettings?.advanced?.temperature ?? 0.7)) payload.temperature = temperature
    if (topP !== (initialSettings?.advanced?.top_p ?? 1.0)) payload.top_p = topP
    if (repPenalty !== (initialSettings?.advanced?.repetition_penalty ?? 1.0)) payload.repetition_penalty = repPenalty
    if (enableSearch !== (initialSettings?.advanced?.enable_search ?? false)) payload.enable_search = enableSearch
    if (thinkingMode !== (initialSettings?.advanced?.thinking_mode ?? false)) payload.thinking_mode = thinkingMode
    try {
      await onSave(payload)
      // Validate API connection by fetching models with the saved credentials
      const verifyParams = new URLSearchParams()
      if (baseUrl) verifyParams.set("preview_base_url", baseUrl)
      if (apiKeyInput) verifyParams.set("preview_api_key", apiKeyInput)
      const verifyQs = verifyParams.toString()
      if (verifyQs) {
        const verifyResp = await fetch(`/api/v1/models?${verifyQs}`)
        if (!verifyResp.ok) {
          const detail = await verifyResp.json().catch(() => ({ detail: `API 请求失败 (${verifyResp.status})` }))
          throw new Error(typeof detail.detail === "string" ? detail.detail : "API 验证失败")
        }
      }
      setDirty(false)
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "\u4fdd\u5b58\u5931\u8d25"
      setModelError(msg)
      toast(msg, {
        position: "bottom-center",
        style: {
          borderRadius: "16px",
          padding: "16px 20px",
          fontSize: "14px",
        },
      })
    }
  }, [baseUrl, apiKeyInput, modelName, maxTokens, temperature, topP, repPenalty, enableSearch, thinkingMode, initialSettings, onSave, onClose])

  const markDirty = useCallback(() => setDirty(true), [])
  const handleModelSelect = useCallback((id: string) => {
    setModelName(id); setShowModelDropdown(false); setDirty(true)
  }, [])

  if (loading) return (
    <div className="flex h-full min-h-0 items-center justify-center">
      <Spinner className="size-6" />
      <span className="ml-3 text-sm text-muted-foreground">加载设置中…</span>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <Button type="button" variant="ghost" size="icon-sm" onClick={onClose} aria-label="返回对话">
            <ArrowLeftIcon aria-hidden="true" />
          </Button>
          <div>
            <h2 className="text-base font-semibold">模型设置</h2>
            <p className="text-xs text-muted-foreground">配置后端模型接口与参数</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {error && <span className="text-xs text-destructive">{error}</span>}
          <Button type="button" variant="outline" size="sm" onClick={onClose}>取消</Button>
          <Button type="button" size="sm" disabled={!dirty || saving} onClick={() => void handleSave()}>
            {saving && <Spinner data-icon="inline-start" className="size-3.5" />}
            {saving ? "保存中…" : "保存"}
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-2xl space-y-8 p-6">
          
          <section>
            <h3 className="text-sm font-semibold text-foreground">API 连接</h3>
            <p className="mt-1 text-xs text-muted-foreground">配置模型服务的访问地址和认证密钥。</p>
            <div className="mt-4 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="settings-baseurl">Base URL</Label>
                <div className="relative">
                  <Input id="settings-baseurl" value={baseUrl}
                    onChange={(e) => { setBaseUrl(e.target.value); setSelectedVendor("custom"); markDirty() }}
                    placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" />
                  {!baseUrl && (
                    <button type="button"
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-primary hover:text-primary/80 font-medium"
                      onClick={() => { setBaseUrl("https://dashscope.aliyuncs.com/compatible-mode/v1"); setSelectedVendor("custom"); markDirty() }}>
                      填入默认
                    </button>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="settings-apikey">API Key</Label>
                <div className="relative">
                  <Input id="settings-apikey" type={showApiKey ? "text" : "password"}
                    value={apiKeyInput}
                    onChange={(e) => { setApiKeyInput(e.target.value); markDirty() }}
                    placeholder={apiKey ? "输入新值覆盖已配置密钥" : "sk-..."} />
                  <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowApiKey((v) => !v)}>
                    {showApiKey ? <EyeClosedIcon className="size-4" /> : <EyeIcon className="size-4" />}
                  </button>
                </div>
              </div>
            </div>
          </section>
          <Separator />

          <section>
            <h3 className="text-sm font-semibold text-foreground">模型选择</h3>
            <p className="mt-1 text-xs text-muted-foreground">选择要使用的模型。</p>
            <div className="mt-4 space-y-1.5">
              <Label htmlFor="settings-model">模型</Label>
              <div className="relative">
                {models.length === 0 ? (
                  <Input
                    id="settings-model"
                    value={modelName}
                    onChange={(e) => { setModelName(e.target.value); markDirty() }}
                    placeholder="输入模型名称（如 qwen-plus）"
                    className="h-10 w-full rounded-lg border bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                ) : (
                  <>
                    <button type="button" id="settings-model"
                      className="flex h-10 w-full items-center justify-between rounded-lg border bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => setShowModelDropdown((v) => !v)}>
                      {modelsLoading ? (
                        <span className="flex items-center gap-2 text-muted-foreground"><Spinner className="size-3.5" />加载模型列表中...</span>
                      ) : (
                         <span>{(apiKeyInput || apiKey) ? (selectedModel?.name || "选择模型") : "请先配置 API Key"}</span>
                       )}
                      <span className="text-xs text-muted-foreground">{models.length > 0 ? models.length + " 个可用" : ((apiKeyInput || apiKey) ? "暂无可用模型" : "请输入 API Key")}</span>
                    </button>
                    {showModelDropdown && (
                      <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border bg-popover shadow-md">
                        <div className="p-2"><Input placeholder="搜索模型..." value={modelSearch} onChange={(e) => setModelSearch(e.target.value)} className="h-9 text-sm" autoFocus /></div>
                        <ScrollArea className="max-h-72">
                          {filteredModels.length === 0 ? (
                            <div className="p-4 text-center text-sm text-muted-foreground">{apiKeyInput || apiKey ? "没有匹配的模型" : "请先填写 API Key 以加载模型列表"}</div>
                          ) : filteredModels.map((model) => (
                            <button key={model.id} type="button"
                              className={cn("flex w-full items-center justify-between px-3 py-2.5 text-left text-sm hover:bg-accent", model.id === modelName && "bg-accent font-medium")}
                              onClick={() => handleModelSelect(model.id)}>
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="truncate">{model.name}</span>
                                  {model.recommended && <span className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">推荐</span>}
                                </div>
                                <p className="truncate text-xs text-muted-foreground">{model.description}</p>
                              </div>
                              <div className="ml-3 flex shrink-0 gap-1.5">
                                {model.capabilities.image && (
                                  <TooltipProvider><Tooltip><TooltipTrigger asChild>
                                    <span className="text-emerald-600 dark:text-emerald-400"><Image weight="fill" className="size-3" /></span>
                                  </TooltipTrigger><TooltipContent>支持图像</TooltipContent></Tooltip></TooltipProvider>
                                )}
                                {model.capabilities.video && (
                                  <TooltipProvider><Tooltip><TooltipTrigger asChild>
                                    <span className="text-emerald-600 dark:text-emerald-400"><VideoCamera weight="fill" className="size-3" /></span>
                                  </TooltipTrigger><TooltipContent>支持视频</TooltipContent></Tooltip></TooltipProvider>
                                )}
                                {model.capabilities.audio && (
                                  <TooltipProvider><Tooltip><TooltipTrigger asChild>
                                    <span className="text-emerald-600 dark:text-emerald-400"><SpeakerHigh weight="fill" className="size-3" /></span>
                                  </TooltipTrigger><TooltipContent>支持音频</TooltipContent></Tooltip></TooltipProvider>
                                )}
                              </div>
                            </button>
                          ))}
                        </ScrollArea>
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
            {selectedModel && <ModelInfoCard model={selectedModel} />}
            {modelError && (
              <p className="mt-2 text-xs text-destructive">{modelError}</p>
            )}
          </section>
          <Separator />

          <section>
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-foreground">生成参数</h3>
                <p className="mt-1 text-xs text-muted-foreground">控制模型生成行为与输出限制。</p>
              </div>
              <Button type="button" variant="ghost" size="sm" className="gap-1 text-xs" onClick={() => setShowAdvanced((v) => !v)}>
                <SlidersIcon className="size-3.5" />
                {showAdvanced ? "收起" : "高级"}
              </Button>
            </div>
            <div className="mt-4 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="settings-maxtokens">最大输出 Tokens</Label>
                <div className="flex items-center gap-3">
                  <input id="settings-maxtokens" type="range" min={512} max={131072} step={512} value={maxTokens}
                    onChange={(e) => { setMaxTokens(Number(e.target.value)); markDirty() }}
                    className="h-2 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary" />
                  <span className="w-24 text-right font-mono text-sm tabular-nums text-muted-foreground">{maxTokens.toLocaleString()}</span>
                </div>
                <div className="flex justify-between text-[11px] text-muted-foreground"><span>512</span><span>131K</span></div>
              </div>

              {showAdvanced && (
                <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">高级参数</h4>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="settings-temperature">Temperature</Label>
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">{temperature.toFixed(1)}</span>
                    </div>
                    <input id="settings-temperature" type="range" min={0} max={2} step={0.1} value={temperature}
                      onChange={(e) => { setTemperature(Number(e.target.value)); markDirty() }}
                      className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary" />
                    <div className="flex justify-between text-[10px] text-muted-foreground"><span>精确 (0)</span><span>平衡 (1)</span><span>创意 (2)</span></div>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="settings-topp">Top P</Label>
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">{topP.toFixed(2)}</span>
                    </div>
                    <input id="settings-topp" type="range" min={0} max={1} step={0.05} value={topP}
                      onChange={(e) => { setTopP(Number(e.target.value)); markDirty() }}
                      className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary" />
                    <div className="flex justify-between text-[10px] text-muted-foreground"><span>严格 (0)</span><span>默认 (1)</span></div>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="settings-reppenalty">重复惩罚</Label>
                      <span className="font-mono text-xs tabular-nums text-muted-foreground">{repPenalty.toFixed(1)}</span>
                    </div>
                    <input id="settings-reppenalty" type="range" min={1} max={2} step={0.1} value={repPenalty}
                      onChange={(e) => { setRepPenalty(Number(e.target.value)); markDirty() }}
                      className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary" />
                    <div className="flex justify-between text-[10px] text-muted-foreground"><span>无 (1.0)</span><span>强 (2.0)</span></div>
                  </div>
                  <Separator className="my-2" />
                  <div className="space-y-3">
                    {selectedModel?.id?.startsWith("qwq") && (
                      <div className="flex items-center justify-between">
                        <div>
                          <Label htmlFor="settings-thinking" className="text-sm">思维链模式</Label>
                          <p className="text-xs text-muted-foreground">为推理模型启用/禁用长思考过程</p>
                        </div>
                        <Switch id="settings-thinking" checked={thinkingMode} onCheckedChange={(v) => { setThinkingMode(v); markDirty() }} />
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <div>
                        <Label htmlFor="settings-search" className="text-sm">联网搜索</Label>
                        <p className="text-xs text-muted-foreground">让模型在需要时自动检索互联网</p>
                      </div>
                      <Switch id="settings-search" checked={enableSearch} onCheckedChange={(v) => { setEnableSearch(v); markDirty() }} />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
          <div className="h-8" />
        </div>
      </ScrollArea>
    </div>
  )
}
