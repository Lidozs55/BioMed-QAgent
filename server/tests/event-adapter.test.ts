import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

import type { BioMedAgentEvent } from "../src/agent/contracts.js";
import { PiEventAdapter } from "../src/agent/event-adapter.js";

const taskId = "task-live-1";
const runId = "run-live-1";

function createAdapter(onDiagnostic = vi.fn()) {
  let id = 0;
  return {
    adapter: new PiEventAdapter({
      taskId,
      onDiagnostic,
      id: () => `event-${++id}`,
      now: () => new Date("2026-08-12T00:00:00.000Z"),
    }),
    onDiagnostic,
  };
}

describe("PiEventAdapter", () => {
  test("maps assistant, reasoning, tool success, and completion in order", () => {
    const { adapter } = createAdapter();
    const source: BioMedAgentEvent[] = [
      { type: "turn_started" },
      { type: "assistant_delta", delta: "hello" },
      { type: "reasoning_delta", delta: "check evidence" },
      {
        type: "tool_started",
        toolCallId: "call-1",
        toolName: "workspace_read",
        arguments: { path: "parsed/data.csv" },
      },
      {
        type: "tool_completed",
        toolCallId: "call-1",
        toolName: "workspace_read",
        result: { rows: 2 },
        isError: false,
      },
      { type: "turn_completed" },
    ];

    const events = source.flatMap((event) => adapter.adapt(runId, event));

    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "assistant_delta",
      "assistant_reasoning_delta",
      "tool_started",
      "tool_called",
      "tool_completed",
      "run_completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(events.every((event) => event.task_id === taskId)).toBe(true);
    expect(events.every((event) => event.run_id === runId)).toBe(true);
    expect(events[3]?.payload).toEqual({
      type: "tool_started",
      tool_call_id: "call-1",
      tool_name: "workspace_read",
      arguments: { path: "parsed/data.csv" },
    });
    expect(events[4]?.payload).toMatchObject({
      type: "tool_called",
      tool_name: "workspace_read",
      arguments: { path: "parsed/data.csv", tool_call_id: "call-1" },
    });
    expect(events[5]?.payload).toEqual({
      type: "tool_completed",
      tool_name: "workspace_read",
      tool_call_id: "call-1",
      output: '{"rows":2}',
      output_digest: null,
      is_error: false,
    });
  });

  test("maps tool errors without failing an otherwise completed turn", () => {
    const { adapter } = createAdapter();
    const events = [
      ...adapter.adapt(runId, {
        type: "tool_completed",
        toolCallId: "call-2",
        toolName: "workspace_exec",
        result: { code: "POLICY_DENIED", message: "not allowed" },
        isError: true,
      }),
      ...adapter.adapt(runId, { type: "turn_completed" }),
    ];

    expect(events.map((event) => event.type)).toEqual([
      "tool_completed",
      "run_completed",
    ]);
    expect(events[0]?.payload).toMatchObject({ is_error: true });
  });

  test("maps context_compacted into a durable conversation_compacted event", () => {
    const { adapter } = createAdapter();
    const summary = "compacted checkpoint summary";

    const events = adapter.adapt(runId, { type: "context_compacted", summary });

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      type: "conversation_compacted",
      compaction_id: expect.any(String),
      covered_through_run_id: runId,
      summary_digest: createHash("sha256").update(summary, "utf8").digest("hex"),
    });
  });

  test("maps runtime context usage into a durable context_usage event", () => {
    const { adapter } = createAdapter();

    const events = adapter.adapt(runId, {
      type: "context_usage",
      tokens: 12_345,
      contextWindow: 131_072,
      percent: 9.41,
      source: "runtime",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      type: "context_usage",
      tokens: 12_345,
      context_window: 131_072,
      percent: 9.41,
      source: "runtime",
    });
  });

  test("carries provider-reported usage into the durable context_usage payload", () => {
    const { adapter } = createAdapter();

    const events = adapter.adapt(runId, {
      type: "context_usage",
      tokens: 40_000,
      contextWindow: 256_000,
      percent: 15.6,
      source: "runtime",
      usage: {
        input: 38_000,
        output: 2_000,
        cacheRead: 30_000,
        cacheWrite: 0,
        totalTokens: 40_000,
        reasoning: 500,
      },
    });

    expect(events[0]?.payload).toEqual({
      type: "context_usage",
      tokens: 40_000,
      context_window: 256_000,
      percent: 15.6,
      source: "runtime",
      usage: {
        input_tokens: 38_000,
        output_tokens: 2_000,
        cache_read_tokens: 30_000,
        cache_write_tokens: 0,
        total_tokens: 40_000,
        reasoning_tokens: 500,
      },
    });
  });

  test("a turn that ended after compaction is not terminal until completeRun", () => {
    const { adapter } = createAdapter();
    const events = [
      ...adapter.adapt(runId, { type: "turn_started" }),
      ...adapter.adapt(runId, { type: "context_compacted", summary: "checkpoint" }),
      ...adapter.adapt(runId, { type: "turn_completed" }),
    ];
    // The compacted turn end emits no terminal event: the runtime resumes the
    // run with a fresh turn instead of terminating it.
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "conversation_compacted",
    ]);
    // A second turn completes normally and is terminal.
    const second = [
      ...adapter.adapt(runId, { type: "turn_started" }),
      ...adapter.adapt(runId, { type: "turn_completed" }),
    ];
    expect(second.map((event) => event.type)).toEqual(["run_started", "run_completed"]);
  });

  test("completeRun forces the terminal run_completed for a compacted run", () => {
    const { adapter } = createAdapter();
    adapter.adapt(runId, { type: "turn_started" });
    adapter.adapt(runId, { type: "context_compacted", summary: "checkpoint" });
    adapter.adapt(runId, { type: "turn_completed" });
    const forced = adapter.completeRun(runId);
    expect(forced.map((event) => event.type)).toEqual(["run_completed"]);
    // Idempotent: a second force emits nothing.
    expect(adapter.completeRun(runId)).toEqual([]);
  });

  test("maps stable failure and cancellation request/ack", () => {
    const { adapter } = createAdapter();
    const request = adapter.cancellationRequested(runId, "user requested");
    const ack = adapter.adapt(runId, {
      type: "turn_cancelled",
      reason: "user requested",
    });
    const failure = adapter.failed("run-live-2", new Error("Bearer secret-value at C:\\private\\trace.ts"));

    expect(request.payload).toEqual({
      type: "run_cancel_requested",
      reason: "user requested",
    });
    expect(ack[0]?.payload).toEqual({
      type: "run_cancelled",
      reason: "user requested",
    });
    expect(failure[0]?.payload).toEqual({
      type: "run_failed",
      error: "Pi turn failed",
      error_code: "internal_error",
    });
    expect(JSON.stringify(failure)).not.toContain("secret-value");
    expect(JSON.stringify(failure)).not.toContain("private");
  });

  test("suppresses duplicate terminal events and ignores unknown input diagnostically", () => {
    const { adapter, onDiagnostic } = createAdapter();
    const first = adapter.adapt(runId, { type: "turn_completed" });
    const duplicate = adapter.adapt(runId, { type: "turn_completed" });
    const unknown = adapter.adapt(
      runId,
      { type: "provider_raw", credential: "secret", payload: "x".repeat(10_000) } as never,
    );

    expect(first).toHaveLength(1);
    expect(duplicate).toEqual([]);
    expect(unknown).toEqual([]);
    expect(onDiagnostic).toHaveBeenCalledOnce();
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toContain("secret");
    expect(JSON.stringify(onDiagnostic.mock.calls).length).toBeLessThan(1_000);
  });

  test("preserves absolute and private paths across streamed event payloads", () => {
    const { adapter } = createAdapter();
    const windowsPath = "C:\\Users\\cheng\\BioMed-QAgent\\server\\src\\agent\\event-adapter.ts";
    const uncPath = "\\\\lab-server\\shared\\datasets\\input.csv";
    const posixPath = "/home/cheng/BioMed-QAgent/data/input.csv";
    const events = [
      ...adapter.adapt(runId, {
        type: "assistant_delta",
        delta: `Read ${windowsPath}`,
      }),
      ...adapter.adapt(runId, {
        type: "reasoning_delta",
        delta: `Compare ${uncPath}`,
      }),
      ...adapter.adapt(runId, {
        type: "tool_started",
        toolCallId: "call-paths",
        toolName: "workspace_read",
        arguments: { path: posixPath },
      }),
      ...adapter.adapt(runId, {
        type: "tool_completed",
        toolCallId: "call-paths",
        toolName: "workspace_read",
        result: { source: windowsPath, mirror: uncPath, output: posixPath },
        isError: false,
      }),
      adapter.cancellationRequested("run-path-cancel", `Stop reading ${posixPath}`),
    ];
    const serialized = JSON.stringify(events);

    expect(serialized).toContain(windowsPath.replaceAll("\\", "\\\\"));
    expect(serialized).toContain(uncPath.replaceAll("\\", "\\\\"));
    expect(serialized).toContain(posixPath);
    expect(serialized).not.toContain("[redacted-path]");
  });

  test("bounds browser payloads and redacts credentials while preserving paths", () => {
    const { adapter } = createAdapter();
    const oversized = "z".repeat(10_000);
    const events = [
      ...adapter.adapt(runId, { type: "assistant_delta", delta: oversized }),
      ...adapter.adapt(runId, {
        type: "tool_started",
        toolCallId: "call-3",
        toolName: "bridge",
        arguments: {
          api_key: "credential-value",
          absolute: "C:\\Users\\private\\secret.txt",
          nested: { one: { two: { three: { four: "hidden" } } } },
          list: Array.from({ length: 40 }, (_, index) => index),
          text: oversized,
        },
      }),
      ...adapter.adapt("run-live-2", { type: "turn_started" }),
    ];
    const serialized = JSON.stringify(events);

    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect((events[0]?.payload as { delta: string }).delta.length).toBeLessThanOrEqual(4_096);
    expect(serialized).not.toContain("credential-value");
    expect(serialized).toContain("C:\\\\Users\\\\private\\\\secret.txt");
    expect(serialized).not.toContain(oversized);
    expect(serialized).toContain("[redacted]");
    expect(serialized).toContain("[truncated]");
  });
});
