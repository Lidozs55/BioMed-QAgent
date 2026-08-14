import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { BioMedModelConfig } from "../agent/contracts.js";
import {
  DEFAULT_DASHSCOPE_BASE_URL,
  VL_MODEL_NAME,
} from "../processing/vlm/vlm-client.js";

type JsonObject = Record<string, unknown>;
type ModelSource = "api" | "manual" | "catalog";

interface ProviderRecord {
  id: string;
  name: string;
  base_url: string;
  preset_id: string | null;
  description: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface ModelRecord {
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

interface SettingsRecord {
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

interface RegistryState {
  version: 1;
  settings: SettingsRecord;
  providers: ProviderRecord[];
  models: ModelRecord[];
  legacy_registry_migrated_at?: string;
}

interface AuthState {
  version: 1;
  direct_api_key: string;
  provider_api_keys: Record<string, string>;
}

export interface ModelSettingsServiceOptions {
  settingsDir: string;
  legacyRegistryPath?: string;
  environment?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<readonly { address: string }[]>;
}

const ADVANCED_DEFAULTS = {
  temperature: 0.7,
  top_p: 1,
  repetition_penalty: 1,
  enable_search: false,
  thinking_mode: false,
};

const RUNTIME_DEFAULTS: JsonObject = {
  agent_max_turns: 240,
  max_turns_resume_limit: 3,
  child_agent_max_turns: 30,
  subagent_timeout_seconds: 3600,
  no_progress_window_seconds: 300,
  no_progress_repeat_threshold: 3,
  lock_timeout_seconds: 5,
  http_timeout_seconds: 30,
  http_download_timeout_seconds: 60,
  browser_timeout_seconds: 120,
};

const PARAM_SPECS = [
  { key: "max_tokens", label: "最大输出 Tokens", type: "integer", min: 1 },
  { key: "temperature", label: "Temperature", type: "number", min: 0, max: 2 },
  { key: "top_p", label: "Top P", type: "number", min: 0, max: 1, advanced: true },
  { key: "repetition_penalty", label: "重复惩罚", type: "number", min: 0, advanced: true },
  { key: "enable_search", label: "联网搜索", type: "boolean", advanced: true },
  { key: "thinking_mode", label: "思维链模式", type: "boolean", advanced: true },
] as const;

const VENDORS = [
  ["dashscope", "DashScope", "https://dashscope.aliyuncs.com/compatible-mode/v1", true],
  ["openai", "OpenAI", "https://api.openai.com/v1", false],
  ["deepseek", "DeepSeek", "https://api.deepseek.com/v1", false],
  ["siliconflow", "SiliconFlow", "https://api.siliconflow.cn/v1", false],
  ["moonshot", "Moonshot", "https://api.moonshot.cn/v1", false],
  ["zhipu", "ZhipuAI", "https://open.bigmodel.cn/api/paas/v4", false],
  ["groq", "Groq", "https://api.groq.com/openai/v1", false],
  ["xai", "xAI", "https://api.x.ai/v1", false],
  ["mistral", "Mistral AI", "https://api.mistral.ai/v1", false],
] as const;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function timestamp(): string {
  return new Date().toISOString();
}

function asRecord(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(422, "request body must be an object");
  }
  return value as JsonObject;
}

function optionalRecord(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(422, `${name} must be a non-empty string`);
  }
  return value.trim();
}

function boundedNumber(value: unknown, name: string, minimum: number, maximum?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum ||
      (maximum !== undefined && value > maximum)) {
    throw new HttpError(422, `${name} is outside the supported range`);
  }
  return value;
}

