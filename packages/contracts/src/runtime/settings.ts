/**
 * Settings / personalization / vendor / model response parsers.
 *
 * Reject malformed JSON at the wire boundary. Moved verbatim from
 * ``frontend/src/hooks/settingsParsers.ts`` so the frontend client and any
 * other consumer share one parser per DTO (types in ``../settings.js``).
 */

import type {
  CapabilitySource,
  ModelInfo,
  ModelSettings,
  Personality,
  RuntimeLimits,
  PersonalizationSettings,
  VendorInfo,
} from "../settings.js";
import { DEFAULT_RUNTIME_LIMITS, RUNTIME_LIMIT_RANGES } from "../settings.js";
import { APIError } from "./errors.js";
import {
  assertBoolean,
  assertNumber,
  assertObject,
  assertString,
  optBoolean,
  optNumber,
  optString,
} from "./primitives.js";

/** Settings response source — unavailable capacity is explicitly "unknown". */
function assertSettingsSource(v: unknown, path: string): "catalog" | "user" | "inferred" | "unknown" {
  if (v === "catalog") return "catalog";
  if (v === "user") return "user";
  if (v === "inferred") return "inferred";
  if (v === "unknown") return "unknown";
  throw new APIError(502, `Expected catalog|user|inferred|unknown at ${path}, got ${String(v)}`);
}

/** Model capability source — backend emits "catalog" or "api". */
function assertCapabilitySource(v: unknown, path: string): CapabilitySource {
  if (v === "catalog") return "catalog";
  if (v === "api") return "api";
  throw new APIError(502, `Expected catalog|api at ${path}, got ${String(v)}`);
}

/** Parse a settings response body into ModelSettings, rejecting malformed shapes. */
export function parseModelSettings(body: unknown): ModelSettings {
  const obj = assertObject(body, "settings");
  const contextWindow = assertNumber(Reflect.get(obj, "context_window"), "settings.context_window");
  const contextWindowSource = assertSettingsSource(Reflect.get(obj, "context_window_source"), "settings.context_window_source");
  const safetyReserveTokens = assertNumber(Reflect.get(obj, "safety_reserve_tokens"), "settings.safety_reserve_tokens");
  const availableInputTokens = assertNumber(Reflect.get(obj, "available_input_tokens"), "settings.available_input_tokens");
  if (contextWindowSource === "unknown" && (contextWindow !== 0 || safetyReserveTokens !== 0 || availableInputTokens !== 0)) {
    throw new APIError(502, "Unknown context capacity must use zero-valued budget fields");
  }
  return {
    base_url: assertString(Reflect.get(obj, "base_url"), "settings.base_url"),
    api_key: assertString(Reflect.get(obj, "api_key"), "settings.api_key"),
    api_key_configured: assertBoolean(Reflect.get(obj, "api_key_configured"), "settings.api_key_configured"),
    model_name: assertString(Reflect.get(obj, "model_name"), "settings.model_name"),
    max_tokens: assertNumber(Reflect.get(obj, "max_tokens"), "settings.max_tokens"),
    context_window: contextWindow,
    context_window_source: contextWindowSource,
    safety_reserve_ratio: assertNumber(Reflect.get(obj, "safety_reserve_ratio"), "settings.safety_reserve_ratio"),
    safety_reserve_tokens: safetyReserveTokens,
    compaction_trigger_ratio: assertNumber(Reflect.get(obj, "compaction_trigger_ratio"), "settings.compaction_trigger_ratio"),
    compaction_target_ratio: assertNumber(Reflect.get(obj, "compaction_target_ratio"), "settings.compaction_target_ratio"),
    available_input_tokens: availableInputTokens,
    advanced: parseAdvanced(Reflect.get(obj, "advanced"), "settings.advanced"),
    run_block_reason: optString(Reflect.get(obj, "run_block_reason"), "settings.run_block_reason") ?? null,
    runtime_limits: parseRuntimeLimits(Reflect.get(obj, "runtime_limits"), "settings.runtime_limits"),
  };
}

function parseRuntimeLimits(v: unknown, path: string): RuntimeLimits {
  if (v === undefined) return { ...DEFAULT_RUNTIME_LIMITS };
  const obj = assertObject(v, path);
  const result = {} as RuntimeLimits;
  for (const key of Object.keys(RUNTIME_LIMIT_RANGES) as Array<keyof RuntimeLimits>) {
    const value = assertNumber(Reflect.get(obj, key), `${path}.${key}`);
    const range = RUNTIME_LIMIT_RANGES[key];
    if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
      throw new APIError(502, `Expected integer in [${range.min},${range.max}] at ${path}.${key}, got ${value}`);
    }
    result[key] = value;
  }
  return result;
}

