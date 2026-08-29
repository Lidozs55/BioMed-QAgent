import { createHash, randomUUID } from "node:crypto";

import type { EventEnvelope, EventPayload, JsonValue } from "@biomed/contracts";

import { BioMedAgentError, type BioMedAgentEvent } from "./contracts.js";

const MAX_CHUNK_LENGTH = 4_096;
const MAX_ARGUMENT_STRING_LENGTH = 200;
const MAX_OUTPUT_LENGTH = 4_096;
const MAX_DEPTH = 3;
const MAX_ITEMS = 20;
const SENSITIVE_KEY = /api[-_]?key|authorization|bearer|credential|password|secret|token/i;
const BEARER_VALUE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:[\\/][^\s"']+/g;
const UNC_PATH = /\\\\[^\s"']+/g;
const POSIX_PRIVATE_PATH = /\/(?:Users|home|root|private|etc|var|tmp|mnt|opt|srv)\/[^\s"']+/g;

export interface PiEventAdapterDiagnostic {
  code: "unknown_upstream_event" | "unmapped_upstream_event";
  upstreamType: string;
  message: string;
}

export interface PiEventAdapterOptions {
  taskId: string;
  now?: () => Date;
  id?: () => string;
  onDiagnostic?: (diagnostic: PiEventAdapterDiagnostic) => void;
}

function sanitizeText(value: string, limit: number): string {
  return value
    .replace(BEARER_VALUE, "[redacted]")
    .replace(WINDOWS_ABSOLUTE_PATH, "[redacted-path]")
    .replace(UNC_PATH, "[redacted-path]")
    .replace(POSIX_PRIVATE_PATH, "[redacted-path]")
    .slice(0, limit);
}

function sanitizeValue(
  value: unknown,
  depth = 0,
  stringLimit = MAX_ARGUMENT_STRING_LENGTH,
): JsonValue {
  if (typeof value === "string") return sanitizeText(value, stringLimit);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ITEMS)
      .map((item) => sanitizeValue(item, depth + 1, stringLimit));
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [rawKey, item] of Object.entries(value).slice(0, MAX_ITEMS)) {
      const key = sanitizeText(rawKey, MAX_ARGUMENT_STRING_LENGTH);
      result[key] = SENSITIVE_KEY.test(key)
        ? "[redacted]"
        : sanitizeValue(item, depth + 1, stringLimit);
    }
    return result;
  }
  return sanitizeText(String(value), stringLimit);
}

function asArguments(value: unknown): Record<string, JsonValue> {
  const bounded = sanitizeValue(value);
  if (bounded !== null && typeof bounded === "object" && !Array.isArray(bounded)) {
    return bounded;
  }
  return { value: bounded };
}

