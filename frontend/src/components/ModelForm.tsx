import { useState } from "react";

import { useModelSettingsDraft } from "@/hooks/useModelSettingsDraft";
import { ModelConnectionSection } from "@/components/ModelConnectionSection";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import type { ModelSettings, SettingsAPIClient, VendorInfo } from "@/hooks/useAPI";

export interface ModelFormProps {
  api: SettingsAPIClient;
  settings: ModelSettings | null;
  vendors: VendorInfo[];
  onSaved: (updated: ModelSettings) => void;
}

export function ModelForm({ api, settings, vendors, onSaved }: ModelFormProps) {
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const hook = useModelSettingsDraft(settings, api, onSaved);
  const { draft, effectiveBudget, dirty, modelError, saving, outputCapacityBound } = hook;
  const selectedModel = hook.models.find((m) => m.id === draft.modelName) ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>模型连接</CardTitle>
        <CardDescription>新任务会使用保存后的配置；运行中的模型实例保持不变。</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          <ModelConnectionSection
            vendors={vendors}
            baseUrl={draft.baseUrl} onBaseUrlChange={hook.setBaseUrl}
            apiKey={draft.apiKey} apiKeyVisible={apiKeyVisible}
            onApiKeyChange={hook.setApiKey} onToggleApiKey={() => setApiKeyVisible((v) => !v)}
            modelName={draft.modelName} models={hook.models} modelsLoading={hook.modelsLoading}
            onModelSelect={hook.setModelName} onPreviewModels={hook.previewModels}
            maxTokensStr={draft.maxTokensStr} maxOutputMax={outputCapacityBound}
            onMaxTokensChange={hook.setMaxTokensStr}
            temperature={draft.temperature} onTemperatureChange={hook.setTemperature}
            topP={draft.topP} onTopPChange={hook.setTopP}
            enableSearch={draft.enableSearch} onEnableSearchChange={hook.setEnableSearch}
            thinkingMode={draft.thinkingMode} onThinkingModeChange={hook.setThinkingMode}
            showThinking={selectedModel?.id?.startsWith("qwq") ?? false}
            apiKeyConfigured={settings?.api_key_configured ?? false}
            contextWindow={effectiveBudget.contextWindow} source={effectiveBudget.source}
            safetyReserveTokens={effectiveBudget.safetyReserveTokens}
            availableInputTokens={effectiveBudget.availableInputTokens}
            budgetRatios={draft.budgetValues} onBudgetChange={hook.setBudgetValues}
          />
          {modelError && (
            <Alert variant="destructive" role="alert">
              <AlertTitle>Error</AlertTitle>
              <AlertDescription>{modelError}</AlertDescription>
            </Alert>
          )}
        </FieldGroup>
      </CardContent>
      <CardFooter className="justify-end">
        <Button onClick={() => void hook.saveModel()} disabled={!dirty || saving || !effectiveBudget.budgetValid}>
          {saving && <Spinner data-icon="inline-start" />}
          保存模型设置
        </Button>
        {!effectiveBudget.budgetValid && dirty && (
          <span className="ml-2 text-xs text-destructive">Fix budget errors before saving</span>
        )}
      </CardFooter>
    </Card>
  );
}
