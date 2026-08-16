/**
 * Strict validation primitives for the deterministic Dataset Core contracts.
 *
 * Mirrors the Python ``app.domain.contracts.base.ContractModel`` semantics
 * (extra="forbid", schema_version="1.0") and ``app.tools.workdir`` path-safe
 * identifiers so the TypeScript core accepts exactly what Python V2
 * serializes and rejects unknown fields the same way (migration plan §10.1:
 * JSON contract must not drift).
 */

import type { JsonValue } from "@biomed/contracts";

export const SCHEMA_VERSION = "1.0" as const;
export type SchemaVersion = "1.0";

const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;

export function assertRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) {
    throw new TypeError(`${name} has unknown fields: ${extras.join(", ")}`);
  }
}

export function assertString(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

export function assertNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

/** Single path-safe identifier component (Python validate_safe_path_id). */
export function assertSafeId(value: unknown, name: string): string {
  const text = assertNonEmptyString(value, name);
  if (!SAFE_ID_PATTERN.test(text)) {
    throw new TypeError(`${name} must be a safe path identifier`);
  }
  return text;
}

/** 64-hex checksum, normalized to lowercase (Python FileAsset validator). */
export function assertSha256(value: unknown, name: string): string {
  const checksum = assertString(value, name).toLowerCase();
  if (!SHA256_PATTERN.test(checksum)) {
    throw new TypeError(`${name} must contain 64 hexadecimal characters`);
  }
  return checksum;
}

export function assertNonNegativeInt(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return Number(value);
}

export function assertBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${name} must be a boolean`);
  return value;
}

export function assertStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  for (const item of value) assertString(item, `${name} item`);
  return value;
}

/** Optional string that may be null (omitted is treated as null). */
export function assertOptionalString(
  value: unknown,
  name: string,
): string | null {
  if (value === undefined || value === null) return null;
  return assertString(value, name);
}

/** Optional string with Python `Field(min_length=1)` semantics when present. */
export function assertOptionalNonEmptyString(
  value: unknown,
  name: string,
): string | null {
  if (value === undefined || value === null) return null;
  return assertNonEmptyString(value, name);
}


export function assertStringRecord(
  value: unknown,
  name: string,
): Record<string, string[]> {
  const record = assertRecord(value, name);
  const result: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(record)) {
    result[key] = assertStringArray(entry, `${name}.${key}`);
  }
  return result;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item));
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).every((item) =>
      isJsonValue(item),
    );
  }
  return false;
}

export function assertJsonValue(value: unknown, name: string): void {
  if (!isJsonValue(value)) throw new TypeError(`${name} must be a JSON value`);
}

export function assertJsonRecord(
  value: unknown,
  name: string,
): Record<string, JsonValue> {
  const record = assertRecord(value, name);
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (!isJsonValue(entry)) {
      throw new TypeError(`${name}.${key} must be a JSON value`);
    }
    result[key] = entry;
  }
  return result;
}

/**
 * Non-empty POSIX relative path: no backslashes, not absolute, cannot escape
 * its root (Python ``_validate_relative_path``).
 */
export function assertRelativePath(value: unknown, name: string): string {
  const path = assertNonEmptyString(value, name);
  if (path.includes("\\")) {
    throw new TypeError(`${name} must be a POSIX relative path`);
  }
  if (path.startsWith("/") || path.includes("..") || /^[A-Za-z]:[\\/]/.test(path)) {
    throw new TypeError(`${name} must not be absolute or escape its root`);
  }
  return path;
}

/**
 * Versioned contract envelope: ``schema_version`` is optional on input and
 * normalized to "1.0" (Python ContractModel default).
 */
export function parseSchemaVersion(value: Record<string, unknown>): SchemaVersion {
  const raw = value.schema_version;
  if (raw === undefined) return SCHEMA_VERSION;
  if (raw !== SCHEMA_VERSION) {
    throw new TypeError("schema_version must be \"1.0\"");
  }
  return SCHEMA_VERSION;
}

/**
 * Publication shipment version: 1.1 records carry the P7 file-byte receipt
 * (``manifest_sha256``); 1.0 records are pre-P7 migration artifacts that
 * keep the legacy trust level. Version is mandatory on publications.
 */
export type PublicationSchemaVersion = "1.0" | "1.1";

export function parsePublicationSchemaVersion(
  value: Record<string, unknown>,
): PublicationSchemaVersion {
  const raw = value.schema_version;
  if (raw === "1.0" || raw === "1.1") return raw;
  throw new TypeError("publication schema_version must be \"1.0\" or \"1.1\"");
}

/**
 * ISO-8601 datetime string (Python ``datetime`` wire serialization).
 */
const ISO_DATETIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

export function assertIsoDateTime(value: unknown, name: string): string {
  const text = assertString(value, name);
  if (!ISO_DATETIME_PATTERN.test(text) || Number.isNaN(Date.parse(text))) {
    throw new TypeError(`${name} must be an ISO-8601 datetime string`);
  }
  return text;
}

/** Epoch milliseconds for an ISO-8601 datetime (Python datetime comparison). */
export function isoDateTimeMillis(value: string): number {
  return Date.parse(value);
}