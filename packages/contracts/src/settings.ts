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
