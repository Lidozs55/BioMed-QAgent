/**
 * Active-model and visual-extraction-role resolution (pure functions over
 * registry/auth state).
 *
 * Produces the runtime configs consumed by the Pi adapter (chat) and the
 * VLM chart-extraction client (image). Kept separate from the HTTP/CRUD
 * surface of ``./service.ts``.
 *
 * The visual role is explicit: the stored ``vision_model_id`` assignment wins;
 * when unset, a *visual-capable active model* serves extraction; otherwise
 * resolution fails closed with an actionable message — there is no hidden
 * default visual model and no cross-provider credential reuse.
 */
import { modelRetryPolicyFromRuntimeLimits } from "@biomed/contracts";
import type { BioMedModelConfig } from "../../agent/contracts.js";
import type { AuthState, ModelRecord, ProviderRecord, RegistryState } from "./store.js";

/** Visual-extraction config could not be resolved (actionable, secret-free). */
export class VisionConfigError extends Error {}

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

/**
 * Credential for a provider: its stored key only. The settings layer no
 * longer reads any model parameter from environment variables, so there is
 * no env fallback here; an empty stored key means the visual role is not
 * ready (callers fail closed with an actionable message).
 */
export function visionApiKey(
  provider: ProviderRecord,
  auth: AuthState,
): string {
  return auth.provider_api_keys[provider.id] ?? "";
}

type VisionPick =
  | { ok: true; model: ModelRecord; provider: ProviderRecord }
  | { ok: false; failure: string };

/**
 * Pick the effective visual-extraction model: the explicit assignment when
 * set (and still usable), else the active model when it is image-capable and
 * its provider is enabled. Every failure carries an actionable message.
 */
function pickVisionModel(registry: RegistryState): VisionPick {
  const assignment = registry.settings.vision_model_id;
  if (assignment !== null) {
    const model = registry.models.find((item) => item.id === assignment);
    if (model === undefined) {
      return {
        ok: false,
        failure:
          "已选择的视觉抽取模型不存在（可能已被删除），请在设置的「视觉抽取模型」中重新选择。",
      };
    }
    const provider = registry.providers.find((item) => item.id === model.provider_id);
    if (provider === undefined || provider.enabled === false) {
      return {
        ok: false,
        failure: `视觉抽取模型「${model.name}」所属供应商不可用（已停用或已删除），请在设置中重新选择。`,
      };
    }
    if (model.capabilities.image !== true) {
      return {
        ok: false,
        failure: `模型「${model.name}」未开启图像能力，不能作为视觉抽取模型，请重新选择。`,
      };
    }
    return { ok: true, model, provider };
  }
  const model = activeModel(registry);
  const provider = model === undefined
    ? undefined
    : registry.providers.find((item) => item.id === model.provider_id);
  if (model !== undefined && provider !== undefined && provider.enabled !== false &&
      model.capabilities.image === true) {
    return { ok: true, model, provider };
  }
  return {
    ok: false,
    failure:
      "未配置可用的视觉抽取模型：请在设置的「视觉抽取模型」中选择一个开启图像能力的模型。" +
      "上传的图片由视觉抽取工具处理，主对话模型不会自动替代视觉模型。",
  };
}

/**
 * Actionable reason the stored assignment is stale (target deleted, provider
 * disabled, or image capability removed), or null when absent/usable. The
 * service layer clears such assignments at resolution time.
 */
export function visionAssignmentProblem(registry: RegistryState): string | null {
  if (registry.settings.vision_model_id === null) return null;
  const picked = pickVisionModel(registry);
  if (picked.ok) return null;
  return picked.failure.startsWith("未配置可用的视觉抽取模型") ? null : picked.failure;
}

/** Read-only visual-role facts for the settings response. */
export function visionSettingsFacts(
  registry: RegistryState,
  auth: AuthState,
): {
  vision_model_id: string | null;
  vision_model_name: string | null;
  vision_provider_name: string | null;
  vision_model_ready: boolean;
  vision_block_reason: string | null;
} {
  const picked = pickVisionModel(registry);
  if (!picked.ok) {
    return {
      vision_model_id: registry.settings.vision_model_id,
      vision_model_name: null,
      vision_provider_name: null,
      vision_model_ready: false,
      vision_block_reason: registry.settings.vision_model_id === null ? null : picked.failure,
    };
  }
  const ready = visionApiKey(picked.provider, auth).trim() !== "";
  return {
    // The id stays the *stored* assignment: an effective fallback to the
    // active model must not look like an explicit role in the UI.
    vision_model_id: registry.settings.vision_model_id,
    vision_model_name: picked.model.name,
    vision_provider_name: picked.provider.name,
    vision_model_ready: ready,
    vision_block_reason: ready
      ? null
      : `供应商「${picked.provider.name}」尚未配置 API Key，视觉抽取不可用。`,
  };
}

export function effectiveContextWindow(
  settings: RegistryState["settings"],
  model: ModelRecord | undefined,
): number {
  return settings.context_window ?? model?.context_window ?? 131_072;
}

export function resolveActiveConfig(
  registry: RegistryState,
  auth: AuthState,
): BioMedModelConfig {
  const settings = registry.settings;
  const provider = activeProvider(registry);
  const model = activeModel(registry);
  const apiKey = activeApiKey(registry, auth);
  const modelId = model?.model_id ?? settings.model_name;
  if (apiKey === "" || modelId.trim() === "") {
    throw new Error("Pi provider credentials and model are required");
  }
  const contextWindow = effectiveContextWindow(settings, model);
  return {
    provider: provider?.preset_id ?? provider?.id ?? "openai-compatible",
    modelId,
    apiKey,
    baseUrl: provider?.base_url ?? settings.base_url,
    contextWindow,
    maxTokens: settings.max_tokens,
    safetyReserveTokens: Math.ceil(contextWindow * settings.safety_reserve_ratio),
    compactionTriggerRatio: settings.compaction_trigger_ratio,
    compactionTargetRatio: settings.compaction_target_ratio,
    temperature: settings.advanced.temperature,
    topP: settings.advanced.top_p,
    repetitionPenalty: settings.advanced.repetition_penalty,
    enableSearch: settings.advanced.enable_search,
    thinkingMode: settings.advanced.thinking_mode,
    retryPolicy: modelRetryPolicyFromRuntimeLimits(settings.runtime_limits),
    params: model?.params ?? {},
  };
}

/**
 * Resolve the visual-extraction config at call time from the explicit role
 * (or a visual-capable active model). Fails closed with an actionable
 * ``VisionConfigError`` — never a hidden default model, never another
 * provider's credential. The returned API key stays in memory only.
 */
export function resolveVlmConfig(
  registry: RegistryState,
  auth: AuthState,
): { apiKey: string; baseUrl: string; model: string; temperature?: number } {
  const picked = pickVisionModel(registry);
  if (!picked.ok) throw new VisionConfigError(picked.failure);
  const apiKey = visionApiKey(picked.provider, auth);
  if (apiKey.trim() === "") {
    throw new VisionConfigError(
      `视觉抽取模型「${picked.model.name}」所属供应商「${picked.provider.name}」` +
        "未配置 API Key，请在设置中补全后重试。",
    );
  }
  const temperature = picked.model.params.temperature;
  return {
    apiKey,
    baseUrl: picked.provider.base_url,
    model: picked.model.model_id,
    ...(typeof temperature === "number" ? { temperature } : {}),
  };
}
