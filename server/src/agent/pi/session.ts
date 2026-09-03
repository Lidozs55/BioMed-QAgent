/**
 * ``PiBioMedAgentSession`` — the durable BioMed agent session wrapping one
 * upstream Pi session: turn lifecycle (queue + coalesced deltas), upstream
 * event → BioMed event mapping, length-continuation stall guards, steering,
 * manual compaction, and disposal.
 */

import {
  BioMedAgentError,
  type BioMedAgentEvent,
  type BioMedAgentSession,
  type BioMedSessionBudget,
  type BioMedSessionConfig,
  type RunOptions,
} from "../contracts.js";
import type { ProviderSearchResult } from "../search-info-capture.js";
import {
  boundedText,
  boundedValue,
  MAX_STALLED_LENGTH_CONTINUATIONS,
  MAX_TEXT,
  MIN_PROGRESS_CHARS,
} from "./bounded.js";
import type { PiUpstreamEvent, PiUpstreamSession } from "./types.js";

const DELTA_FLUSH_INTERVAL_MS = 32;

interface QueueItem {
  event?: BioMedAgentEvent;
  error?: BioMedAgentError;
  done?: true;
  barrier?: () => void;
}

class EventQueue {
  private readonly values: QueueItem[] = [];
  private readonly waiters: Array<(item: QueueItem) => void> = [];

