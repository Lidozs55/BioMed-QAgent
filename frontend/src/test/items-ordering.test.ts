import { describe, expect, it } from "vitest";

import type {
  EventEnvelope,
  EventPayload,
  TaskSummary,
} from "@/runtime/contracts";
import {
  createInitialRuntimeState,
  mergeTaskPage,
  reduceRuntimeEvent,
} from "@/runtime/reducer";

const CREATED_AT = "2026-07-14T00:00:00Z";

function summary(
  taskId: string,
  status: TaskSummary["status"] = "running",
  latestSequence = 0,
): TaskSummary {
  return {
    task_id: taskId,
    mode: "agent",
    databases: [],
    title: `Task ${taskId}`,
    status,
    active_run_id: status === "running" ? `run_${taskId}` : null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    latest_sequence: latestSequence,
  };
}

function envelope(
  taskId: string,
  runId: string | null,
  sequence: number,
  payload: EventPayload,
  stageAttemptId: string | null = null,
): EventEnvelope {
  return {
    schema_version: runId === null ? "1.0" : "2.0",
    event_id: `event_${taskId}_${sequence}`,
    type: payload.type,
    task_id: taskId,
    run_id: runId,
    stage_attempt_id: stageAttemptId,
    sequence,
    timestamp: `2026-07-14T00:00:${String(sequence).padStart(2, "0")}Z`,
    payload,
  } as EventEnvelope;
}

describe("conversation items ordering", () => {
  function setup(taskId = "task_order") {
    return mergeTaskPage(
      createInitialRuntimeState(),
      { active_items: [summary(taskId)], items: [], next_cursor: null },
      false,
    );
  }

  it("keeps items sorted by sequence ascending across event types", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 1, {
        type: "assistant_reasoning_delta",
        delta: "thinking",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 2, {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 3, {
        type: "assistant_delta",
        delta: "result",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 4, {
        type: "artifact_produced",
        artifact: {
          artifact_id: "a1",
          name: "out.csv",
          relative_path: "artifacts/out.csv",
          media_type: "text/csv",
          size_bytes: 10,
          sha256: "a".repeat(64),
          generated_by_step_id: "step_1",
        },
      }),
    );

    const items = state.tasksById.task_order.items;
    expect(items.map((i) => i.sequence)).toEqual([1, 2, 3, 4]);
    expect(items.map((i) => i.kind)).toEqual([
      "reasoning",
      "tool_call",
      "assistant_segment",
      "artifact",
    ]);
  });

  it("interleaves items from different runs by sequence", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_a", 1, {
        type: "tool_started",
        tool_call_id: "call_a1",
        tool_name: "search_a",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_b", 2, {
        type: "assistant_delta",
        delta: "from run b",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_a", 3, {
        type: "warning",
        code: "warn",
        message: "be careful",
      }),
    );

    const items = state.tasksById.task_order.items;
    expect(items.map((i) => i.runId)).toEqual(["run_a", "run_b", "run_a"]);
    expect(items.map((i) => i.sequence)).toEqual([1, 2, 3]);
    expect(items.map((i) => i.kind)).toEqual([
      "tool_call",
      "assistant_segment",
      "warning",
    ]);
  });

  it("preserves createdAt when upserting an existing item", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 1, {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search",
      }),
    );
    const createdAtBefore = (
      state.tasksById.task_order.items[0] as { createdAt: string }
    ).createdAt;

    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 2, {
        type: "tool_completed",
        tool_call_id: "call_1",
        tool_name: "search",
        output: "done",
        is_error: false,
      }),
    );

    expect(state.tasksById.task_order.items[0]).toMatchObject({
      kind: "tool_call",
      status: "completed",
      createdAt: createdAtBefore,
    });
  });

  it("keeps an item's sequence fixed when an upsert updates it", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 1, {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 2, {
        type: "warning",
        code: "warn",
        message: "be careful",
      }),
    );
    // tool_completed updates the tool_call item (sequence would be 3) —
    // the item must keep its first-entry sequence (1) and not move after
    // the warning.
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 3, {
        type: "tool_completed",
        tool_call_id: "call_1",
        tool_name: "search",
        is_error: false,
      }),
    );

    const items = state.tasksById.task_order.items;
    expect(items.map((i) => i.sequence)).toEqual([1, 2]);
    expect(items.map((i) => i.kind)).toEqual(["tool_call", "warning"]);
  });

  it("tracks first sequence per item in itemSequences", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 1, {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 2, {
        type: "tool_completed",
        tool_call_id: "call_1",
        tool_name: "search",
        is_error: false,
      }),
    );

    expect(state.tasksById.task_order.itemSequences["tool:run_order:call_1"]).toBe(1);
  });

  it("deduplicates items by itemId across interleaved runs", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_a", 1, {
        type: "tool_started",
        tool_call_id: "call_shared",
        tool_name: "search",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_b", 2, {
        type: "tool_started",
        tool_call_id: "call_shared",
        tool_name: "search",
        arguments: { q: "from run_b" },
      }),
    );

    const items = state.tasksById.task_order.items;
    // Same itemId `tool:run_a:call_shared` vs `tool:run_b:call_shared` — different runId prefix,
    // so they are distinct items. Verify both exist and are sorted by sequence.
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ runId: "run_a", sequence: 1 });
    expect(items[1]).toMatchObject({ runId: "run_b", sequence: 2 });
  });

  it("preserves assistant/tool interleaving within one run", () => {
    let state = setup();

    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 1, {
        type: "assistant_delta",
        delta: "before ",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 2, {
        type: "assistant_delta",
        delta: "tool",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 3, {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "query_local_cache",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 4, {
        type: "tool_completed",
        tool_call_id: "call_1",
        tool_name: "query_local_cache",
        is_error: false,
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_order", "run_order", 5, {
        type: "assistant_delta",
        delta: "after tool",
      }),
    );

    const items = state.tasksById.task_order.items;
    expect(
      items.map((item) => ({
        kind: item.kind,
        sequence: item.sequence,
        content: item.kind === "assistant_segment" ? item.content : undefined,
      })),
    ).toEqual([
      {
        kind: "assistant_segment",
        sequence: 1,
        content: "before tool",
      },
      {
        kind: "tool_call",
        sequence: 3,
        content: undefined,
      },
      {
        kind: "assistant_segment",
        sequence: 5,
        content: "after tool",
      },
    ]);
  });
});
