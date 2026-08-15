/**
 * Model registry wire DTOs (``/api/v1/model-registry/*``).
 *
 * Canonical transport shapes for providers, managed models and parameter
 * specs. Moved out of the frontend ``hooks/settingsContracts`` module so both
 * sides of the wire share one definition.
 */

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
