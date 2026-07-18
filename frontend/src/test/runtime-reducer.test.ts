import { describe, expect, it } from "vitest";

import type {
  EventEnvelope,
  EventPayload,
  MessagePage,
  MessageRecord,
  RunRecord,
  TaskPage,
  TaskSnapshot,
  TaskSummary,
} from "@/runtime/contracts";
import {
  createInitialRuntimeState,
  hydrateTaskSnapshot,
  mergeOlderMessagePage,
  mergeTaskPage,
  reduceRuntimeEvent,
} from "@/runtime/reducer";

const CREATED_AT = "2026-07-14T00:00:00Z";

function summary(
  taskId: string,
  status: TaskSummary["status"] = "running",
  latestSequence = 0,
  mode: TaskSummary["mode"] = "agent",
  createdAt = CREATED_AT,
): TaskSummary {
  return {
    task_id: taskId,
    mode,
    databases: [],
    title: `Task ${taskId}`,
    status,
    active_run_id: status === "running" ? `run_${taskId}` : null,
    created_at: createdAt,
    updated_at: createdAt,
    latest_sequence: latestSequence,
  };
}

function page(...tasks: TaskSummary[]): TaskPage {
  return { active_items: tasks, items: [], next_cursor: null };
}

function message(
  taskId: string,
  ordinal: number,
  options: {
    messageId?: string;
    runId?: string | null;
    role?: MessageRecord["role"];
    content?: string;
  } = {},
): MessageRecord {
  return {
    message_id: options.messageId ?? `message_${ordinal}`,
    task_id: taskId,
    run_id: options.runId ?? `run_${ordinal}`,
    ordinal,
    role: options.role ?? "user",
    content: options.content ?? `message ${ordinal}`,
    created_at: `2026-07-14T00:00:${String(ordinal).padStart(2, "0")}Z`,
  };
}

function taskSnapshot(
  taskId: string,
  messages: MessageRecord[],
  olderMessagesCursor: string | null,
  latestSequence = 0,
): TaskSnapshot {
  return {
    task: summary(taskId, "completed", latestSequence),
    runs: [],
    messages,
    older_messages_cursor: olderMessagesCursor,
  };
}

