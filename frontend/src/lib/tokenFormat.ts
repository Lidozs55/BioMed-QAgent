/**
 * Token count unit display — the single source of truth for the whole app.
 *
 * All token counts are displayed in base-10 units (K = 1,000, M = 1,000,000),
 * matching how model vendors advertise context windows. Components must not
 * inline their own K/M formatting; import from here instead.
 */

/** 1 K tokens (base-10). */
const TOKENS_PER_K = 1_000;
/** 1 M tokens (base-10). */
const TOKENS_PER_M = 1_000_000;

/** Token count unit suffix used by the custom context-window input. */
export type TokenUnit = "B" | "K" | "M";

/** Token count multiplier per unit (base-10). */
export const TOKEN_UNIT_MULTIPLIER: Record<TokenUnit, number> = {
  B: 1,
  K: TOKENS_PER_K,
  M: TOKENS_PER_M,
};

/** Round to at most one decimal place, dropping a trailing ".0" (1 → "1", 1.5 → "1.5"). */
function formatScaled(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Format a raw token count with base-10 K/M units (131_072 → "131.1K", 1_000_000 → "1M"). */
export function formatTokenCount(n: number): string {
  if (n >= TOKENS_PER_M) return `${formatScaled(n / TOKENS_PER_M)}M`;
  if (n >= TOKENS_PER_K) return `${formatScaled(n / TOKENS_PER_K)}K`;
  return String(Math.round(n));
}

/** Format a context window token count, falling back to "未知" for missing/invalid values. */
export function formatContextWindow(tokens: number | null | undefined): string {
  if (!tokens || tokens <= 0) return "未知";
  return formatTokenCount(tokens);
}

/** Decompose a token count into the largest exact base-10 unit (32_000 → "32" + "K"). */
export function decomposeTokenCount(n: number): { num: string; unit: TokenUnit } {
  if (n > 0 && n % TOKENS_PER_M === 0) return { num: String(n / TOKENS_PER_M), unit: "M" };
  if (n > 0 && n % TOKENS_PER_K === 0) return { num: String(n / TOKENS_PER_K), unit: "K" };
  return { num: String(n), unit: "B" };
}
