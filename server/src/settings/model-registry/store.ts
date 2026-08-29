/**
 * Model registry durable state: file layout, defaults, load/persist.
 *
 * Registry + auth are two JSON files persisted atomically (see
 * ``persistence/atomic-json.ts``): ``model-registry.json`` (settings +
 * providers + models) and ``model-auth.json`` (0600, API keys).
 */
import path from "node:path";

import { DEFAULT_RUNTIME_LIMITS, RUNTIME_LIMIT_RANGES, type RuntimeLimits } from "@biomed/contracts";

import type { JsonObject } from "../../http/validation.js";
import { optionalRecord } from "../../http/validation.js";
import { readJsonFile, writeJsonAtomic } from "../../persistence/atomic-json.js";
import {
  ADVANCED_DEFAULTS,
  catalogCapacity,
  catalogContextWindow,
  lookupModelCatalog,
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
  /** 环境变量引导（bootstrapEnvironmentDefaults）已执行过并注入过默认服务商。 */
  env_bootstrapped?: boolean;
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

export function defaultRegistry(environment: Record<string, string | undefined>): RegistryState {
  return {
    version: 1,
    settings: {
      provider_id: null,
      active_model_id: null,
      base_url: environment.PI_BASE_URL ?? environment.DASHSCOPE_BASE_URL ??
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model_name: environment.PI_MODEL ?? environment.MODEL_NAME ?? "",
      max_tokens: 8192,
      context_window: null,
      safety_reserve_ratio: 0.05,
      compaction_trigger_ratio: 0.85,
      compaction_target_ratio: 0.45,
      advanced: { ...ADVANCED_DEFAULTS },
      runtime_limits: { ...RUNTIME_DEFAULTS },
      runtime_limits_version: 1,
    },
    providers: [],
    models: [],
  };
}

export function defaultAuth(environment: Record<string, string | undefined>): AuthState {
  return {
    version: 1,
    direct_api_key: environment.PI_API_KEY ?? environment.DASHSCOPE_API_KEY ?? "",
    provider_api_keys: {},
  };
}

/** 环境变量引导注入的默认 DashScope 服务商/模型（固定 id，保证幂等）。 */
export const ENV_BOOTSTRAP_PROVIDER_ID = "provider_dashscope_env";
export const ENV_BOOTSTRAP_MODEL_ID = "model_dashscope_env_default";

/**
 * 一次性环境引导：当环境变量提供了 API key 且当前没有任何已配置服务商时，
 * 自动注册 DashScope 服务商并注入密钥，使凭据进入设置系统。**绝不臆造默认
 * 模型**：只有 env 显式提供 PI_MODEL/MODEL_NAME 时才创建并激活模型记录；
 * 否则 active_model_id 保持 null，`resolveActiveConfig` fail-closed，用户必须
 * 在设置里选择模型后才会真正计费运行。已有用户配置时绝不覆盖。
 */
export function bootstrapEnvironmentDefaults(
  registry: RegistryState,
  auth: AuthState,
  environment: Record<string, string | undefined>,
): void {
  if (registry.env_bootstrapped === true) return;
  if (registry.providers.length > 0) return;
  const apiKey = environment.PI_API_KEY ?? environment.DASHSCOPE_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") return;
  registry.env_bootstrapped = true;

  const now = timestamp();
  const baseUrl = environment.PI_BASE_URL ?? environment.DASHSCOPE_BASE_URL ??
    "https://dashscope.aliyuncs.com/compatible-mode/v1";
  registry.providers.push({
    id: ENV_BOOTSTRAP_PROVIDER_ID,
    name: "DashScope",
    base_url: baseUrl,
    preset_id: "dashscope",
    description: "阿里云 DashScope（由环境变量自动引导）",
    enabled: true,
    created_at: now,
    updated_at: now,
  });
  auth.provider_api_keys[ENV_BOOTSTRAP_PROVIDER_ID] = apiKey;
  const settings = registry.settings;
  settings.provider_id = ENV_BOOTSTRAP_PROVIDER_ID;
  settings.base_url = baseUrl;

  const modelId = (environment.PI_MODEL ?? environment.MODEL_NAME ?? "").trim();
  if (modelId === "") return;
  // Catalog facts win when the env model is verified locally (a 1M-window
  // model must not be under-reported); the 131072/8192 pair is only the
  // fallback for models missing from the catalog.
  const entry = lookupModelCatalog(modelId);
  const contextWindow = entry === undefined ? 131_072 : catalogContextWindow(entry);
  const maxOutputTokens = entry === undefined ? 8192 : catalogCapacity(entry.max_output_tokens);
  const suggestedMaxTokens = entry === undefined ? 8192 : catalogCapacity(entry.suggested_max_tokens);
  registry.models.push({
    id: ENV_BOOTSTRAP_MODEL_ID,
    provider_id: ENV_BOOTSTRAP_PROVIDER_ID,
    model_id: modelId,
    name: modelId,
    description: "环境变量默认模型",
    context_window: contextWindow,
    max_output_tokens: maxOutputTokens,
    suggested_max_tokens: suggestedMaxTokens,
    capabilities: entry === undefined
      ? { text: true, image: false, video: false, audio: false }
      : { ...entry.capabilities },
    params: {},
    source: "catalog",
    metadata_source: "catalog",
    active: true,
    created_at: now,
    updated_at: now,
  });
  settings.active_model_id = ENV_BOOTSTRAP_MODEL_ID;
  settings.model_name = modelId;
  settings.context_window = contextWindow;
  // Same derivation order as the active-model path: suggested, then max
  // output, then the 8192 default.
  settings.max_tokens = suggestedMaxTokens ?? maxOutputTokens ?? 8192;
}

/**
 * Clamp every persisted settings number/boolean to the shared bounds after a
 * disk load. Corrupt values fall back to the ``defaultRegistry`` defaults,
 * one ``console.warn`` line each — nothing from disk is trusted blindly.
 */
function normalizeLoadedSettings(settings: SettingsRecord): void {
  const defaults = defaultRegistry({}).settings;
  const bounds = SETTING_NUMBER_BOUNDS;
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
  environment: Record<string, string | undefined>,
): Promise<RegistryState> {
  const loaded = await readJsonFile<RegistryState>(path.join(settingsDir, REGISTRY_FILE));
  if (loaded === null || loaded === undefined) return defaultRegistry(environment);
  const rawSettings: unknown = loaded.settings;
  if (typeof rawSettings !== "object" || rawSettings === null) {
    console.warn(
      `[model-registry] ${REGISTRY_FILE}: settings object missing or corrupt, ` +
        "rebuilding defaults",
    );
    return defaultRegistry(environment);
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
  environment: Record<string, string | undefined>,
): Promise<AuthState> {
  return await readJsonFile<AuthState>(path.join(settingsDir, AUTH_FILE))
    ?? defaultAuth(environment);
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
