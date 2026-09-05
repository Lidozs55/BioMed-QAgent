/**
 * Settings / personalization / vendor / model wire DTOs.
 *
 * Canonical transport shapes for ``/api/v1/settings``, ``/api/v1/personalization``,
 * ``/api/v1/vendors`` and ``/api/v1/models``. Moved out of the frontend
 * ``hooks/settingsContracts`` module so both sides of the wire share one
 * definition (frontend wire parsers live in ``./runtime/settings.js``).
 */

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

/** User-managed operational budgets. Security invariants are intentionally excluded. */
export interface RuntimeLimits {
  command_timeout_seconds: number;
  command_output_kib: number;
  workspace_read_kib: number;
  workspace_write_kib: number;
  workspace_search_file_mib: number;
  workspace_search_max_files: number;
  http_timeout_seconds: number;
  download_timeout_seconds: number;
  browser_timeout_seconds: number;
  dataset_operation_timeout_seconds: number;
  database_timeout_seconds: number;
  max_download_mib: number;
  gdc_max_files: number;
  chembl_max_compounds: number;
  chembl_max_records: number;
  request_interval_ms: number;
  /**
   * Wall-clock timeout for a single model-provider HTTP request (VLM chart
   * extraction, HIL LLM pre-review, model discovery probe, skill iteration).
   * The main agent session uses its own provider retry/timeout policy.
   */
  model_request_timeout_seconds: number;
  /** Download attempts per core acquisition before failing the operation. */
  acquisition_max_attempts: number;
  /** Pi SDK retries for one transient model-provider request. */
  model_provider_max_retries: number;
  /** Extra durable recovery turns after exhausted stream/provider failures. */
  model_recovery_max_attempts: number;
  /** Base delay for Pi request retries and exponential stream recovery. */
  model_retry_base_delay_ms: number;
  /** Maximum Pi retry delay and fixed exhausted-provider recovery delay. */
  model_retry_max_delay_ms: number;
  /** Total attempts for one visual-model page request. */
  vlm_max_attempts: number;
  /** Base delay for exponential visual-model request retry. */
  vlm_retry_base_delay_ms: number;
  /** Maximum caption-selected or fallback PDF pages sent to the visual model. */
  vlm_pdf_max_pages: number;
  /** Maximum embedded PDF raster images sent to the visual model. */
  vlm_pdf_max_images: number;
  /** PDF page raster resolution; the pixel safety gate remains code-owned. */
  vlm_render_dpi: number;
  /**
   * Host-side ceiling for JSON tool responses: each curated tool's own
   * response cap is clamped to ``min(tool cap, api_response_max_mib)`` so
   * lowering the setting bounds every tool (2026-09-02 audit P1).
   */
  api_response_max_mib: number;
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimits = {
  command_timeout_seconds: 600,
  command_output_kib: 256,
  workspace_read_kib: 256,
  workspace_write_kib: 1024,
  workspace_search_file_mib: 16,
  workspace_search_max_files: 2000,
  http_timeout_seconds: 300,
  download_timeout_seconds: 3600,
  browser_timeout_seconds: 300,
  dataset_operation_timeout_seconds: 3600,
  database_timeout_seconds: 600,
  max_download_mib: 8192,
  gdc_max_files: 50,
  chembl_max_compounds: 1000,
  chembl_max_records: 10000,
  request_interval_ms: 500,
  model_request_timeout_seconds: 120,
  acquisition_max_attempts: 3,
  model_provider_max_retries: 6,
  model_recovery_max_attempts: 3,
  model_retry_base_delay_ms: 3000,
  model_retry_max_delay_ms: 60_000,
  vlm_max_attempts: 3,
  vlm_retry_base_delay_ms: 1000,
  vlm_pdf_max_pages: 12,
  vlm_pdf_max_images: 10,
  vlm_render_dpi: 216,
  api_response_max_mib: 16,
};

/**
 * Shipped model-settings defaults (2026-09-02 hardcoded-params audit P0-12):
 * the single source for ``store.defaultRegistry`` and the Pi-adapter fallbacks,
 * so the settings default and the code fallback can no longer drift apart.
 */
export const DEFAULT_MAX_TOKENS = 8192;
/**
 * Context-window fallback when neither the active model record nor the runtime
 * settings pin one (i.e. models missing from the vendor catalog). 256k so the
 * >100k knowledge-injection payloads fit; single source for the server budget
 * math (model-resolution / budget / upstream-session) and the frontend display
 * fallback. Within SETTING_NUMBER_BOUNDS.context_window (max 4_194_304).
 */
export const DEFAULT_CONTEXT_WINDOW = 262_144;
export const DEFAULT_SAFETY_RESERVE_RATIO = 0.05;
export const DEFAULT_COMPACTION_TRIGGER_RATIO = 0.85;
export const DEFAULT_COMPACTION_TARGET_RATIO = 0.45;

export const RUNTIME_LIMIT_RANGES = {
  command_timeout_seconds: { min: 1, max: 86_400 },
  command_output_kib: { min: 64, max: 16_384 },
  workspace_read_kib: { min: 64, max: 16_384 },
  workspace_write_kib: { min: 256, max: 65_536 },
  workspace_search_file_mib: { min: 1, max: 1024 },
  workspace_search_max_files: { min: 100, max: 100_000 },
  http_timeout_seconds: { min: 5, max: 3600 },
  download_timeout_seconds: { min: 60, max: 86_400 },
  browser_timeout_seconds: { min: 10, max: 3600 },
  dataset_operation_timeout_seconds: { min: 60, max: 86_400 },
  database_timeout_seconds: { min: 10, max: 3600 },
  max_download_mib: { min: 64, max: 65_536 },
  gdc_max_files: { min: 1, max: 1000 },
  chembl_max_compounds: { min: 1, max: 10_000 },
  chembl_max_records: { min: 1, max: 100_000 },
  request_interval_ms: { min: 0, max: 10_000 },
  model_request_timeout_seconds: { min: 10, max: 3600 },
  acquisition_max_attempts: { min: 1, max: 10 },
  model_provider_max_retries: { min: 0, max: 20 },
  model_recovery_max_attempts: { min: 0, max: 10 },
  model_retry_base_delay_ms: { min: 0, max: 60_000 },
  model_retry_max_delay_ms: { min: 1000, max: 600_000 },
  vlm_max_attempts: { min: 1, max: 10 },
  vlm_retry_base_delay_ms: { min: 0, max: 60_000 },
  vlm_pdf_max_pages: { min: 1, max: 100 },
  vlm_pdf_max_images: { min: 1, max: 100 },
  vlm_render_dpi: { min: 72, max: 300 },
  api_response_max_mib: { min: 1, max: 256 },
} as const satisfies Record<keyof RuntimeLimits, { min: number; max: number }>;

export interface ModelRetryPolicy {
  providerMaxRetries: number;
  recoveryMaxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  vlmMaxAttempts: number;
  vlmBaseDelayMs: number;
}

/** Derive the one model retry policy consumed by Pi, recovery, and VLM. */
export function modelRetryPolicyFromRuntimeLimits(
  limits: RuntimeLimits,
): ModelRetryPolicy {
  return {
    providerMaxRetries: limits.model_provider_max_retries,
    recoveryMaxAttempts: limits.model_recovery_max_attempts,
    baseDelayMs: limits.model_retry_base_delay_ms,
    maxDelayMs: limits.model_retry_max_delay_ms,
    vlmMaxAttempts: limits.vlm_max_attempts,
    vlmBaseDelayMs: limits.vlm_retry_base_delay_ms,
  };
}

export const DEFAULT_MODEL_RETRY_POLICY = Object.freeze(
  modelRetryPolicyFromRuntimeLimits(DEFAULT_RUNTIME_LIMITS),
);

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
  /** Non-null when task creation needs explicit user confirmation (e.g. context budget warning). */
  run_block_reason: string | null;
  runtime_limits: RuntimeLimits;
  /** Explicit visual-extraction role: managed-model record id, or null when unset. */
  vision_model_id: string | null;
  /** Read-only facts about the effective visual model (assignment, else active model when visual). */
  vision_model_name: string | null;
  vision_provider_name: string | null;
  /** True when the effective visual model exists, is enabled, image-capable, and has credentials. */
  vision_model_ready: boolean;
  /** Actionable reason the visual role is not ready, or null. */
  vision_block_reason: string | null;
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
  runtime_limits?: Partial<RuntimeLimits> | null;
  /** Visual-extraction model assignment; null clears the role. */
  vision_model_id?: string | null;
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
