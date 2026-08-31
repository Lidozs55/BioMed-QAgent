/**
 * One-time migrations for the model registry.
 *
 * - ``migrateLegacySettings``: adopt the old ``model.json`` settings file
 *   when ``model-registry.json`` does not exist yet.
 * - ``migrateLegacyRegistry``: import the pre-TS SQLite registry
 *   (``providers``/``managed_models``) exactly once.
 */
import { stat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

import type { JsonObject } from "../../http/validation.js";
import { optionalRecord } from "../../http/validation.js";
import { readJsonFile } from "../../persistence/atomic-json.js";
import {
  clampBoolean,
  clampNumber,
  defaultRegistry,
  normalizeRuntimeLimits,
  parseStoredJson,
  SETTING_NUMBER_BOUNDS,
  timestamp,
  type AuthState,
  type ModelRecord,
  type RegistryState,
} from "./store.js";

/**
 * SQLite model capacities: a positive safe integer is kept, anything else
 * (bad type, out of range) becomes ``null`` (unknown) with a warning — the
 * same fallback the non-number branch always used, now also covering bad
 * values instead of trusting them.
 */
function clampLegacyCapacity(value: unknown, label: string): number | null {
  return clampNumber(
    value,
    SETTING_NUMBER_BOUNDS.context_window.min,
    SETTING_NUMBER_BOUNDS.context_window.max,
    null,
    { label, integer: true },
  );
}

export async function migrateLegacySettings(
  registry: RegistryState,
  auth: AuthState,
  registryPath: string,
  legacySettingsPath: string,
): Promise<void> {
  if (await stat(registryPath).then(() => true, () => false)) return;
  const legacy = await readJsonFile<JsonObject>(legacySettingsPath);
  if (legacy === undefined) return;
  const settings = registry.settings;
  const defaults = defaultRegistry().settings;
  const bounds = SETTING_NUMBER_BOUNDS;
  if (typeof legacy.base_url === "string") settings.base_url = legacy.base_url;
  if (typeof legacy.model_name === "string") settings.model_name = legacy.model_name;
  // Legacy values predate load-time normalization, so every numeric/boolean
  // write is clamped here through the same helpers — out-of-range values
  // fall back to the field defaults instead of landing on disk.
  if (legacy.max_tokens !== undefined) {
    settings.max_tokens = clampNumber(
      legacy.max_tokens,
      bounds.max_tokens.min,
      bounds.max_tokens.max,
      defaults.max_tokens,
      { label: "legacy model.json max_tokens", integer: true },
    );
  }
  if (legacy.context_window !== undefined && legacy.context_window !== null) {
    settings.context_window = clampNumber(
      legacy.context_window,
      bounds.context_window.min,
      bounds.context_window.max,
      defaults.context_window,
      { label: "legacy model.json context_window", integer: true },
    );
  }
  for (const key of ["safety_reserve_ratio", "compaction_trigger_ratio", "compaction_target_ratio"] as const) {
    if (legacy[key] === undefined) continue;
    const range = bounds[key];
    settings[key] = clampNumber(legacy[key], range.min, range.max, defaults[key], {
      label: `legacy model.json ${key}`,
    });
  }
  const advanced = optionalRecord(legacy.advanced);
  settings.advanced = {
    temperature: advanced.temperature === undefined
      ? settings.advanced.temperature
      : clampNumber(
        advanced.temperature,
        bounds.temperature.min,
        bounds.temperature.max,
        defaults.advanced.temperature,
        { label: "legacy model.json advanced.temperature" },
      ),
    top_p: advanced.top_p === undefined
      ? settings.advanced.top_p
      : clampNumber(
        advanced.top_p,
        bounds.top_p.min,
        bounds.top_p.max,
        defaults.advanced.top_p,
        { label: "legacy model.json advanced.top_p" },
      ),
    repetition_penalty: advanced.repetition_penalty === undefined
      ? settings.advanced.repetition_penalty
      : clampNumber(
        advanced.repetition_penalty,
        bounds.repetition_penalty.min,
        bounds.repetition_penalty.max,
        defaults.advanced.repetition_penalty,
        { label: "legacy model.json advanced.repetition_penalty" },
      ),
    enable_search: advanced.enable_search === undefined
      ? settings.advanced.enable_search
      : clampBoolean(
        advanced.enable_search,
        defaults.advanced.enable_search,
        "legacy model.json advanced.enable_search",
      ),
    thinking_mode: advanced.thinking_mode === undefined
      ? settings.advanced.thinking_mode
      : clampBoolean(
        advanced.thinking_mode,
        defaults.advanced.thinking_mode,
        "legacy model.json advanced.thinking_mode",
      ),
  };
  settings.runtime_limits = normalizeRuntimeLimits({
    ...settings.runtime_limits,
    ...optionalRecord(legacy.runtime_limits),
  });
  if (typeof legacy.api_key === "string") auth.direct_api_key = legacy.api_key;
}

export async function migrateLegacyRegistry(
  registry: RegistryState,
  auth: AuthState,
  legacyRegistryPath: string | undefined,
  activate: (model: ModelRecord) => void,
): Promise<void> {
  if (registry.legacy_registry_migrated_at !== undefined) return;
  if (legacyRegistryPath === undefined ||
      !(await stat(legacyRegistryPath).then(() => true, () => false))) {
    registry.legacy_registry_migrated_at = timestamp();
    return;
  }
  const database = new DatabaseSync(legacyRegistryPath, { readOnly: true });
  try {
    const providers = database.prepare("SELECT * FROM providers").all() as unknown as JsonObject[];
    const models = database.prepare("SELECT * FROM managed_models").all() as unknown as JsonObject[];
    const providerIds = new Set(registry.providers.map(({ id }) => id));
    const modelIds = new Set(registry.models.map(({ id }) => id));
    for (const row of providers) {
      const id = String(row.id);
      if (providerIds.has(id)) continue;
      registry.providers.push({
        id,
        name: String(row.name),
        base_url: String(row.base_url),
        preset_id: row.preset_id === null ? null : String(row.preset_id),
        description: String(row.description ?? ""),
        enabled: Boolean(row.enabled),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
      });
      auth.provider_api_keys[id] = String(row.api_key ?? "");
    }
    for (const row of models) {
      const id = String(row.id);
      if (modelIds.has(id)) continue;
      const capabilities = parseStoredJson(row.capabilities);
      registry.models.push({
        id,
        provider_id: String(row.provider_id),
        model_id: String(row.model_id),
        name: String(row.name || row.model_id),
        description: String(row.description ?? ""),
        context_window: clampLegacyCapacity(row.context_window, "legacy sqlite context_window"),
        max_output_tokens: clampLegacyCapacity(row.max_output_tokens, "legacy sqlite max_output_tokens"),
        suggested_max_tokens: clampLegacyCapacity(row.suggested_max_tokens, "legacy sqlite suggested_max_tokens"),
        capabilities: {
          text: capabilities.text !== false,
          image: capabilities.image === true,
          video: capabilities.video === true,
          audio: capabilities.audio === true,
        },
        params: parseStoredJson(row.params),
        source: row.source === "api" || row.source === "catalog" ? row.source : "manual",
        metadata_source: row.source === "manual" ? "user" : "catalog",
        active: Boolean(row.active),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
      });
    }
    const active = registry.models.find(({ active }) => active);
    if (active !== undefined) activate(active);
    registry.legacy_registry_migrated_at = timestamp();
  } finally {
    database.close();
  }
}
