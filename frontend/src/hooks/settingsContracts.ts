/* ------------------------------------------------------------------ */
/*  Settings contracts — extracted from useAPI.ts for 250-LOC ceiling  */
/* ------------------------------------------------------------------ */

/* ---- Source types — server vs client ---- */
/** Server-facing source for catalog, explicit-user, name-inferred, or unavailable unknown capacity. */
export type ServerSource = "catalog" | "user" | "inferred" | "unknown";
/** Client-local draft/effective source mirrors the authoritative server source. */
export type DraftSource = ServerSource;

/* ---- Budget types ---- */
export interface ContextBudgetSettings {
  context_window: number;
  context_window_source: ServerSource;
  safety_reserve_ratio: number;
  safety_reserve_tokens: number;
  compaction_trigger_ratio: number;
  compaction_target_ratio: number;
  available_input_tokens: number;
}

/* ---- Model settings ---- */
export interface ModelSettings extends ContextBudgetSettings {
  base_url: string;
  api_key: string;
  api_key_configured: boolean;
  model_name: string;
  max_tokens: number;
  advanced: {
    temperature?: number;
    top_p?: number;
    repetition_penalty?: number;
    enable_search?: boolean;
    thinking_mode?: boolean;
  };
  /** Non-null when the backend cannot resolve a valid context budget; task creation will be rejected. */
  run_block_reason: string | null;
}

export interface ModelSettingsUpdate {
  base_url?: string;
  api_key?: string;
  model_name?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  repetition_penalty?: number;
  enable_search?: boolean;
  thinking_mode?: boolean;
  context_window?: number | null;
  safety_reserve_ratio?: number;
  compaction_trigger_ratio?: number;
  compaction_target_ratio?: number;
}

/* ---- Personalization ---- */

export type Personality = "pragmatic" | "warm" | "rigorous";

export interface PersonalizationSettings {
  custom_instructions: string;
  personality: Personality;
  personality_label: string;
}

export interface PersonalizationUpdate {
  custom_instructions?: string;
  personality?: Personality;
}

export interface ModelPreviewRequest {
  baseUrl: string;
  apiKey?: string;
  query?: string;
}

/* ---- Vendors & models ---- */
export interface VendorInfo {
  id: string;
  name: string;
  base_url: string;
  description: string;
  recommended: boolean;
}

export type CapabilitySource = "catalog" | "api";

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  context_window: number;
  max_output_tokens?: number;
  suggested_max_tokens: number;
  vendor_id?: string | null;
  knowledge_cutoff?: string | null;
  pricing_input_per_1m?: number | null;
  pricing_output_per_1m?: number | null;
  model_family?: string | null;
  function_calling?: boolean;
  supports_streaming?: boolean;
  capabilities: { text: boolean; image: boolean; video: boolean; audio: boolean };
  recommended: boolean;
  api_available: boolean;
  capability_source: CapabilitySource;
}

/* ---- Model registry: providers & managed models ---- */
export interface ParameterSpec {
  key: string;
  label: string;
  type: "integer" | "number" | "boolean" | "string" | "select";
  default?: unknown;
  description?: string;
  min?: number | null;
  max?: number | null;
  options?: { value: string; label: string }[];
  required?: boolean;
  advanced?: boolean;
}

