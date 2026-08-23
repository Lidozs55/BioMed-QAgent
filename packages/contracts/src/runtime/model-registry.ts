/** Strict parsers for model-registry list responses. */
import type { ManagedModelInfo, ModelCapabilities, ParameterSpec, ProviderInfo } from "../model-registry.js";
import { APIError } from "./errors.js";
import { assertArray, assertBoolean, assertJsonRecord, assertJsonValue, assertNumber, assertObject, assertString, optBoolean, optString } from "./primitives.js";

function nullableNumber(value: unknown, path: string): number | null {
  return value === null ? null : assertNumber(value, path);
}

function parseCapabilities(value: unknown, path: string): ModelCapabilities {
  const object = assertObject(value, path);
  return {
    text: assertBoolean(Reflect.get(object, "text"), `${path}.text`),
    image: assertBoolean(Reflect.get(object, "image"), `${path}.image`),
    video: assertBoolean(Reflect.get(object, "video"), `${path}.video`),
    audio: assertBoolean(Reflect.get(object, "audio"), `${path}.audio`),
  };
}

function parseParameterSpec(value: unknown, path: string): ParameterSpec {
  const object = assertObject(value, path);
  const type = assertString(Reflect.get(object, "type"), `${path}.type`);
  if (!["integer", "number", "boolean", "string", "select"].includes(type)) {
    throw new APIError(502, `Unexpected parameter type at ${path}.type: ${type}`);
  }
  const result: ParameterSpec = {
    key: assertString(Reflect.get(object, "key"), `${path}.key`),
    label: assertString(Reflect.get(object, "label"), `${path}.label`),
    type: type as ParameterSpec["type"],
  };
  const defaultValue = Reflect.get(object, "default");
  if (defaultValue !== undefined) result.default = assertJsonValue(defaultValue, `${path}.default`);
  const description = optString(Reflect.get(object, "description"), `${path}.description`);
  if (description !== undefined) result.description = description;
  const min = Reflect.get(object, "min");
  if (min !== undefined) result.min = min === null ? null : assertNumber(min, `${path}.min`);
  const max = Reflect.get(object, "max");
  if (max !== undefined) result.max = max === null ? null : assertNumber(max, `${path}.max`);
  const options = Reflect.get(object, "options");
  if (options !== undefined) {
    result.options = assertArray(options, `${path}.options`, (item, index) => {
      const option = assertObject(item, `${path}.options[${index}]`);
      return {
        value: assertString(Reflect.get(option, "value"), `${path}.options[${index}].value`),
        label: assertString(Reflect.get(option, "label"), `${path}.options[${index}].label`),
      };
    });
  }
  const required = optBoolean(Reflect.get(object, "required"), `${path}.required`);
  if (required !== undefined) result.required = required;
  const advanced = optBoolean(Reflect.get(object, "advanced"), `${path}.advanced`);
  if (advanced !== undefined) result.advanced = advanced;
  return result;
}

function parseProvider(value: unknown, index: number): ProviderInfo {
  const path = `providers[${index}]`;
  const object = assertObject(value, path);
  return {
    id: assertString(Reflect.get(object, "id"), `${path}.id`),
    name: assertString(Reflect.get(object, "name"), `${path}.name`),
    base_url: assertString(Reflect.get(object, "base_url"), `${path}.base_url`),
    api_key: assertString(Reflect.get(object, "api_key"), `${path}.api_key`),
    api_key_configured: assertBoolean(Reflect.get(object, "api_key_configured"), `${path}.api_key_configured`),
    preset_id: Reflect.get(object, "preset_id") === null
      ? null
      : assertString(Reflect.get(object, "preset_id"), `${path}.preset_id`),
    description: assertString(Reflect.get(object, "description"), `${path}.description`),
    enabled: assertBoolean(Reflect.get(object, "enabled"), `${path}.enabled`),
    created_at: assertString(Reflect.get(object, "created_at"), `${path}.created_at`),
    updated_at: assertString(Reflect.get(object, "updated_at"), `${path}.updated_at`),
  };
}

function parseManagedModel(value: unknown, index: number): ManagedModelInfo {
  const path = `models[${index}]`;
  const object = assertObject(value, path);
  const source = assertString(Reflect.get(object, "source"), `${path}.source`);
  if (source !== "api" && source !== "manual" && source !== "catalog") {
    throw new APIError(502, `Unexpected model source at ${path}.source: ${source}`);
  }
  return {
    id: assertString(Reflect.get(object, "id"), `${path}.id`),
    provider_id: assertString(Reflect.get(object, "provider_id"), `${path}.provider_id`),
    provider_name: assertString(Reflect.get(object, "provider_name"), `${path}.provider_name`),
    provider_base_url: assertString(Reflect.get(object, "provider_base_url"), `${path}.provider_base_url`),
    provider_api_key_configured: assertBoolean(Reflect.get(object, "provider_api_key_configured"), `${path}.provider_api_key_configured`),
    model_id: assertString(Reflect.get(object, "model_id"), `${path}.model_id`),
    name: assertString(Reflect.get(object, "name"), `${path}.name`),
    description: assertString(Reflect.get(object, "description"), `${path}.description`),
    context_window: nullableNumber(Reflect.get(object, "context_window"), `${path}.context_window`),
    max_output_tokens: nullableNumber(Reflect.get(object, "max_output_tokens"), `${path}.max_output_tokens`),
    suggested_max_tokens: nullableNumber(Reflect.get(object, "suggested_max_tokens"), `${path}.suggested_max_tokens`),
    capabilities: parseCapabilities(Reflect.get(object, "capabilities"), `${path}.capabilities`),
    params: assertJsonRecord(Reflect.get(object, "params"), `${path}.params`),
    param_specs: assertArray(Reflect.get(object, "param_specs"), `${path}.param_specs`, (item, itemIndex) => parseParameterSpec(item, `${path}.param_specs[${itemIndex}]`)),
    source,
    active: assertBoolean(Reflect.get(object, "active"), `${path}.active`),
    created_at: assertString(Reflect.get(object, "created_at"), `${path}.created_at`),
    updated_at: assertString(Reflect.get(object, "updated_at"), `${path}.updated_at`),
  };
}

export function parseProvidersEnvelope(body: unknown): ProviderInfo[] {
  return assertArray(body, "providers", parseProvider);
}

export function parseManagedModelsEnvelope(body: unknown): ManagedModelInfo[] {
  return assertArray(body, "models", parseManagedModel);
}