  push(item: QueueItem): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(item);
    else waiter(item);
  }

  next(): Promise<QueueItem> {
    const item = this.values.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

interface ActiveTurn {
  queue: EventQueue;
  cancelled: boolean;
  terminal: boolean;
  reason?: string;
  reasoningChars: number;
  assistantChars: number;
  toolEvents: number;
  lengthContinuationStalls: number;
  pendingDelta?: Extract<
    BioMedAgentEvent,
    { type: "assistant_delta" | "reasoning_delta" }
  >;
  deltaTimer?: ReturnType<typeof setTimeout>;
  assistantStopReason?: string;
}

export class PiBioMedAgentSession implements BioMedAgentSession {
  readonly piSessionId: string;
  readonly taskId: string;
  readonly runId: string;
  private activeTurn?: ActiveTurn;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeSearchInfo: () => void;
  private disposePromise?: Promise<void>;
  private readonly cleanup?: () => Promise<void>;
  private readonly getCurrentPublicationId?: () => string | null;

  constructor(
    private readonly upstream: PiUpstreamSession,
    config: BioMedSessionConfig,
  ) {
    this.piSessionId = upstream.sessionId;
    this.taskId = config.taskId;
    this.runId = config.runId;
    this.cleanup = config.cleanup;
    this.getCurrentPublicationId = config.getCurrentPublicationId;
    this.unsubscribe = upstream.subscribe((event) => this.handleEvent(event));
    this.unsubscribeSearchInfo = upstream.onSearchInfo?.((results) => {
      this.pushSearchInfo(results);
    }) ?? (() => {});
  }

  getBudget(): BioMedSessionBudget | null {
    return this.upstream.getBudget?.() ?? null;
  }

  /** Base system prompt of the underlying Pi session (diagnostics, tests). */
  systemPrompt(): string | null {
    return this.upstream.getSystemPrompt?.() ?? null;
  }

  /**
   * Forward one model call's captured web-search hits into the active turn.
   * The capture resolves asynchronously from the response mirror, so on a
   * turn that already finished the (rare) trailing batch is dropped.
   */
  private pushSearchInfo(results: ProviderSearchResult[]): void {
    const active = this.activeTurn;
    if (active === undefined || active.terminal || results.length === 0) return;
    this.pushBoundary(active, {
      event: { type: "provider_search_info", results },
    });
  }

  private handleEvent(event: PiUpstreamEvent): void {
    const active = this.activeTurn;
    if (active === undefined || active.terminal) return;
    const common = {
      toolCallId: boundedText(event.toolCallId ?? "unknown"),
      toolName: boundedText(event.toolName ?? "unknown"),
    };
    if (event.type === "message_update") {
      const message = event.assistantMessageEvent;
      if (message?.type === "text_delta" && message.delta !== undefined) {
        this.queueDelta(active, "assistant_delta", message.delta);
      } else if (message?.type === "thinking_delta" && message.delta !== undefined) {
        this.queueDelta(active, "reasoning_delta", message.delta);
      }
    } else if (event.type === "tool_execution_start") {
      active.toolEvents += 1;
      this.pushBoundary(active, {
        event: {
          type: "tool_started",
          ...common,
          arguments: boundedValue(event.args),
        },
      });
    } else if (event.type === "tool_execution_update") {
      this.pushBoundary(active, {
        event: {
          type: "tool_progress",
          ...common,
          result: boundedValue(event.partialResult),
        },
      });
    } else if (event.type === "tool_execution_end") {
      active.toolEvents += 1;
      this.pushBoundary(active, {
        event: {
          type: "tool_completed",
          ...common,
          result: boundedValue(event.result),
          isError: event.isError === true,
        },
      });
    } else if (event.type === "compaction_end") {
      const result = event.compactionResult;
      if (
        event.aborted !== true &&
        result !== undefined &&
        result.summary.trim() !== ""
      ) {
        const summary = result.summary;
        this.pushBoundary(active, {
          event: {
            type: "context_compacted",
            summary,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
            ...(result.tokensBefore === undefined
              ? {}
              : { tokensBefore: result.tokensBefore }),
            ...(result.estimatedTokensAfter === undefined
              ? {}
              : { estimatedTokensAfter: result.estimatedTokensAfter }),
            ...(result.targetTokens === undefined
              ? {}
              : { targetTokens: result.targetTokens }),
            ...(result.summaryTokens === undefined
              ? {}
              : { summaryTokens: result.summaryTokens }),
          },
        });
        const didNotReduce =
          result.tokensBefore !== undefined &&
          result.estimatedTokensAfter !== undefined &&
          result.estimatedTokensAfter >= result.tokensBefore;
        const missedTarget =
          result.targetTokens !== undefined &&
          result.estimatedTokensAfter !== undefined &&
          result.estimatedTokensAfter > result.targetTokens;
        if (didNotReduce || missedTarget) {
          // Once the run has emitted its immutable publication, the closing
          // turn cannot contribute further work: land it gracefully instead
          // of failing the run, so publication registration and supervisor
          // closure survive post-publication context exhaustion.
          if ((this.getCurrentPublicationId?.() ?? null) !== null) {
            this.finish(active, { event: { type: "turn_completed" } });
            return;
          }
          this.finish(active, {
            error: new BioMedAgentError(
              "CONTEXT_COMPACTION_INEFFECTIVE",
              "Context compaction did not reduce the estimated context",
            ),
          });
          return;
        }
      }
      if (event.contextUsage !== undefined) {
        this.pushBoundary(active, {
          event: {
            type: "context_usage",
            tokens: event.contextUsage.tokens,
            contextWindow: event.contextUsage.contextWindow,
            percent: event.contextUsage.percent,
            source: "runtime",
            ...(event.usage === undefined ? {} : { usage: event.usage }),
          },
        });
      }
    } else if (event.type === "message_end" && event.assistantStopReason !== undefined) {
      active.assistantStopReason = event.assistantStopReason;
      if (event.contextUsage !== undefined) {
        this.pushBoundary(active, {
          event: {
            type: "context_usage",
            tokens: event.contextUsage.tokens,
            contextWindow: event.contextUsage.contextWindow,
            percent: event.contextUsage.percent,
            source: "runtime",
            ...(event.usage === undefined ? {} : { usage: event.usage }),
          },
        });
      }
    }
  }

  private async promptUntilComplete(active: ActiveTurn, input: string): Promise<void> {
    active.assistantStopReason = undefined;
    await this.upstream.prompt(input);
    while (!active.cancelled && active.assistantStopReason === "length") {
      if (this.upstream.continueAfterLength === undefined) {
        throw new Error("Pi runtime cannot continue a length-truncated turn");
      }
      const beforeReasoning = active.reasoningChars;
      const beforeAssistant = active.assistantChars;
      const beforeTools = active.toolEvents;
      active.assistantStopReason = undefined;
      await this.upstream.continueAfterLength();
      const madeProgress =
        active.assistantChars > beforeAssistant ||
        active.reasoningChars - beforeReasoning >= MIN_PROGRESS_CHARS ||
        active.toolEvents > beforeTools;
      if (!madeProgress) {
        active.lengthContinuationStalls += 1;
        if (active.lengthContinuationStalls >= MAX_STALLED_LENGTH_CONTINUATIONS) {
          throw new Error("Pi runtime length continuation made no meaningful progress");
        }
      } else {
        active.lengthContinuationStalls = 0;
      }
    }
    if (!active.cancelled && active.assistantStopReason === "error") {
      throw new Error("Pi runtime ended with an upstream error");
    }
  }

  private queueDelta(
    active: ActiveTurn,
    type: "assistant_delta" | "reasoning_delta",
    rawDelta: string,
  ): void {
    const delta = boundedText(rawDelta);
    if (type === "reasoning_delta") {
      active.reasoningChars += delta.length;
    } else {
      active.assistantChars += delta.length;
    }
    const pending = active.pendingDelta;
    if (
      pending !== undefined &&
      (pending.type !== type || pending.delta.length + delta.length > MAX_TEXT)
    ) {
      this.flushPendingDelta(active);
    }
    if (active.pendingDelta === undefined) {
      active.pendingDelta = { type, delta };
      active.deltaTimer = setTimeout(
        () => this.flushPendingDelta(active),
        DELTA_FLUSH_INTERVAL_MS,
      );
      return;
    }
    active.pendingDelta = {
      ...active.pendingDelta,
      delta: `${active.pendingDelta.delta}${delta}`,
    };
  }

  private flushPendingDelta(active: ActiveTurn): void {
    if (active.deltaTimer !== undefined) {
      clearTimeout(active.deltaTimer);
      active.deltaTimer = undefined;
    }
    const pending = active.pendingDelta;
    active.pendingDelta = undefined;
    if (pending !== undefined) active.queue.push({ event: pending });
  }

  private pushBoundary(active: ActiveTurn, item: QueueItem): void {
    this.flushPendingDelta(active);
    active.queue.push(item);
  }

  private finish(active: ActiveTurn, item: QueueItem): void {
    if (active.terminal) return;
    this.flushPendingDelta(active);
    active.terminal = true;
    active.queue.push(item);
    active.queue.push({ done: true });
  }

  async *run(input: string, options: RunOptions = {}): AsyncIterable<BioMedAgentEvent> {
    if (this.disposePromise !== undefined) {
      throw new BioMedAgentError("SESSION_DISPOSED", "Agent session is disposed");
    }
    if (this.activeTurn !== undefined) {
      throw new BioMedAgentError("SESSION_BUSY", "Agent session already has an active turn");
    }
    if (input.trim() === "") {
      throw new BioMedAgentError(
        "INVALID_SESSION_CONFIG",
        "Agent input must not be empty",
      );
    }
    await this.upstream.reconcileConfig?.();
    const active: ActiveTurn = {
      queue: new EventQueue(),
      cancelled: false,
      terminal: false,
      reasoningChars: 0,
      assistantChars: 0,
      toolEvents: 0,
      lengthContinuationStalls: 0,
    };
    this.activeTurn = active;
    const onAbort = (): void => {
      void this.cancel("aborted").catch(() => undefined);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    active.queue.push({ event: { type: "turn_started" } });
    void this.promptUntilComplete(active, input).then(
      () => {
        if (!active.cancelled) {
          this.finish(active, { event: { type: "turn_completed" } });
        }
      },
      (error: unknown) => {
        if (!active.cancelled) {
          this.finish(active, {
            error: new BioMedAgentError(
              "UPSTREAM_FAILURE",
              "Agent runtime request failed",
              { cause: error },
            ),
          });
        }
      },
    );
    try {
      while (true) {
        const item = await active.queue.next();
        if (item.error !== undefined) throw item.error;
        if (item.done === true) break;
        if (item.barrier !== undefined) {
          item.barrier();
          continue;
        }
        if (item.event !== undefined) yield item.event;
      }
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (!active.terminal) {
        active.cancelled = true;
        await this.upstream.abort();
        active.terminal = true;
        if (active.deltaTimer !== undefined) clearTimeout(active.deltaTimer);
        active.deltaTimer = undefined;
        active.pendingDelta = undefined;
      }
      if (this.activeTurn === active) this.activeTurn = undefined;
    }
  }

  async cancel(reason?: string): Promise<void> {
    const active = this.activeTurn;
    if (active === undefined || active.terminal) return;
    active.cancelled = true;
    active.reason = reason;
    try {
      await this.upstream.abort();
    } catch (error) {
      const failure = new BioMedAgentError(
        "UPSTREAM_FAILURE",
        "Agent runtime cancellation failed",
        { cause: error },
      );
      this.finish(active, { error: failure });
      throw failure;
    }
    this.finish(active, {
      event: reason === undefined
        ? { type: "turn_cancelled" }
        : { type: "turn_cancelled", reason: boundedText(reason) },
    });
  }

  resetRunProgress(): void {
    this.upstream.resetRunProgress?.();
  }

  async steer(text: string): Promise<void> {
    const active = this.activeTurn;
    if (active === undefined || active.terminal) {
      throw new BioMedAgentError("SESSION_BUSY", "Agent session has no active turn to steer");
    }
    if (this.upstream.steer === undefined) {
      throw new BioMedAgentError("UPSTREAM_FAILURE", "Agent runtime does not support steering");
    }
    // The realtime stream can be ahead of the coalesced durable event stream.
    // Flush and wait until the run consumer has processed every earlier event
    // before accepting the new user turn, so run_steered receives a sequence
    // after the text the user already saw.
    this.flushPendingDelta(active);
    await new Promise<void>((resolve) => active.queue.push({ barrier: resolve }));
    await this.upstream.steer(text);
  }

  async compact(): Promise<{ summary: string }> {
    await this.upstream.reconcileConfig?.();
    if (this.upstream.compact === undefined) {
      throw new BioMedAgentError("UPSTREAM_FAILURE", "Agent runtime does not support compaction");
    }
    return this.upstream.compact();
  }

  dispose(): Promise<void> {
    this.disposePromise ??= (async () => {
      try {
        await this.cancel("session disposed");
      } finally {
        try {
          this.unsubscribe();
          this.unsubscribeSearchInfo();
          this.upstream.dispose();
        } finally {
          await this.cleanup?.();
        }
      }
    })();
    return this.disposePromise;
  }
}
