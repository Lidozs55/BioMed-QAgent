import type { ModelInfo } from "@/hooks/useAPI";

/**
 * Small offline fallback shown only when the real models endpoint is
 * unreachable/empty (``GET /api/v1/models`` proxy): keeps the searchable
 * selector usable instead of a dead-end. Never a substitute for the fetched
 * list — the settings dialog is the authoritative source.
 */
export const OFFLINE_MODEL_FALLBACK: readonly ModelInfo[] = [
  {
    id: "qwen-plus",
    name: "Qwen Plus",
    description: "离线备选模型",
    context_window: 131072,
    suggested_max_tokens: 8192,
    capabilities: { text: true, image: true, video: false, audio: false },
    recommended: false,
    api_available: true,
    capability_source: "catalog",
  },
  {
    id: "qwen-max",
    name: "Qwen Max",
    description: "离线备选模型",
    context_window: 131072,
    suggested_max_tokens: 8192,
    capabilities: { text: true, image: true, video: false, audio: false },
    recommended: false,
    api_available: true,
    capability_source: "catalog",
  },
  {
    id: "qwen-turbo",
    name: "Qwen Turbo",
    description: "离线备选模型",
    context_window: 131072,
    suggested_max_tokens: 8192,
    capabilities: { text: true, image: true, video: false, audio: false },
    recommended: false,
    api_available: true,
    capability_source: "catalog",
  },
  {
    id: "qwq-plus",
    name: "QWQ Plus",
    description: "离线备选模型",
    context_window: 131072,
    suggested_max_tokens: 8192,
    capabilities: { text: true, image: true, video: false, audio: false },
    recommended: false,
    api_available: true,
    capability_source: "catalog",
  },
];

/**
 * Resolve which model list the searchable selector shows. The fetched
 * endpoint list wins; when the API key is configured but the endpoint is
 * unreachable/empty the small offline fallback keeps the box usable.
 */
export function resolveModelChoices(
  models: ModelInfo[] | undefined,
  hasApiKey: boolean,
): { choices: ModelInfo[]; offline: boolean } {
  const fetched = models ?? [];
  if (!hasApiKey || fetched.length > 0) {
    return { choices: fetched, offline: false };
  }
  return { choices: [...OFFLINE_MODEL_FALLBACK], offline: true };
}
