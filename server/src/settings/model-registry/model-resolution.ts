/**
 * Active-model resolution (pure functions over registry/auth state).
 *
 * Produces the runtime configs consumed by the Pi adapter (chat) and the
 * VLM chart-extraction client (image). Kept separate from the HTTP/CRUD
 * surface of ``./service.ts``.
 */
import type { BioMedModelConfig } from "../../agent/contracts.js";
import {
  DEFAULT_DASHSCOPE_BASE_URL,
  VL_MODEL_NAME,
} from "../../processing/vlm/vlm-client.js";
import type { AuthState, RegistryState } from "./store.js";

function activeProvider(registry: RegistryState): RegistryState["providers"][number] | undefined {
  const settings = registry.settings;
  return settings.provider_id === null
    ? undefined
    : registry.providers.find(({ id }) => id === settings.provider_id);
}

function activeModel(registry: RegistryState): RegistryState["models"][number] | undefined {
  const settings = registry.settings;
  return settings.active_model_id === null
    ? undefined
    : registry.models.find(({ id }) => id === settings.active_model_id);
}

function activeApiKey(registry: RegistryState, auth: AuthState): string {
  const provider = activeProvider(registry);
  return provider === undefined
    ? auth.direct_api_key
    : auth.provider_api_keys[provider.id] ?? "";
}

export function resolveActiveConfig(
  registry: RegistryState,
  auth: AuthState,
  environment: Record<string, string | undefined>,
): BioMedModelConfig {
  const settings = registry.settings;
  const provider = activeProvider(registry);
  const model = activeModel(registry);
  const apiKey = activeApiKey(registry, auth);
  const modelId = model?.model_id ?? settings.model_name;
  if (apiKey === "" || modelId.trim() === "") {
    throw new Error("Pi provider credentials and model are required");
  }
  return {
    provider: provider?.preset_id ?? provider?.id ?? environment.PI_PROVIDER ?? "openai-compatible",
    modelId,
    apiKey,
    baseUrl: provider?.base_url ?? settings.base_url,
    contextWindow: model?.context_window ?? settings.context_window ?? 131_072,
    maxTokens: settings.max_tokens,
    safetyReserveTokens: Math.ceil(
      (model?.context_window ?? settings.context_window ?? 131_072) *
        settings.safety_reserve_ratio,
    ),
    compactionTriggerRatio: settings.compaction_trigger_ratio,
    compactionTargetRatio: settings.compaction_target_ratio,
    temperature: settings.advanced.temperature,
    topP: settings.advanced.top_p,
    repetitionPenalty: settings.advanced.repetition_penalty,
    enableSearch: settings.advanced.enable_search,
    thinkingMode: settings.advanced.thinking_mode,
    params: model?.params ?? {},
  };
}

/** Resolve VLM chart-extraction config from active settings when possible. */
export function resolveVlmConfig(
  registry: RegistryState,
  auth: AuthState,
  environment: Record<string, string | undefined>,
): { apiKey: string; baseUrl: string; model: string } {
  const settings = registry.settings;
  const provider = activeProvider(registry);
  const model = activeModel(registry);
  const activeKey = activeApiKey(registry, auth);
  const isDashScope =
    provider?.preset_id === "dashscope" || provider?.id === "dashscope";
  if (model?.capabilities.image === true) {
    return {
      apiKey: activeKey,
      baseUrl: provider?.base_url ?? settings.base_url,
      model: model.model_id,
    };
  }
  return {
    apiKey: isDashScope
      ? (activeKey !== "" ? activeKey : (environment.DASHSCOPE_API_KEY ?? ""))
      : (environment.DASHSCOPE_API_KEY ?? ""),
    baseUrl: isDashScope
      ? (environment.DASHSCOPE_BASE_URL ?? provider?.base_url ?? settings.base_url)
      : (environment.DASHSCOPE_BASE_URL ?? DEFAULT_DASHSCOPE_BASE_URL),
    model: VL_MODEL_NAME,
  };
}
