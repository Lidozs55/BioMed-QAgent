import { EyeClosedIcon, EyeIcon } from "@phosphor-icons/react";

import { ModelInfoCard } from "@/components/model-info-card";
import { ModelDropdown } from "@/components/ModelDropdown";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { ContextBudgetSummary } from "@/components/ContextBudgetSummary";
import { ContextBudgetControls, type ContextBudgetValues } from "@/components/ContextBudgetControls";
import type { ModelInfo, VendorInfo } from "@/hooks/useAPI";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */
export interface ModelConnectionSectionProps {
  vendors: VendorInfo[];
  baseUrl: string;
  onBaseUrlChange: (v: string) => void;
  apiKey: string;
  apiKeyVisible: boolean;
  onApiKeyChange: (v: string) => void;
  onToggleApiKey: () => void;
  modelName: string;
  models: ModelInfo[];
  modelsLoading: boolean;
  onModelSelect: (id: string) => void;
  onPreviewModels: () => void;
  maxTokensStr: string;
  maxOutputMax: number;
  onMaxTokensChange: (v: string) => void;
  temperature: number;
  onTemperatureChange: (v: number) => void;
  topP: number;
  onTopPChange: (v: number) => void;
  enableSearch: boolean;
  onEnableSearchChange: (v: boolean) => void;
  thinkingMode: boolean;
  onThinkingModeChange: (v: boolean) => void;
  showThinking: boolean;
  apiKeyConfigured: boolean;

