import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";

import { deriveEffectiveBudget, isPositiveSafeInteger, parseOverrideWindow } from "@/lib/contextBudget";
import type { ContextBudgetValues } from "@/components/ContextBudgetControls";
import type { ModelInfo, ModelSettings, ModelSettingsUpdate, SettingsAPIClient } from "@/hooks/useAPI";

/* ------------------------------------------------------------------ */
/*  Draft type — string-based for editable temporally-invalid fields   */
/* ------------------------------------------------------------------ */
export interface ModelSettingsDraft {
  baseUrl: string;
  apiKey: string;
  apiKeyDirty: boolean;
  modelName: string;
  maxTokensStr: string;
  temperature: number;
  topP: number;
  enableSearch: boolean;
  thinkingMode: boolean;
  budgetValues: ContextBudgetValues;
}

/* ------------------------------------------------------------------ */
/*  Parsing utilities                                                  */
/* ------------------------------------------------------------------ */
function parseMaxTokens(raw: string): number {
  const t = raw.trim();
  if (t === "") return NaN;
  const n = Number(t);
  if (!Number.isFinite(n)) return NaN;
  if (!Number.isInteger(n)) return NaN;
  return n;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/* ------------------------------------------------------------------ */
/*  Default budget                                                     */
/* ------------------------------------------------------------------ */
function defaultBudget(s: ModelSettings | null): ContextBudgetValues {
  return {
    safetyReserveRatio: s?.safety_reserve_ratio ?? 0.05,
    compactionTriggerRatio: s?.compaction_trigger_ratio ?? 0.85,
    compactionTargetRatio: s?.compaction_target_ratio ?? 0.60,
    contextWindowOverrideStr: s?.context_window_source === "user" ? String(s.context_window) : "",
  };
}

/* ------------------------------------------------------------------ */
/*  Hook                                                               */
/* ------------------------------------------------------------------ */
export function useModelSettingsDraft(
  settings: ModelSettings | null,
  api: SettingsAPIClient,
  onSaved: (updated: ModelSettings) => void,
) {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const [draft, setDraft] = useState<ModelSettingsDraft>(() => ({
    baseUrl: settings?.base_url ?? "",
    apiKey: "",
    apiKeyDirty: false,
    modelName: settings?.model_name ?? "",
    maxTokensStr: String(settings?.max_tokens ?? 8192),
    temperature: settings?.advanced.temperature ?? 0.7,
    topP: settings?.advanced.top_p ?? 1,
    enableSearch: settings?.advanced.enable_search ?? false,
    thinkingMode: settings?.advanced.thinking_mode ?? false,
    budgetValues: defaultBudget(settings),
  }));

  const [modelError, setModelError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saveSeqRef = useRef(0);

  /* ---- dirty ---- */
  const dirty = (() => {
    const s = settings;
    if (!s) return false;
    if (draft.baseUrl !== s.base_url) return true;
    if (draft.apiKeyDirty) return true;
    if (draft.modelName !== s.model_name) return true;
    if (draft.maxTokensStr !== String(s.max_tokens)) return true;
    if (draft.temperature !== (s.advanced.temperature ?? 0.7)) return true;
    if (draft.topP !== (s.advanced.top_p ?? 1)) return true;
    if (draft.enableSearch !== (s.advanced.enable_search ?? false)) return true;
    if (draft.thinkingMode !== (s.advanced.thinking_mode ?? false)) return true;
    if (draft.budgetValues.safetyReserveRatio !== (s.safety_reserve_ratio ?? 0.05)) return true;
    if (draft.budgetValues.compactionTriggerRatio !== (s.compaction_trigger_ratio ?? 0.85)) return true;
    if (draft.budgetValues.compactionTargetRatio !== (s.compaction_target_ratio ?? 0.60)) return true;
    const ov = parseOverrideWindow(draft.budgetValues.contextWindowOverrideStr);
    const savedSource = s.context_window_source;
    if (ov > 0 && ov !== s.context_window) return true;
    // Source-intent transitions: blank override vs saved user, or positive override vs saved non-user
    if (ov === 0 && savedSource === "user") return true;
    if (ov > 0 && savedSource !== "user") return true;
    return false;
  })();

  /* ---- parse ---- */
  const maxTokensParsed = parseMaxTokens(draft.maxTokensStr);
  const maxTokensValid = isPositiveSafeInteger(maxTokensParsed);

  /* ---- effective budget with provenance ---- */
  const selectedModel = models.find((m) => m.id === draft.modelName) ?? null;
  const selectedModelFromCatalog = selectedModel !== null && (selectedModel.context_window ?? 0) > 0;
  // For a selected API-only model (0 window), pass catalogWindow=0 and selectionKnown=true
  // so deriveEffectiveBudget forces source=unknown/ window=0 instead of falling to saved.
  const isApiOnly = selectedModel !== null && (selectedModel.context_window ?? 0) <= 0;
  const effectiveBudget = deriveEffectiveBudget(
    settings?.context_window ?? 0,
    settings?.context_window_source ?? "unknown",
    selectedModel?.context_window ?? 0,
    selectedModelFromCatalog || isApiOnly,
    maxTokensValid ? maxTokensParsed : 0,
    draft.budgetValues.safetyReserveRatio,
    draft.budgetValues.compactionTargetRatio,
    draft.budgetValues.compactionTriggerRatio,
    draft.budgetValues.contextWindowOverrideStr,
  );

  /* ---- computed independently of current output validity ---- */
  const outputCapacityBound = Math.max(0, effectiveBudget.contextWindow - effectiveBudget.safetyReserveTokens - 1);

  /* ---- setters ---- */
  const patch = useCallback((p: Partial<ModelSettingsDraft>) => {
    setDraft((prev) => ({ ...prev, ...p }));
    if ("baseUrl" in p || "apiKey" in p || "modelName" in p) setModelError(null);
  }, []);

  const setBaseUrl = useCallback((v: string) => patch({ baseUrl: v }), [patch]);
  const setApiKeyFn = useCallback((v: string) => patch({ apiKey: v, apiKeyDirty: true }), [patch]);

  /** Select model by ID; clear overrideStr when any fetched model is selected (catalog or API-only). */
  const setModelName = useCallback((id: string) => {
    const found = models.find((m) => m.id === id);
    setDraft((prev) => {
      // Clear override when explicitly selecting any fetched model (catalog or API-only).
      // For catalog: exact catalog window takes effect (RC2 resolved).
      // For API-only: stale user override must not be inherited (RFC1).
      const modelSelected = found !== undefined;
      return {
        ...prev,
        modelName: id,
        budgetValues: modelSelected
          ? { ...prev.budgetValues, contextWindowOverrideStr: "" }
          : prev.budgetValues,
      };
    });
    setModelError(null);
  }, [models]);

  const setMaxTokensStr = useCallback((v: string) => setDraft((p) => ({ ...p, maxTokensStr: v })), []);
  const setTemperature = useCallback((v: number) => patch({ temperature: v }), [patch]);
  const setTopP = useCallback((v: number) => patch({ topP: v }), [patch]);
  const setEnableSearch = useCallback((v: boolean) => patch({ enableSearch: v }), [patch]);
  const setThinkingMode = useCallback((v: boolean) => patch({ thinkingMode: v }), [patch]);
  const setBudgetValuesCb = useCallback((v: ContextBudgetValues) => patch({ budgetValues: v }), [patch]);

  /* ---- preview ---- */
  const previewModels = useCallback(async () => {
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    setModelsLoading(true);
    try {
      const result = await api.fetchModels({ baseUrl: draft.baseUrl, apiKey: draft.apiKey || undefined });
      if (!abort.signal.aborted) setModels(result);
    } catch (error) {
      if (!abort.signal.aborted) toast.error("模型列表加载失败", { description: errMsg(error) });
    } finally {
      if (!abort.signal.aborted) setModelsLoading(false);
    }
  }, [api, draft.baseUrl, draft.apiKey]);

  /* ---- save with typed payload ---- */
  const saveModel = useCallback(async () => {
    const s = settings;

    if (!effectiveBudget.budgetValid) {
      setModelError(`Cannot save: ${effectiveBudget.budgetErrors.join("; ")}`);
      return;
    }
    if (effectiveBudget.source === "unknown" && parseOverrideWindow(draft.budgetValues.contextWindowOverrideStr) <= 0) {
      setModelError("Unknown model requires an explicit positive context window override");
      return;
    }
    if (!draft.modelName.trim()) {
      setModelError("请填写模型名称，例如 qwen-plus");
      return;
    }
    if (models.length > 0 && !models.find((m) => m.id === draft.modelName)) {
      setModelError(`模型名称 "${draft.modelName}" 不在可用列表中`);
      return;
    }
    if (!maxTokensValid) {
      setModelError("Max output must be a positive integer");
      return;
    }
    setModelError(null);

    const payload: ModelSettingsUpdate = {};
    if (draft.baseUrl !== s?.base_url) payload.base_url = draft.baseUrl;
    if (draft.apiKeyDirty) payload.api_key = draft.apiKey;
    if (draft.modelName !== s?.model_name) payload.model_name = draft.modelName;
    if (maxTokensParsed !== s?.max_tokens) payload.max_tokens = maxTokensParsed;
    if (draft.temperature !== (s?.advanced.temperature ?? 0.7)) payload.temperature = draft.temperature;
    if (draft.topP !== (s?.advanced.top_p ?? 1)) payload.top_p = draft.topP;
    if (draft.enableSearch !== (s?.advanced.enable_search ?? false)) payload.enable_search = draft.enableSearch;
    if (draft.thinkingMode !== (s?.advanced.thinking_mode ?? false)) payload.thinking_mode = draft.thinkingMode;
    if (draft.budgetValues.safetyReserveRatio !== (s?.safety_reserve_ratio ?? 0.05)) {
      payload.safety_reserve_ratio = draft.budgetValues.safetyReserveRatio;
    }
    if (draft.budgetValues.compactionTriggerRatio !== (s?.compaction_trigger_ratio ?? 0.85)) {
      payload.compaction_trigger_ratio = draft.budgetValues.compactionTriggerRatio;
    }
    if (draft.budgetValues.compactionTargetRatio !== (s?.compaction_target_ratio ?? 0.60)) {
      payload.compaction_target_ratio = draft.budgetValues.compactionTargetRatio;
    }

    const ov = parseOverrideWindow(draft.budgetValues.contextWindowOverrideStr);
    if (ov > 0) {
      // Always send a positive override with the payload; backend handles idempotency.
      // Include even when ov equals saved context_window, because the selected model may
      // have changed (RFC1: API-only selection with stale override).
      payload.context_window = ov;
    } else if (ov === 0 && s?.context_window_source === "user") {
      payload.context_window = null;
    }

    if (Object.keys(payload).length === 0) return;

    const seq = ++saveSeqRef.current;
    setSaving(true);
    try {
      const updated = await api.saveSettings(payload);
      if (saveSeqRef.current !== seq) return;

      setDraft((prev) => ({
        ...prev, apiKey: "", apiKeyDirty: false,
        baseUrl: updated.base_url, modelName: updated.model_name,
        maxTokensStr: String(updated.max_tokens),
        temperature: updated.advanced.temperature ?? 0.7,
        topP: updated.advanced.top_p ?? 1,
        enableSearch: updated.advanced.enable_search ?? false,
        thinkingMode: updated.advanced.thinking_mode ?? false,
        budgetValues: defaultBudget(updated),
      }));
      setModelError(null);
      toast.success("模型设置已保存");

      setModelsLoading(true);
      try {
        const fresh = await api.fetchModels({ baseUrl: updated.base_url });
        if (saveSeqRef.current === seq) setModels(fresh);
      } catch (de: unknown) {
        if (saveSeqRef.current === seq) console.debug("Model discovery (non-fatal):", errMsg(de));
      } finally {
        if (saveSeqRef.current === seq) setModelsLoading(false);
      }

      onSaved(updated);
    } catch (error) {
      setModelError(errMsg(error));
      toast.error("模型设置保存失败", { description: errMsg(error) });
    } finally {
      if (saveSeqRef.current === seq) setSaving(false);
    }
  }, [settings, effectiveBudget, draft, models, maxTokensParsed, maxTokensValid, api, onSaved]);

  return {
    draft, setBaseUrl, setApiKey: setApiKeyFn, setModelName, setMaxTokensStr,
    setTemperature, setTopP, setEnableSearch, setThinkingMode,
    setBudgetValues: setBudgetValuesCb,
    dirty, models, modelsLoading,
    saveModel, previewModels, effectiveBudget, modelError, saving,
    outputCapacityBound, selectedModel,
  };
}