function maskApiKey(value: string): string {
  if (value === "") return "";
  if (value.length <= 12) return `${value.slice(0, 4)}****`;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function parseStoredJson(value: unknown): JsonObject {
  if (typeof value !== "string") return {};
  try {
    return optionalRecord(JSON.parse(value));
  } catch {
    return {};
  }
}

function guessContextWindow(modelId: string): number {
  const normalized = modelId.toLowerCase();
  if (normalized.includes("2m")) return 2_000_000;
  if (normalized.includes("1m") || normalized.includes("million") ||
      normalized.includes("max")) return 1_000_000;
  if (normalized.includes("262144") || normalized.includes("256k")) return 262_144;
  if (normalized.includes("131072") || normalized.includes("128k")) return 131_072;
  if (normalized.includes("65536") || normalized.includes("64k")) return 65_536;
  if (normalized.includes("32768") || normalized.includes("32k")) return 32_768;
  if (normalized.includes("16384") || normalized.includes("16k")) return 16_384;
  if (normalized.includes("8192") || normalized.includes("8k")) return 8_192;
  if (normalized.includes("omni") || normalized.includes("vl")) return 131_072;
  return 524_288;
}

function defaultRegistry(environment: Record<string, string | undefined>): RegistryState {
  return {
    version: 1,
    settings: {
      provider_id: null,
      active_model_id: null,
      base_url: environment.PI_BASE_URL ?? environment.DASHSCOPE_BASE_URL ??
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model_name: environment.PI_MODEL ?? environment.MODEL_NAME ?? "qwen-plus",
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

function defaultAuth(environment: Record<string, string | undefined>): AuthState {
  return {
    version: 1,
    direct_api_key: environment.PI_API_KEY ?? environment.DASHSCOPE_API_KEY ?? "",
    provider_api_keys: {},
  };
}

async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

async function atomicWrite(filePath: string, value: unknown, privateFile = false): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (privateFile) await chmod(temporary, 0o600).catch(() => undefined);
  await rename(temporary, filePath);
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [first = 0, second = 0] = address.split(".").map(Number);
    return first === 0 || first === 10 || first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168);
  }
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || normalized.startsWith("fe80:");
}

async function publicProviderUrl(
  rawUrl: string,
  apiKey: string,
  resolveHost: (hostname: string) => Promise<readonly { address: string }[]>,
): Promise<URL> {
  let target: URL;
  try {
    target = new URL(rawUrl);
  } catch {
    throw new HttpError(422, "provider base URL is invalid");
  }
  if (!(["http:", "https:"] as string[]).includes(target.protocol) ||
      target.username !== "" || target.password !== "") {
    throw new HttpError(422, "provider base URL must be HTTP(S) without credentials");
  }
  if (apiKey !== "" && target.protocol !== "https:") {
    throw new HttpError(422, "credentialed provider URLs must use HTTPS");
  }
  if (target.hostname === "localhost" || target.hostname.endsWith(".localhost")) {
    throw new HttpError(422, "provider base URL must be public");
  }
  const addresses = await resolveHost(target.hostname).catch(() => {
    throw new HttpError(422, "provider hostname cannot be resolved");
  });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new HttpError(422, "provider base URL must resolve only to public addresses");
  }
  return target;
}