  contextWindow: number;
  source: "catalog" | "user" | "inferred" | "unknown";
  safetyReserveTokens: number;
  availableInputTokens: number;
  budgetRatios: ContextBudgetValues;
  onBudgetChange: (v: ContextBudgetValues) => void;
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */
export function ModelConnectionSection({
  vendors, baseUrl, onBaseUrlChange,
  apiKey, apiKeyVisible, onApiKeyChange, onToggleApiKey,
  modelName, models, modelsLoading, onModelSelect, onPreviewModels,
  maxTokensStr, maxOutputMax, onMaxTokensChange,
  temperature, onTemperatureChange,
  topP, onTopPChange,
  enableSearch, onEnableSearchChange,
  thinkingMode, onThinkingModeChange,
  showThinking, apiKeyConfigured,
  contextWindow, source, safetyReserveTokens, availableInputTokens,
  budgetRatios, onBudgetChange,
}: ModelConnectionSectionProps) {
  const selectedModel = models.find((m) => m.id === modelName) ?? null;

  /* ---- Max tokens state: explicit invalid classes for accessible feedback (RFI1) ---- */
  const maxTokensState = (() => {
    const t = maxTokensStr.trim();
    if (t === "") return { invalid: true, kind: "empty" as const, message: "Enter max output tokens" };
    const n = Number(t);
    if (!Number.isFinite(n)) return { invalid: true, kind: "nonNumeric" as const, message: "Must be a number" };
    if (!Number.isInteger(n)) return { invalid: true, kind: "fractional" as const, message: "Must be a whole number" };
    if (n <= 0) return { invalid: true, kind: "nonPositive" as const, message: "Must be a positive integer" };
    if (maxOutputMax > 0 && n > maxOutputMax) {
      return { invalid: true, kind: "overBound" as const, message: `Maximum is ${maxOutputMax.toLocaleString()} tokens` };
    }
    return { invalid: false, kind: "valid" as const };
  })();
  const maxTokensNum = Number(maxTokensStr); // numeric value for summary display

  return (
    <>
      {/* Vendor */}
      <Field>
        <FieldLabel>Vendor</FieldLabel>
        <div className="flex flex-wrap gap-2">
          {vendors.map((vendor) => (
            <Button key={vendor.id} type="button" size="sm" variant="outline" onClick={() => onBaseUrlChange(vendor.base_url)}>
              {vendor.name}{vendor.recommended ? " · 推荐" : ""}
            </Button>
          ))}
        </div>
      </Field>

      {/* Base URL */}
      <Field>
        <FieldLabel htmlFor="settings-baseurl">Base URL</FieldLabel>
        <div className="relative">
          <Input id="settings-baseurl" value={baseUrl} onChange={(e) => onBaseUrlChange(e.target.value)} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1" />
          {!baseUrl && (
            <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-medium text-primary hover:text-primary/80"
              onClick={() => onBaseUrlChange("https://dashscope.aliyuncs.com/compatible-mode/v1")}>
              填入默认
            </button>
          )}
        </div>
      </Field>

      {/* API Key */}
      <Field>
        <FieldLabel htmlFor="settings-apikey">API Key</FieldLabel>
        <div className="relative">
          <Input id="settings-apikey" type={apiKeyVisible ? "text" : "password"} value={apiKey}
            onChange={(e) => onApiKeyChange(e.target.value)}
            placeholder={apiKeyConfigured ? "输入新值覆盖已配置密钥" : "sk-..."} />
          <button type="button" className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label={apiKeyVisible ? "隐藏 API Key" : "显示 API Key"}
            onClick={onToggleApiKey}>
            {apiKeyVisible ? <EyeClosedIcon className="size-4" /> : <EyeIcon className="size-4" />}
          </button>
        </div>
        <FieldDescription>已保存的密钥不会回填输入框。留空并保存，可将密钥清除。</FieldDescription>
      </Field>

      {/* Model */}
      <Field>
        <FieldLabel htmlFor="settings-model">Model</FieldLabel>
        <ModelDropdown models={models} modelsLoading={modelsLoading} selectedModelId={modelName}
          onSelectModel={onModelSelect} onPreview={onPreviewModels} />
        {selectedModel && <ModelInfoCard model={selectedModel} />}
      </Field>

      {/* Max output — explicit invalid classes (RFI1) */}
      <Field data-invalid={maxTokensState.invalid || undefined}>
        <FieldLabel htmlFor="settings-maxtokens">最大输出 Tokens</FieldLabel>
        <Input id="settings-maxtokens" type="number" min={1} max={maxOutputMax > 0 ? maxOutputMax : 999999999} step={1}
          value={maxTokensStr} aria-invalid={maxTokensState.invalid || undefined}
          onChange={(e) => onMaxTokensChange(e.target.value)} />
        {maxTokensState.invalid && <FieldError>{maxTokensState.message}</FieldError>}
        <FieldDescription>
          {maxOutputMax > 0
            ? `Maximum: ${maxOutputMax.toLocaleString()} tokens (capacity minus reserve minus 1)`
            : "Configure a valid context window to set output limit"}
        </FieldDescription>
      </Field>

      {/* Temperature + Top P */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="settings-temperature">Temperature</Label>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">{temperature.toFixed(1)}</span>
          </div>
          <input id="settings-temperature" type="range" min={0} max={2} step={0.1} value={temperature}
            onChange={(e) => onTemperatureChange(Number(e.target.value))}
            className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary" />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>精确 (0)</span><span>平衡 (1)</span><span>创意 (2)</span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <Label htmlFor="settings-topp">Top P</Label>
            <span className="font-mono text-xs tabular-nums text-muted-foreground">{topP.toFixed(2)}</span>
          </div>
          <input id="settings-topp" type="range" min={0} max={1} step={0.05} value={topP}
            onChange={(e) => onTopPChange(Number(e.target.value))}
            className="h-2 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary [&::-webkit-slider-thumb]:size-3.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary" />
          <div className="flex justify-between text-[10px] text-muted-foreground">
            <span>严格 (0)</span><span>默认 (1)</span>
          </div>
        </div>
      </div>

      {/* Switches */}
      <div className="flex flex-col gap-3 pt-2">
        {showThinking && (
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="settings-thinking" className="text-sm">思维链模式</Label>
              <p className="text-xs text-muted-foreground">为推理模型启用/禁用长思考过程</p>
            </div>
            <Switch id="settings-thinking" checked={thinkingMode} onCheckedChange={onThinkingModeChange} />
          </div>
        )}
        <div className="flex items-center justify-between">
          <div>
            <Label htmlFor="settings-search" className="text-sm">联网搜索</Label>
            <p className="text-xs text-muted-foreground">让模型在需要时自动检索互联网</p>
          </div>
          <Switch id="settings-search" checked={enableSearch} onCheckedChange={onEnableSearchChange} />
        </div>
      </div>

      {/* Budget */}
      <Separator className="my-4" />
      <ContextBudgetSummary contextWindow={contextWindow} source={source} maxOutputTokens={maxTokensNum || 0}
        safetyReserveTokens={safetyReserveTokens} availableInputTokens={availableInputTokens} />
      <ContextBudgetControls
        safetyReserveRatio={budgetRatios.safetyReserveRatio}
        compactionTriggerRatio={budgetRatios.compactionTriggerRatio}
        compactionTargetRatio={budgetRatios.compactionTargetRatio}
        contextWindowOverrideStr={budgetRatios.contextWindowOverrideStr}
        showAdvanced source={source}
        onChange={onBudgetChange} />
    </>
  );
}
