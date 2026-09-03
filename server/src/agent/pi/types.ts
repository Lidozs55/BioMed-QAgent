/**
 * Public surface types of the Pi adapter package
 * (`server/src/agent/pi/`, re-exported through `../pi-adapter.ts`).
 */

import type { BioMedModelConfig, BioMedSessionConfig } from "../contracts.js";
import type { ProviderSearchResult } from "../search-info-capture.js";

export interface PiUpstreamEvent {
  type: string;
  assistantMessageEvent?: { type: string; delta?: string };
  assistantStopReason?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: boolean;
  reason?: "manual" | "threshold" | "overflow";
  aborted?: boolean;
  errorMessage?: string;
  compactionResult?: {
    summary: string;
    tokensBefore?: number;
    estimatedTokensAfter?: number;
    targetTokens?: number;
    summaryTokens?: number;
  } | undefined;
  contextUsage?: {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  };
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    reasoning?: number;
  };
}

export interface PiUpstreamSession {
  readonly sessionId: string;
  prompt(input: string): Promise<void>;
  resetRunProgress?(): void;
  continueAfterLength?(): Promise<void>;
  steer?(text: string): Promise<void>;
  compact?(): Promise<{ summary: string }>;
  /**
   * Reconcile the session with the currently active product model config.
   * Called before every prompt and before manual compaction so a mid-task
   * model switch (which may change the context window) is always reflected in
   * the Pi model registry, session model, and compaction budgets.
   */
  reconcileConfig?(): Promise<void>;
  /** Current session context usage (token estimate and window percent). */
  contextUsage?(): { tokens: number | null; percent: number | null } | undefined;
  /** Current model budget facts for the run-entry preflight. */
  getBudget?(): { contextWindow: number; maxTokens: number; reserveTokens: number };
  /** Current base system prompt (diagnostics/tests; reflects active tools). */
  getSystemPrompt?(): string;
  getContextUsage?(): {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | undefined;
  subscribe(listener: (event: PiUpstreamEvent) => void): () => void;
  /**
   * Bounded web-search results captured from Bailian's ``search_info`` payload
   * (one callback per model call that performed a platform-side search). The
   * channel stays silent for every other provider and when 联网搜索 is off.
   */
  onSearchInfo?(listener: (results: ProviderSearchResult[]) => void): () => void;
  abort(): Promise<void>;
  dispose(): void;
}

export interface PiAgentAdapterOptions {
  createUpstreamSession?: (
    config: BioMedSessionConfig,
  ) => Promise<PiUpstreamSession>;
  resolveModel?: () => Promise<BioMedModelConfig>;
  phase1SkillRoot?: string;
  /** Repository source trees the session read tool may additionally open. */
  phase1CodeReadRoots?: readonly string[];
  onResourceDiagnostic?: (message: string) => void;
}