export class ModelSettingsService {
  private readonly registryPath: string;
  private readonly authPath: string;
  private readonly legacySettingsPath: string;
  private readonly environment: Record<string, string | undefined>;
  private readonly fetcher: typeof fetch;
  private readonly resolveHost: (hostname: string) => Promise<readonly { address: string }[]>;
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: ModelSettingsServiceOptions,
    private registry: RegistryState,
    private auth: AuthState,
  ) {
    this.registryPath = path.join(options.settingsDir, "model-registry.json");
    this.authPath = path.join(options.settingsDir, "model-auth.json");
    this.legacySettingsPath = path.join(options.settingsDir, "model.json");
    this.environment = options.environment ?? process.env;
    this.fetcher = options.fetcher ?? fetch;
    this.resolveHost = options.resolveHost ??
      ((hostname) => lookup(hostname, { all: true }));
  }

  static async create(options: ModelSettingsServiceOptions): Promise<ModelSettingsService> {
    const environment = options.environment ?? process.env;
    const registry = await readJson<RegistryState>(
      path.join(options.settingsDir, "model-registry.json"),
    ) ?? defaultRegistry(environment);
    const auth = await readJson<AuthState>(path.join(options.settingsDir, "model-auth.json")) ??
      defaultAuth(environment);
    const service = new ModelSettingsService(options, registry, auth);
    await service.migrateLegacySettings();
    await service.migrateLegacyRegistry();
    await service.persist();
    return service;
  }

  resolveActiveModel = async (): Promise<BioMedModelConfig> => {
    const settings = this.registry.settings;
    const provider = settings.provider_id === null
      ? undefined
      : this.registry.providers.find(({ id }) => id === settings.provider_id);
    const model = settings.active_model_id === null
      ? undefined
      : this.registry.models.find(({ id }) => id === settings.active_model_id);
    const apiKey = provider === undefined
      ? this.auth.direct_api_key
      : this.auth.provider_api_keys[provider.id] ?? "";
    if (apiKey === "") throw new Error("Pi provider credentials are required");
    return {
      provider: provider?.preset_id ?? provider?.id ?? this.environment.PI_PROVIDER ?? "openai-compatible",
      modelId: model?.model_id ?? settings.model_name,
      apiKey,
      baseUrl: provider?.base_url ?? settings.base_url,
      contextWindow: model?.context_window ?? settings.context_window ?? 131_072,
      maxTokens: settings.max_tokens,
      temperature: settings.advanced.temperature,
      topP: settings.advanced.top_p,
      repetitionPenalty: settings.advanced.repetition_penalty,
      enableSearch: settings.advanced.enable_search,
      thinkingMode: settings.advanced.thinking_mode,
    };
  };

  /** Resolve VLM chart-extraction config from active settings when possible. */
  resolveVlmConfig = async (): Promise<{
    apiKey: string;
    baseUrl: string;
    model: string;
  }> => {
    const settings = this.registry.settings;
    const provider = settings.provider_id === null
      ? undefined
      : this.registry.providers.find(({ id }) => id === settings.provider_id);
    const model = settings.active_model_id === null
      ? undefined
      : this.registry.models.find(({ id }) => id === settings.active_model_id);
    const activeApiKey = provider === undefined
      ? this.auth.direct_api_key
      : this.auth.provider_api_keys[provider.id] ?? "";
    const isDashScope =
      provider?.preset_id === "dashscope" || provider?.id === "dashscope";
    if (model?.capabilities.image === true) {
      return {
        apiKey: activeApiKey,
        baseUrl: provider?.base_url ?? settings.base_url,
        model: model.model_id,
      };
    }
    return {
      apiKey: isDashScope
        ? (activeApiKey !== "" ? activeApiKey : (this.environment.DASHSCOPE_API_KEY ?? ""))
        : (this.environment.DASHSCOPE_API_KEY ?? ""),
      baseUrl: isDashScope
        ? (this.environment.DASHSCOPE_BASE_URL ?? provider?.base_url ?? settings.base_url)
        : (this.environment.DASHSCOPE_BASE_URL ?? DEFAULT_DASHSCOPE_BASE_URL),
      model: VL_MODEL_NAME,
    };
  };

  handle = (request: IncomingMessage, response: ServerResponse): boolean => {
    const pathname = new URL(request.url ?? "/", "http://application-host").pathname;
    if (pathname !== "/api/v1/settings" && pathname !== "/api/v1/vendors" &&
        pathname !== "/api/v1/models" &&
        !pathname.startsWith("/api/v1/model-registry/")) return false;
    void this.dispatch(request, response, pathname).catch((error: unknown) => {
      const failure = error instanceof HttpError
        ? error
        : new HttpError(500, "Settings service failed");
      this.send(response, failure.status, { detail: failure.message });
    });
    return true;
  };

  private mutate(operation: () => void): Promise<void> {
    const next = this.writes.then(async () => {
      operation();
      await this.persist();
    });
    this.writes = next.catch(() => undefined);
    return next;
  }

  private persist(): Promise<void> {
    return Promise.all([
      atomicWrite(this.registryPath, this.registry),
      atomicWrite(this.authPath, this.auth, true),
    ]).then(() => undefined);
  }

  private async migrateLegacySettings(): Promise<void> {
    if (await stat(this.registryPath).then(() => true, () => false)) return;
    const legacy = await readJson<JsonObject>(this.legacySettingsPath);
    if (legacy === undefined) return;
    const settings = this.registry.settings;
    if (typeof legacy.base_url === "string") settings.base_url = legacy.base_url;
    if (typeof legacy.model_name === "string") settings.model_name = legacy.model_name;
    if (typeof legacy.max_tokens === "number") settings.max_tokens = legacy.max_tokens;
    if (typeof legacy.context_window === "number") settings.context_window = legacy.context_window;
    for (const key of ["safety_reserve_ratio", "compaction_trigger_ratio", "compaction_target_ratio"] as const) {
      if (typeof legacy[key] === "number") settings[key] = legacy[key];
    }
    settings.advanced = { ...settings.advanced, ...optionalRecord(legacy.advanced) };
    settings.runtime_limits = { ...settings.runtime_limits, ...optionalRecord(legacy.runtime_limits) };
    if (typeof legacy.api_key === "string") this.auth.direct_api_key = legacy.api_key;
  }

  private async migrateLegacyRegistry(): Promise<void> {
    if (this.registry.legacy_registry_migrated_at !== undefined) return;
    const databasePath = this.options.legacyRegistryPath;
    if (databasePath === undefined ||
        !(await stat(databasePath).then(() => true, () => false))) {
      this.registry.legacy_registry_migrated_at = timestamp();
      return;
    }
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const providers = database.prepare("SELECT * FROM providers").all() as unknown as JsonObject[];
      const models = database.prepare("SELECT * FROM managed_models").all() as unknown as JsonObject[];
      const providerIds = new Set(this.registry.providers.map(({ id }) => id));
      const modelIds = new Set(this.registry.models.map(({ id }) => id));
      for (const row of providers) {
        const id = String(row.id);
        if (providerIds.has(id)) continue;
        this.registry.providers.push({
          id,
          name: String(row.name),
          base_url: String(row.base_url),
          preset_id: row.preset_id === null ? null : String(row.preset_id),
          description: String(row.description ?? ""),
          enabled: Boolean(row.enabled),
          created_at: String(row.created_at),
          updated_at: String(row.updated_at),
        });
        this.auth.provider_api_keys[id] = String(row.api_key ?? "");
      }
      for (const row of models) {
        const id = String(row.id);
        if (modelIds.has(id)) continue;
        const capabilities = parseStoredJson(row.capabilities);
        this.registry.models.push({
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
      const active = this.registry.models.find(({ active }) => active);
      if (active !== undefined) this.activateInMemory(active);
      this.registry.legacy_registry_migrated_at = timestamp();
    } finally {
      database.close();
    }
  }

  private async dispatch(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
    const method = request.method ?? "GET";
    if (method === "GET" && pathname === "/api/v1/settings") {
      return this.send(response, 200, this.publicSettings());
    }
    if (method === "PUT" && pathname === "/api/v1/settings") {
      await this.updateSettings(await this.body(request));
      return this.send(response, 200, this.publicSettings());
    }
    if (method === "GET" && pathname === "/api/v1/vendors") {
      return this.send(response, 200, {
        vendors: VENDORS.map(([id, name, base_url, recommended]) => ({
          id, name, base_url, recommended,
          description: `${name} OpenAI-compatible API`,
        })),
      });
    }
    if (method === "POST" && pathname === "/api/v1/models") {
      const body = await this.body(request);
      const baseUrl = requiredString(body.preview_base_url, "preview_base_url");
      const apiKey = typeof body.preview_api_key === "string" ? body.preview_api_key : "";
      const models = await this.discover(baseUrl, apiKey,
        typeof body.query === "string" ? body.query : undefined);
      return this.send(response, 200, { models, total_count: models.length, api_source: baseUrl });
    }
    if (method === "GET" && pathname === "/api/v1/model-registry/providers") {
      return this.send(response, 200, this.registry.providers.map((provider) => this.publicProvider(provider)));
    }
    if (method === "POST" && pathname === "/api/v1/model-registry/providers") {
      return this.send(response, 201, this.publicProvider(await this.createProvider(await this.body(request))));
    }
    const providerMatch = /^\/api\/v1\/model-registry\/providers\/([^/]+)$/.exec(pathname);
    if (providerMatch !== null && method === "PUT") {
      return this.send(response, 200, this.publicProvider(
        await this.updateProvider(decodeURIComponent(providerMatch[1]!), await this.body(request)),
      ));
    }
    if (providerMatch !== null && method === "DELETE") {
      await this.deleteProvider(decodeURIComponent(providerMatch[1]!));
      response.writeHead(204).end();
      return;
    }
    const discoveryMatch = /^\/api\/v1\/model-registry\/providers\/([^/]+)\/discover$/.exec(pathname);
    if (discoveryMatch !== null && method === "POST") {
      const provider = this.provider(decodeURIComponent(discoveryMatch[1]!));
      return this.send(response, 200, await this.discover(
        provider.base_url,
        this.auth.provider_api_keys[provider.id] ?? "",
      ));
    }
    const specsMatch = /^\/api\/v1\/model-registry\/providers\/([^/]+)\/param-specs$/.exec(pathname);
    if (specsMatch !== null && method === "GET") {
      this.provider(decodeURIComponent(specsMatch[1]!));
      return this.send(response, 200, PARAM_SPECS);
    }
    if (method === "GET" && pathname === "/api/v1/model-registry/models") {
      return this.send(response, 200, this.registry.models.map((model) => this.publicModel(model)));
    }
    if (method === "POST" && pathname === "/api/v1/model-registry/models") {
      return this.send(response, 201, this.publicModel(await this.createModel(await this.body(request))));
    }
    const modelMatch = /^\/api\/v1\/model-registry\/models\/([^/]+)$/.exec(pathname);
    if (modelMatch !== null && method === "PUT") {
      return this.send(response, 200, this.publicModel(
        await this.updateModel(decodeURIComponent(modelMatch[1]!), await this.body(request)),
      ));
    }
    if (modelMatch !== null && method === "DELETE") {
      await this.deleteModel(decodeURIComponent(modelMatch[1]!));
      response.writeHead(204).end();
      return;
    }
    const activationMatch = /^\/api\/v1\/model-registry\/models\/([^/]+)\/activate$/.exec(pathname);
    if (activationMatch !== null && method === "POST") {
      await this.activateModel(decodeURIComponent(activationMatch[1]!));
      return this.send(response, 200, this.publicSettings());
    }
    throw new HttpError(404, "Not Found");
  }

  private async body(request: IncomingMessage): Promise<JsonObject> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size > 1_048_576) throw new HttpError(413, "request body is too large");
      chunks.push(buffer);
    }
    try {
      return asRecord(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "request body is not valid JSON");
    }
  }

  private send(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(value));
  }

  private publicSettings(): JsonObject {
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

  private updateSettings(body: JsonObject): Promise<void> {
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

  private publicProvider(provider: ProviderRecord): JsonObject {
    const apiKey = this.auth.provider_api_keys[provider.id] ?? "";
    return { ...provider, api_key: maskApiKey(apiKey), api_key_configured: apiKey !== "" };
  }

  private createProvider(body: JsonObject): Promise<ProviderRecord> {
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

  private updateProvider(id: string, body: JsonObject): Promise<ProviderRecord> {
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

  private deleteProvider(id: string): Promise<void> {
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

  private publicModel(model: ModelRecord): JsonObject {
    const provider = this.provider(model.provider_id);
    return {
      ...model,
      provider_name: provider.name,
      provider_base_url: provider.base_url,
      provider_api_key_configured: (this.auth.provider_api_keys[provider.id] ?? "") !== "",
      param_specs: PARAM_SPECS,
    };
  }

  private createModel(body: JsonObject): Promise<ModelRecord> {
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

  private updateModel(id: string, body: JsonObject): Promise<ModelRecord> {
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

  private deleteModel(id: string): Promise<void> {
    return this.mutate(() => {
      this.model(id);
      this.registry.models = this.registry.models.filter((item) => item.id !== id);
      if (this.registry.settings.active_model_id === id) {
        this.registry.settings.active_model_id = null;
      }
    });
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

  private activateModel(id: string): Promise<void> {
    return this.mutate(() => this.activateInMemory(this.model(id)));
  }

  private async discover(baseUrl: string, apiKey: string, query?: string): Promise<JsonObject[]> {
    const target = await publicProviderUrl(baseUrl, apiKey, this.resolveHost);
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