export interface ModelCapabilities {
  text: boolean;
  image: boolean;
  video: boolean;
  audio: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  api_key_configured: boolean;
  preset_id: string | null;
  description: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProviderInput {
  name: string;
  base_url: string;
  api_key?: string;
  preset_id?: string | null;
  description?: string;
}

export interface ProviderUpdateInput {
  name?: string;
  base_url?: string;
  api_key?: string;
  preset_id?: string | null;
  description?: string;
  enabled?: boolean;
}

export interface ManagedModelInfo {
  id: string;
  provider_id: string;
  provider_name: string;
  provider_base_url: string;
  provider_api_key_configured: boolean;
  model_id: string;
  name: string;
  description: string;
  context_window: number | null;
  max_output_tokens: number | null;
  suggested_max_tokens: number | null;
  capabilities: ModelCapabilities;
  params: Record<string, unknown>;
  param_specs: ParameterSpec[];
  source: "api" | "manual" | "catalog";
  active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ManagedModelInput {
  provider_id: string;
  model_id: string;
  name?: string;
  description?: string;
  context_window?: number | null;
  max_output_tokens?: number | null;
  suggested_max_tokens?: number | null;
  capabilities?: Partial<ModelCapabilities>;
  params?: Record<string, unknown>;
  source?: "api" | "manual" | "catalog";
  [key: string]: unknown;
}

export interface DiscoveredModelInfo {
  id: string;
  name: string;
  description?: string;
  context_window?: number | null;
  max_output_tokens?: number | null;
  suggested_max_tokens?: number | null;
  capabilities?: Partial<ModelCapabilities>;
  recommended?: boolean;
  param_specs?: ParameterSpec[];
  capability_source?: "catalog" | "api";
}

export interface AuthReference {
  source: "env";
  reference: string;
  location: "header" | "query";
  name: string;
  prefix?: string;
}

export interface DeclarativeOperation {
  name: string;
  description: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
  url: string;
  query: Record<string, unknown>;
  headers: Record<string, unknown>;
  body: unknown;
  timeout_seconds: number;
  extract: string | null;
  auth: AuthReference | null;
}

export interface DeclarativeSkillManifest {
  schema_version: "1.0";
  name: string;
  display_name: string;
  version: string;
  category: string;
  description: string;
  supported_sources: string[];
  operations: DeclarativeOperation[];
  enabled: boolean;
  user_selectable: boolean;
  pipeline_supported: false;
  requirements: string[];
}

/* ---- Database (Phase 2: thin declarative store) ---- */
export interface DatabaseItem {
  id: string;
  name: string;
  category: string;
  description: string;
  available?: boolean;
  enabled: boolean;
  origin: "builtin" | "package";
  version?: string;
  pipeline_supported?: boolean;
  capability?: string;
  declarative_manifest?: DeclarativeSkillManifest | null;
}

export interface DatabaseDetail extends DatabaseItem {
  declarative_manifest: DeclarativeSkillManifest | null;
}

export interface DatabaseOperationUpdatePatch {
  name: string;
  description?: string;
  method?: DeclarativeOperation["method"];
  url?: string;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: unknown;
  timeout_seconds?: number;
  extract?: string | null;
}

export interface DatabaseUpdatePatch {
  display_name?: string;
  description?: string;
  operation?: DatabaseOperationUpdatePatch;
}

/* ---- Settings API client ---- */
export interface SettingsAPIClient {
  fetchSettings: () => Promise<ModelSettings>;
  saveSettings: (changes: ModelSettingsUpdate) => Promise<ModelSettings>;
  fetchPersonalization: () => Promise<PersonalizationSettings>;
  savePersonalization: (changes: PersonalizationUpdate) => Promise<PersonalizationSettings>;
  fetchVendors: () => Promise<VendorInfo[]>;
  fetchModels: (preview: ModelPreviewRequest) => Promise<ModelInfo[]>;
  fetchProviders: () => Promise<ProviderInfo[]>;
  createProvider: (input: ProviderInput) => Promise<ProviderInfo>;
  updateProvider: (id: string, patch: ProviderUpdateInput) => Promise<ProviderInfo>;
  deleteProvider: (id: string) => Promise<void>;
  discoverProviderModels: (id: string) => Promise<DiscoveredModelInfo[]>;
  fetchProviderParamSpecs: (id: string) => Promise<ParameterSpec[]>;
  fetchManagedModels: () => Promise<ManagedModelInfo[]>;
  createManagedModel: (input: ManagedModelInput) => Promise<ManagedModelInfo>;
  updateManagedModel: (
    id: string,
    patch: Partial<ManagedModelInput>,
  ) => Promise<ManagedModelInfo>;
  deleteManagedModel: (id: string) => Promise<void>;
  activateManagedModel: (id: string) => Promise<ModelSettings>;
  fetchDatabases: () => Promise<DatabaseItem[]>;
  fetchDatabase: (name: string) => Promise<DatabaseDetail>;
  setDatabaseEnabled: (name: string, enabled: boolean) => Promise<void>;
  createDatabase: (manifest: DeclarativeSkillManifest) => Promise<DatabaseDetail>;
  updateDatabase: (name: string, patch: DatabaseUpdatePatch) => Promise<DatabaseDetail>;
  deleteDatabase: (name: string) => Promise<void>;
}

/* ---- Error types ---- */

/** Check if a value has a string `msg` property. */
function hasMsg(v: unknown): v is object & { msg: string } {
  return v !== null && typeof v === "object" && "msg" in v && typeof Reflect.get(v, "msg") === "string";
}

/** Check if a value has a `detail` property (for nested error wrapping). */
function hasDetail(v: unknown): v is object & { detail: unknown } {
  return v !== null && typeof v === "object" && "detail" in v;
}

/** Normalize FastAPI error detail into a readable message. */
export function normalizeErrorDetail(status: number, detail: unknown): string {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    const messages: string[] = [];
    for (const item of detail) {
      if (hasMsg(item)) messages.push(item.msg);
    }
    if (messages.length > 0) return messages.join("; ");
  }
  if (hasDetail(detail)) {
    return normalizeErrorDetail(status, Reflect.get(detail, "detail"));
  }
  return `API request failed (${status})`;
}

export class APIError extends Error {
  readonly status: number;
  readonly detail: unknown;

  constructor(status: number, detail: unknown) {
    super(normalizeErrorDetail(status, detail));
    this.name = "APIError";
    this.status = status;
    this.detail = detail;
  }
}
