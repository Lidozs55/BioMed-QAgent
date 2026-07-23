/* ------------------------------------------------------------------ */
/*  Pure helpers for context-budget arithmetic — frontend mirrors      */
/*  backend ceil() and validation rules. Backend response remains      */
/*  authoritative; these provide immediate UI guidance.                */
/* ------------------------------------------------------------------ */

import type { DraftSource } from "@/hooks/settingsContracts";

/**
 * Compute safety reserve tokens: max(16_384, ceil(context_window * ratio)).
 */
export function computeSafetyReserveTokens(
  contextWindow: number,
  ratio: number,
): number {
  return Math.max(16_384, Math.ceil(contextWindow * ratio));
}

/**
 * Compute available input tokens: context_window - max_output_tokens - safety_reserve_tokens.
 * Returns the exact signed arithmetic result (negative when capacity is exceeded).
 * Callers validate positivity at the validation layer.
 */
export function computeInputCapacity(
  contextWindow: number,
  maxOutputTokens: number,
  safetyReserveTokens: number,
): number {
  return contextWindow - maxOutputTokens - safetyReserveTokens;
}

/** Validate safety_reserve_ratio: 0 <= value <= 0.25 */
export function isSafetyReserveRatioValid(value: number): boolean {
  return value >= 0 && value <= 0.25;
}

/** Validate compaction ratios: 0 < target < trigger < 1 */
export function isCompactionRatioValid(
  target: number,
  trigger: number,
): boolean {
  return target > 0 && trigger > target && trigger < 1;
}

/** Validate context_window is a positive safe integer */
export function isContextWindowPositive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Parse a context-window override string: returns NaN for invalid.
 * Blank or "0" means "use catalog/saved" (returned as 0).
 */
export function parseOverrideWindow(raw: string | undefined | null): number {
  if (raw === null || raw === undefined) return 0;
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "0") return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return NaN;
  if (!Number.isSafeInteger(n)) return NaN;
  if (n <= 0) return NaN;
  return n;
}

/** Validate positive safe integer */
export function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

export interface EffectiveBudget {
  contextWindow: number;
  source: DraftSource;
  safetyReserveTokens: number;
  availableInputTokens: number;
  budgetValid: boolean;
  budgetErrors: string[];
}

/**
 * Derive effective budget from saved/catalog settings + draft values.
 * catalogKnown=true means a model is selected from fetched results.
 * When a model IS selected but has context_window=0 (API-only),
 * the source is "unknown" and override is required.
 * Catalog selection with positive window takes priority;
 * override always takes priority over catalog.
 * contextWindowOverrideStr is a string draft; parse with parseOverrideWindow.
 */
export function deriveEffectiveBudget(
  savedWindow: number,
  savedSource: "catalog" | "user" | "unknown",
  catalogWindow: number,
  selectionKnown: boolean, // true when a model was actually selected (catalog or API-only)
  draftMaxTokens: number,
  safetyReserveRatio: number,
  compactionTargetRatio: number,
  compactionTriggerRatio: number,
  contextWindowOverrideStr: string,
): EffectiveBudget {
  const overrideParsed = parseOverrideWindow(contextWindowOverrideStr);
  // Override always wins
  if (overrideParsed > 0) {
    const w = overrideParsed;
    const safety = computeSafetyReserveTokens(w, safetyReserveRatio);
    const avail = computeInputCapacity(w, draftMaxTokens, safety);
    const v = isBudgetValid(w, draftMaxTokens, safetyReserveRatio, compactionTargetRatio, compactionTriggerRatio);
    return { contextWindow: w, source: "user" as const, safetyReserveTokens: safety, availableInputTokens: avail, budgetValid: v.valid, budgetErrors: v.errors };
  }

  // A model IS selected from fetched results (catalog or API-only)
  if (selectionKnown) {
    if (catalogWindow <= 0) {
      const v = isBudgetValid(0, draftMaxTokens, safetyReserveRatio, compactionTargetRatio, compactionTriggerRatio);
      return { contextWindow: 0, source: "unknown" as const, safetyReserveTokens: 0, availableInputTokens: 0, budgetValid: v.valid, budgetErrors: v.errors };
    }
    const w = catalogWindow;
    const safety = computeSafetyReserveTokens(w, safetyReserveRatio);
    const avail = computeInputCapacity(w, draftMaxTokens, safety);
    const v = isBudgetValid(w, draftMaxTokens, safetyReserveRatio, compactionTargetRatio, compactionTriggerRatio);
    return { contextWindow: w, source: "catalog" as const, safetyReserveTokens: safety, availableInputTokens: avail, budgetValid: v.valid, budgetErrors: v.errors };
  }

  // No model selected — fall back to saved
  if (savedSource === "unknown") {
    const v = isBudgetValid(0, draftMaxTokens, safetyReserveRatio, compactionTargetRatio, compactionTriggerRatio);
    return { contextWindow: 0, source: "unknown", safetyReserveTokens: 0, availableInputTokens: 0, budgetValid: v.valid, budgetErrors: v.errors };
  }
  const w = savedWindow > 0 ? savedWindow : 0;
  const safety = computeSafetyReserveTokens(w, safetyReserveRatio);
  const avail = computeInputCapacity(w, draftMaxTokens, safety);
  const v = isBudgetValid(w, draftMaxTokens, safetyReserveRatio, compactionTargetRatio, compactionTriggerRatio);
  return { contextWindow: w, source: savedSource, safetyReserveTokens: safety, availableInputTokens: avail, budgetValid: v.valid, budgetErrors: v.errors };
}

/** Validate entire budget: capacity must be positive */
export function isBudgetValid(
  contextWindow: number,
  maxOutputTokens: number,
  safetyReserveRatio: number,
  compactionTargetRatio: number,
  compactionTriggerRatio: number,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!isContextWindowPositive(contextWindow)) {
    errors.push("context_window must be positive");
  }
  if (!isPositiveSafeInteger(maxOutputTokens)) {
    errors.push("max_tokens must be a positive integer");
  }
  if (!isSafetyReserveRatioValid(safetyReserveRatio)) {
    errors.push("safety_reserve_ratio must be between 0 and 0.25");
  }
  if (!isCompactionRatioValid(compactionTargetRatio, compactionTriggerRatio)) {
    errors.push("compaction ratios must satisfy 0 < target < trigger < 1");
  }

  if (errors.length === 0) {
    const reserve = computeSafetyReserveTokens(contextWindow, safetyReserveRatio);
    const capacity = computeInputCapacity(contextWindow, maxOutputTokens, reserve);
    if (capacity <= 0) {
      errors.push("input_capacity would be non-positive; reduce output tokens or safety reserve");
    }
  }

  return { valid: errors.length === 0, errors };
}
