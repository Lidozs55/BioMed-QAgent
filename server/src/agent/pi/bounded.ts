/**
 * Bounded-value helpers and shared turn-progress guards for the Pi adapter
 * package. Every value that crosses into the BioMed agent event stream is
 * truncated here so a pathological upstream payload cannot inflate durable
 * events.
 */

import type { PiUpstreamEvent } from "./types.js";

export const MAX_TEXT = 4_096;
const MAX_DEPTH = 3;
const MAX_ITEMS = 20;
// Guard against a pathological length loop: three continuations with almost no
// new assistant/reasoning/tool progress indicate a degenerate configuration.
export const MAX_STALLED_LENGTH_CONTINUATIONS = 3;
export const MIN_PROGRESS_CHARS = 32;

export function boundedText(value: string): string {
  return value.slice(0, MAX_TEXT);
}

export function toModelCallUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  reasoning?: number;
}): PiUpstreamEvent["usage"] {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
  };
}

export function boundedValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return boundedText(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => boundedValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, MAX_ITEMS)
        .map(([key, item]) => [boundedText(key), boundedValue(item, depth + 1)]),
    );
  }
  return String(value).slice(0, MAX_TEXT);
}
