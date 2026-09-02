/**
 * Model registry durable state: file layout, defaults, load/persist.
 *
 * Registry + auth are two JSON files persisted atomically (see
 * ``persistence/atomic-json.ts``): ``model-registry.json`` (settings +
 * providers + models) and ``model-auth.json`` (0600, API keys).
 */
import path from "node:path";

import {
  DEFAULT_COMPACTION_TARGET_RATIO,
  DEFAULT_COMPACTION_TRIGGER_RATIO,
  DEFAULT_MAX_TOKENS,
  DEFAULT_RUNTIME_LIMITS,
  DEFAULT_SAFETY_RESERVE_RATIO,
  RUNTIME_LIMIT_RANGES,
  type RuntimeLimits,
} from "@biomed/contracts";

import type { JsonObject } from "../../http/validation.js";
import { optionalRecord } from "../../http/validation.js";
import { readJsonFile, writeJsonAtomic } from "../../persistence/atomic-json.js";
import {
  ADVANCED_DEFAULTS,
  RUNTIME_DEFAULTS,
} from "./catalog.js";

export type ModelSource = "api" | "manual" | "catalog";
export type ModelMetadataSource = "catalog" | "api" | "user";

export interface ProviderRecord {
  id: string;
  name: string;
  base_url: string;
  preset_id: string | null;
  description: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ModelRecord {
  id: string;
  provider_id: string;
  model_id: string;
  name: string;
  description: string;
  context_window: number | null;
  max_output_tokens: number | null;
  suggested_max_tokens: number | null;
  capabilities: { text: boolean; image: boolean; video: boolean; audio: boolean };
  params: JsonObject;
  source: ModelSource;
  /**
   * Which layer last owned the model metadata:
   * ``catalog`` = code catalog refresh is allowed, ``api`` = discovered but
   * not in the catalog, ``user`` = user-edited and must never be overwritten.
   */
  metadata_source?: ModelMetadataSource;
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SettingsRecord {
  provider_id: string | null;
  active_model_id: string | null;
  /**
   * Explicit visual-extraction role: managed-model record id (never a provider
   * model name), or null when unset. Existing registries migrate to null; a
   * manually edited image capability is never promoted into this role.
   */
  vision_model_id: string | null;
  base_url: string;
  model_name: string;
  max_tokens: number;
  context_window: number | null;
  safety_reserve_ratio: number;
  compaction_trigger_ratio: number;
  compaction_target_ratio: number;
  advanced: {
    temperature: number;
    top_p: number;
    repetition_penalty: number;
    enable_search: boolean;
    thinking_mode: boolean;
  };
  runtime_limits: RuntimeLimits;
  runtime_limits_version: 1;
}

export interface RegistryState {
  version: 1;
  settings: SettingsRecord;
  providers: ProviderRecord[];
  models: ModelRecord[];
  legacy_registry_migrated_at?: string;
}

export interface AuthState {
  version: 1;
  direct_api_key: string;
  provider_api_keys: Record<string, string>;
}

export const REGISTRY_FILE = "model-registry.json";
export const AUTH_FILE = "model-auth.json";

export function timestamp(): string {
  return new Date().toISOString();
}

/** Parse a stored JSON column (capabilities/params) leniently. */
export function parseStoredJson(value: unknown): JsonObject {
  if (typeof value !== "string") return {};
  try {
    return optionalRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

/**
 * Shared numeric bounds for persisted settings fields. Load-time
 * normalization (``normalizeLoadedSettings``) and legacy migration
 * (``migration.ts``) must clamp identically, so both use this table plus
 * ``clampNumber``; a bad value always falls back to the ``defaultRegistry``
 * default for its field instead of being trusted.
 *
 * Ceilings: ``max_tokens`` matches the 262144 maximum every provider param
 * spec exposes; ``context_window`` leaves headroom above the largest catalog
 * window (~1.05M) while rejecting garbage like 1e9.
 */
export const SETTING_NUMBER_BOUNDS = {
  max_tokens: { min: 1, max: 262_144, integer: true },
  context_window: { min: 1, max: 4_194_304, integer: true },
  safety_reserve_ratio: { min: 0, max: 0.25, integer: false },
  compaction_trigger_ratio: { min: 0.01, max: 0.99, integer: false },
  compaction_target_ratio: { min: 0.01, max: 0.99, integer: false },
  temperature: { min: 0, max: 2, integer: false },
  top_p: { min: 0, max: 1, integer: false },
  repetition_penalty: { min: 0, max: Number.MAX_SAFE_INTEGER, integer: false },
} as const;

export interface ClampNumberOptions {
  /** Field label used in the fallback warning line. */
  label?: string;
  /** Additionally require the value to be a safe integer. */
  integer?: boolean;
}

/**
 * Clamp a persisted numeric value: anything that is not a finite number
 * (a safe integer when ``integer``) inside ``[min, max]`` is replaced by
 * ``fallback`` with a one-line ``console.warn`` — corrupt values are never
 * silently repaired. An absent field (``undefined``) falls back without a
 * warning so "not set" stays distinct from "corrupt". NaN/Infinity count as
 * corrupt. Values are never clamped toward a bound: out of range means the
 * field default (same semantics as ``normalizeRuntimeLimits``).
 */
export function clampNumber<T extends number | null>(
  value: unknown,
  min: number,
  max: number,
  fallback: T,
  options: ClampNumberOptions = {},
): T {
  if (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    (options.integer !== true || Number.isSafeInteger(value))
  ) {
    return value as T;
  }
  if (value !== undefined) {
    console.warn(
      `[model-registry] ${options.label ?? "numeric setting"}: invalid value ` +
        `${String(value)}, falling back to ${String(fallback)}`,
    );
  }
  return fallback;
}

/** Clamp a persisted boolean value (same contract as clampNumber). */
export function clampBoolean(value: unknown, fallback: boolean, label: string): boolean {
  if (typeof value === "boolean") return value;
  if (value !== undefined) {
    console.warn(
      `[model-registry] ${label}: invalid value ${String(value)}, ` +
        `falling back to ${String(fallback)}`,
    );
  }
  return fallback;
}

export function defaultRegistry(): RegistryState {
  return {
    version: 1,
    settings: {
      provider_id: null,
      active_model_id: null,
      vision_model_id: null,
      // DashScope OpenAI-compatible endpoint is the catalog default base URL
      // (a vendor fact, see VENDORS in catalog.ts); model params come only via
      // the settings API, never from environment variables.
      base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model_name: "",
      max_tokens: DEFAULT_MAX_TOKENS,
      context_window: null,
      safety_reserve_ratio: DEFAULT_SAFETY_RESERVE_RATIO,
      compaction_trigger_ratio: DEFAULT_COMPACTION_TRIGGER_RATIO,
      compaction_target_ratio: DEFAULT_COMPACTION_TARGET_RATIO,
      advanced: { ...ADVANCED_DEFAULTS },
      runtime_limits: { ...RUNTIME_DEFAULTS },
      runtime_limits_version: 1,
    },
    providers: [],
    models: [],
  };
}

export function defaultAuth(): AuthState {
  return {
    version: 1,
    direct_api_key: "",
    provider_api_keys: {},
  };
}

/**
 * Clamp every persisted settings number/boolean to the shared bounds after a
 * disk load. Corrupt values fall back to the ``defaultRegistry`` defaults,
 * one ``console.warn`` line each — nothing from disk is trusted blindly.
 */
function normalizeLoadedSettings(settings: SettingsRecord): void {
  const defaults = defaultRegistry().settings;
  const bounds = SETTING_NUMBER_BOUNDS;
  // vision_model_id: absent (pre-vision registries) and null both mean "no
  // explicit role"; only a non-empty string is kept, anything else is corrupt.
  settings.vision_model_id = settings.vision_model_id === undefined ||
      settings.vision_model_id === null
    ? defaults.vision_model_id
    : typeof settings.vision_model_id === "string" && settings.vision_model_id.trim() !== ""
      ? settings.vision_model_id
      : (console.warn(
        `[model-registry] settings.vision_model_id: invalid value ` +
          `${String(settings.vision_model_id)}, falling back to null`,
      ),
        defaults.vision_model_id);
  settings.max_tokens = clampNumber(
    settings.max_tokens,
    bounds.max_tokens.min,
    bounds.max_tokens.max,
    defaults.max_tokens,
    { label: "settings.max_tokens", integer: true },
  );
  // null is the valid "inferred" sentinel for context_window, so it passes
  // through untouched; only a stored number must clear the bounds.
  settings.context_window = settings.context_window === null || settings.context_window === undefined
    ? defaults.context_window
    : clampNumber(
      settings.context_window,
      bounds.context_window.min,
      bounds.context_window.max,
      defaults.context_window,
      { label: "settings.context_window", integer: true },
    );
  settings.safety_reserve_ratio = clampNumber(
    settings.safety_reserve_ratio,
    bounds.safety_reserve_ratio.min,
    bounds.safety_reserve_ratio.max,
    defaults.safety_reserve_ratio,
    { label: "settings.safety_reserve_ratio" },
  );
  settings.compaction_trigger_ratio = clampNumber(
    settings.compaction_trigger_ratio,
    bounds.compaction_trigger_ratio.min,
    bounds.compaction_trigger_ratio.max,
    defaults.compaction_trigger_ratio,
    { label: "settings.compaction_trigger_ratio" },
  );
  settings.compaction_target_ratio = clampNumber(
    settings.compaction_target_ratio,
    bounds.compaction_target_ratio.min,
    bounds.compaction_target_ratio.max,
    defaults.compaction_target_ratio,
    { label: "settings.compaction_target_ratio" },
  );
  // Rebuild ``advanced`` from the known keys only, so corrupt types and
  // unknown extras cannot leak through.
  const advanced = optionalRecord(settings.advanced);
  settings.advanced = {
    temperature: clampNumber(
      advanced.temperature,
      bounds.temperature.min,
      bounds.temperature.max,
      defaults.advanced.temperature,
      { label: "settings.advanced.temperature" },
    ),
    top_p: clampNumber(
      advanced.top_p,
      bounds.top_p.min,
      bounds.top_p.max,
      defaults.advanced.top_p,
      { label: "settings.advanced.top_p" },
    ),
    repetition_penalty: clampNumber(
      advanced.repetition_penalty,
      bounds.repetition_penalty.min,
      bounds.repetition_penalty.max,
      defaults.advanced.repetition_penalty,
      { label: "settings.advanced.repetition_penalty" },
    ),
    enable_search: clampBoolean(
      advanced.enable_search,
      defaults.advanced.enable_search,
      "settings.advanced.enable_search",
    ),
    thinking_mode: clampBoolean(
      advanced.thinking_mode,
      defaults.advanced.thinking_mode,
      "settings.advanced.thinking_mode",
    ),
  };
}

export async function loadRegistryState(
  settingsDir: string,
): Promise<RegistryState> {
  const loaded = await readJsonFile<RegistryState>(path.join(settingsDir, REGISTRY_FILE));
  if (loaded === null || loaded === undefined) return defaultRegistry();
  const rawSettings: unknown = loaded.settings;
  if (typeof rawSettings !== "object" || rawSettings === null) {
    console.warn(
      `[model-registry] ${REGISTRY_FILE}: settings object missing or corrupt, ` +
        "rebuilding defaults",
    );
    return defaultRegistry();
  }
  normalizeLoadedSettings(loaded.settings);
  if (loaded.settings.runtime_limits_version !== 1) {
    loaded.settings.runtime_limits = { ...DEFAULT_RUNTIME_LIMITS };
    loaded.settings.runtime_limits_version = 1;
  } else {
    loaded.settings.runtime_limits = normalizeRuntimeLimits(loaded.settings.runtime_limits);
  }
  return loaded;
}

export function normalizeRuntimeLimits(value: unknown): RuntimeLimits {
  const source = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const normalized = { ...DEFAULT_RUNTIME_LIMITS };
  for (const key of Object.keys(RUNTIME_LIMIT_RANGES) as Array<keyof RuntimeLimits>) {
    const range = RUNTIME_LIMIT_RANGES[key];
    normalized[key] = clampNumber(source[key], range.min, range.max, DEFAULT_RUNTIME_LIMITS[key], {
      label: `runtime_limits.${key}`,
      integer: true,
    });
  }
  return normalized;
}

export async function loadAuthState(
  settingsDir: string,
): Promise<AuthState> {
  return await readJsonFile<AuthState>(path.join(settingsDir, AUTH_FILE))
    ?? defaultAuth();
}

export async function persistState(
  settingsDir: string,
  registry: RegistryState,
  auth: AuthState,
): Promise<void> {
  await Promise.all([
    writeJsonAtomic(path.join(settingsDir, REGISTRY_FILE), registry),
    writeJsonAtomic(path.join(settingsDir, AUTH_FILE), auth, { private: true }),
  ]);
}
