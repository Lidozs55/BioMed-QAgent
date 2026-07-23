/* ------------------------------------------------------------------ */
/*  Settings/model response parsers — reject malformed JSON at boundary */
/* ------------------------------------------------------------------ */

import { APIError, type CapabilitySource, type ModelInfo, type ModelSettings, type VendorInfo } from "@/hooks/settingsContracts";

/* ---- Type assertions ---- */

function assertString(v: unknown, path: string): string {
  if (typeof v !== "string") throw new APIError(502, `Expected string at ${path}, got ${typeof v}`);
  return v;
}

function assertNumber(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new APIError(502, `Expected finite number at ${path}, got ${typeof v}`);
  return v;
}

function assertBoolean(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") throw new APIError(502, `Expected boolean at ${path}, got ${typeof v}`);
  return v;
}

function assertObject(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new APIError(502, `Expected object at ${path}, got ${typeof v}`);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(v)) result[key] = Reflect.get(v, key);
  return result;
}

/** Settings response source — unavailable capacity is explicitly "unknown". */
function assertSettingsSource(v: unknown, path: string): "catalog" | "user" | "unknown" {
  if (v === "catalog") return "catalog";
  if (v === "user") return "user";
  if (v === "unknown") return "unknown";
  throw new APIError(502, `Expected catalog|user|unknown at ${path}, got ${String(v)}`);
}

/** Model capability source — backend emits "catalog" or "api". */
function assertCapabilitySource(v: unknown, path: string): CapabilitySource {
  if (v === "catalog") return "catalog";
  if (v === "api") return "api";
  throw new APIError(502, `Expected catalog|api at ${path}, got ${String(v)}`);
}

/* ---- Optional assertions (absent = undefined; present + wrong type = reject) ---- */

function optNumber(v: unknown, path: string): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new APIError(502, `Expected optional number at ${path}, got ${typeof v}`);
  return v;
}

function optBoolean(v: unknown, path: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new APIError(502, `Expected optional boolean at ${path}, got ${typeof v}`);
  return v;
}

/* ---- Concrete parsers ---- */

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
  };
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
