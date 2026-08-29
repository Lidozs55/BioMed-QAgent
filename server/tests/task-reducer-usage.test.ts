import { describe, expect, test } from "vitest";

import type { EventEnvelope, EventPayload } from "@biomed/contracts";

import {
  reduceTaskEvents,
  type DurableTaskMetadata,
} from "../src/runtime/task-reducer.js";

const metadata: DurableTaskMetadata = {
  schema_version: 1,
  task_id: "task-usage",
  mode: "agent",
  databases: [],
  title: "usage",
  created_at: "2026-08-29T00:00:00.000Z",
};

function envelope(sequence: number, payload: EventPayload): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event-${sequence}`,
    type: payload.type,
    task_id: metadata.task_id,
    run_id: "run-1",
    stage_attempt_id: null,
    sequence,
    timestamp: `2026-08-29T00:00:0${sequence}.000Z`,
    payload,
  };
}

function contextUsage(sequence: number, input: number, output: number): EventEnvelope {
  return envelope(sequence, {
    type: "context_usage",
    tokens: input + output,
    context_window: 256_000,
    percent: 1,
    source: "runtime",
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: 100,
      cache_write_tokens: 10,
      total_tokens: input + output,
      reasoning_tokens: 5,
    },
  });
}

describe("task reducer run usage totals", () => {
  test("aggregates provider-reported model usage into the terminal run summary", () => {
    const snapshot = reduceTaskEvents(metadata, [
      envelope(1, { type: "run_queued", request_id: "req-1", input: "go" }),
      envelope(2, { type: "run_started" }),
      contextUsage(3, 1_000, 200),
      contextUsage(4, 2_500, 300),
      envelope(5, { type: "run_completed" }),
    ]);

    expect(snapshot.runs[0]?.summary).toEqual({
      run_status: "completed",
      error_code: null,
      cancelled_at_stage: null,
      user_message: null,
      usage: {
        model_calls: 2,
        input_tokens: 3_500,
        output_tokens: 500,
        cache_read_tokens: 200,
        cache_write_tokens: 20,
        total_tokens: 4_000,
        reasoning_tokens: 10,
      },
    });
  });

  test("attaches usage to failed terminal summaries too", () => {
    const snapshot = reduceTaskEvents(metadata, [
      envelope(1, { type: "run_queued", request_id: "req-1", input: "go" }),
      envelope(2, { type: "run_started" }),
      contextUsage(3, 700, 100),
      envelope(4, { type: "run_failed", error: "boom", error_code: "internal_error" }),
    ]);

    expect(snapshot.runs[0]?.summary?.usage).toEqual({
      model_calls: 1,
      input_tokens: 700,
      output_tokens: 100,
      cache_read_tokens: 100,
      cache_write_tokens: 10,
      total_tokens: 800,
      reasoning_tokens: 5,
    });
  });

  test("keeps the summary usage-free when no provider usage was reported", () => {
    const snapshot = reduceTaskEvents(metadata, [
      envelope(1, { type: "run_queued", request_id: "req-1", input: "go" }),
      envelope(2, { type: "run_started" }),
      envelope(3, {
        type: "context_usage",
        tokens: 500,
        context_window: 256_000,
        percent: 0.2,
        source: "runtime",
      }),
      envelope(4, { type: "run_completed" }),
    ]);

    expect(snapshot.runs[0]?.summary).not.toHaveProperty("usage");
  });
});
