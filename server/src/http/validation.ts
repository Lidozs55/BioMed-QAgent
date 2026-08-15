/**
 * Request-body validation primitives for the application host's native API
 * surface. Unified from ``model-settings.ts`` (asRecord/optionalRecord/
 * requiredString/boundedNumber) so every handler uses one validation layer.
 */
import { HttpError } from "./error.js";

export type JsonObject = Record<string, unknown>;

export function asRecord(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(422, "request body must be an object");
  }
  return value as JsonObject;
}

export function optionalRecord(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(422, `${name} must be a non-empty string`);
  }
  return value.trim();
}

export function boundedNumber(
  value: unknown,
  name: string,
  minimum: number,
  maximum?: number,
): number {
  if (
    typeof value !== "number" || !Number.isFinite(value) || value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new HttpError(422, `${name} is outside the supported range`);
  }
  return value;
}