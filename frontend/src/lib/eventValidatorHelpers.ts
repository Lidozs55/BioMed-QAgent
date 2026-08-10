import { APIError } from "@/hooks/settingsContracts";
import type { JsonValue } from "@/runtime/contracts";

export function assertJsonValue(v: unknown, path: string): JsonValue {
  if (v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v;
  if (Array.isArray(v)) {
    const out: JsonValue[] = [];
    for (let i = 0; i < v.length; i++) out.push(assertJsonValue(v[i], `${path}[${i}]`));
    return out;
  }
  if (typeof v === "object") {
    const obj = assertObject(v, path);
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(obj)) {
      out[key] = assertJsonValue(Reflect.get(obj, key), `${path}.${key}`);
    }
    return out;
  }
  throw new APIError(502, `Unexpected JSON value type at ${path}: ${typeof v}`);
}

export function assertJsonRecord(v: unknown, path: string): Record<string, JsonValue> {
  const jv = assertJsonValue(v, path);
  if (jv === null || typeof jv !== "object" || Array.isArray(jv)) {
    throw new APIError(502, `Expected JSON object at ${path}, got ${jv === null ? "null" : typeof jv}`);
  }
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(jv)) {
    result[key] = jv[key];
  }
  return result;
}

export function assertString(v: unknown, path: string, nonEmpty = false): string {
  if (typeof v !== "string") throw new APIError(502, `Expected string at ${path}, got ${typeof v}`);
  if (nonEmpty && v.length === 0) throw new APIError(502, `Expected non-empty string at ${path}`);
  return v;
}

export function assertNumber(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new APIError(502, `Expected finite number at ${path}, got ${typeof v}`);
  return v;
}

export function assertBoolean(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") throw new APIError(502, `Expected boolean at ${path}, got ${typeof v}`);
  return v;
}

export function assertStringOrNull(v: unknown, path: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw new APIError(502, `Expected string|null at ${path}, got ${typeof v}`);
  return v;
}

export function assertFinite<T extends string>(v: unknown, path: string, values: readonly T[]): T {
  if (typeof v !== "string") throw new APIError(502, `Expected one of [${values.join(",")}] at ${path}, got ${typeof v}`);
  const found = values.find((x) => x === v);
  if (!found) throw new APIError(502, `Unexpected value "${v}" at ${path}, expected one of [${values.join(",")}]`);
  return found;
}

export function assertObject(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new APIError(502, `Expected object at ${path}, got ${typeof v}`);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(v)) result[key] = Reflect.get(v, key);
  return result;
}

export function assertArray<T>(v: unknown, path: string, itemParse: (item: unknown, idx: number) => T): T[] {
  if (!Array.isArray(v)) throw new APIError(502, `Expected array at ${path}, got ${typeof v}`);
  return v.map((item, i) => itemParse(item, i));
}

export function optBoolean(v: unknown, path: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw new APIError(502, `Expected optional boolean at ${path}, got ${typeof v}`);
  return v;
}

export function optSchemaVersion(v: unknown, path: string): "1.0" | undefined {
  if (v === undefined) return undefined;
  if (v === "1.0") return "1.0";
  throw new APIError(502, `Expected "1.0" or absent at ${path}, got ${String(v)}`);
}

export function assertOptionalNull<T>(v: unknown, path: string, guard: (x: unknown, p: string) => T): T | null {
  if (v === null || v === undefined) return null;
  return guard(v, path);
}

export function assertHex64(v: unknown, path: string): string {
  const s = assertString(v, path);
  if (!/^[0-9a-f]{64}$/.test(s)) throw new APIError(502, `Expected 64-char hex string at ${path}`);
  return s;
}

export function assertPositiveInt(v: unknown, path: string): number {
  const n = assertNumber(v, path);
  if (n < 1 || !Number.isInteger(n)) throw new APIError(502, `Expected positive integer at ${path}, got ${n}`);
  return n;
}

export function assertNonNegativeInt(v: unknown, path: string): number {
  const n = assertNumber(v, path);
  if (n < 0 || !Number.isInteger(n)) throw new APIError(502, `Expected non-negative integer at ${path}, got ${n}`);
  return n;
}

export function assertOptionalNonNegativeInt(v: unknown, path: string): number | null {
  const n = assertOptionalNull(v, path, (x, p) => { const num = assertNumber(x, p); if (num < 0 || !Number.isInteger(num)) throw new APIError(502, `Expected non-negative integer at ${p}, got ${num}`); return num; });
  return n;
}
