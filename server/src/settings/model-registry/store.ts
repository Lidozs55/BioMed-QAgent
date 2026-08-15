/**
 * Model registry durable state: file layout, defaults, load/persist.
 *
 * Registry + auth are two JSON files persisted atomically (see
 * ``persistence/atomic-json.ts``): ``model-registry.json`` (settings +
 * providers + models) and ``model-auth.json`` (0600, API keys).
 */
import path from "node:path";

import type { JsonObject } from "../../http/validation.js";
import { optionalRecord } from "../../http/validation.js";
import { readJsonFile, writeJsonAtomic } from "../../persistence/atomic-json.js";
import { ADVANCED_DEFAULTS, RUNTIME_DEFAULTS } from "./catalog.js";

export type ModelSource = "api" | "manual" | "catalog";

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
  runtime_limits: JsonObject;
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

export function defaultRegistry(environment: Record<string, string | undefined>): RegistryState {
  return {
    version: 1,
    settings: {
      provider_id: null,
      active_model_id: null,
      base_url: environment.PI_BASE_URL ?? environment.DASHSCOPE_BASE_URL ??
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model_name: environment.PI_MODEL ?? environment.MODEL_NAME ?? "qwen3.7-plus",
      max_tokens: 8192,
      context_window: null,
      safety_reserve_ratio: 0.05,
      compaction_trigger_ratio: 0.85,
      compaction_target_ratio: 0.6,
      advanced: { ...ADVANCED_DEFAULTS },
      runtime_limits: { ...RUNTIME_DEFAULTS },
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
 * 自动注册 DashScope 服务商并激活默认模型，使前端模型列表非空。
 * 仅在实际注入时置位 ``env_bootstrapped``，已有用户配置时绝不覆盖。
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
  const modelId = environment.PI_MODEL ?? environment.MODEL_NAME ?? "qwen3.7-plus";
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
  registry.models.push({
    id: ENV_BOOTSTRAP_MODEL_ID,
    provider_id: ENV_BOOTSTRAP_PROVIDER_ID,
    model_id: modelId,
    name: modelId,
    description: "环境变量默认模型",
    context_window: 131_072,
    max_output_tokens: 8192,
    suggested_max_tokens: 8192,
    capabilities: { text: true, image: false, video: false, audio: false },
    params: {},
    source: "catalog",
    active: true,
    created_at: now,
    updated_at: now,
  });
  const settings = registry.settings;
  settings.provider_id = ENV_BOOTSTRAP_PROVIDER_ID;
  settings.active_model_id = ENV_BOOTSTRAP_MODEL_ID;
  settings.base_url = baseUrl;
  settings.model_name = modelId;
  settings.context_window = 131_072;
  settings.max_tokens = 8192;
}

export async function loadRegistryState(
  settingsDir: string,
  environment: Record<string, string | undefined>,
): Promise<RegistryState> {
  return await readJsonFile<RegistryState>(path.join(settingsDir, REGISTRY_FILE))
    ?? defaultRegistry(environment);
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