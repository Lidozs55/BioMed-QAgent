/**
 * Shared argument parsing helpers for agent tools (deduplicated from
 * ``gdc.ts`` / ``xena.ts``; Python ``*_args`` / ``_get_*`` parity).
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function objectArgument(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError("arguments must be an object");
  return value;
}

export function expectString(record: Record<string, unknown>, field: string, fallback: string): string {
  const value = record[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

export function expectOptionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
  return value;
}

export function expectInt(record: Record<string, unknown>, field: string, fallback: number): number {
  const value = record[field];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`${field} must be an integer`);
  }
  return value;
}