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
  parseStoredJson,
  timestamp,
  type AuthState,
  type ModelRecord,
  type RegistryState,
} from "./store.js";

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
  if (typeof legacy.base_url === "string") settings.base_url = legacy.base_url;
  if (typeof legacy.model_name === "string") settings.model_name = legacy.model_name;
  if (typeof legacy.max_tokens === "number") settings.max_tokens = legacy.max_tokens;
  if (typeof legacy.context_window === "number") settings.context_window = legacy.context_window;
  for (const key of ["safety_reserve_ratio", "compaction_trigger_ratio", "compaction_target_ratio"] as const) {
    if (typeof legacy[key] === "number") settings[key] = legacy[key];
  }
  settings.advanced = { ...settings.advanced, ...optionalRecord(legacy.advanced) };
  settings.runtime_limits = { ...settings.runtime_limits, ...optionalRecord(legacy.runtime_limits) };
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
        context_window: typeof row.context_window === "number" ? row.context_window : null,
        max_output_tokens: typeof row.max_output_tokens === "number" ? row.max_output_tokens : null,
        suggested_max_tokens: typeof row.suggested_max_tokens === "number" ? row.suggested_max_tokens : null,
        capabilities: {
          text: capabilities.text !== false,
          image: capabilities.image === true,
          video: capabilities.video === true,
          audio: capabilities.audio === true,
        },
        params: parseStoredJson(row.params),
        source: row.source === "api" || row.source === "catalog" ? row.source : "manual",
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