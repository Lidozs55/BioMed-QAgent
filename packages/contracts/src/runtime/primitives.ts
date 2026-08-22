/**
 * Shared runtime validation primitives (path-based, APIError-throwing).
 *
 * Wire objects are snapshotted from own enumerable data-property descriptors.
 * Parsers therefore never read an input property through ordinary property
 * access and never execute an accessor. Node's native proxy detector is used
 * before any reflective object operation so hostile Proxy traps are not run.
 */

import type { JsonValue } from "../json.js";
import { APIError } from "./errors.js";

const MAX_STRING_LENGTH = 1_048_576;
const MAX_ARRAY_LENGTH = 10_000;
const MAX_OBJECT_KEYS = 10_000;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 100_000;

interface NodeUtilTypes {
  isProxy(value: unknown): boolean;
}

function loadNodeUtilTypes(): NodeUtilTypes | null {
  if (typeof process !== "object" || process === null) return null;
  const getBuiltinModuleDescriptor = Object.getOwnPropertyDescriptor(process, "getBuiltinModule");
  const getBuiltinModule = getBuiltinModuleDescriptor?.value;
  if (typeof getBuiltinModule !== "function") return null;
  const utilModule: unknown = getBuiltinModule.call(process, "node:util");
  if (utilModule === null || typeof utilModule !== "object") return null;
  const typesDescriptor = Object.getOwnPropertyDescriptor(utilModule, "types");
  const typesValue: unknown = typesDescriptor?.value;
  if (typesValue === null || typeof typesValue !== "object") return null;
  const isProxyDescriptor = Object.getOwnPropertyDescriptor(typesValue, "isProxy");
  const isProxy = isProxyDescriptor?.value;
  if (typeof isProxy !== "function") return null;
  return {
    isProxy(value: unknown): boolean {
      return isProxy.call(typesValue, value) === true;
    },
  };
}

const NODE_UTIL_TYPES = loadNodeUtilTypes();

function rejectProxy(value: unknown, path: string): void {
  if (NODE_UTIL_TYPES?.isProxy(value)) {
    throw new APIError(502, `Proxy objects are not accepted at ${path}`);
  }
}

function assertValidUnicode(value: string, path: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new APIError(502, `Expected well-formed Unicode at ${path}`);
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new APIError(502, `Expected well-formed Unicode at ${path}`);
    }
  }
  return value;
}

function ownDataDescriptors(
  value: object,
  path: string,
): Record<PropertyKey, PropertyDescriptor> {
  rejectProxy(value, path);
  return Object.getOwnPropertyDescriptors(value);
}

function assertPlainObjectPrototype(value: object, path: string): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new APIError(502, `Expected Object.prototype or null prototype at ${path}`);
  }
}

function arrayValues(value: unknown, path: string): unknown[] {
  rejectProxy(value, path);
  if (!Array.isArray(value)) {
    throw new APIError(502, `Expected array at ${path}, got ${typeof value}`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new APIError(502, `Expected Array.prototype at ${path}`);
  }
  if (value.length > MAX_ARRAY_LENGTH) {
    throw new APIError(502, `Array at ${path} exceeds ${MAX_ARRAY_LENGTH} items`);
  }

  const descriptors = ownDataDescriptors(value, path);
  const keys = Reflect.ownKeys(descriptors);
  for (const key of keys) {
    if (typeof key === "symbol") {
      throw new APIError(502, `Symbol array property is not accepted at ${path}`);
    }
    if (key === "length") continue;
    if (!/^(0|[1-9][0-9]*)$/.test(key)) {
      throw new APIError(502, `Unexpected array property "${key}" at ${path}`);
    }
    const numericKey = Number(key);
    if (!Number.isSafeInteger(numericKey) || numericKey >= value.length) {
      throw new APIError(502, `Unexpected array index ${key} at ${path}`);
    }
  }

  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, String(index))?.value;
    if (!descriptor) {
      throw new APIError(502, `Sparse array hole at ${path}[${index}]`);
    }
    if (!("value" in descriptor)) {
      throw new APIError(502, `Array index ${path}[${index}] must be a data property`);
    }
    if (!descriptor.enumerable) {
      throw new APIError(502, `Array index ${path}[${index}] must be enumerable`);
    }
    result.push(descriptor.value);
  }
  return result;
}

