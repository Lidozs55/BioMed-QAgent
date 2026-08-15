/**
 * Model settings / model registry domain service.
 *
 * Owns the durable registry+auth state, the serialized mutation queue
 * (``mutate``), provider/model CRUD, settings updates, and model discovery.
 * HTTP routing lives in ``./routes.ts`` (``createSettingsRouter``); state
 * persistence in ``./store.ts``; one-time migrations in ``./migration.ts``;
 * active-model resolution in ``./model-resolution.ts``; catalog constants in
 * ``./catalog.ts``.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";

import type { BioMedModelConfig } from "../../agent/contracts.js";
import type { AddressResolver } from "../../external/network/dns.js";
import { resolveAllAddresses } from "../../external/network/dns.js";
import { UnsafeUrlError } from "../../external/network/errors.js";
import {
  validateCredentialedPublicUrl,
  validatePublicHttpUrl,
} from "../../external/network/url-policy.js";
import { HttpError } from "../../http/error.js";
import {
  asRecord,
  boundedNumber,
  optionalRecord,
  requiredString,
  type JsonObject,
} from "../../http/validation.js";
import { guessContextWindow, PARAM_SPECS } from "./catalog.js";
import { migrateLegacyRegistry, migrateLegacySettings } from "./migration.js";
import { resolveActiveConfig, resolveVlmConfig } from "./model-resolution.js";
import { createSettingsRouter } from "./routes.js";
import {
  loadAuthState,
  loadRegistryState,
  persistState,
  timestamp,
  type AuthState,
  type ModelRecord,
  type ProviderRecord,
  type RegistryState,
} from "./store.js";

export interface ModelSettingsServiceOptions {
  settingsDir: string;
  legacyRegistryPath?: string;
  environment?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  resolveHost?: AddressResolver;
}

function maskApiKey(value: string): string {
  if (value === "") return "";
  if (value.length <= 12) return `${value.slice(0, 4)}****`;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

export class ModelSettingsService {
  private readonly registryPath: string;
  private readonly legacySettingsPath: string;
  private readonly environment: Record<string, string | undefined>;
  private readonly fetcher: typeof fetch;
  private readonly resolveHost: AddressResolver;
  private writes: Promise<void> = Promise.resolve();
  private readonly router: ReturnType<typeof createSettingsRouter>;

  private constructor(
    private readonly options: ModelSettingsServiceOptions,
    private registry: RegistryState,
    private auth: AuthState,
  ) {
    this.registryPath = path.join(options.settingsDir, "model-registry.json");
    this.legacySettingsPath = path.join(options.settingsDir, "model.json");
    this.environment = options.environment ?? process.env;
    this.fetcher = options.fetcher ?? fetch;
    this.resolveHost = options.resolveHost ?? resolveAllAddresses;
    this.router = createSettingsRouter(this);
  }

  static async create(options: ModelSettingsServiceOptions): Promise<ModelSettingsService> {
    const environment = options.environment ?? process.env;
    const registry = await loadRegistryState(options.settingsDir, environment);
    const auth = await loadAuthState(options.settingsDir, environment);
    const service = new ModelSettingsService(options, registry, auth);
    await migrateLegacySettings(
      service.registry,
      service.auth,
      service.registryPath,
      service.legacySettingsPath,
    );
    await migrateLegacyRegistry(
      service.registry,
      service.auth,
      service.options.legacyRegistryPath,
      (model) => service.activateInMemory(model),
    );
    await service.persist();
    return service;
  }

  handle = (request: IncomingMessage, response: ServerResponse): boolean =>
    this.router.handle(request, response);

  resolveActiveModel = async (): Promise<BioMedModelConfig> =>
    resolveActiveConfig(this.registry, this.auth, this.environment);

  /** Resolve VLM chart-extraction config from active settings when possible. */
  resolveVlmConfig = (): Promise<{
    apiKey: string;
    baseUrl: string;
    model: string;
  }> => Promise.resolve(resolveVlmConfig(this.registry, this.auth, this.environment));

  /* ---- Routes surface ---- */

  getSettings(): JsonObject {
    const settings = this.registry.settings;
    const apiKey = settings.provider_id === null
      ? this.auth.direct_api_key
      : this.auth.provider_api_keys[settings.provider_id] ?? "";
    const contextWindow = settings.context_window ?? 131_072;
    const reserve = Math.ceil(contextWindow * settings.safety_reserve_ratio);
    return {
      base_url: settings.base_url,
      api_key: maskApiKey(apiKey),
      api_key_configured: apiKey !== "",
      model_name: settings.model_name,
      max_tokens: settings.max_tokens,
      advanced: settings.advanced,
      context_window: contextWindow,
      context_window_source: settings.context_window === null ? "inferred" : "user",
      safety_reserve_ratio: settings.safety_reserve_ratio,
      safety_reserve_tokens: reserve,
      compaction_trigger_ratio: settings.compaction_trigger_ratio,
      compaction_target_ratio: settings.compaction_target_ratio,
      available_input_tokens: Math.max(1, contextWindow - settings.max_tokens - reserve),
      run_ready: apiKey !== "",
      run_block_reason: apiKey === "" ? "provider credentials are required" : null,
      runtime_limits: settings.runtime_limits,
    };
  }

  updateSettings(body: JsonObject): Promise<void> {
    return this.mutate(() => {
      const settings = this.registry.settings;
      if (body.base_url !== undefined) settings.base_url = requiredString(body.base_url, "base_url");
      if (body.model_name !== undefined) settings.model_name = requiredString(body.model_name, "model_name");
      if (body.max_tokens !== undefined) settings.max_tokens = boundedNumber(body.max_tokens, "max_tokens", 1);
      if (body.context_window === null) settings.context_window = null;
      else if (body.context_window !== undefined) settings.context_window = boundedNumber(body.context_window, "context_window", 1);
      if (body.safety_reserve_ratio !== undefined) settings.safety_reserve_ratio = boundedNumber(body.safety_reserve_ratio, "safety_reserve_ratio", 0, 0.25);
      if (body.compaction_trigger_ratio !== undefined) settings.compaction_trigger_ratio = boundedNumber(body.compaction_trigger_ratio, "compaction_trigger_ratio", 0.01, 0.99);
      if (body.compaction_target_ratio !== undefined) settings.compaction_target_ratio = boundedNumber(body.compaction_target_ratio, "compaction_target_ratio", 0.01, 0.99);
      if (body.temperature !== undefined) settings.advanced.temperature = boundedNumber(body.temperature, "temperature", 0, 2);
      if (body.top_p !== undefined) settings.advanced.top_p = boundedNumber(body.top_p, "top_p", 0, 1);
      if (body.repetition_penalty !== undefined) settings.advanced.repetition_penalty = boundedNumber(body.repetition_penalty, "repetition_penalty", 0);
      if (body.enable_search !== undefined) settings.advanced.enable_search = Boolean(body.enable_search);
      if (body.thinking_mode !== undefined) settings.advanced.thinking_mode = Boolean(body.thinking_mode);
      if (body.runtime_limits !== undefined) settings.runtime_limits = {
        ...settings.runtime_limits,
        ...asRecord(body.runtime_limits),
      };
      if (typeof body.api_key === "string") {
        const current = settings.provider_id === null
          ? this.auth.direct_api_key
          : this.auth.provider_api_keys[settings.provider_id] ?? "";
        if (body.api_key !== maskApiKey(current)) {
          if (settings.provider_id === null) this.auth.direct_api_key = body.api_key;
          else this.auth.provider_api_keys[settings.provider_id] = body.api_key;
        }
      }
    });
  }

  getProvider(id: string): ProviderRecord {
    return this.provider(id);
  }

  listProviders(): JsonObject[] {
    return this.registry.providers.map((provider) => this.publicProvider(provider));
  }

  createProvider(body: JsonObject): Promise<ProviderRecord> {
    let created!: ProviderRecord;
    return this.mutate(() => {
      const name = requiredString(body.name, "name");
      if (this.registry.providers.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
        throw new HttpError(409, "供应商名称已存在");
      }
      const current = timestamp();
      created = {
        id: `provider_${randomUUID().replaceAll("-", "")}`,
        name,
        base_url: requiredString(body.base_url, "base_url"),
        preset_id: typeof body.preset_id === "string" ? body.preset_id : null,
        description: typeof body.description === "string" ? body.description : "",
        enabled: true,
        created_at: current,
        updated_at: current,
      };
      this.registry.providers.push(created);
      this.auth.provider_api_keys[created.id] = typeof body.api_key === "string" ? body.api_key : "";
    }).then(() => created);
  }

  updateProvider(id: string, body: JsonObject): Promise<ProviderRecord> {
    let updated!: ProviderRecord;
    return this.mutate(() => {
      const provider = this.provider(id);
      if (body.name !== undefined) provider.name = requiredString(body.name, "name");
      if (body.base_url !== undefined) provider.base_url = requiredString(body.base_url, "base_url");
      if (body.preset_id !== undefined) provider.preset_id = typeof body.preset_id === "string" ? body.preset_id : null;
      if (body.description !== undefined) provider.description = String(body.description);
      if (body.enabled !== undefined) provider.enabled = Boolean(body.enabled);
      if (typeof body.api_key === "string" &&
          body.api_key !== maskApiKey(this.auth.provider_api_keys[id] ?? "")) {
        this.auth.provider_api_keys[id] = body.api_key;
      }
      provider.updated_at = timestamp();
      updated = provider;
    }).then(() => updated);
  }

  deleteProvider(id: string): Promise<void> {
    return this.mutate(() => {
      this.provider(id);
      this.registry.providers = this.registry.providers.filter((item) => item.id !== id);
      this.registry.models = this.registry.models.filter((item) => item.provider_id !== id);
      delete this.auth.provider_api_keys[id];
      if (this.registry.settings.provider_id === id) {
        this.registry.settings.provider_id = null;
        this.registry.settings.active_model_id = null;
      }
    });
  }

  listModels(): JsonObject[] {
    return this.registry.models.map((model) => this.publicModel(model));
  }

  createModel(body: JsonObject): Promise<ModelRecord> {
    let created!: ModelRecord;
    return this.mutate(() => {
      const providerId = requiredString(body.provider_id, "provider_id");
      this.provider(providerId);
      const modelId = requiredString(body.model_id, "model_id");
      if (this.registry.models.some((item) => item.provider_id === providerId && item.model_id === modelId)) {
        throw new HttpError(422, "该供应商下已存在同名模型");
      }
      const current = timestamp();
      const capabilities = optionalRecord(body.capabilities);
      created = {
        id: `model_${randomUUID().replaceAll("-", "")}`,
        provider_id: providerId,
        model_id: modelId,
        name: typeof body.name === "string" && body.name.trim() !== "" ? body.name.trim() : modelId,
        description: typeof body.description === "string" ? body.description : "",
        context_window: typeof body.context_window === "number" ? boundedNumber(body.context_window, "context_window", 1) : null,
        max_output_tokens: typeof body.max_output_tokens === "number" ? boundedNumber(body.max_output_tokens, "max_output_tokens", 1) : null,
        suggested_max_tokens: typeof body.suggested_max_tokens === "number" ? boundedNumber(body.suggested_max_tokens, "suggested_max_tokens", 1) : null,
        capabilities: {
          text: capabilities.text !== false,
          image: capabilities.image === true,
          video: capabilities.video === true,
          audio: capabilities.audio === true,
        },
        params: optionalRecord(body.params),
        source: body.source === "api" || body.source === "catalog" ? body.source : "manual",
        active: false,
        created_at: current,
        updated_at: current,
      };
      this.registry.models.push(created);
    }).then(() => created);
  }

  updateModel(id: string, body: JsonObject): Promise<ModelRecord> {
    let updated!: ModelRecord;
    return this.mutate(() => {
      const model = this.model(id);
      if (body.name !== undefined) model.name = requiredString(body.name, "name");
      if (body.description !== undefined) model.description = String(body.description);
      if (body.context_window !== undefined) model.context_window = body.context_window === null ? null : boundedNumber(body.context_window, "context_window", 1);
      if (body.max_output_tokens !== undefined) model.max_output_tokens = body.max_output_tokens === null ? null : boundedNumber(body.max_output_tokens, "max_output_tokens", 1);
      if (body.suggested_max_tokens !== undefined) model.suggested_max_tokens = body.suggested_max_tokens === null ? null : boundedNumber(body.suggested_max_tokens, "suggested_max_tokens", 1);
      if (body.params !== undefined) model.params = { ...model.params, ...asRecord(body.params) };
      model.updated_at = timestamp();
      updated = model;
    }).then(() => updated);
  }

  deleteModel(id: string): Promise<void> {
    return this.mutate(() => {
      this.model(id);
      this.registry.models = this.registry.models.filter((item) => item.id !== id);
      if (this.registry.settings.active_model_id === id) {
        this.registry.settings.active_model_id = null;
      }
    });
  }

  activateModel(id: string): Promise<void> {
    return this.mutate(() => this.activateInMemory(this.model(id)));
  }

  /** Discover models for a stored provider (its base_url + stored api key). */
  discoverProviderModels(id: string): Promise<JsonObject[]> {
    const provider = this.provider(id);
    return this.discover(
      provider.base_url,
      this.auth.provider_api_keys[provider.id] ?? "",
    );
  }

  /* ---- Internal ---- */

  private mutate(operation: () => void): Promise<void> {
    const next = this.writes.then(async () => {
      operation();
      await this.persist();
    });
    this.writes = next.catch(() => undefined);
    return next;
  }

  private persist(): Promise<void> {
    return persistState(this.options.settingsDir, this.registry, this.auth);
  }

  private provider(id: string): ProviderRecord {
    const provider = this.registry.providers.find((item) => item.id === id);
    if (provider === undefined) throw new HttpError(404, "供应商不存在");
    return provider;
  }

  private model(id: string): ModelRecord {
    const model = this.registry.models.find((item) => item.id === id);
    if (model === undefined) throw new HttpError(404, "模型不存在");
    return model;
  }

  public publicProvider(provider: ProviderRecord): JsonObject {
    const apiKey = this.auth.provider_api_keys[provider.id] ?? "";
    return { ...provider, api_key: maskApiKey(apiKey), api_key_configured: apiKey !== "" };
  }

  public publicModel(model: ModelRecord): JsonObject {
    const provider = this.provider(model.provider_id);
    return {
      ...model,
      provider_name: provider.name,
      provider_base_url: provider.base_url,
      provider_api_key_configured: (this.auth.provider_api_keys[provider.id] ?? "") !== "",
      param_specs: PARAM_SPECS,
    };
  }

  private activateInMemory(model: ModelRecord): void {
    const provider = this.provider(model.provider_id);
    for (const item of this.registry.models) item.active = item.id === model.id;
    const settings = this.registry.settings;
    settings.provider_id = provider.id;
    settings.active_model_id = model.id;
    settings.base_url = provider.base_url;
    settings.model_name = model.model_id;
    settings.context_window = model.context_window;
    const maxTokens = model.params.max_tokens ?? model.suggested_max_tokens ?? model.max_output_tokens;
    if (typeof maxTokens === "number") settings.max_tokens = maxTokens;
    if (typeof model.params.temperature === "number") settings.advanced.temperature = model.params.temperature;
    if (typeof model.params.top_p === "number") settings.advanced.top_p = model.params.top_p;
    if (typeof model.params.repetition_penalty === "number") settings.advanced.repetition_penalty = model.params.repetition_penalty;
    if (typeof model.params.enable_search === "boolean") settings.advanced.enable_search = model.params.enable_search;
    if (typeof model.params.thinking_mode === "boolean") settings.advanced.thinking_mode = model.params.thinking_mode;
  }

  /**
   * Validate *baseUrl* against the shared outbound URL policy (url-policy.ts)
   * before hitting it: HTTP(S) shape, no URL credentials, localhost blocked,
   * every resolved address must be global. Credentialed requests force HTTPS.
   */
  private async publicProviderUrl(rawUrl: string, apiKey: string): Promise<URL> {
    try {
      if (apiKey !== "") {
        await validateCredentialedPublicUrl(rawUrl, { resolve: this.resolveHost });
      } else {
        await validatePublicHttpUrl(rawUrl, { resolve: this.resolveHost });
      }
    } catch (error) {
      if (error instanceof UnsafeUrlError) {
        throw new HttpError(422, error.message);
      }
      throw error;
    }
    return new URL(rawUrl);
  }

  async discover(baseUrl: string, apiKey: string, query?: string): Promise<JsonObject[]> {
    const target = await this.publicProviderUrl(baseUrl, apiKey);
    target.pathname = `${target.pathname.replace(/\/$/, "")}/models`;
    const response = await this.fetcher(target, {
      headers: apiKey === "" ? undefined : { authorization: `Bearer ${apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {
      throw new HttpError(502, "模型发现失败");
    });
    if (!response.ok) throw new HttpError(502, "模型发现失败");
    const payload = asRecord(await response.json());
    if (!Array.isArray(payload.data)) throw new HttpError(502, "模型发现响应格式无效");
    return payload.data.flatMap((item): JsonObject[] => {
      const candidate = optionalRecord(item);
      if (typeof candidate.id !== "string" ||
          (query !== undefined && !candidate.id.toLowerCase().includes(query.toLowerCase()))) return [];
      return [{
        id: candidate.id,
        name: candidate.id,
        description: "API discovered model",
        context_window: guessContextWindow(candidate.id),
        max_output_tokens: 4096,
        suggested_max_tokens: 4096,
        capabilities: { text: true, image: false, video: false, audio: false },
        recommended: candidate.id === this.registry.settings.model_name,
        param_specs: PARAM_SPECS,
        capability_source: "api",
        api_available: true,
      }];
    });
  }
}