function runRecord(
  taskId: string,
  runId: string,
  status: RunRecord["status"],
): RunRecord {
  return {
    run_id: runId,
    task_id: taskId,
    request_id: `request_${runId}`,
    status,
    input: "input",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    started_at: CREATED_AT,
    finished_at: status === "awaiting_user_input" ? null : CREATED_AT,
    error: null,
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

describe("runtime event projection", () => {
  it("deduplicates and sorts merged task groups by immutable creation order", () => {
    const preservedActive = summary(
      "task_active_new",
      "running",
      2,
      "agent",
      "2026-07-15T00:00:00Z",
    );
    const preservedHistory = summary(
      "task_history_old",
      "completed",
      2,
      "agent",
      "2026-07-13T00:00:00Z",
    );
    const initial = mergeTaskPage(
      createInitialRuntimeState(),
      {
        active_items: [preservedActive],
        items: [preservedHistory],
        next_cursor: null,
      },
      false,
    );
    const incomingActive = summary(
      "task_active_old",
      "running",
      1,
      "agent",
      "2026-07-14T00:00:00Z",
    );
    const incomingHistoryA = summary(
      "task_history_a",
      "completed",
      1,
      "agent",
      "2026-07-14T00:00:00Z",
    );
    const incomingHistoryZ = summary(
      "task_history_z",
      "completed",
      1,
      "agent",
      "2026-07-14T00:00:00Z",
    );

    const state = mergeTaskPage(
      initial,
      {
        active_items: [incomingActive, incomingActive],
        items: [incomingHistoryA, incomingHistoryZ, incomingHistoryZ],
        next_cursor: null,
      },
      false,
      new Set([preservedHistory.task_id]),
    );

    expect(state.activeItems).toEqual([
      "task_active_new",
      "task_active_old",
    ]);
    expect(state.taskOrder).toEqual([
      "task_history_z",
      "task_history_a",
      "task_history_old",
    ]);
  });

  it("keeps streamed assistant text visible through plan approval events", () => {
    const taskId = "task_plan_stream";
    const runId = "run_task_plan_stream";
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary(taskId, "running", 0)),
      false,
    );

    state = reduceRuntimeEvent(
      state,
      envelope(taskId, runId, 1, { type: "run_started" }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(taskId, runId, 2, {
        type: "assistant_delta",
        delta: "I am preparing the plan.",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(taskId, runId, 3, {
        type: "plan_ready",
        specification: { topic: "test" },
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(taskId, runId, 4, {
        type: "user_input_required",
        request_id: "request_plan",
        prompt_kind: "plan_confirmation",
        summary: "Confirm the plan",
        expires_at: null,
        fixture_exempt: false,
        detail: {},
      }),
    );

    const task = state.tasksById[taskId];
    expect(task.messages).toHaveLength(1);
    expect(task.messages[0]).toMatchObject({
      role: "assistant",
      runId,
      content: "I am preparing the plan.",
    });
    expect(task.activityOrder).toHaveLength(1);
    expect(task.activitiesById[task.activityOrder[0]]).toMatchObject({
      name: "plan_ready",
    });
    expect(task.pendingUserInput).toMatchObject({
      runId,
      requestId: "request_plan",
    });
  });

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

  it("binds pending user input to the authoritative Run", () => {
    const initial = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_a")),
      false,
    );

    const state = reduceRuntimeEvent(
      initial,
      envelope("task_a", "run_prompt", 1, {
        type: "user_input_required",
        request_id: "request_prompt",
        prompt_kind: "plan_confirmation",
        summary: "Confirm the plan",
        expires_at: null,
        fixture_exempt: false,
        detail: {},
      }),
    );

    expect(state.tasksById.task_a.pendingUserInput).toMatchObject({
      runId: "run_prompt",
      requestId: "request_prompt",
    });
  });

  it("preserves pending input while its snapshot Run is still awaiting input", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_a")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_prompt", 1, {
        type: "user_input_required",
        request_id: "request_prompt",
        prompt_kind: "plan_confirmation",
        summary: "Confirm the plan",
        expires_at: null,
        fixture_exempt: false,
        detail: {},
      }),
    );

    const hydrated = hydrateTaskSnapshot(state, {
      task: {
        ...summary("task_a", "awaiting_user_input", 2),
        active_run_id: "run_prompt",
      },
      runs: [runRecord("task_a", "run_prompt", "awaiting_user_input")],
      messages: [],
      older_messages_cursor: null,
    });

    expect(hydrated.tasksById.task_a.pendingUserInput).toEqual(
      state.tasksById.task_a.pendingUserInput,
    );
  });

  it("clears pending input when a cancellation snapshot terminalizes its Run", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_a")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_prompt", 1, {
        type: "user_input_required",
        request_id: "request_prompt",
        prompt_kind: "plan_confirmation",
        summary: "Confirm the plan",
        expires_at: null,
        fixture_exempt: false,
        detail: {},
      }),
    );

    const hydrated = hydrateTaskSnapshot(state, {
      task: {
        ...summary("task_a", "cancelled", 2),
        active_run_id: null,
      },
      runs: [runRecord("task_a", "run_prompt", "cancelled")],
      messages: [],
      older_messages_cursor: null,
    });

    expect(hydrated.tasksById.task_a.pendingUserInput).toBeNull();
  });

  it("does not clear pending user input when another Run resumes", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_a")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_prompt", 1, {
        type: "user_input_required",
        request_id: "request_prompt",
        prompt_kind: "plan_confirmation",
        summary: "Confirm the plan",
        expires_at: null,
        fixture_exempt: false,
        detail: {},
      }),
    );

    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_other", 2, {
        type: "user_input_resumed",
        request_id: "request_other",
        decision: "approve",
        detail: {},
      }),
    );

    expect(state.tasksById.task_a.pendingUserInput).toMatchObject({
      runId: "run_prompt",
      requestId: "request_prompt",
    });
  });

  it.each([
    "run_completed",
    "run_failed",
    "run_cancelled",
    "run_interrupted",
  ] as const)("clears pending input on %s only for its owning Run", (type) => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_a")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_prompt", 1, {
        type: "user_input_required",
        request_id: "request_prompt",
        prompt_kind: "plan_confirmation",
        summary: "Confirm the plan",
        expires_at: null,
        fixture_exempt: false,
        detail: {},
      }),
    );
    const terminalPayload: EventPayload =
      type === "run_completed"
        ? { type }
        : type === "run_failed"
          ? { type, error: "failed" }
          : { type, reason: "stopped" };

    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_other", 2, terminalPayload),
    );
    expect(state.tasksById.task_a.pendingUserInput).toMatchObject({
      runId: "run_prompt",
      requestId: "request_prompt",
    });

    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_prompt", 3, terminalPayload),
    );
    expect(state.tasksById.task_a.pendingUserInput).toBeNull();
  });

  it("clears an older pending prompt when a new Run is queued", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_a")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_old", 1, {
        type: "user_input_required",
        request_id: "request_old",
        prompt_kind: "plan_confirmation",
        summary: "Confirm the old plan",
        expires_at: null,
        fixture_exempt: false,
        detail: {},
      }),
    );

    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_new", 2, {
        type: "run_queued",
        request_id: "request_new",
        input: "new turn",
      }),
    );

    expect(state.tasksById.task_a.pendingUserInput).toBeNull();
  });

  it("projects fixture input-required before its automatic resume", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_fixture", "running", 0, "fixture")),
      false,
    );

    state = reduceRuntimeEvent(
      state,
      envelope("task_fixture", "run_fixture", 1, {
        type: "user_input_required",
        request_id: "request_fixture",
        prompt_kind: "plan_confirmation",
        summary: "Fixture plan",
        expires_at: null,
        fixture_exempt: true,
        detail: {},
      }),
    );
    expect(state.tasksById.task_fixture.pendingUserInput).toMatchObject({
      runId: "run_fixture",
      requestId: "request_fixture",
      fixtureExempt: true,
    });
    expect(state.tasksById.task_fixture.summary.status).toBe(
      "awaiting_user_input",
    );

    state = reduceRuntimeEvent(
      state,
      envelope("task_fixture", "run_fixture", 2, {
        type: "user_input_resumed",
        request_id: "request_fixture",
        decision: "approve",
        detail: { automatic: true },
      }),
    );

    expect(state.tasksById.task_fixture.pendingUserInput).toBeNull();
    expect(state.tasksById.task_fixture.summary).toMatchObject({
      status: "running",
      active_run_id: "run_fixture",
      latest_sequence: 2,
    });
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

    expect(state.tasksById.task_fixture.stages.discovery).toMatchObject({
      stageAttemptId: "stage_attempt_1",
      attempt: 1,
      status: "running",
    });
    expect(Object.keys(state.tasksById.task_fixture.stages)).toEqual([
      "discovery",
    ]);
  });

  it.each(["run_cancelled", "run_failed", "run_interrupted"] as const)(
    "terminalizes the running fixture stage when %s ends the authoritative Run",
    (type) => {
      let state = mergeTaskPage(
        createInitialRuntimeState(),
        page(summary("task_fixture", "running", 0, "fixture")),
        false,
      );
      state = reduceRuntimeEvent(
        state,
        envelope(
          "task_fixture",
          "run_fixture",
          1,
          { type: "stage_started", stage: "processing", attempt: 1 },
          "stage_attempt_processing",
        ),
      );
      const terminalPayload: EventPayload =
        type === "run_failed"
          ? { type, error: "processing failed" }
          : { type, reason: "processing stopped" };

      state = reduceRuntimeEvent(
        state,
        envelope("task_fixture", "run_fixture", 2, terminalPayload),
      );

      expect(state.tasksById.task_fixture.stages.processing).toMatchObject({
        status: type === "run_failed" ? "failed" : "cancelled",
        finishedAt: "2026-07-14T00:00:02Z",
        error:
          type === "run_failed" ? "processing failed" : "processing stopped",
      });
    },
  );

  it("projects stage events for agent tasks (cross-mode stage projection)", () => {
    const initial = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_agent", "running", 0, "agent")),
      false,
    );

    const state = reduceRuntimeEvent(
      initial,
      envelope(
        "task_agent",
        null,
        1,
        { type: "stage_started", stage: "discovery", attempt: 1 },
        "stage_attempt_agent",
      ),
    );

    // Agent mode now projects stage events to task.stages so the frontend
    // can show concrete progress (see docs/REVIEW_2026-07-18.md §4).
    expect(state.tasksById.task_agent.stages.discovery).toMatchObject({
      stageAttemptId: "stage_attempt_agent",
      attempt: 1,
      status: "running",
    });
    expect(state.tasksById.task_agent.lastSequence).toBe(1);
    expect(state.tasksById.task_agent.summary.latest_sequence).toBe(1);
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

    expect(state.tasksById.task_fixture.stages.discovery).toMatchObject({
      stageAttemptId: "attempt_2",
      attempt: 2,
      status: "running",
    });
  });

  it("merges older message pages in durable order and rejects a stale cursor", () => {
    let state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      taskSnapshot(
        "task_history",
        [message("task_history", 4), message("task_history", 5)],
        "cursor_before_4",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_history", "run_live", 1, {
        type: "assistant_delta",
        delta: "live answer",
      }),
    );
    const olderPage: MessagePage = {
      messages: [
        message("task_history", 2),
        message("task_history", 3),
        message("task_history", 4),
      ],
      next_cursor: "cursor_before_2",
    };

    const merged = mergeOlderMessagePage(
      state,
      "task_history",
      "cursor_before_4",
      olderPage,
    );

    expect(
      merged.tasksById.task_history.messages.map((item) => item.messageId),
    ).toEqual([
      "message_2",
      "message_3",
      "message_4",
      "message_5",
      "live:run_live:assistant",
    ]);
    expect(merged.tasksById.task_history.olderMessagesCursor).toBe(
      "cursor_before_2",
    );
    expect(
      mergeOlderMessagePage(
        merged,
        "task_history",
        "cursor_before_4",
        { messages: [message("task_history", 1)], next_cursor: null },
      ),
    ).toBe(merged);
  });

  it("keeps already loaded older messages and their cursor across a newer snapshot", () => {
    let state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      taskSnapshot(
        "task_history",
        [message("task_history", 4), message("task_history", 5)],
        "cursor_before_4",
      ),
    );
    state = mergeOlderMessagePage(
      state,
      "task_history",
      "cursor_before_4",
      {
        messages: [message("task_history", 2), message("task_history", 3)],
        next_cursor: "cursor_before_2",
      },
    );

    const refreshed = hydrateTaskSnapshot(
      state,
      taskSnapshot(
        "task_history",
        [message("task_history", 5), message("task_history", 6)],
        "cursor_before_5",
        1,
      ),
    );

    expect(
      refreshed.tasksById.task_history.messages.map((item) => item.ordinal),
    ).toEqual([2, 3, 4, 5, 6]);
    expect(refreshed.tasksById.task_history.olderMessagesCursor).toBe(
      "cursor_before_2",
    );
  });

  it("uses a newer snapshot cursor when a message gap still needs pagination", () => {
    const state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      taskSnapshot(
        "task_history",
        [message("task_history", 1), message("task_history", 2)],
        null,
      ),
    );

    const refreshed = hydrateTaskSnapshot(
      state,
      taskSnapshot(
        "task_history",
        [message("task_history", 5), message("task_history", 6)],
        "cursor_before_5",
        1,
      ),
    );

    expect(
      refreshed.tasksById.task_history.messages.map((item) => item.ordinal),
    ).toEqual([1, 2, 5, 6]);
    expect(refreshed.tasksById.task_history.olderMessagesCursor).toBe(
      "cursor_before_5",
    );
  });

  it("replaces live user and assistant slots with durable snapshot messages", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_live", "running")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_live", "run_live", 1, {
        type: "run_queued",
        request_id: "req_live",
        input: "question",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_live", "run_live", 2, {
        type: "assistant_delta",
        delta: "answer",
      }),
    );

    const hydrated = hydrateTaskSnapshot(state, {
      task: {
        ...summary("task_live", "running", 2),
        active_run_id: "run_live",
      },
      runs: [],
      messages: [
        message("task_live", 1, {
          messageId: "durable_user",
          runId: "run_live",
          role: "user",
          content: "question",
        }),
        message("task_live", 2, {
          messageId: "durable_assistant",
          runId: "run_live",
          role: "assistant",
          content: "answer",
        }),
      ],
      older_messages_cursor: null,
    });

    expect(
      hydrated.tasksById.task_live.messages.map((item) => item.messageId),
    ).toEqual(["durable_user", "durable_assistant"]);
  });

  it("keeps fixture task terminal payloads informational until runtime terminalizes the Run", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_fixture", "running", 0, "fixture")),
      false,
    );

    state = reduceRuntimeEvent(
      state,
      envelope("task_fixture", "run_task_fixture", 1, {
        type: "task_completed",
        validation: {
          status: "valid",
          checked_count: 1,
          failed_count: 0,
          report_path: "logs/validation_report.json",
        },
      }),
    );
    expect(state.tasksById.task_fixture.summary.status).toBe("running");
    expect(state.tasksById.task_fixture.activitiesById["event:1"]).toMatchObject({
      kind: "fixture_event",
      name: "task_completed",
    });

    state = reduceRuntimeEvent(
      state,
      envelope("task_fixture", "run_task_fixture", 2, {
        type: "run_finalizing",
      }),
    );
    expect(state.tasksById.task_fixture.summary.status).toBe("finalizing");

    state = reduceRuntimeEvent(
      state,
      envelope("task_fixture", "run_task_fixture", 3, {
        type: "run_completed",
      }),
    );
    expect(state.tasksById.task_fixture.summary.status).toBe("completed");
  });

  it.each(["task_cancelled", "task_failed"] as const)(
    "does not let fixture %s override the authoritative Run status",
    (type) => {
      const initial = mergeTaskPage(
        createInitialRuntimeState(),
        page(summary("task_fixture", "running", 0, "fixture")),
        false,
      );
      const payload: EventPayload =
        type === "task_cancelled"
          ? { type, reason: "cancelled by user" }
          : {
              type,
              error: {
                code: "fixture_failed",
                message: "fixture failed",
                retryable: false,
                stage: "validation",
                details: {},
              },
            };

      const state = reduceRuntimeEvent(
        initial,
        envelope("task_fixture", "run_task_fixture", 1, payload),
      );

      expect(state.tasksById.task_fixture.summary.status).toBe("running");
      expect(state.tasksById.task_fixture.activitiesById["event:1"]).toMatchObject({
        kind: "fixture_event",
        name: type,
      });
    },
  );
});
