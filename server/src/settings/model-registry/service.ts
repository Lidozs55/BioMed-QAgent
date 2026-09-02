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

import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_RUNTIME_LIMITS,
  RUNTIME_LIMIT_RANGES,
  type ModelRegistryListQuery,
  type ParameterSpec,
  type RuntimeLimits,
} from "@biomed/contracts";

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
import { catalogCapacity, catalogContextWindow, lookupModelCatalog, paramSpecsFor } from "./catalog.js";
import { migrateLegacyRegistry, migrateLegacySettings } from "./migration.js";
import {
  effectiveContextWindow,
  resolveActiveConfig,
  resolveVlmConfig,
  VisionConfigError,
  visionAssignmentProblem,
  visionSettingsFacts,
} from "./model-resolution.js";
import { createSettingsRouter } from "./routes.js";
import {
  defaultRegistry,
  loadAuthState,
  loadRegistryState,
  persistState,
  timestamp,
  type AuthState,
  type ModelRecord,
  type ProviderRecord,
  type RegistryState,
  type SettingsRecord,
} from "./store.js";

export interface ModelSettingsServiceOptions {
  settingsDir: string;
  legacyRegistryPath?: string;
  fetcher?: typeof fetch;
  resolveHost?: AddressResolver;
}

function maskApiKey(value: string): string {
  if (value === "") return "";
  if (value.length <= 12) return `${value.slice(0, 4)}****`;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

const DEFAULT_PAGE_SIZE = 20;

// 激活三源皆空的模型时回退到 contracts 的全局默认 max_tokens
// （store.ts ``defaultRegistry`` 同源），保证 ``settings.max_tokens`` 总有明确来源。

function runtimeLimitsPatch(value: unknown): Partial<RuntimeLimits> {
  const record = asRecord(value);
  const patch: Partial<RuntimeLimits> = {};
  for (const [rawKey, candidate] of Object.entries(record)) {
    if (!Object.hasOwn(RUNTIME_LIMIT_RANGES, rawKey)) {
      throw new HttpError(422, `Unknown runtime limit: ${rawKey}`);
    }
    const key = rawKey as keyof RuntimeLimits;
    const range = RUNTIME_LIMIT_RANGES[key];
    if (!Number.isSafeInteger(candidate) || (candidate as number) < range.min || (candidate as number) > range.max) {
      throw new HttpError(422, `${key} must be an integer between ${range.min} and ${range.max}`);
    }
    patch[key] = candidate as number;
  }
  return patch;
}

/**
 * Derive the runtime ``settings.max_tokens`` from a model record:
 * ``params.max_tokens`` wins, then ``suggested_max_tokens``, then
 * ``max_output_tokens``. Returns ``null`` when all three sources are empty.
 */
function deriveModelMaxTokens(model: ModelRecord): number | null {
  const value = model.params.max_tokens ?? model.suggested_max_tokens ?? model.max_output_tokens;
  return typeof value === "number" ? value : null;
}

/**
 * Apply the active model's derived parameters (max output + sampling) to the
 * runtime settings. Shared by ``activateInMemory`` and ``updateModel`` so
 * editing an active model takes effect without reactivation and the two
 * call sites cannot drift apart.
 */
function applyModelDerivedParams(model: ModelRecord, settings: SettingsRecord): void {
  settings.max_tokens = deriveModelMaxTokens(model) ?? DEFAULT_MAX_TOKENS;
  if (typeof model.params.temperature === "number") settings.advanced.temperature = model.params.temperature;
  if (typeof model.params.top_p === "number") settings.advanced.top_p = model.params.top_p;
  if (typeof model.params.repetition_penalty === "number") settings.advanced.repetition_penalty = model.params.repetition_penalty;
  if (typeof model.params.enable_search === "boolean") settings.advanced.enable_search = model.params.enable_search;
  if (typeof model.params.thinking_mode === "boolean") settings.advanced.thinking_mode = model.params.thinking_mode;
}

/**
 * ``base_url`` 写入端的结构校验(updateSettings / createProvider /
 * updateProvider 共用):必须能解析为 URL、协议为 http/https 且带 hostname。
 * 刻意保持同步且不发网络请求——全局 IP/localhost 的运行时策略仍由
 * discover 出站时的 ``publicProviderUrl``(url-policy.ts)把守,写入端只挡
 * "明显不是 URL"的值。
 */
function assertHttpBaseUrl(value: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new HttpError(422, `base_url must be a valid http(s) URL: ${value}`);
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.hostname === "") {
    throw new HttpError(422, `base_url must be a valid http(s) URL: ${value}`);
  }
}

