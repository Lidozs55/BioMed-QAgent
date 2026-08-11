import type { ManagedModelInfo, ModelInfo } from "@/hooks/useAPI";

/**
 * Map the configured managed-model list (``GET /api/v1/model-registry/models``)
 * into the workspace model selector choices.  The selector id is the real
 * model identifier (``model_id``) so switching persists ``model_name``; the
 * active model is marked as recommended.
 */
export function managedModelsToChoices(models: ManagedModelInfo[]): ModelInfo[] {
  return models.map((model) => ({
    id: model.model_id,
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
