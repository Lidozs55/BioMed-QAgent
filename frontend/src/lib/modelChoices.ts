import type {
  ManagedModelInfo,
  ModelInfo,
  ModelSettings,
} from "@/hooks/useAPI";

/**
 * Map the configured managed-model list (``GET /api/v1/model-registry/models``)
 * into the workspace model selector choices. The selector id is the unique
 * managed model id so providers that reuse the same ``model_id`` do not
 * collide; the active model is marked as recommended.
 */
export function managedModelsToChoices(models: ManagedModelInfo[]): ModelInfo[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name || model.model_id,
    description: `${model.provider_name} · ${model.model_id}`,
    context_window: model.context_window ?? 131072,
    suggested_max_tokens: model.suggested_max_tokens ?? model.max_output_tokens ?? 8192,
    capabilities: model.capabilities,
    recommended: model.active,
    api_available: model.provider_api_key_configured,
    capability_source: "catalog",
  }));
}

/**
 * Resolve the selector value from the authoritative registry state.
 *
 * An active managed model wins. A legacy/direct configuration is accepted
 * only when credentials exist; otherwise a stale default `model_name` must not
 * be presented as the current model.
 */
export function resolveActiveModelId(
  settings: Pick<ModelSettings, "model_name" | "api_key_configured"> | null,
  models: ManagedModelInfo[],
): string {
  const active = models.find((model) => model.active);
  if (active !== undefined) return active.id;
  return settings?.api_key_configured === true && settings.model_name !== ""
    ? settings.model_name
    : "";
}

/** Whether the app has a usable model identity or credentials configured. */
export function hasConfiguredModelApiKey(
  settings: Pick<ModelSettings, "api_key_configured"> | null,
  models: ModelInfo[],
): boolean {
  return settings?.api_key_configured === true ||
    models.some((model) => model.api_available);
}
