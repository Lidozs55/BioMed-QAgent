import type { TaskProjection } from "@/runtime/types";

/**
 * Best-effort persistence of fully hydrated task projections so that
 * reopening a historical conversation renders instantly instead of replaying
 * the whole event log. The cached projection is always reconciled against an
 * authoritative snapshot and the event delta after ``lastSequence``, so stale
 * caches self-heal and never bypass deduplication.
 */

// Version 1 could persist user-message timeline positions derived from message
// ordinals. Those positions cannot be reconciled when the cache already covers
// the snapshot watermark, so force one authoritative event replay after the
// timeline switched to stable event-sequence ordering.
const CACHE_VERSION = 2;
const LEGACY_CACHE_VERSIONS = [1] as const;
const KEY_PREFIX = "biomed-qagent:task-projection:v";
const MAX_CACHE_CHARS = 4 * 1024 * 1024;

function cacheKey(taskId: string): string {
  return `${KEY_PREFIX}${CACHE_VERSION}:${taskId}`;
}

function clearLegacyTaskProjections(taskId: string): void {
  for (const version of LEGACY_CACHE_VERSIONS) {
    localStorage.removeItem(`${KEY_PREFIX}${version}:${taskId}`);
  }
}

function isUsableProjection(value: unknown, taskId: string): value is TaskProjection {
  if (typeof value !== "object" || value === null) return false;
  const projection = value as Record<string, unknown>;
  return (
    typeof projection.lastSequence === "number" &&
    projection.lastSequence >= 0 &&
    Array.isArray(projection.items) &&
    projection.hydration === "snapshot" &&
    typeof projection.summary === "object" &&
    projection.summary !== null &&
    Reflect.get(projection.summary, "task_id") === taskId
  );
}

export function loadTaskProjection(taskId: string): TaskProjection | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(cacheKey(taskId));
    if (raw === null) {
      clearLegacyTaskProjections(taskId);
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isUsableProjection(parsed, taskId)) {
      localStorage.removeItem(cacheKey(taskId));
      return null;
    }
    return {
      ...parsed,
      hydration: "snapshot",
      sequenceGap: null,
    };
  } catch {
    try {
      localStorage.removeItem(cacheKey(taskId));
    } catch {
      // Ignore storage failures during cleanup.
    }
    return null;
  }
}

export function saveTaskProjection(task: TaskProjection): void {
  if (typeof localStorage === "undefined") return;
  try {
    const serialized: TaskProjection = {
      ...task,
      hydration: "snapshot",
      sequenceGap: null,
    };
    const raw = JSON.stringify(serialized);
    if (raw.length > MAX_CACHE_CHARS) return;
    localStorage.setItem(cacheKey(task.summary.task_id), raw);
  } catch {
    // Quota exceeded or storage unavailable: the cache is best-effort only.
  }
}

export function clearTaskProjection(taskId: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.removeItem(cacheKey(taskId));
    clearLegacyTaskProjections(taskId);
  } catch {
    // Best-effort cleanup.
  }
}
