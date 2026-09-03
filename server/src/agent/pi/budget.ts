/**
 * Compaction budgets, retry policy, session-reconfiguration checks, and
 * recoverable-failure classification for the Pi adapter. Pure config math —
 * no Pi imports; the upstream-session factory applies these to Pi settings.
 */

import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL_RETRY_POLICY,
  DEFAULT_SAFETY_RESERVE_RATIO,
  type ModelRetryPolicy,
} from "@biomed/contracts";

import type {
  BioMedModelConfig,
  BioMedSessionBudget,
} from "../contracts.js";

/** Minimum recent context kept after compaction, as a fraction of the window. */
const MIN_KEEP_RATIO = 0.05;
/** Maximum final compaction target, as a fraction of the window. */
const MAX_KEEP_RATIO = 0.6;
/** Fraction of the Pi reserve budget available to the compaction summary. */
const SUMMARY_BUDGET_RATIO = 0.8;
/** Manual compaction keeps only a tiny recent tail so Pi always has older content to summarize. */
const MANUAL_KEEP_RECENT_RATIO = 0.01;

/**
 * Translate product-level compaction ratios onto Pi's absolute compaction
 * settings. Pi compacts when context tokens exceed
 * ``contextWindow - reserveTokens`` and keeps approximately
 * ``keepRecentTokens`` tokens from the end of the conversation.
 */
export function resolvePiCompactionTargetTokens(
  contextWindow: number,
  targetRatio: number,
  currentTokens?: number | null,
): number {
  const floorKeep = Math.round(contextWindow * MIN_KEEP_RATIO);
  const capKeep = Math.round(contextWindow * MAX_KEEP_RATIO);
  const hasKnownUsage = currentTokens !== null &&
    currentTokens !== undefined &&
    Number.isFinite(currentTokens) &&
    currentTokens > 0;
  const desiredTarget = hasKnownUsage
    ? Math.round(currentTokens * targetRatio)
    : Math.round(contextWindow * targetRatio);
  return Math.min(Math.max(desiredTarget, floorKeep), capKeep);
}

export function resolvePiCompactionOverrides(
  contextWindow: number,
  triggerRatio: number,
  targetRatio: number,
  currentTokens?: number | null,
): { compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number } } {
  const reserveTokens = Math.max(0, Math.round(contextWindow * (1 - triggerRatio)));
  // Pi caps the compaction summary at 80% of the reserve budget; pre-reserve
  // that headroom so a dense summary never displaces the recent context.
  const summaryBudget = Math.round(SUMMARY_BUDGET_RATIO * reserveTokens);
  const hasKnownUsage = currentTokens !== null &&
    currentTokens !== undefined &&
    Number.isFinite(currentTokens) &&
    currentTokens > 0;
  const finalTarget = resolvePiCompactionTargetTokens(
    contextWindow,
    targetRatio,
    currentTokens,
  );
  const floorKeep = Math.round(contextWindow * MIN_KEEP_RATIO);
  const desiredKeep = Math.max(floorKeep, finalTarget - summaryBudget);
  const keptRecent = Math.min(
    desiredKeep,
    Math.max(0, contextWindow - reserveTokens),
  );
  // When the whole conversation already fits under the final target, Pi would
  // keep everything anyway; leave its settings in the no-op range.
  const effectiveKeep = hasKnownUsage && currentTokens <= finalTarget
    ? Math.max(currentTokens, keptRecent)
    : keptRecent;
  return {
    compaction: {
      enabled: true,
      reserveTokens,
      keepRecentTokens: effectiveKeep,
    },
  };
}

/**
 * Manual compaction forces a small recent tail even when the automatic keep
 * budget would leave Pi with zero messages to summarize below the threshold.
 */
export function resolveManualPiCompactionOverrides(
  contextWindow: number,
  triggerRatio: number,
  targetRatio: number,
  currentTokens?: number | null,
): { compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number } } {
  const auto = resolvePiCompactionOverrides(
    contextWindow,
    triggerRatio,
    targetRatio,
    currentTokens,
  );
  const hasKnownUsage = currentTokens !== null &&
    currentTokens !== undefined &&
    Number.isFinite(currentTokens) &&
    currentTokens > 0;
  const keepRecentTokens = hasKnownUsage
    ? Math.max(1, Math.round(currentTokens * MANUAL_KEEP_RECENT_RATIO))
    : 1;
  return {
    compaction: {
      ...auto.compaction,
      keepRecentTokens,
    },
  };
}

/** Model budget facts for the run-entry preflight, derived from config. */
export function resolveSessionBudget(config: BioMedModelConfig): BioMedSessionBudget {
  const contextWindow = config.contextWindow ?? 131_072;
  return {
    contextWindow,
    maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
    reserveTokens: config.safetyReserveTokens
      ?? Math.round(contextWindow * DEFAULT_SAFETY_RESERVE_RATIO),
  };
}

/**
 * Formal dataset runs often span many provider turns. Keep transient 429/5xx
 * failures inside one durable run long enough for a short upstream throttle
 * window to clear, while Pi's retry classifier still fails non-transient
 * errors immediately.
 */
export function resolvePiRetryOverrides(
  policy: ModelRetryPolicy = DEFAULT_MODEL_RETRY_POLICY,
): {
  retry: {
    enabled: true;
    maxRetries: number;
    baseDelayMs: number;
    provider: { maxRetryDelayMs: number };
  };
} {
  return {
    retry: {
      enabled: true,
      maxRetries: policy.providerMaxRetries,
      baseDelayMs: policy.baseDelayMs,
      provider: { maxRetryDelayMs: policy.maxDelayMs },
    },
  };
}

export function isRecoverablePiStreamError(message: string | undefined): boolean {
  return typeof message === "string" && (
    /(?:^|\b)stream_read_error(?:\b|$)/iu.test(message)
    || /^stream error:\s*stream disconnected before completion:\s*stream closed before response\.completed$/iu
      .test(message.trim())
  );
}

export function isRecoverablePiProviderError(message: string | undefined): boolean {
  if (typeof message !== "string") return false;
  const normalized = message.trim();
  return (
    /^429:/u.test(normalized)
    && /(?:upstream rate limit exceeded|rate_limit_error)/iu.test(normalized)
    && !/(?:insufficient_quota|billing|quota exhausted)/iu.test(normalized)
  ) || (
    /^503:/u.test(normalized)
    && /(?:service temporarily unavailable|api_error)/iu.test(normalized)
  );
}

export async function waitForStreamRecovery(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, delayMs);
    const abort = (): void => {
      clearTimeout(timeout);
      resolve(false);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Whether a freshly resolved product config requires re-applying the Pi
 * session model / context window / compaction budgets.
 */
export function shouldReconfigureSession(
  current: BioMedModelConfig,
  next: BioMedModelConfig,
): boolean {
  const windowOf = (config: BioMedModelConfig): number => config.contextWindow ?? 131_072;
  return (
    current.provider !== next.provider ||
    current.modelId !== next.modelId ||
    current.baseUrl !== next.baseUrl ||
    windowOf(current) !== windowOf(next) ||
    current.compactionTriggerRatio !== next.compactionTriggerRatio ||
    current.compactionTargetRatio !== next.compactionTargetRatio
  );
}
