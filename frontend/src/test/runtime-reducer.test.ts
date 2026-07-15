import { describe, expect, it } from "vitest";

import type {
  EventEnvelope,
  EventPayload,
  TaskPage,
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
  mode: TaskSummary["mode"] = "agent",
): TaskSummary {
  return {
    task_id: taskId,
    mode,
    databases: [],
    title: `Task ${taskId}`,
    status,
    active_run_id: status === "running" ? `run_${taskId}` : null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    latest_sequence: latestSequence,
  };
}

function page(...tasks: TaskSummary[]): TaskPage {
  return { active_items: tasks, items: [], next_cursor: null };
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

describe("runtime event projection", () => {
  it("routes overlapping task-local sequences independently", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_a"), summary("task_b")),
      false,
    );

    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_task_a", 1, {
        type: "assistant_delta",
        delta: "A1",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_b", "run_task_b", 1, {
        type: "assistant_delta",
        delta: "B1",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_task_a", 2, {
        type: "assistant_delta",
        delta: "A2",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_b", "run_task_b", 2, {
        type: "assistant_delta",
        delta: "B2",
      }),
    );

    expect(state.tasksById.task_a.messages.slice(-1)[0]?.content).toBe("A1A2");
    expect(state.tasksById.task_b.messages.slice(-1)[0]?.content).toBe("B1B2");
    expect(state.tasksById.task_a.lastSequence).toBe(2);
    expect(state.tasksById.task_b.lastSequence).toBe(2);
  });

  it.each(["task_b", null] as const)(
    "terminalizes a background task without changing foreground %s or the draft",
    (activeTaskId) => {
      const initial = mergeTaskPage(
        createInitialRuntimeState(),
        page(summary("task_a"), summary("task_b")),
        false,
      );
      const state = {
        ...initial,
        activeTaskId,
        draft: {
          ...initial.draft,
          input: "untouched draft",
          selectedDatabaseIds: ["pubmed"],
        },
      };
      const beforeTaskB = state.tasksById.task_b;
      const beforeDraft = state.draft;

      const next = reduceRuntimeEvent(
        state,
        envelope("task_a", "run_task_a", 1, { type: "run_completed" }),
      );

      expect(next.tasksById.task_a.summary.status).toBe("completed");
      expect(next.activeItems).not.toContain("task_a");
      expect(next.taskOrder).toContain("task_a");
      expect(next.activeTaskId).toBe(activeTaskId);
      expect(next.tasksById.task_b).toBe(beforeTaskB);
      expect(next.draft).toBe(beforeDraft);
    },
  );

  it("returns the same root for duplicate and stale envelopes", () => {
    const initial = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_a")),
      false,
    );
    const artifactEvent = envelope("task_a", "run_task_a", 3, {
      type: "artifact_produced",
      artifact: {
        schema_version: "1.0",
        artifact_id: "artifact_1",
        name: "result.csv",
        relative_path: "artifacts/result.csv",
        media_type: "text/csv",
        size_bytes: 12,
        sha256: "a".repeat(64),
        generated_by_step_id: "step_1",
      },
    });
    const projected = reduceRuntimeEvent(initial, artifactEvent);

    expect(reduceRuntimeEvent(projected, artifactEvent)).toBe(projected);
    expect(
      reduceRuntimeEvent(
        projected,
        envelope("task_a", "run_task_a", 2, {
          type: "assistant_delta",
          delta: "stale",
        }),
      ),
    ).toBe(projected);
    expect(projected.tasksById.task_a.artifactOrder).toEqual(["artifact_1"]);
  });

  it("routes lifecycle events to the addressed run only", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_a")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_first", 1, {
        type: "run_queued",
        request_id: "req_first",
        input: "first",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_first", 2, { type: "run_completed" }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_second", 3, {
        type: "run_queued",
        request_id: "req_second",
        input: "second",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_second", 4, { type: "run_started" }),
    );

    expect(state.tasksById.task_a.runsById.run_first.status).toBe("completed");
    expect(state.tasksById.task_a.runsById.run_second.status).toBe("running");
    expect(state.tasksById.task_a.summary.active_run_id).toBe("run_second");
  });

  it("projects fixture stages without inventing stages for generic activity", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_fixture", "running", 0, "fixture")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_fixture",
        null,
        1,
        { type: "stage_started", stage: "discovery", attempt: 1 },
        "stage_attempt_1",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_fixture", "run_fixture", 2, {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search_literature",
      }),
    );

    expect(state.tasksById.task_fixture.fixtureStages.discovery).toMatchObject({
      stageAttemptId: "stage_attempt_1",
      attempt: 1,
      status: "running",
    });
    expect(Object.keys(state.tasksById.task_fixture.fixtureStages)).toEqual([
      "discovery",
    ]);
  });

  it("does not overwrite a newer active run when an older run terminalizes", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_a")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_first", 1, {
        type: "run_queued",
        request_id: "req_first",
        input: "first",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_second", 2, {
        type: "run_queued",
        request_id: "req_second",
        input: "second",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_first", 3, { type: "run_completed" }),
    );

    expect(state.tasksById.task_a.summary).toMatchObject({
      status: "queued",
      active_run_id: "run_second",
    });
    expect(state.activeItems).toContain("task_a");
  });

  it("keeps a newer fixture stage attempt when an older attempt completes late", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_fixture", "running", 0, "fixture")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_fixture",
        null,
        1,
        { type: "stage_started", stage: "discovery", attempt: 1 },
        "attempt_1",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_fixture",
        null,
        2,
        { type: "stage_started", stage: "discovery", attempt: 2 },
        "attempt_2",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_fixture",
        null,
        3,
        {
          type: "stage_completed",
          stage: "discovery",
          status: "succeeded",
          output_digest: "a".repeat(64),
        },
        "attempt_1",
      ),
    );

    expect(state.tasksById.task_fixture.fixtureStages.discovery).toMatchObject({
      stageAttemptId: "attempt_2",
      attempt: 2,
      status: "running",
    });
  });
});
