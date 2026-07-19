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
import type { AgentRuntimeData } from "@/runtime/types";

const TIMESTAMP = "2026-07-18T00:00:00Z";

function summary(): TaskSummary {
  return {
    task_id: "task_summary",
    mode: "agent",
    databases: [],
    title: "Summary",
    status: "running",
    active_run_id: "run_a",
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    latest_sequence: 0,
  };
}

function stateWithTask(): AgentRuntimeData {
  return mergeTaskPage(
    createInitialRuntimeState(),
    { active_items: [summary()], items: [], next_cursor: null },
    false,
  );
}

function envelope(
  sequence: number,
  runId: string,
  payload: EventPayload,
  stageAttemptId: string | null = null,
): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event_${sequence}`,
    type: payload.type,
    task_id: "task_summary",
    run_id: runId,
    stage_attempt_id: stageAttemptId,
    sequence,
    timestamp: TIMESTAMP,
    payload,
  };
}

describe("execution summary activity projection", () => {
  it("keeps reasoning out of assistant messages and appends it to one activity", () => {
    let state = stateWithTask();
    state = reduceRuntimeEvent(
      state,
      envelope(1, "run_a", {
        type: "assistant_reasoning_delta",
        delta: "先检索文献。",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(2, "run_a", {
        type: "assistant_reasoning_delta",
        delta: "再分析数据。",
      }),
    );

    const task = state.tasksById.task_summary;
    expect(task.messages).toHaveLength(0);
    expect(task.activityOrder).toEqual(["reasoning:run_a"]);
    expect(task.activitiesById["reasoning:run_a"]).toMatchObject({
      kind: "reasoning",
      output: "先检索文献。再分析数据。",
      sequence: 2,
    });
  });

  it("updates one progress activity in place without changing first-event order", () => {
    let state = stateWithTask();
    state = reduceRuntimeEvent(
      state,
      envelope(1, "run_a", {
        type: "stage_progress",
        stage: "discovery",
        kind: "discovered_records",
        current: 3,
        total: 12,
        detail: { hidden_query: "must not enter the summary activity" },
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(2, "run_a", {
        type: "warning",
        code: "partial_results",
        message: "部分结果不可用",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(3, "run_a", {
        type: "stage_progress",
        stage: "discovery",
        kind: "discovered_records",
        current: 8,
        total: 12,
        detail: { raw_payload: "secret" },
      }),
    );

    const task = state.tasksById.task_summary;
    expect(task.activityOrder).toEqual([
      "progress:run_a:discovery:discovered_records",
      "event:2",
    ]);
    expect(
      task.activitiesById["progress:run_a:discovery:discovered_records"],
    ).toMatchObject({
      kind: "progress",
      runId: "run_a",
      sequence: 3,
      progress: {
        stage: "discovery",
        kind: "discovered_records",
        current: 8,
        total: 12,
      },
    });
    expect(
      task.activitiesById["progress:run_a:discovery:discovered_records"],
    ).not.toHaveProperty("progress.detail");
  });

  it("isolates stable stage and progress identities between runs", () => {
    let state = stateWithTask();
    state = reduceRuntimeEvent(
      state,
      envelope(
        1,
        "run_a",
        { type: "stage_started", stage: "validation", attempt: 1 },
        "attempt_a",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(
        2,
        "run_a",
        {
          type: "stage_completed",
          stage: "validation",
          status: "succeeded",
          output_digest: "a".repeat(64),
        },
        "attempt_a",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(
        3,
        "run_b",
        { type: "stage_started", stage: "validation", attempt: 1 },
        "attempt_b",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(4, "run_b", {
        type: "stage_progress",
        stage: "validation",
        kind: "parsed",
        current: 2,
        total: 4,
        detail: {},
      }),
    );

    const task = state.tasksById.task_summary;
    expect(task.activityOrder).toEqual([
      "stage:run_a:validation",
      "stage:run_b:validation",
      "progress:run_b:validation:parsed",
    ]);
    expect(task.activitiesById["stage:run_a:validation"]).toMatchObject({
      runId: "run_a",
      kind: "stage",
      status: "completed",
      stage: "validation",
    });
    expect(task.activitiesById["stage:run_b:validation"]).toMatchObject({
      runId: "run_b",
      kind: "stage",
      status: "started",
      stage: "validation",
    });
  });
});