interface JsonWalkState {
  nodes: number;
}

function assertJsonValueInternal(
  value: unknown,
  path: string,
  depth: number,
  state: JsonWalkState,
  canonicalizeUnicode: boolean,
): JsonValue {
  state.nodes += 1;
  if (state.nodes > MAX_JSON_NODES) {
    throw new APIError(502, `JSON value at ${path} exceeds ${MAX_JSON_NODES} nodes`);
  }
  if (depth > MAX_JSON_DEPTH) {
    throw new APIError(502, `JSON value at ${path} exceeds nesting depth ${MAX_JSON_DEPTH}`);
  }
  if (value === null) return null;
  if (typeof value === "string") {
    const string = assertValidUnicode(assertString(value, path), path);
    return canonicalizeUnicode ? string.normalize("NFC") : string;
  }
  if (typeof value === "number") {
    const number = assertNumber(value, path);
    if (Number.isInteger(number) && !Number.isSafeInteger(number)) {
      throw new APIError(502, `Expected safe JSON integer at ${path}, got ${number}`);
    }
    return number;
  }
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return arrayValues(value, path).map((item, index) =>
      assertJsonValueInternal(
        item,
        `${path}[${index}]`,
        depth + 1,
        state,
        canonicalizeUnicode,
      ),
    );
  }
  if (typeof value === "object") {
    const object = assertObject(value, path);
    const keys = Object.keys(object);
    if (keys.length > MAX_OBJECT_KEYS) {
      throw new APIError(502, `JSON object at ${path} exceeds ${MAX_OBJECT_KEYS} fields`);
    }
    const result = Object.create(null) as Record<string, JsonValue>;
    const normalizedKeys = new Set<string>();
    for (const key of keys) {
      const validKey = assertValidUnicode(key, `${path} key`);
      const normalizedKey = canonicalizeUnicode ? validKey.normalize("NFC") : validKey;
      if (normalizedKeys.has(normalizedKey)) {
        throw new APIError(
          502,
          canonicalizeUnicode
            ? `Duplicate JSON key after NFC normalization at ${path}: "${normalizedKey}"`
            : `Duplicate JSON key at ${path}: "${normalizedKey}"`,
        );
      }
      normalizedKeys.add(normalizedKey);
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new APIError(502, `Expected own data property "${key}" at ${path}`);
      }
      result[normalizedKey] = assertJsonValueInternal(
        descriptor.value,
        `${path}.${normalizedKey}`,
        depth + 1,
        state,
        canonicalizeUnicode,
      );
    }
    return result;
  }
  throw new APIError(502, `Unexpected JSON value type at ${path}: ${typeof value}`);
}

export function assertJsonValue(value: unknown, path: string): JsonValue {
  return assertJsonValueInternal(value, path, 0, { nodes: 0 }, false);
}

/** JSON-safe snapshot for deterministic digest canonicalization only. */
export function assertCanonicalJsonValue(value: unknown, path: string): JsonValue {
  return assertJsonValueInternal(value, path, 0, { nodes: 0 }, true);
}

export function assertJsonRecord(value: unknown, path: string): Record<string, JsonValue> {
  const jsonValue = assertJsonValue(value, path);
  if (jsonValue === null || typeof jsonValue !== "object" || Array.isArray(jsonValue)) {
    throw new APIError(
      502,
      `Expected JSON object at ${path}, got ${jsonValue === null ? "null" : typeof jsonValue}`,
    );
  }
  return jsonValue;
}

export function assertString(value: unknown, path: string, nonEmpty = false): string {
  if (typeof value !== "string") {
    throw new APIError(502, `Expected string at ${path}, got ${typeof value}`);
  }
  if (nonEmpty && value.length === 0) {
    throw new APIError(502, `Expected non-empty string at ${path}`);
  }
  if (value.length > MAX_STRING_LENGTH) {
    throw new APIError(502, `String at ${path} exceeds ${MAX_STRING_LENGTH} characters`);
  }
  return value;
}

