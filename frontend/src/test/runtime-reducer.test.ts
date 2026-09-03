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
    sequence?: number;
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
    ...(options.sequence === undefined ? {} : { sequence: options.sequence }),
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

function subagentEnvelope(
  sequence: number,
  payload: Extract<EventPayload, { type: `subagent_${string}` }>,
): EventEnvelope {
  return {
    ...envelope("task_items", "run_items", sequence, payload),
    subagent_id: "subagent_1",
    parent_tool_call_id: "call_parent_1",
  } as EventEnvelope;
}

describe("runtime event projection", () => {
  it("projects queued, progress, and completed subagent events", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_items")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      subagentEnvelope(1, {
        type: "subagent_queued",
        subagent_id: "subagent_1",
        request: {
          agent_type: "source_research",
          objective: "Find TP53 datasets",
          target_source: "GEO",
          domain: "genomics",
          capability: "dataset_search",
          inputs: { gene: "TP53" },
        },
      }),
    );
    state = reduceRuntimeEvent(
      state,
      subagentEnvelope(2, {
        type: "subagent_progress",
        subagent_id: "subagent_1",
        current: 1,
        total: 2,
        message: "Inspecting GEO",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      subagentEnvelope(3, {
        type: "subagent_completed",
        subagent_id: "subagent_1",
        result: {
          subagent_id: "subagent_1",
          status: "completed",
          summary: "Found a source",
          source_asset_ids: ["source_1"],
          recipe_id: null,
          warnings: ["Search results were rate limited"],
          error_code: null,
          error_message: null,
        },
      }),
    );

    const task = state.tasksById.task_items;
    expect(task.subagentOrder).toEqual(["subagent_1"]);
    expect(task.subagentsById.subagent_1).toMatchObject({
      status: "completed",
      progressCurrent: 1,
      progressTotal: 2,
      sourceAssetIds: ["source_1"],
      warnings: ["Search results were rate limited"],
      parentToolCallId: "call_parent_1",
    });
    expect(task.items).toHaveLength(0);
  });

  it("hydrates an old snapshot without subagents", () => {
    const state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      taskSnapshot("task_1", [], null),
    );

    expect(state.tasksById.task_1.subagentOrder).toEqual([]);
    expect(state.tasksById.task_1.subagentsById).toEqual({});
  });

  it("merges snapshot subagents without duplicating replayed records", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_items")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      subagentEnvelope(1, {
        type: "subagent_queued",
        subagent_id: "subagent_1",
        request: {
          agent_type: "source_research",
          objective: "Find datasets",
          target_source: null,
          domain: "genomics",
          capability: "dataset_search",
          inputs: {},
        },
      }),
    );
    state = hydrateTaskSnapshot(state, {
      ...taskSnapshot("task_items", [], null, 1),
      subagents: [
        {
          subagent_id: "subagent_1",
          task_id: "task_items",
          run_id: "run_items",
          agent_type: "source_research",
          objective: "Find datasets",
          target_source: null,
          status: "running",
          parent_tool_call_id: "call_parent_1",
          created_at: CREATED_AT,
          started_at: CREATED_AT,
          finished_at: null,
          progress_current: 1,
          progress_total: 2,
          progress_message: "Searching",
          result_summary: null,
          source_asset_ids: [],
          recipe_id: null,
          error_code: null,
          error_message: null,
          pending_request_id: null,
        },
      ],
    });

    const task = state.tasksById.task_items;
    expect(task.subagentOrder).toEqual(["subagent_1"]);
    expect(task.subagentsById.subagent_1).toMatchObject({
      status: "running",
      progressCurrent: 1,
    });
  });

  it("preserves terminal subagent warnings through snapshot hydration", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_items")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      subagentEnvelope(1, {
        type: "subagent_queued",
        subagent_id: "subagent_1",
        request: {
          agent_type: "source_research",
          objective: "Find datasets",
          target_source: null,
          domain: "genomics",
          capability: "dataset_search",
          inputs: {},
        },
      }),
    );
    state = reduceRuntimeEvent(
      state,
      subagentEnvelope(2, {
        type: "subagent_completed",
        subagent_id: "subagent_1",
        result: {
          subagent_id: "subagent_1",
          status: "completed",
          summary: "Found datasets",
          source_asset_ids: [],
          recipe_id: null,
          warnings: ["Fallback used"],
          error_code: null,
          error_message: null,
        },
      }),
    );

    state = hydrateTaskSnapshot(state, {
      ...taskSnapshot("task_items", [], null, 2),
      subagents: [
        {
          subagent_id: "subagent_1",
          task_id: "task_items",
          run_id: "run_items",
          agent_type: "source_research",
          objective: "Find datasets",
          target_source: null,
          status: "completed",
          parent_tool_call_id: "call_parent_1",
          created_at: CREATED_AT,
          started_at: CREATED_AT,
          finished_at: CREATED_AT,
          progress_current: 1,
          progress_total: 1,
          progress_message: null,
          result_summary: "Found datasets",
          source_asset_ids: [],
          recipe_id: null,
          error_code: null,
          error_message: null,
          pending_request_id: null,
        },
      ],
    });

    expect(state.tasksById.task_items.subagentsById.subagent_1.warnings).toEqual([
      "Fallback used",
    ]);
  });

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

  it("passes operation lifecycle events through without changing state (F4)", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_operation", "running", 0)),
      false,
    );
    const before = state.tasksById.task_operation;

    // V2 build-execution events (Design §15.1) project one conversation
    // item per operation (label + category + lifecycle status) while the
    // cursor keeps advancing.
    state = reduceRuntimeEvent(
      state,
      envelope("task_operation", "run_operation", 1, {
        type: "operation_started",
        operation_id: "op-1",
        label: "build skeleton",
        category: "build",
        attempt: 1,
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_operation", "run_operation", 2, {
        type: "operation_progress",
        operation_id: "op-1",
        kind: "rows_parsed",
        current: 42,
        total: 100,
        detail: {},
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_operation", "run_operation", 3, {
        type: "operation_completed",
        operation_id: "op-1",
        status: "succeeded",
        output_digest: "a".repeat(64),
        reused_operation_attempt_id: null,
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_operation", "run_operation", 4, {
        type: "operation_failed",
        operation_id: "op-1",
        status: "failed",
        error: null,
      }),
    );

    const after = state.tasksById.task_operation;
    expect(after.lastSequence).toBe(4);
    expect(after.sequenceGap).toBeNull();
    expect(after.messages).toEqual(before.messages);
    expect(after.runsById).toEqual(before.runsById);
    // The four operation events project a single grouped operation item
    // keyed by operation_id; the terminal event wins the status.
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({
      kind: "operation",
      operationId: "op-1",
      label: "build skeleton",
      category: "build",
      status: "failed",
      progress: { kind: "rows_parsed", current: 42, total: 100 },
    });
    expect(after.summary.status).toBe(before.summary.status);
    expect(after.summary.latest_sequence).toBe(4);
  });

  it("binds byte-level download progress to the running tool call", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_dl", "running", 0)),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_dl", "run_dl", 1, {
        type: "tool_started",
        tool_call_id: "call_xena",
        tool_name: "download_xena",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_dl", "run_dl", 2, {
        type: "operation_progress",
        operation_id: "tool:acquisition:downloaded_bytes",
        kind: "downloaded_bytes",
        current: 3411477,
        total: 1642160120,
        detail: { source: "xena", filename: "TCGA-GTEx-TARGET.log2.gz" },
      }),
    );
    const after = state.tasksById.task_dl;
    const toolItem = after.items.find(
      (item) => item.itemId === "tool:run_dl:call_xena",
    );
    expect(toolItem?.kind).toBe("tool_call");
    if (toolItem !== undefined && toolItem.kind === "tool_call") {
      expect(toolItem.progress).toMatchObject({
        kind: "downloaded_bytes",
        current: 3411477,
        total: 1642160120,
        detail: { source: "xena", filename: "TCGA-GTEx-TARGET.log2.gz" },
      });
    }
    // The grouped operation item is still projected alongside.
    expect(
      after.items.some(
        (item) =>
          item.itemId === "operation:run_dl:tool:acquisition:downloaded_bytes",
      ),
    ).toBe(true);
  });

  it("finalizes running operation items when the run completes (lifecycle gap safety net)", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_op_gap", "running", 0)),
      false,
    );
    // Progress-only operations (pre-lifecycle tool queries and the
    // ``tool:discovery:*`` aggregation) never receive a terminal event.
    state = reduceRuntimeEvent(
      state,
      envelope("task_op_gap", "run_op_gap", 1, {
        type: "operation_progress",
        operation_id: "tool:geo:query",
        kind: "query",
        current: 5,
        total: null,
        detail: { source: "geo", status: "success", query: "TP53" },
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_op_gap", "run_op_gap", 2, {
        type: "operation_progress",
        operation_id: "tool:discovery:discovered_records",
        kind: "discovered_records",
        current: 5,
        total: 20703,
        detail: {},
      }),
    );
    const before = state.tasksById.task_op_gap;
    expect(
      before.items.every(
        (item) => item.kind !== "operation" || item.status === "running",
      ),
    ).toBe(true);

    state = reduceRuntimeEvent(
      state,
      envelope("task_op_gap", "run_op_gap", 3, { type: "run_completed" }),
    );

    const after = state.tasksById.task_op_gap;
    const operations = after.items.filter((item) => item.kind === "operation");
    expect(operations).toHaveLength(2);
    for (const operation of operations) {
      expect(operation.status).toBe("completed");
    }
    // Progress payloads survive the terminalization.
    expect(
      after.items.find(
        (item) => item.kind === "operation" && item.operationId === "tool:geo:query",
      ),
    ).toMatchObject({
      status: "completed",
      progress: { kind: "query", current: 5, total: null },
    });
  });

  it("finalizes running operation items as failed when the run fails", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_op_gap_fail", "running", 0)),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_op_gap_fail", "run_op_gap_fail", 1, {
        type: "operation_progress",
        operation_id: "tool:pubmed:query",
        kind: "query",
        current: 5,
        total: null,
        detail: { source: "pubmed" },
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_op_gap_fail", "run_op_gap_fail", 2, {
        type: "run_failed",
        error: "Pi turn failed",
        error_code: "internal_error",
      }),
    );
    const operations = state.tasksById.task_op_gap_fail.items.filter(
      (item) => item.kind === "operation",
    );
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ status: "failed" });
  });

  it("caps the rendered timeline and drops the oldest items past ITEMS_CAP", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_cap", "running", 0)),
      false,
    );
    // 600 distinct tool calls → 600 tool items; the timeline must hold at
    // most ITEMS_CAP and keep only the newest tail.
    const ITEMS_CAP = 500;
    for (let sequence = 1; sequence <= 600; sequence += 1) {
      state = reduceRuntimeEvent(
        state,
        envelope("task_cap", "run_cap", sequence, {
          type: "tool_started",
          tool_call_id: `call_${sequence}`,
          tool_name: "search_literature",
        }),
      );
    }
    const task = state.tasksById.task_cap;
    expect(task.items).toHaveLength(ITEMS_CAP);
    // Oldest tool items were evicted; the newest tail survives.
    expect(
      task.items.some((item) => item.itemId === "tool:run_cap:call_1"),
    ).toBe(false);
    expect(
      task.items.some((item) => item.itemId === "tool:run_cap:call_600"),
    ).toBe(true);
    // itemSequences stays aligned with the surviving items.
    expect(Object.keys(task.itemSequences)).toHaveLength(ITEMS_CAP);
  });

  it("suppresses stage/progress timeline items for runs carrying operation events (R1S-01)", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_items", "running", 0)),
      false,
    );
    // Managed run: pipeline stage events are mirrored by operation events.
    // The timeline must render by operation identity (§17.2) — exactly one
    // operation item, no stage/progress duplicates for the same run.
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        1,
        { type: "stage_started", stage: "discovery", attempt: 1 },
        "stage_attempt_1",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 2, {
        type: "operation_started",
        operation_id: "op-1",
        label: "检索 PubMed",
        category: "discovery",
        attempt: 1,
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 3, {
        type: "operation_completed",
        operation_id: "op-1",
        status: "succeeded",
        output_digest: "a".repeat(64),
        reused_operation_attempt_id: null,
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        4,
        {
          type: "stage_completed",
          stage: "discovery",
          status: "succeeded",
          output_digest: "a".repeat(64),
        },
        "stage_attempt_1",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        5,
        {
          type: "stage_progress",
          stage: "discovery",
          kind: "records_discovered",
          current: 5,
          total: 10,
          detail: {},
        },
        "stage_attempt_1",
      ),
    );

    const items = state.tasksById.task_items.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "operation",
      itemId: "operation:run_items:op-1",
      operationId: "op-1",
      label: "检索 PubMed",
      category: "discovery",
      status: "completed",
    });
    // The stage state map is still tracked (drives pipeline status panels).
    expect(state.tasksById.task_items.stages.discovery!.status).toBe(
      "succeeded",
    );
  });

  it("keeps stage/progress timeline items when a run has no operation events (legacy compat, R1S-01)", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_items", "running", 0)),
      false,
    );
    // Legacy replay (pre-T3 events.jsonl): no operation events — stage and
    // progress items must still render unchanged.
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        1,
        { type: "stage_started", stage: "discovery", attempt: 1 },
        "stage_attempt_1",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        2,
        {
          type: "stage_completed",
          stage: "discovery",
          status: "succeeded",
          output_digest: "a".repeat(64),
        },
        "stage_attempt_1",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        3,
        {
          type: "stage_progress",
          stage: "discovery",
          kind: "records_discovered",
          current: 5,
          total: 10,
          detail: {},
        },
        "stage_attempt_1",
      ),
    );

    const items = state.tasksById.task_items.items;
    expect(items.map((item) => item.kind).sort()).toEqual([
      "progress",
      "stage",
    ]);
  });

  it("rejects a sequence gap without reducing or advancing the cursor", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_gap", "running", 4)),
      false,
    );
    expect(state.tasksById.task_gap.lastSequence).toBe(4);

    // A frame at 5 was dropped or rejected; the next valid frame is 6.
    // The cursor must NOT advance past the missing event, and the event
    // must not be reduced; a recoverable gap is recorded from 4.
    state = reduceRuntimeEvent(
      state,
      envelope("task_gap", "run_gap", 6, {
        type: "warning",
        code: "rate_limit",
        message: "Approaching rate limit",
      }),
    );
    expect(state.tasksById.task_gap.lastSequence).toBe(4);
    expect(state.tasksById.task_gap.sequenceGap).toEqual({
      expected: 5,
      received: 6,
    });
    expect(state.tasksById.task_gap.items).toHaveLength(0);

    // Replay 5 then 6 → both applied, cursor 6, gap healed.
    state = reduceRuntimeEvent(
      state,
      envelope("task_gap", "run_gap", 5, {
        type: "assistant_delta",
        delta: "five",
      }),
    );
    expect(state.tasksById.task_gap.lastSequence).toBe(5);
    expect(state.tasksById.task_gap.sequenceGap).toBeNull();

    state = reduceRuntimeEvent(
      state,
      envelope("task_gap", "run_gap", 6, {
        type: "warning",
        code: "rate_limit",
        message: "Approaching rate limit",
      }),
    );
    expect(state.tasksById.task_gap.lastSequence).toBe(6);
    expect(state.tasksById.task_gap.sequenceGap).toBeNull();
    // The replayed warning is now reduced (alongside the replayed delta).
    expect(
      state.tasksById.task_gap.items.some(
        (item) => item.kind === "warning",
      ),
    ).toBe(true);
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
      page(summary("task_a", "running", 2)),
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
  it("projects one report per publication with its exact run id", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_reports")),
      false,
    );
    const published = (runId: string, publicationId: string, sequence: number) =>
      envelope("task_reports", runId, sequence, {
        type: "publication_created",
        publication_id: publicationId,
        run_id: runId,
        manifest_sha256: "a".repeat(64),
        supersedes_publication_id: null,
        published_at: CREATED_AT,
      });

    state = reduceRuntimeEvent(state, published("run_first", "pub_first", 1));
    state = reduceRuntimeEvent(state, published("run_second", "pub_second", 2));

    expect(
      state.tasksById.task_reports.items.filter((item) => item.kind === "publication_report"),
    ).toEqual([
      expect.objectContaining({
        itemId: "publication:pub_first",
        runId: "run_first",
        taskId: "task_reports",
        publicationId: "pub_first",
      }),
      expect.objectContaining({
        itemId: "publication:pub_second",
        runId: "run_second",
        taskId: "task_reports",
        publicationId: "pub_second",
      }),
    ]);
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

  it("clears pending input for the owning run on run_cancel_requested", () => {
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
    expect(state.tasksById.task_a.pendingUserInput).not.toBeNull();

    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_prompt", 2, {
        type: "run_cancel_requested",
        reason: "user cancelled",
      }),
    );
    expect(state.tasksById.task_a.pendingUserInput).toBeNull();
    expect(state.tasksById.task_a.runsById.run_prompt?.status).toBe(
      "cancel_requested",
    );
    expect(state.tasksById.task_a.summary.status).toBe("cancel_requested");
  });

  it("keeps another run's pending input when a different run is cancel-requested", () => {
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
        type: "run_cancel_requested",
        reason: "stopped",
      }),
    );
    expect(state.tasksById.task_a.pendingUserInput).toMatchObject({
      runId: "run_prompt",
      requestId: "request_prompt",
    });
  });

  it("ignores a stale user_input_resumed for a superseded request without regressing state", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_a")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_a", 1, {
        type: "user_input_required",
        request_id: "request_new",
        prompt_kind: "plan_confirmation",
        summary: "Confirm the new plan",
        expires_at: null,
        fixture_exempt: false,
        detail: {},
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_a", 2, {
        type: "user_input_resumed",
        request_id: "request_old",
        decision: "approve",
        detail: {},
      }),
    );
    const task = state.tasksById.task_a;
    expect(task.pendingUserInput).toMatchObject({
      runId: "run_a",
      requestId: "request_new",
    });
    expect(task.summary.status).toBe("awaiting_user_input");
    expect(task.summary.active_run_id).toBe("run_a");
    expect(task.runsById.run_a?.status).toBe("awaiting_user_input");
  });

  it("ignores a user_input_resumed for a different run without regressing state", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_a")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_a", 1, {
        type: "user_input_required",
        request_id: "request_new",
        prompt_kind: "plan_confirmation",
        summary: "Confirm the new plan",
        expires_at: null,
        fixture_exempt: false,
        detail: {},
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_b", 2, {
        type: "user_input_resumed",
        request_id: "request_other",
        decision: "approve",
        detail: {},
      }),
    );
    const task = state.tasksById.task_a;
    expect(task.pendingUserInput).toMatchObject({
      runId: "run_a",
      requestId: "request_new",
    });
    expect(task.summary.status).toBe("awaiting_user_input");
    expect(task.summary.active_run_id).toBe("run_a");
    expect(task.runsById.run_b).toBeUndefined();
  });

  it("still applies a matching user_input_resumed as the running transition", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_a")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_a", 1, {
        type: "user_input_required",
        request_id: "request_new",
        prompt_kind: "plan_confirmation",
        summary: "Confirm the new plan",
        expires_at: null,
        fixture_exempt: false,
        detail: {},
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_a", "run_a", 2, {
        type: "user_input_resumed",
        request_id: "request_new",
        decision: "approve",
        detail: {},
      }),
    );
    const task = state.tasksById.task_a;
    expect(task.pendingUserInput).toBeNull();
    expect(task.summary.status).toBe("running");
    expect(task.summary.active_run_id).toBe("run_a");
    expect(task.runsById.run_a?.status).toBe("running");
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

  it("preserves conversation item identity across older-message page loads", () => {
    // Regression: re-projecting already-loaded messages used to hand every
    // memoized timeline row a fresh object on each older-page merge, forcing
    // the whole history to re-render (and re-parse markdown) per page — the
    // visible jank when scrolling up through a long conversation.
    const assistantMessage = (ordinal: number) =>
      message("task_history", ordinal, { role: "assistant" });
    let state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      taskSnapshot(
        "task_history",
        [assistantMessage(4), assistantMessage(5)],
        "cursor_before_4",
      ),
    );
    state = mergeOlderMessagePage(state, "task_history", "cursor_before_4", {
      messages: [
        assistantMessage(2),
        assistantMessage(3),
        assistantMessage(4),
      ],
      next_cursor: "cursor_before_2",
    });
    const itemsAfterFirstPage = state.tasksById.task_history.items;
    const findItem = (itemId: string) =>
      itemsAfterFirstPage.find((item) => item.itemId === itemId);
    expect(findItem("msg:message_2")).toBeDefined();
    expect(findItem("msg:message_4")).toBeDefined();

    state = mergeOlderMessagePage(state, "task_history", "cursor_before_2", {
      messages: [assistantMessage(1)],
      next_cursor: null,
    });
    const itemsAfterSecondPage = state.tasksById.task_history.items;
    expect(
      itemsAfterSecondPage.find((item) => item.itemId === "msg:message_2"),
    ).toBe(findItem("msg:message_2"));
    expect(
      itemsAfterSecondPage.find((item) => item.itemId === "msg:message_3"),
    ).toBe(findItem("msg:message_3"));
    expect(
      itemsAfterSecondPage.find((item) => item.itemId === "msg:message_4"),
    ).toBe(findItem("msg:message_4"));
    // The genuinely new page still lands.
    expect(
      itemsAfterSecondPage.some((item) => item.itemId === "msg:message_1"),
    ).toBe(true);
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

  it("renders duplicate durable user records once per run", () => {
    const state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      taskSnapshot(
        "task_duplicate_user",
        [
          message("task_duplicate_user", 1, {
            messageId: "user_first",
            runId: "run_duplicate",
            content: "question",
          }),
          message("task_duplicate_user", 57, {
            messageId: "user_replayed",
            runId: "run_duplicate",
            content: "question",
          }),
        ],
        null,
      ),
    );

    const task = state.tasksById.task_duplicate_user;
    expect(task.messages).toHaveLength(2);
    expect(
      task.items.filter((item) => item.kind === "user_message"),
    ).toEqual([
      expect.objectContaining({
        itemId: "user:run_duplicate",
        content: "question",
        sequence: 1,
      }),
    ]);
  });

  it("prefers event assistant segments when events arrive before hydration", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_event_first", "running")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_event_first", "run_event_first", 1, {
        type: "assistant_delta",
        delta: "answer",
        stream_id: "stream_event_first",
        from_chunk_index: 0,
        through_chunk_index: 0,
      }),
    );
    state = hydrateTaskSnapshot(
      state,
      taskSnapshot(
        "task_event_first",
        [
          message("task_event_first", 2, {
            messageId: "durable_assistant",
            runId: "run_event_first",
            role: "assistant",
            content: "answer",
          }),
        ],
        null,
        1,
      ),
    );

    expect(
      state.tasksById.task_event_first.items.filter(
        (item) => item.kind === "assistant_segment",
      ),
    ).toEqual([
      expect.objectContaining({
        itemId: "assistant:stream_event_first",
        streamId: "stream_event_first",
        content: "answer",
      }),
    ]);
  });

  it("evicts hydrated assistant fallback when its event arrives later", () => {
    let state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      taskSnapshot(
        "task_hydrate_first",
        [
          message("task_hydrate_first", 2, {
            messageId: "durable_assistant",
            runId: "run_hydrate_first",
            role: "assistant",
            content: "answer",
          }),
        ],
        null,
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_hydrate_first", "run_hydrate_first", 1, {
        type: "assistant_delta",
        delta: "answer",
        stream_id: "stream_hydrate_first",
        from_chunk_index: 0,
        through_chunk_index: 0,
      }),
    );

    expect(
      state.tasksById.task_hydrate_first.items.filter(
        (item) => item.kind === "assistant_segment",
      ),
    ).toEqual([
      expect.objectContaining({
        itemId: "assistant:stream_hydrate_first",
        streamId: "stream_hydrate_first",
        content: "answer",
      }),
    ]);
  });

  it("keeps hydrated assistant fallback when a run has no assistant events", () => {
    const state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      taskSnapshot(
        "task_legacy_assistant",
        [
          message("task_legacy_assistant", 2, {
            messageId: "legacy_assistant",
            runId: "run_legacy",
            role: "assistant",
            content: "legacy answer",
          }),
        ],
        null,
      ),
    );

    expect(
      state.tasksById.task_legacy_assistant.items.filter(
        (item) => item.kind === "assistant_segment",
      ),
    ).toEqual([
      expect.objectContaining({
        itemId: "msg:legacy_assistant",
        streamId: "hydrate:legacy_assistant",
        content: "legacy answer",
      }),
    ]);
  });

  it("keeps hydrated user messages on the event clock so ordering survives re-entry", () => {
    // Live path: user messages are created by run_queued events with the
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_reentry")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_reentry", "run_one", 1, {
        type: "run_queued",
        request_id: "req_one",
        input: "first request",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_reentry", "run_one", 2, {
        type: "assistant_delta",
        delta: "first reply",
        stream_id: "stream_one",
        from_chunk_index: 0,
        through_chunk_index: 0,
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_reentry", "run_two", 3, {
        type: "run_queued",
        request_id: "req_two",
        input: "second request",
      }),
    );

    const beforeHydrate = state.tasksById.task_reentry.items.map(
      (item) => item.kind,
    );
    expect(beforeHydrate).toEqual([
      "user_message",
      "assistant_segment",
      "user_message",
    ]);

    // Re-entry: hydrate from the snapshot. user messages come from
    // snapshot.messages (ordinals 1 and 2), which would sort before the
    // assistant reply at event sequence 2 without the fix.
    state = hydrateTaskSnapshot(
      state,
      taskSnapshot(
        "task_reentry",
        [
          message("task_reentry", 1, {
            messageId: "user_one",
            runId: "run_one",
            role: "user",
            content: "first request",
          }),
          message("task_reentry", 2, {
            messageId: "user_two",
            runId: "run_two",
            role: "user",
            content: "second request",
          }),
          message("task_reentry", 3, {
            messageId: "assistant_one",
            runId: "run_one",
            role: "assistant",
            content: "first reply",
          }),
        ],
        null,
        3,
      ),
    );

    const afterHydrate = state.tasksById.task_reentry.items.map(
      (item) => [item.kind, item.sequence] as const,
    );
    expect(afterHydrate).toEqual([
      ["user_message", 1],
      ["assistant_segment", 2],
      ["user_message", 3],
    ]);
  });

  it("falls back to ordinal when a user run_queued event was not replayed", () => {
    // Truncated event page: hydrate has no user_message items to capture
    // event sequences from, so projection must fall back to ordinal.
    const state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      taskSnapshot(
        "task_no_event",
        [
          message("task_no_event", 7, {
            messageId: "user_only",
            runId: "run_orphan",
            role: "user",
            content: "orphan request",
          }),
        ],
        null,
        0,
      ),
    );

    const userItem = state.tasksById.task_no_event.items.find(
      (item) => item.kind === "user_message",
    );
    expect(userItem?.sequence).toBe(7);
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

describe("conversation items projection", () => {
  function setup(taskId = "task_items") {
    return mergeTaskPage(
      createInitialRuntimeState(),
      page(summary(taskId)),
      false,
    );
  }

  it("creates an AssistantSegmentItem accumulating content from assistant_delta without stream_id", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "assistant_delta",
        delta: "Hello",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 2, {
        type: "assistant_delta",
        delta: " world",
      }),
    );

    const items = state.tasksById.task_items.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "assistant_segment",
      itemId: "assistant:live:run_items:0",
      runId: "run_items",
      // sequence is the first delta's position; later deltas must not move it.
      sequence: 1,
      content: "Hello world",
      isStreaming: false,
      finishReason: null,
    });
    expect(state.tasksById.task_items.itemSequences["assistant:live:run_items:0"]).toBe(1);
  });

  it("creates distinct AssistantSegmentItems per stream_id", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "assistant_delta",
        delta: "seg1",
        stream_id: "assistant:run_items:0",
        from_chunk_index: 0,
        through_chunk_index: 0,
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 2, {
        type: "assistant_delta",
        delta: "seg2",
        stream_id: "assistant:run_items:1",
        from_chunk_index: 0,
        through_chunk_index: 0,
      }),
    );

    const items = state.tasksById.task_items.items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      itemId: "assistant:assistant:run_items:0",
      content: "seg1",
    });
    expect(items[1]).toMatchObject({
      itemId: "assistant:assistant:run_items:1",
      content: "seg2",
    });
  });

  it("creates a ReasoningItem from assistant_reasoning_delta", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "assistant_reasoning_delta",
        delta: "Thinking...",
      }),
    );

    const items = state.tasksById.task_items.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "reasoning",
      itemId: "reasoning:run_items:0",
      runId: "run_items",
      content: "Thinking...",
      isStreaming: true,
    });
  });

  it("keeps replayed subagent reasoning out of the main conversation", () => {
    let state = setup();
    const childReasoning = {
      ...envelope("task_items", "run_items", 1, {
        type: "assistant_reasoning_delta",
        delta: "Inspecting GEO",
      }),
      subagent_id: "subagent_1",
      parent_tool_call_id: "call_parent_1",
    } as EventEnvelope;

    state = reduceRuntimeEvent(state, childReasoning);
    const afterFirstDelivery = state;
    state = reduceRuntimeEvent(state, childReasoning);
    state = reduceRuntimeEvent(state, {
      ...childReasoning,
      event_id: "event_task_items_2",
      sequence: 2,
      payload: {
        type: "assistant_reasoning_delta",
        delta: "Found a candidate",
      },
    });

    expect(afterFirstDelivery.tasksById.task_items.items).toEqual([]);
    expect(state.tasksById.task_items.items).toEqual([]);
    expect(state.tasksById.task_items.activitiesById["subagent_reasoning:subagent_1:run_items"])
      .toMatchObject({
        kind: "reasoning",
        subagentId: "subagent_1",
        output: "Inspecting GEOFound a candidate",
      });
    expect(reduceRuntimeEvent(afterFirstDelivery, childReasoning)).toBe(
      afterFirstDelivery,
    );
  });

  it("projects child tool activity for the subagent timeline only", () => {
    let state = setup();
    const childToolStarted = {
      ...envelope("task_items", "run_items", 1, {
        type: "tool_started",
        tool_call_id: "call_child_1",
        tool_name: "search_pubmed",
      }),
      subagent_id: "subagent_1",
      parent_tool_call_id: "call_parent_1",
    } as EventEnvelope;

    state = reduceRuntimeEvent(state, childToolStarted);
    state = reduceRuntimeEvent(state, {
      ...childToolStarted,
      event_id: "event_task_items_2",
      sequence: 2,
      type: "tool_completed",
      payload: {
        type: "tool_completed",
        tool_name: "search_pubmed",
        tool_call_id: "call_child_1",
        output: "Found 4 records",
        is_error: false,
      },
    });

    expect(state.tasksById.task_items.items).toEqual([]);
    expect(state.tasksById.task_items.activitiesById[
      "subagent_tool:subagent_1:run_items:call_child_1"
    ]).toMatchObject({
      subagentId: "subagent_1",
      name: "search_pubmed",
      output: "Found 4 records",
    });
  });

  it("splits reasoning into a new segment after tool_started", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "assistant_reasoning_delta",
        delta: "before tool",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 2, {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search_literature",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 3, {
        type: "assistant_reasoning_delta",
        delta: "after tool",
      }),
    );

    const reasoningItems = state.tasksById.task_items.items.filter(
      (i) => i.kind === "reasoning",
    );
    expect(reasoningItems).toHaveLength(2);
    expect(reasoningItems[0]).toMatchObject({
      itemId: "reasoning:run_items:0",
      content: "before tool",
      isStreaming: false,
    });
    expect(reasoningItems[1]).toMatchObject({
      itemId: "reasoning:run_items:1",
      content: "after tool",
      isStreaming: true,
    });
    expect(state.tasksById.task_items.currentReasoningSegmentByRun.run_items).toBe(1);
  });

  it("creates a ToolCallItem with arguments and status=running from tool_started", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search_pubmed",
        arguments: { query: "lung cancer", limit: 10 },
      }),
    );

    const items = state.tasksById.task_items.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "tool_call",
      itemId: "tool:run_items:call_1",
      toolCallId: "call_1",
      toolName: "search_pubmed",
      arguments: { query: "lung cancer", limit: 10 },
      status: "running",
      output: null,
      completedSequence: null,
    });
  });

  it("defaults arguments to null when tool_started omits the field", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search_pubmed",
      }),
    );

    expect(state.tasksById.task_items.items[0]).toMatchObject({
      kind: "tool_call",
      arguments: null,
    });
  });

  it("updates ToolCallItem to completed with output while preserving arguments", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search_pubmed",
        arguments: { query: "lung cancer" },
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 2, {
        type: "tool_completed",
        tool_call_id: "call_1",
        tool_name: "search_pubmed",
        output: "found 10 results",
        is_error: false,
      }),
    );

    const items = state.tasksById.task_items.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "tool_call",
      itemId: "tool:run_items:call_1",
      status: "completed",
      output: "found 10 results",
      completedSequence: 2,
      arguments: { query: "lung cancer" },
    });
  });

  it("marks ToolCallItem as error on tool_completed with is_error=true", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search_pubmed",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 2, {
        type: "tool_completed",
        tool_call_id: "call_1",
        tool_name: "search_pubmed",
        output: "network error",
        is_error: true,
      }),
    );

    expect(state.tasksById.task_items.items[0]).toMatchObject({
      status: "error",
      output: "network error",
    });
  });

  it("removes assistant_segment whose content is purely leaked tool-args JSON on tool_started", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "assistant_delta",
        delta: '{"query": "Alzheimer disease osteoporosis ',
        stream_id: "assistant:run_items:0",
        from_chunk_index: 0,
        through_chunk_index: 0,
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 2, {
        type: "assistant_delta",
        delta: 'comorbidity mechanism", "max_results": 20}',
        stream_id: "assistant:run_items:0",
        from_chunk_index: 1,
        through_chunk_index: 1,
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 3, {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search_pubmed",
        arguments: {
          query: "Alzheimer disease osteoporosis comorbidity mechanism",
          max_results: 20,
        },
      }),
    );

    const items = state.tasksById.task_items.items;
    const assistantSegments = items.filter(
      (i) => i.kind === "assistant_segment",
    );
    expect(assistantSegments).toHaveLength(0);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "tool_call",
      toolName: "search_pubmed",
      status: "running",
    });
  });

  it("strips only trailing tool-args JSON from assistant_segment, keeping preceding reasoning text", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "assistant_delta",
        delta: "Now searching for relevant literature.\n",
        stream_id: "assistant:run_items:0",
        from_chunk_index: 0,
        through_chunk_index: 0,
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 2, {
        type: "assistant_delta",
        delta: '{"query": "Alzheimer AND osteoporosis", "max_results": 20}',
        stream_id: "assistant:run_items:0",
        from_chunk_index: 1,
        through_chunk_index: 1,
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 3, {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search_pubmed",
        arguments: { query: "Alzheimer AND osteoporosis", max_results: 20 },
      }),
    );

    const items = state.tasksById.task_items.items;
    const segment = items.find((i) => i.kind === "assistant_segment");
    expect(segment).toBeDefined();
    expect(segment?.kind).toBe("assistant_segment");
    if (segment?.kind === "assistant_segment") {
      expect(segment.content).toBe("Now searching for relevant literature.");
    }
  });

  it("does not strip trailing JSON when keys do not match tool arguments", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "assistant_delta",
        delta: '{"unrelated": "value", "count": 5}',
        stream_id: "assistant:run_items:0",
        from_chunk_index: 0,
        through_chunk_index: 0,
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 2, {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search_pubmed",
        arguments: { query: "different", max_results: 10 },
      }),
    );

    const items = state.tasksById.task_items.items;
    const segment = items.find((i) => i.kind === "assistant_segment");
    expect(segment).toBeDefined();
    expect(segment?.kind).toBe("assistant_segment");
    if (segment?.kind === "assistant_segment") {
      expect(segment.content).toBe('{"unrelated": "value", "count": 5}');
    }
  });

  it("strips trailing JSON heuristically when tool_started has no arguments", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "assistant_delta",
        delta: '{"query": "cancer", "limit": 10}',
        stream_id: "assistant:run_items:0",
        from_chunk_index: 0,
        through_chunk_index: 0,
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 2, {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search_pubmed",
      }),
    );

    const items = state.tasksById.task_items.items;
    const assistantSegments = items.filter(
      (i) => i.kind === "assistant_segment",
    );
    expect(assistantSegments).toHaveLength(0);
  });

  it("creates a StageItem with status=running from stage_started", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        1,
        { type: "stage_started", stage: "discovery", attempt: 1 },
        "stage_attempt_1",
      ),
    );

    const items = state.tasksById.task_items.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "stage",
      itemId: "stage:run_items:discovery",
      stage: "discovery",
      status: "running",
      attempt: 1,
      error: null,
    });
  });

  it("updates StageItem to completed on stage_completed", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        1,
        { type: "stage_started", stage: "discovery", attempt: 1 },
        "stage_attempt_1",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        2,
        {
          type: "stage_completed",
          stage: "discovery",
          status: "succeeded",
          output_digest: "a".repeat(64),
        },
        "stage_attempt_1",
      ),
    );

    expect(state.tasksById.task_items.items[0]).toMatchObject({
      kind: "stage",
      status: "completed",
    });
  });

  it("updates StageItem to failed with error message on stage_failed", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        1,
        { type: "stage_started", stage: "acquisition", attempt: 1 },
        "stage_attempt_1",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        2,
        {
          type: "stage_failed",
          stage: "acquisition",
          status: "failed",
          error: {
            code: "download_failed",
            message: "GEO unavailable",
            retryable: true,
            stage: "acquisition",
            details: {},
          },
        },
        "stage_attempt_1",
      ),
    );

    expect(state.tasksById.task_items.items[0]).toMatchObject({
      kind: "stage",
      status: "failed",
      error: "GEO unavailable",
    });
  });

  it("updates StageItem to skipped on stage_skipped", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        1,
        { type: "stage_started", stage: "processing", attempt: 1 },
        "stage_attempt_1",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        2,
        {
          type: "stage_skipped",
          stage: "processing",
          status: "skipped",
          reason: "no data",
          reused_stage_attempt_id: null,
        },
        "stage_attempt_1",
      ),
    );

    expect(state.tasksById.task_items.items[0]).toMatchObject({
      kind: "stage",
      status: "skipped",
    });
  });

  it("creates a ProgressItem from stage_progress and upserts on update", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        1,
        { type: "stage_started", stage: "discovery", attempt: 1 },
        "stage_attempt_1",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        2,
        {
          type: "stage_progress",
          stage: "discovery",
          kind: "records_discovered",
          current: 5,
          total: 10,
          detail: {},
        },
        "stage_attempt_1",
      ),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(
        "task_items",
        "run_items",
        3,
        {
          type: "stage_progress",
          stage: "discovery",
          kind: "records_discovered",
          current: 8,
          total: 10,
          detail: {},
        },
        "stage_attempt_1",
      ),
    );

    const progressItems = state.tasksById.task_items.items.filter(
      (i) => i.kind === "progress",
    );
    expect(progressItems).toHaveLength(1);
    expect(progressItems[0]).toMatchObject({
      kind: "progress",
      itemId: "progress:run_items:discovery:records_discovered",
      stage: "discovery",
      progressKind: "records_discovered",
      current: 8,
      total: 10,
      // Progress updates merge into the first-entry item; its timeline
      // position (sequence 2, first stage_progress) is immutable.
      sequence: 2,
    });
  });

  it("creates a WarningItem from warning event", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "warning",
        code: "rate_limit",
        message: "Approaching rate limit",
      }),
    );

    const items = state.tasksById.task_items.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "warning",
      itemId: "warning:1",
      runId: "run_items",
      code: "rate_limit",
      message: "Approaching rate limit",
    });
  });

  it("creates an ArtifactItem from artifact_produced", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "artifact_produced",
        artifact: {
          artifact_id: "artifact_1",
          name: "result.csv",
          relative_path: "artifacts/result.csv",
          media_type: "text/csv",
          size_bytes: 1024,
          sha256: "a".repeat(64),
          generated_by_step_id: "step_1",
        },
      }),
    );

    const items = state.tasksById.task_items.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "artifact",
      itemId: "artifact:run_items:artifact_1",
      artifactId: "artifact_1",
      name: "result.csv",
      sizeBytes: 1024,
      mediaType: "text/csv",
    });
  });

  it("creates a user_message item for run_queued so the user's input is visible during LLM thinking", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "run_queued",
        request_id: "req_1",
        input: "question",
      }),
    );

    const items = state.tasksById.task_items.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "user_message",
      itemId: "user:run_items",
      runId: "run_items",
      content: "question",
    });
  });

  it("keeps a durable direction adjustment between the assistant segments it interrupts", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "run_queued",
        request_id: "req_1",
        input: "original question",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 2, {
        type: "assistant_delta",
        delta: "answer before steering",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 3, {
        type: "run_steered",
        input: "focus on TP53",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 4, {
        type: "assistant_delta",
        delta: "answer after steering",
      }),
    );

    const visibleTimeline = () =>
      state.tasksById.task_items.items
        .filter(
          (item) =>
            item.kind === "user_message" || item.kind === "assistant_segment",
        )
        .map((item) => [item.kind, item.sequence, item.content]);

    expect(visibleTimeline()).toEqual([
      ["user_message", 1, "original question"],
      ["assistant_segment", 2, "answer before steering"],
      ["user_message", 3, "focus on TP53"],
      ["assistant_segment", 4, "answer after steering"],
    ]);

    state = hydrateTaskSnapshot(state, {
      task: {
        ...summary("task_items", "running", 4),
        active_run_id: "run_items",
      },
      runs: [runRecord("task_items", "run_items", "running")],
      messages: [
        message("task_items", 1, {
          messageId: "message_event_task_items_1",
          runId: "run_items",
          content: "original question",
          sequence: 1,
        }),
        message("task_items", 2, {
          messageId: "message_before",
          runId: "run_items",
          role: "assistant",
          content: "answer before steering",
          sequence: 2,
        }),
        message("task_items", 3, {
          messageId: "message_event_task_items_3",
          runId: "run_items",
          content: "focus on TP53",
          sequence: 3,
        }),
        message("task_items", 4, {
          messageId: "message_after",
          runId: "run_items",
          role: "assistant",
          content: "answer after steering",
          sequence: 4,
        }),
      ],
      older_messages_cursor: null,
    });

    expect(visibleTimeline()).toEqual([
      ["user_message", 1, "original question"],
      ["assistant_segment", 2, "answer before steering"],
      ["user_message", 3, "focus on TP53"],
      ["assistant_segment", 4, "answer after steering"],
    ]);
  });

  it("creates a completed compaction timeline item for conversation_compacted", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "run_queued",
        request_id: "req_1",
        input: "question",
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 2, {
        type: "plan_ready",
        specification: { topic: "test" },
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 3, {
        type: "user_input_required",
        request_id: "req_1",
        prompt_kind: "plan_confirmation",
        summary: "Confirm",
        expires_at: null,
        fixture_exempt: false,
        detail: {},
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 4, {
        type: "conversation_compacted",
        compaction_id: "compaction-test-1",
        covered_through_run_id: "run_old",
        summary_digest: "digest",
      }),
    );

    // run_queued creates 1 user_message item; compaction creates its own timeline item.
    expect(state.tasksById.task_items.items).toHaveLength(2);
    expect(state.tasksById.task_items.items[0]).toMatchObject({
      kind: "user_message",
    });
    expect(state.tasksById.task_items.items[1]).toMatchObject({
      kind: "compaction",
      status: "completed",
    });
  });

  it("projects compaction started and failed status into the timeline", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "conversation_compaction_started",
        compaction_id: "compaction-running",
        covered_through_run_id: "run_items",
      }),
    );
    expect(state.tasksById.task_items.compacting).toBe(true);
    expect(state.tasksById.task_items.items[0]).toMatchObject({
      kind: "compaction",
      status: "running",
    });

    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 2, {
        type: "conversation_compaction_failed",
        compaction_id: "compaction-running",
        covered_through_run_id: "run_items",
        reason: "no_content",
        message: "Nothing to compact",
      }),
    );
    expect(state.tasksById.task_items.compacting).toBe(false);
    expect(state.tasksById.task_items.items[0]).toMatchObject({
      kind: "compaction",
      status: "no_content",
      message: "Nothing to compact",
    });
  });

  it("projects runtime context usage and keeps Pi's post-compaction estimate", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      page(summary("task_context")),
      false,
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_context", "run_context", 1, {
        type: "context_usage",
        tokens: 12_345,
        context_window: 131_072,
        percent: 9.41,
        source: "runtime",
      }),
    );
    expect(state.tasksById.task_context).toMatchObject({
      contextTokensUsed: 12_345,
      contextTokensSource: "runtime",
      contextWindow: 131_072,
      compacting: false,
    });

    state = reduceRuntimeEvent(
      state,
      envelope("task_context", "run_context", 2, {
        type: "conversation_compacted",
        compaction_id: "compaction-test-2",
        covered_through_run_id: "run_context",
        summary_digest: "digest",
        tokens_before: 100_000,
        estimated_tokens_after: 55_000,
        target_tokens: 60_000,
      }),
    );
    expect(state.tasksById.task_context).toMatchObject({
      contextTokensUsed: 55_000,
      contextTokensSource: "runtime",
      contextCompactionSequence: 2,
    });
  });

  it("deactivates streaming reasoning items on run_finalizing", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "assistant_reasoning_delta",
        delta: "thinking",
      }),
    );
    expect(state.tasksById.task_items.items[0]).toMatchObject({
      kind: "reasoning",
      isStreaming: true,
    });

    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 2, { type: "run_finalizing" }),
    );

    expect(state.tasksById.task_items.items[0]).toMatchObject({
      kind: "reasoning",
      isStreaming: false,
    });
  });

  it.each(["run_completed", "run_failed", "run_cancelled", "run_interrupted"] as const)(
    "deactivates streaming reasoning items on %s",
    (type) => {
      let state = setup();
      state = reduceRuntimeEvent(
        state,
        envelope("task_items", "run_items", 1, {
          type: "assistant_reasoning_delta",
          delta: "thinking",
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
        envelope("task_items", "run_items", 2, terminalPayload),
      );

      expect(state.tasksById.task_items.items[0]).toMatchObject({
        kind: "reasoning",
        isStreaming: false,
      });
    },
  );

  it("creates a per-run SearchInfoItem deduped by url", () => {
    let state = setup();
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, {
        type: "provider_search_info",
        results: [
          { site_name: "Nature", url: "https://nature.example/a" },
          { site_name: "PubMed", url: "https://pubmed.example/b" },
        ],
      }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 2, {
        type: "provider_search_info",
        results: [
          { site_name: "Nature", url: "https://nature.example/a" },
          { site_name: "ChEMBL", url: "https://chembl.example/c" },
        ],
      }),
    );

    const items = state.tasksById.task_items.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "search_info",
      itemId: "search_info:run_items",
      runId: "run_items",
    });
    expect((items[0] as { results: Array<{ url: string }> }).results).toHaveLength(3);
  });

  it("caps the SearchInfoItem results at twenty entries", () => {
    let state = setup();
    const results = Array.from({ length: 30 }, (_, index) => ({
      site_name: `Site ${index}`,
      url: `https://site-${index}.example`,
    }));
    state = reduceRuntimeEvent(
      state,
      envelope("task_items", "run_items", 1, { type: "provider_search_info", results }),
    );

    const items = state.tasksById.task_items.items;
    expect((items[0] as { results: unknown[] }).results).toHaveLength(20);
    expect(
      (items[0] as { results: Array<{ url: string }> }).results[
        (items[0] as { results: Array<{ url: string }> }).results.length - 1
      ]?.url,
    ).toBe("https://site-19.example");
  });
});