function serializedOutput(value: unknown): string {
  const bounded = sanitizeValue(value, 0, MAX_ARGUMENT_STRING_LENGTH);
  const serialized = typeof bounded === "string" ? bounded : JSON.stringify(bounded);
  if (serialized.length <= MAX_OUTPUT_LENGTH) return serialized;
  // 超限时把截断文本包成 JSON 字符串字段返回。不得对序列化后的 JSON 再跑
  // 脱敏正则/slice——路径正则会咬坏转义序列、slice 会截断结构,产出非法
  // JSON(前端 toolOutput 解包会因此失败回退原文)。
  return JSON.stringify({
    truncated: true,
    output: serialized.slice(0, MAX_OUTPUT_LENGTH),
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function usageCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function sourceType(event: never): string {
  if (typeof event === "object" && event !== null && "type" in event) {
    const type = Reflect.get(event, "type");
    return typeof type === "string" ? sanitizeText(type, 100) : "unknown";
  }
  return "unknown";
}

export class PiEventAdapter {
  private sequence = 0;
  private readonly terminalRuns = new Set<string>();
  private compactedThisTurn = false;
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(private readonly options: PiEventAdapterOptions) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  adapt(runId: string, event: BioMedAgentEvent): EventEnvelope[] {
    const type = sourceType(event as never);
    if (
      ![
        "turn_started",
        "assistant_delta",
        "reasoning_delta",
        "tool_started",
        "tool_progress",
        "tool_completed",
        "context_compacted",
        "context_usage",
        "turn_cancelled",
        "turn_completed",
      ].includes(type)
    ) {
      this.diagnostic("unknown_upstream_event", type);
      return [];
    }
    if (this.terminalRuns.has(runId)) return [];
    switch (event.type) {
      case "turn_started":
        this.compactedThisTurn = false;
        return [this.envelope(runId, { type: "run_started" })];
      case "assistant_delta":
        return [
          this.envelope(runId, {
            type: "assistant_delta",
            delta: sanitizeText(event.delta, MAX_CHUNK_LENGTH),
          }),
        ];
      case "reasoning_delta":
        return [
          this.envelope(runId, {
            type: "assistant_reasoning_delta",
            delta: sanitizeText(event.delta, MAX_CHUNK_LENGTH),
          }),
        ];
      case "tool_started": {
        const argumentsValue = asArguments(event.arguments);
        return [
          this.envelope(runId, {
            type: "tool_started",
            tool_call_id: sanitizeText(event.toolCallId, MAX_ARGUMENT_STRING_LENGTH),
            tool_name: sanitizeText(event.toolName, MAX_ARGUMENT_STRING_LENGTH),
            arguments: argumentsValue,
          }),
          this.envelope(runId, {
            type: "tool_called",
            tool_name: sanitizeText(event.toolName, MAX_ARGUMENT_STRING_LENGTH),
            arguments_digest: digest(argumentsValue),
            arguments: {
              ...argumentsValue,
              tool_call_id: sanitizeText(
                event.toolCallId,
                MAX_ARGUMENT_STRING_LENGTH,
              ),
            },
          }),
        ];
      }
      case "tool_completed":
        return [
          this.envelope(runId, {
            type: "tool_completed",
            tool_name: sanitizeText(event.toolName, MAX_ARGUMENT_STRING_LENGTH),
            output_digest: null,
            tool_call_id: sanitizeText(event.toolCallId, MAX_ARGUMENT_STRING_LENGTH),
            output: serializedOutput(event.result),
            is_error: event.isError,
          }),
        ];
      case "context_compacted":
        this.compactedThisTurn = true;
        return [
          this.envelope(runId, {
            type: "conversation_compacted",
            compaction_id: randomUUID(),
            covered_through_run_id: runId,
            summary_digest: createHash("sha256").update(event.summary, "utf8").digest("hex"),
            ...(event.reason === undefined ? {} : { reason: event.reason }),
            ...(event.tokensBefore === undefined
              ? {}
              : { tokens_before: event.tokensBefore }),
            ...(event.estimatedTokensAfter === undefined
              ? {}
              : { estimated_tokens_after: event.estimatedTokensAfter }),
            ...(event.targetTokens === undefined
              ? {}
              : { target_tokens: event.targetTokens }),
            ...(event.summaryTokens === undefined
              ? {}
              : { summary_tokens: event.summaryTokens }),
          }),
        ];
      case "context_usage":
        return [
          this.envelope(runId, {
            type: "context_usage",
            tokens: event.tokens,
            context_window: event.contextWindow,
            percent: event.percent,
            source: event.source,
            ...(event.usage === undefined
              ? {}
              : {
                  usage: {
                    input_tokens: usageCount(event.usage.input),
                    output_tokens: usageCount(event.usage.output),
                    cache_read_tokens: usageCount(event.usage.cacheRead),
                    cache_write_tokens: usageCount(event.usage.cacheWrite),
                    total_tokens: usageCount(event.usage.totalTokens),
                    ...(event.usage.reasoning === undefined
                      ? {}
                      : { reasoning_tokens: usageCount(event.usage.reasoning) }),
                  },
                }),
          }),
        ];
      case "turn_cancelled":
        return this.terminal(runId, {
          type: "run_cancelled",
          reason:
            event.reason === undefined
              ? null
              : sanitizeText(event.reason, MAX_ARGUMENT_STRING_LENGTH),
        });
      case "turn_completed":
        // Pi's threshold compaction ends the turn without auto-continue; the
        // runtime resumes with a fresh turn, so a compacted turn end is not
        // terminal. The runtime forces the terminal event via completeRun.
        if (this.compactedThisTurn) return [];
        return this.terminal(runId, { type: "run_completed" });
      case "tool_progress":
        this.diagnostic("unmapped_upstream_event", event.type);
        return [];
      default:
        return [];
    }
  }

  cancellationRequested(runId: string, reason?: string): EventEnvelope {
    return this.envelope(runId, {
      type: "run_cancel_requested",
      reason:
        reason === undefined
          ? null
          : sanitizeText(reason, MAX_ARGUMENT_STRING_LENGTH),
    });
  }

  /**
   * Force a terminal ``run_completed`` for a run whose last turn ended after
   * a compaction (the runtime stops resuming it). Idempotent: a run that is
   * already terminal emits nothing.
   */
  completeRun(runId: string): EventEnvelope[] {
    return this.terminal(runId, { type: "run_completed" });
  }

  failed(runId: string, error: unknown): EventEnvelope[] {
    if (
      error instanceof BioMedAgentError &&
      error.code === "CONTEXT_COMPACTION_INEFFECTIVE"
    ) {
      return this.terminal(runId, {
        type: "run_failed",
        error: "Context compaction did not reduce the estimated context",
        error_code: "internal_error",
      });
    }
    return this.terminal(runId, {
      type: "run_failed",
      error: "Pi turn failed",
      error_code: "internal_error",
    });
  }

  private terminal(runId: string, payload: EventPayload): EventEnvelope[] {
    if (this.terminalRuns.has(runId)) return [];
    this.terminalRuns.add(runId);
    return [this.envelope(runId, payload)];
  }

  private envelope(runId: string, payload: EventPayload): EventEnvelope {
    return {
      schema_version: "2.0",
      event_id: this.id(),
      type: payload.type,
      task_id: this.options.taskId,
      run_id: runId,
      stage_attempt_id: null,
      sequence: ++this.sequence,
      timestamp: this.now().toISOString(),
      payload,
    };
  }

  private diagnostic(
    code: PiEventAdapterDiagnostic["code"],
    upstreamType: string,
  ): void {
    this.options.onDiagnostic?.({
      code,
      upstreamType: sanitizeText(upstreamType, 100),
      message: "Pi event was ignored",
    });
  }
}