export function assertNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new APIError(502, `Expected finite number at ${path}, got ${typeof value}`);
  }
  return value;
}

export function assertBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new APIError(502, `Expected boolean at ${path}, got ${typeof value}`);
  }
  return value;
}

export function assertStringOrNull(value: unknown, path: string): string | null {
  if (value === null || value === undefined) return null;
  return assertString(value, path);
}

export function assertFinite<T extends string>(
  value: unknown,
  path: string,
  values: readonly T[],
): T {
  if (typeof value !== "string") {
    throw new APIError(502, `Expected one of [${values.join(",")}] at ${path}, got ${typeof value}`);
  }
  const found = values.find((candidate) => candidate === value);
  if (!found) {
    throw new APIError(
      502,
      `Unexpected value "${value}" at ${path}, expected one of [${values.join(",")}]`,
    );
  }
  return found;
}

export function assertObject(value: unknown, path: string): Record<string, unknown> {
  rejectProxy(value, path);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new APIError(502, `Expected object at ${path}, got ${typeof value}`);
  }
  assertPlainObjectPrototype(value, path);
  const descriptors = ownDataDescriptors(value, path);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length > MAX_OBJECT_KEYS) {
    throw new APIError(502, `Object at ${path} exceeds ${MAX_OBJECT_KEYS} fields`);
  }

  const result = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (typeof key === "symbol") {
      throw new APIError(502, `Symbol field is not accepted at ${path}`);
    }
    if (key === "__proto__") {
      throw new APIError(502, `Own __proto__ field is not accepted at ${path}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)?.value;
    if (!descriptor) {
      throw new APIError(502, `Invalid property descriptor for "${key}" at ${path}`);
    }
    if (!("value" in descriptor)) {
      throw new APIError(502, `Accessor property "${key}" is not accepted at ${path}`);
    }
    if (!descriptor.enumerable) {
      throw new APIError(502, `Non-enumerable field "${key}" is not accepted at ${path}`);
    }
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    });
  }
  return result;
}

export function assertArray<T>(
  value: unknown,
  path: string,
  itemParse: (item: unknown, index: number) => T,
): T[] {
  return arrayValues(value, path).map((item, index) => itemParse(item, index));
}

export function optBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  return assertBoolean(value, path);
}

export function optString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return assertString(value, path);
}

export function optNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  return assertNumber(value, path);
}

export function optSchemaVersion(value: unknown, path: string): "1.0" | undefined {
  if (value === undefined) return undefined;
  if (value === "1.0") return "1.0";
  throw new APIError(502, `Expected "1.0" or absent at ${path}, got ${String(value)}`);
}

export function assertOptionalNull<T>(
  value: unknown,
  path: string,
  guard: (input: unknown, inputPath: string) => T,
): T | null {
  if (value === null || value === undefined) return null;
  return guard(value, path);
}

export function assertHex64(value: unknown, path: string): string {
  const string = assertString(value, path);
  if (!/^[0-9a-f]{64}$/.test(string)) {
    throw new APIError(502, `Expected 64-char hex (lowercase SHA-256) at ${path}`);
  }
  return string;
}

export function assertPositiveInt(value: unknown, path: string): number {
  const number = assertNumber(value, path);
  if (number < 1 || !Number.isSafeInteger(number)) {
    throw new APIError(502, `Expected positive safe integer at ${path}, got ${number}`);
  }
  return number;
}

export function assertNonNegativeInt(value: unknown, path: string): number {
  const number = assertNumber(value, path);
  if (number < 0 || !Number.isSafeInteger(number)) {
    throw new APIError(502, `Expected non-negative safe integer at ${path}, got ${number}`);
  }
  return number;
}

export function assertOptionalNonNegativeInt(value: unknown, path: string): number | null {
  return assertOptionalNull(value, path, assertNonNegativeInt);
}