export class ModelSettingsService {
  private readonly registryPath: string;
  private readonly legacySettingsPath: string;
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
    this.fetcher = options.fetcher ?? fetch;
    this.resolveHost = options.resolveHost ?? resolveAllAddresses;
    this.router = createSettingsRouter(this);
  }

  static async create(options: ModelSettingsServiceOptions): Promise<ModelSettingsService> {
    const registry = await loadRegistryState(options.settingsDir);
    const auth = await loadAuthState(options.settingsDir);
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
    service.syncCatalogMetadata();
    await service.persist();
    return service;
  }

  handle = (request: IncomingMessage, response: ServerResponse): boolean =>
    this.router.handle(request, response);

  resolveActiveModel = async (): Promise<BioMedModelConfig> =>
    resolveActiveConfig(this.registry, this.auth);

  resolveRuntimeLimits = (): RuntimeLimits => ({ ...this.registry.settings.runtime_limits });

  /**
   * Resolve the visual-extraction config at call time (never snapshotted at
   * bootstrap). A stale assignment is cleared first; anything unresolvable
   * fails closed with an actionable ``VisionConfigError``. The API key is
   * returned to the caller only — it is never logged or persisted here.
   */
  resolveVlmConfig = async (): Promise<{
    apiKey: string;
    baseUrl: string;
    model: string;
  }> => {
    const stale = visionAssignmentProblem(this.registry);
    if (stale !== null) {
      await this.mutate(() => {
        this.registry.settings.vision_model_id = null;
      });
      throw new VisionConfigError(stale);
    }
    return resolveVlmConfig(this.registry, this.auth);
  };

  /* ---- Routes surface ---- */

  getSettings(): JsonObject {
    const settings = this.registry.settings;
    const model = settings.active_model_id === null
      ? undefined
      : this.registry.models.find((item) => item.id === settings.active_model_id);
    const apiKey = settings.provider_id === null
      ? this.auth.direct_api_key
      : this.auth.provider_api_keys[settings.provider_id] ?? "";
    const contextWindow = effectiveContextWindow(settings, model);
    const reserve = Math.ceil(contextWindow * settings.safety_reserve_ratio);
    const modelName = (model?.model_id ?? settings.model_name).trim();
    // Pi clamps max output to the remaining context budget; a zero/negative
    // budget still requires user confirmation before running because Pi would
    // otherwise silently turn the request into a 1-token response.
    const availableInputTokens = Math.max(0, contextWindow - settings.max_tokens - reserve);
    const runBlockReason = apiKey === ""
      ? "provider credentials are required"
      : modelName === ""
        ? "model configuration is required"
        : availableInputTokens <= 0
          ? "上下文窗口不足以容纳最大输出和保留空间"
          : null;
    return {
      base_url: settings.base_url,
      api_key: maskApiKey(apiKey),
      api_key_configured: apiKey !== "",
      model_name: model?.model_id ?? settings.model_name,
      max_tokens: settings.max_tokens,
      advanced: settings.advanced,
      context_window: contextWindow,
      context_window_source: settings.context_window !== null
        ? "user"
        : model?.context_window !== undefined && model?.context_window !== null
          ? "catalog"
          : "inferred",
      safety_reserve_ratio: settings.safety_reserve_ratio,
      safety_reserve_tokens: reserve,
      compaction_trigger_ratio: settings.compaction_trigger_ratio,
      compaction_target_ratio: settings.compaction_target_ratio,
      available_input_tokens: availableInputTokens,
      run_ready: apiKey !== "" && modelName !== "",
      run_block_reason: runBlockReason,
      runtime_limits: settings.runtime_limits,
      ...visionSettingsFacts(this.registry, this.auth),
    };
  }

  updateSettings(body: JsonObject): Promise<void> {
    return this.mutate(() => {
      const settings = structuredClone(this.registry.settings);
      const auth = structuredClone(this.auth);
      if (body.base_url !== undefined) {
        settings.base_url = requiredString(body.base_url, "base_url");
        assertHttpBaseUrl(settings.base_url);
      }
      if (body.model_name !== undefined) {
        const requested = requiredString(body.model_name, "model_name");
        // B7: a PUT on the legacy model_name must never diverge from the
        // active registry model, or execution would silently run the active
        // record while the stored field claims another model (the
        // display/execution drift that mis-ran gold1 r1). Reject conflicts and
        // direct the caller to the registry route; with no active record the
        // legacy field remains authoritative.
        const activeId = settings.active_model_id;
        if (activeId !== null) {
          const activeModel = this.registry.models.find((candidate) => candidate.id === activeId) ?? null;
          if (activeModel !== null && activeModel.model_id !== requested) {
            throw new HttpError(
              422,
              `model_name "${requested}" conflicts with the active registry model "${activeModel.model_id}"; ` +
                "switch the active model through POST /api/v1/model-registry/models/<id>/activate instead",
            );
          }
        }
        settings.model_name = requested;
      }
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
      // Visual-extraction role: persist the managed-model record id only, and
      // only for an enabled provider's image-capable model (fail fast with an
      // actionable message); null clears the role.
      if (body.vision_model_id === null) {
        settings.vision_model_id = null;
      } else if (body.vision_model_id !== undefined) {
        const visionModel = this.model(requiredString(body.vision_model_id, "vision_model_id"));
        const visionProvider = this.provider(visionModel.provider_id);
        if (visionProvider.enabled === false) {
          throw new HttpError(
            422,
            `供应商「${visionProvider.name}」已停用，不能将其模型设为视觉抽取模型`,
          );
        }
        if (visionModel.capabilities.image !== true) {
          throw new HttpError(
            422,
            `模型「${visionModel.name}」未开启图像能力，不能作为视觉抽取模型`,
          );
        }
        settings.vision_model_id = visionModel.id;
      }
      if (body.runtime_limits === null) {
        settings.runtime_limits = { ...DEFAULT_RUNTIME_LIMITS };
      } else if (body.runtime_limits !== undefined) {
        settings.runtime_limits = {
          ...settings.runtime_limits,
          ...runtimeLimitsPatch(body.runtime_limits),
        };
      }
      if (typeof body.api_key === "string") {
        const current = settings.provider_id === null
          ? auth.direct_api_key
          : auth.provider_api_keys[settings.provider_id] ?? "";
        if (body.api_key !== maskApiKey(current)) {
          if (settings.provider_id === null) auth.direct_api_key = body.api_key;
          else auth.provider_api_keys[settings.provider_id] = body.api_key;
        }
      }
      // 跨字段校验：仅在本次请求触及相关字段时校验写入后的组合，
      // 磁盘上已有的历史违规组合不会锁死不相关字段的更新。
      if (body.compaction_target_ratio !== undefined || body.compaction_trigger_ratio !== undefined) {
        if (settings.compaction_target_ratio >= settings.compaction_trigger_ratio) {
          throw new HttpError(
            422,
            `compaction_target_ratio (${settings.compaction_target_ratio}) 必须小于 ` +
              `compaction_trigger_ratio (${settings.compaction_trigger_ratio})，` +
              "请调低压缩目标比例或调高触发比例",
          );
        }
      }
      if (body.max_tokens !== undefined ||
          body.context_window !== undefined ||
          body.safety_reserve_ratio !== undefined) {
        // 与运行时保持一致：显式 settings 窗口优先，模型目录值仅作回退。
        const activeModel = settings.active_model_id === null
          ? undefined
          : this.registry.models.find((item) => item.id === settings.active_model_id);
        const effectiveWindow = effectiveContextWindow(settings, activeModel);
        const budget = effectiveWindow * (1 - settings.safety_reserve_ratio);
        if (settings.max_tokens >= budget) {
          throw new HttpError(
            422,
            `max_tokens (${settings.max_tokens}) 需小于上下文窗口 ${effectiveWindow} ` +
              `扣除安全保留后的可用预算（约 ${Math.floor(budget)}），` +
              "请调低 max_tokens 或扩大 context_window",
          );
        }
      }
      this.registry.settings = settings;
      this.auth = auth;
    });
  }

  getProvider(id: string): ProviderRecord {
    return this.provider(id);
  }

  providerParamSpecs(id: string): ParameterSpec[] {
    const provider = this.provider(id);
    return paramSpecsFor(provider.preset_id ?? provider.id);
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
      const baseUrl = requiredString(body.base_url, "base_url");
      assertHttpBaseUrl(baseUrl);
      created = {
        id: `provider_${randomUUID().replaceAll("-", "")}`,
        name,
        base_url: baseUrl,
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
      if (body.base_url !== undefined) {
        // 先校验再赋值:updateProvider 直接改活跃记录(非克隆),
        // 失败的 PUT 不得留下脏的内存状态。
        const baseUrl = requiredString(body.base_url, "base_url");
        assertHttpBaseUrl(baseUrl);
        provider.base_url = baseUrl;
      }
      if (body.preset_id !== undefined) provider.preset_id = typeof body.preset_id === "string" ? body.preset_id : null;
      if (body.description !== undefined) provider.description = String(body.description);
      if (body.enabled !== undefined) provider.enabled = Boolean(body.enabled);
      // Disabling a provider clears its models' visual role (case: disabled
      // visual model clears the assignment instead of failing at extraction).
      if (provider.enabled === false) {
        const visionModelId = this.registry.settings.vision_model_id;
        if (visionModelId !== null &&
            this.registry.models.some((item) => item.id === visionModelId && item.provider_id === id)) {
          this.registry.settings.vision_model_id = null;
        }
      }
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
        this.resetActiveConnectionSettings(true);
      }
      // The visual role dies with its provider's models (no dangling id).
      const visionModelId = this.registry.settings.vision_model_id;
      if (visionModelId !== null && !this.registry.models.some((item) => item.id === visionModelId)) {
        this.registry.settings.vision_model_id = null;
      }
    });
  }

  listModels(): JsonObject[] {
    return this.registry.models.map((model) => this.publicModel(model));
  }

  listProvidersPage(query: ModelRegistryListQuery): JsonObject {
    return this.paginate(
      this.registry.providers,
      query,
      (provider) => this.publicProvider(provider),
      (provider, q) =>
        [provider.name, provider.base_url, provider.preset_id ?? "", provider.description]
          .some((value) => value.toLowerCase().includes(q)),
    );
  }

  listModelsPage(query: ModelRegistryListQuery): JsonObject {
    return this.paginate(
      this.registry.models,
      query,
      (model) => this.publicModel(model),
      (model, q) => this.matchesModelQ(model, q),
    );
  }

  private paginate<T>(
    records: T[],
    query: ModelRegistryListQuery,
    toPublic: (record: T) => JsonObject,
    matches: (record: T, q: string) => boolean,
  ): JsonObject {
    const page = query.page ?? 1;
    const size = query.size ?? DEFAULT_PAGE_SIZE;
    const q = (query.q ?? "").trim().toLowerCase();
    const filtered = q === "" ? records : records.filter((record) => matches(record, q));
    return {
      items: filtered.slice((page - 1) * size, page * size).map(toPublic),
      total: filtered.length,
      page,
      size,
    };
  }

  private matchesModelQ(model: ModelRecord, q: string): boolean {
    const providerName = this.registry.providers.find((item) => item.id === model.provider_id)?.name ?? "";
    return [model.model_id, model.name, model.description, model.source, providerName]
      .some((value) => value.toLowerCase().includes(q));
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
      const source = body.source === "api" || body.source === "catalog" ? body.source : "manual";
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
        source,
        metadata_source: source === "manual" ? "user" : "catalog",
        active: false,
        created_at: current,
        updated_at: current,
      };
      this.applyCatalogMetadata(created, true);
      created.metadata_source = source === "manual"
        ? "user"
        : lookupModelCatalog(created.model_id) === undefined ? "api" : "catalog";
      const hasActiveModel =
        this.registry.models.some((item) => item.active) ||
        (
          this.registry.settings.active_model_id !== null &&
          this.registry.models.some(
            (item) => item.id === this.registry.settings.active_model_id,
          )
        );
      this.registry.models.push(created);
      if (!hasActiveModel) this.activateInMemory(created);
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
      // 模态（capabilities）用户可编辑：与 createModel 同一套归一化语义
      // （text 未显式 false 即开启，其余显式 opt-in），写 user 后不再被目录同步覆盖。
      if (body.capabilities !== undefined) {
        const caps = optionalRecord(body.capabilities);
        model.capabilities = {
          text: caps.text !== false,
          image: caps.image === true,
          video: caps.video === true,
          audio: caps.audio === true,
        };
        // A selected visual model that loses its image capability no longer
        // serves the role.
        if (model.capabilities.image === false && this.registry.settings.vision_model_id === id) {
          this.registry.settings.vision_model_id = null;
        }
      }
      if (body.params !== undefined) {
        const mergedParams = { ...model.params, ...asRecord(body.params) };
        this.validateModelParams(model, mergedParams);
        model.params = mergedParams;
      }
      // 只要任一用户可编辑字段被修改（与默认/目录元数据不再一致），就标记为
      // 用户手动配置：此后不再被目录启动同步覆盖，前端来源徽标据此显示
      // "手动配置"。
      if (body.name !== undefined ||
          body.description !== undefined ||
          body.context_window !== undefined ||
          body.max_output_tokens !== undefined ||
          body.suggested_max_tokens !== undefined ||
          body.capabilities !== undefined ||
          body.params !== undefined) {
        model.metadata_source = "user";
      }
      // 活动模型的上下文窗口被用户修改后，跟随同步运行时设置，
      // 保证 getSettings()/Pi 会话使用新窗口（与 syncCatalogMetadata 一致）。
      if (body.context_window !== undefined &&
          this.registry.settings.active_model_id === id) {
        const settings = this.registry.settings;
        settings.context_window = model.context_window ?? settings.context_window;
      }
      // 活动模型的 max_tokens/采样参数派生同样回写运行时设置，
      // 与 activateInMemory 共用同一份派生逻辑，参数编辑无需重新激活即生效。
      if ((body.params !== undefined ||
           body.max_output_tokens !== undefined ||
           body.suggested_max_tokens !== undefined) &&
          this.registry.settings.active_model_id === id) {
        applyModelDerivedParams(model, this.registry.settings);
      }
      model.updated_at = timestamp();
      updated = model;
    }).then(() => updated);
  }

  deleteModel(id: string): Promise<void> {
    return this.mutate(() => {
      this.model(id);
      this.registry.models = this.registry.models.filter((item) => item.id !== id);
      if (this.registry.settings.active_model_id === id) {
        this.resetActiveConnectionSettings(false);
      }
      if (this.registry.settings.vision_model_id === id) {
        this.registry.settings.vision_model_id = null;
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
      undefined,
      provider.preset_id ?? provider.id,
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

  /**
   * 按 ``paramSpecsFor(presetId, modelId)`` 对已知参数键校验 min/max，越界
   * 抛 422；未知键保持现状语义放行。JSON 通道此前可绕过前端展示的
   * min/max，这里在写入端补上。
   */
  private validateModelParams(model: ModelRecord, params: JsonObject): void {
    const provider = this.provider(model.provider_id);
    for (const spec of paramSpecsFor(provider.preset_id ?? provider.id, model.model_id)) {
      const boundMin = spec.min ?? null;
      const boundMax = spec.max ?? null;
      if (boundMin === null && boundMax === null) continue;
      const value = params[spec.key];
      if (value === undefined) continue;
      const inRange = typeof value === "number" &&
        (boundMin === null || value >= boundMin) &&
        (boundMax === null || value <= boundMax);
      if (!inRange) {
        const range = `[${boundMin ?? "不限"}, ${boundMax ?? "不限"}]`;
        throw new HttpError(422, `模型参数 ${spec.key} (${String(value)}) 超出允许范围 ${range}`);
      }
    }
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
      param_specs: paramSpecsFor(provider.preset_id ?? provider.id, model.model_id),
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
    applyModelDerivedParams(model, settings);
  }

  /**
   * 回到"未配置"语义:删除的是当前激活链路上的 provider/model 时,把连接
   * 字段重置为 ``defaultRegistry`` 的默认值,避免 GET /settings 与运行时
   * ``resolveActiveConfig`` 继续指向已删实体的幽灵 base_url/model_name;
   * 用户随后必须显式激活模型。
   */
  private resetActiveConnectionSettings(clearProvider: boolean): void {
    const defaults = defaultRegistry().settings;
    const settings = this.registry.settings;
    if (clearProvider) settings.provider_id = null;
    settings.active_model_id = null;
    settings.base_url = defaults.base_url;
    settings.model_name = defaults.model_name;
    settings.context_window = null;
    settings.max_tokens = defaults.max_tokens;
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

  async discover(
    baseUrl: string,
    apiKey: string,
    query?: string,
    providerId?: string,
  ): Promise<JsonObject[]> {
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
      const known = lookupModelCatalog(candidate.id);
      const specsProviderId = providerId ?? detectVendorFromBaseUrl(baseUrl) ?? "unknown";
      return [{
        id: candidate.id,
        name: candidate.id,
        description: "API discovered model",
        context_window: known === undefined ? null : catalogContextWindow(known),
        max_output_tokens: known === undefined ? null : catalogCapacity(known.max_output_tokens),
        suggested_max_tokens: known === undefined ? null : catalogCapacity(known.suggested_max_tokens),
        capabilities: known?.capabilities ?? { text: true, image: false, video: false, audio: false },
        recommended: candidate.id === this.registry.settings.model_name,
        param_specs: paramSpecsFor(specsProviderId, candidate.id),
        capability_source: known === undefined ? "api" : "catalog",
        api_available: true,
      }];
    });
  }

  /**
   * Refresh persisted records from the local catalog on startup.
   *
   * Records whose metadata was explicitly edited by the user (``user``) stay
   * untouched; API-discovered and catalog-sourced records are updated when the
   * catalog contains a verified fact for the model id.
   */
  private syncCatalogMetadata(): void {
    for (const model of this.registry.models) {
      if (model.source === "manual" || model.metadata_source === "user") {
        if (model.metadata_source === undefined) model.metadata_source = "user";
        continue;
      }
      const entry = lookupModelCatalog(model.model_id);
      if (entry === undefined) {
        if (model.metadata_source === "catalog") model.metadata_source = "api";
        continue;
      }
      this.applyCatalogMetadata(model, false);
    }
    const active = this.registry.models.find((item) => item.active);
    if (active !== undefined && active.metadata_source !== "user") {
      const settings = this.registry.settings;
      settings.active_model_id = active.id;
      if (settings.context_window === null) settings.context_window = active.context_window;
      const maxTokens = deriveModelMaxTokens(active);
      if (maxTokens !== null) settings.max_tokens = maxTokens;
    }
  }

  private applyCatalogMetadata(model: ModelRecord, force: boolean): void {
    const entry = lookupModelCatalog(model.model_id);
    if (entry === undefined) return;
    if (!force && (model.metadata_source === "user" || model.source === "manual")) return;
    model.context_window = catalogContextWindow(entry);
    model.max_output_tokens = catalogCapacity(entry.max_output_tokens);
    model.suggested_max_tokens = catalogCapacity(entry.suggested_max_tokens);
    model.capabilities = { ...entry.capabilities };
    model.metadata_source = "catalog";
  }
}

function detectVendorFromBaseUrl(rawUrl: string): string | null {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (host.includes("dashscope.aliyuncs.com")) return "dashscope";
    if (host.includes("api.deepseek.com")) return "deepseek";
    if (host.includes("open.bigmodel.cn") || host.includes("api.z.ai")) return "zhipu";
    if (host.includes("api.moonshot.cn") || host.includes("api.moonshot.ai")) return "moonshot";
    if (host.includes("api.groq.com")) return "groq";
    if (host.includes("api.x.ai")) return "xai";
    if (host.includes("api.mistral.ai")) return "mistral";
    if (host.includes("api.openai.com")) return "openai";
    return null;
  } catch {
    return null;
  }
}
