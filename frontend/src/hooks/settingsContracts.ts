/* ------------------------------------------------------------------ */
/*  Settings contracts — extracted from useAPI.ts for 250-LOC ceiling  */
/* ------------------------------------------------------------------ */

/* ---- Source types — server vs client ---- */
/** Server-facing source: the backend only ever emits "catalog" or "user". */
export type ServerSource = "catalog" | "user";
/** Client-local draft/effective source: includes "unknown" for API-only model state. */
export type DraftSource = ServerSource | "unknown";

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
  suggested_max_tokens: number;
  capabilities: { text: boolean; image: boolean; video: boolean; audio: boolean };
  recommended: boolean;
  api_available: boolean;
  capability_source: CapabilitySource;
}

/* ---- Skills ---- */
export interface SkillManifest {
  name: string;
  display_name: string;
  version: string;
  category: string;
  description: string;
  origin: "builtin" | "package";
  supported_sources: string[];
  operations: string[];
  enabled: boolean;
  user_selectable: boolean;
  pipeline_supported: boolean;
  available?: boolean;
  load_error?: string | null;
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

export interface SkillDetail {
  manifest: SkillManifest;
  current_version: string;
  versions: string[];
  package_kind: "manifest" | "zip";
  warning: string | null;
  available: boolean;
  load_error: string | null;
  declarative_manifest: DeclarativeSkillManifest | null;
}

export interface SkillValidation {
  valid: boolean;
  skill: SkillManifest;
  warning: string | null;
}

/* ---- Database ---- */
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
  fetchVendors: () => Promise<VendorInfo[]>;
  fetchModels: (preview: ModelPreviewRequest) => Promise<ModelInfo[]>;
  fetchSkills: () => Promise<SkillManifest[]>;
  fetchSkill: (name: string) => Promise<SkillDetail>;
  setSkillEnabled: (name: string, enabled: boolean) => Promise<void>;
  rollbackSkill: (name: string) => Promise<void>;
  deleteSkill: (name: string) => Promise<void>;
  validateSkill: (file: File) => Promise<SkillValidation>;
  uploadSkill: (file: File) => Promise<void>;
  createDatabase: (manifest: DeclarativeSkillManifest) => Promise<void>;
  updateDatabase: (name: string, patch: DatabaseUpdatePatch) => Promise<void>;
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