function parseAdvanced(v: unknown, path: string): ModelSettings["advanced"] {
  const obj = assertObject(v, path);
  return {
    temperature: optNumber(Reflect.get(obj, "temperature"), `${path}.temperature`),
    top_p: optNumber(Reflect.get(obj, "top_p"), `${path}.top_p`),
    repetition_penalty: optNumber(Reflect.get(obj, "repetition_penalty"), `${path}.repetition_penalty`),
    enable_search: optBoolean(Reflect.get(obj, "enable_search"), `${path}.enable_search`),
    thinking_mode: optBoolean(Reflect.get(obj, "thinking_mode"), `${path}.thinking_mode`),
  };
}

/** Parse a vendors response envelope. */
export function parseVendorsEnvelope(body: unknown): { vendors: VendorInfo[] } {
  const obj = assertObject(body, "vendors response");
  const vendorsArr = Reflect.get(obj, "vendors");
  if (!Array.isArray(vendorsArr)) throw new APIError(502, "Expected array at response.vendors");
  const vendors: VendorInfo[] = [];
  for (let i = 0; i < vendorsArr.length; i++) {
    const item = vendorsArr[i];
    const itemObj = assertObject(item, `vendors[${i}]`);
    vendors.push({
      id: assertString(Reflect.get(itemObj, "id"), `vendors[${i}].id`),
      name: assertString(Reflect.get(itemObj, "name"), `vendors[${i}].name`),
      base_url: assertString(Reflect.get(itemObj, "base_url"), `vendors[${i}].base_url`),
      description: assertString(Reflect.get(itemObj, "description"), `vendors[${i}].description`),
      recommended: assertBoolean(Reflect.get(itemObj, "recommended"), `vendors[${i}].recommended`),
    });
  }
  return { vendors };
}

/** Parse a models response envelope — backend always emits all fields. */
export function parseModelsEnvelope(body: unknown): { models: ModelInfo[] } {
  const obj = assertObject(body, "models response");
  const modelsArr = Reflect.get(obj, "models");
  if (!Array.isArray(modelsArr)) throw new APIError(502, "Expected array at response.models");
  const models: ModelInfo[] = [];
  for (let i = 0; i < modelsArr.length; i++) {
    const item = modelsArr[i];
    const itemObj = assertObject(item, `models[${i}]`);
    models.push({
      id: assertString(Reflect.get(itemObj, "id"), `models[${i}].id`),
      name: assertString(Reflect.get(itemObj, "name"), `models[${i}].name`),
      description: assertString(Reflect.get(itemObj, "description"), `models[${i}].description`),
      context_window: assertNumber(Reflect.get(itemObj, "context_window"), `models[${i}].context_window`),
      max_output_tokens: optNumber(Reflect.get(itemObj, "max_output_tokens"), `models[${i}].max_output_tokens`),
      suggested_max_tokens: assertNumber(Reflect.get(itemObj, "suggested_max_tokens"), `models[${i}].suggested_max_tokens`),
      recommended: assertBoolean(Reflect.get(itemObj, "recommended"), `models[${i}].recommended`),
      api_available: assertBoolean(Reflect.get(itemObj, "api_available"), `models[${i}].api_available`),
      capability_source: assertCapabilitySource(Reflect.get(itemObj, "capability_source"), `models[${i}].capability_source`),
      capabilities: parseCapabilities(Reflect.get(itemObj, "capabilities"), `models[${i}].capabilities`),
    });
  }
  return { models };
}

function parseCapabilities(v: unknown, path: string): ModelInfo["capabilities"] {
  const obj = assertObject(v, path); // throws for null, undefined, or non-object
  return {
    text: assertBoolean(Reflect.get(obj, "text"), `${path}.text`),
    image: assertBoolean(Reflect.get(obj, "image"), `${path}.image`),
    video: assertBoolean(Reflect.get(obj, "video"), `${path}.video`),
    audio: assertBoolean(Reflect.get(obj, "audio"), `${path}.audio`),
  };
}

function assertPersonality(v: unknown, path: string): Personality {
  if (v === "pragmatic" || v === "warm" || v === "rigorous") return v;
  throw new APIError(502, `Expected pragmatic|warm|rigorous at ${path}, got ${String(v)}`);
}

/** Parse a personalization response body into PersonalizationSettings. */
export function parsePersonalization(body: unknown): PersonalizationSettings {
  const obj = assertObject(body, "personalization");
  return {
    custom_instructions: assertString(
      Reflect.get(obj, "custom_instructions"),
      "personalization.custom_instructions",
    ),
    personality: assertPersonality(
      Reflect.get(obj, "personality"),
      "personalization.personality",
    ),
    personality_label: assertString(
      Reflect.get(obj, "personality_label"),
      "personalization.personality_label",
    ),
  };
}
