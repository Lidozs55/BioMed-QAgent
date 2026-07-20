import { describe, expect, it } from "vitest";

import type {
  EventEnvelope,
  EventPayload,
  MessageRecord,
  TaskSnapshot,
  TaskSummary,
} from "@/runtime/contracts";
import {
  createInitialRuntimeState,
  hydrateTaskSnapshot,
  mergeOlderMessagePage,
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

function snapshot(
  taskId: string,
  messages: MessageRecord[],
  options: {
    olderMessagesCursor?: string | null;
    latestSequence?: number;
    status?: TaskSummary["status"];
  } = {},
): TaskSnapshot {
  const {
    olderMessagesCursor = null,
    latestSequence = 0,
    status = "completed",
  } = options;
  return {
    task: summary(taskId, status, latestSequence),
    runs: [],
    messages,
    older_messages_cursor: olderMessagesCursor,
  };
}

function envelope(
  taskId: string,
  runId: string | null,
  sequence: number,
  payload: EventPayload,
): EventEnvelope {
  return {
    schema_version: runId === null ? "1.0" : "2.0",
    event_id: `event_${taskId}_${sequence}`,
    type: payload.type,
    task_id: taskId,
    run_id: runId,
    stage_attempt_id: null,
    sequence,
    timestamp: `2026-07-14T00:00:${String(sequence).padStart(2, "0")}Z`,
    payload,
  } as EventEnvelope;
}

describe("hydrate compatibility", () => {
  it("maps a user MessageRecord to a UserMessageItem", () => {
    const state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      snapshot("task_hydrate", [
        message("task_hydrate", 1, {
          messageId: "msg_user",
          runId: "run_1",
          role: "user",
          content: "question",
        }),
      ]),
    );

    const items = state.tasksById.task_hydrate.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "user_message",
      itemId: "msg:msg_user",
      runId: "run_1",
      content: "question",
    });
  });

  it("maps an assistant MessageRecord to an AssistantSegmentItem", () => {
    const state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      snapshot("task_hydrate", [
        message("task_hydrate", 1, {
          messageId: "msg_assistant",
          runId: "run_1",
          role: "assistant",
          content: "answer",
        }),
      ]),
    );

    const items = state.tasksById.task_hydrate.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "assistant_segment",
      itemId: "msg:msg_assistant",
      streamId: "hydrate:msg_assistant",
      content: "answer",
      isStreaming: false,
      finishReason: null,
    });
  });

  it("ignores system and tool role messages", () => {
    const state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      snapshot("task_hydrate", [
        message("task_hydrate", 1, {
          role: "system",
          content: "system prompt",
        }),
        message("task_hydrate", 2, {
          role: "tool",
          content: "tool result",
        }),
      ]),
    );

    expect(state.tasksById.task_hydrate.items).toHaveLength(0);
  });

  it("preserves hydrate-created items when later events arrive", () => {
    let state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      snapshot(
        "task_hydrate",
        [
          message("task_hydrate", 1, {
            messageId: "msg_user",
            runId: "run_live",
            role: "user",
            content: "question",
          }),
        ],
        { latestSequence: 1, status: "running" },
      ),
    );

    state = reduceRuntimeEvent(
      state,
      envelope("task_hydrate", "run_live", 2, {
        type: "assistant_delta",
        delta: "answer",
      }),
    );

    const items = state.tasksById.task_hydrate.items;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      kind: "user_message",
      itemId: "msg:msg_user",
    });
    expect(items[1]).toMatchObject({
      kind: "assistant_segment",
      itemId: "assistant:live:run_live:0",
    });
  });

  it("sorts hydrate-created items by message ordinal", () => {
    const state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      snapshot("task_hydrate", [
        message("task_hydrate", 4, {
          messageId: "msg_4",
          runId: "run_1",
          role: "user",
          content: "q4",
        }),
        message("task_hydrate", 5, {
          messageId: "msg_5",
          runId: "run_1",
          role: "assistant",
          content: "a5",
        }),
      ]),
    );

    const items = state.tasksById.task_hydrate.items;
    expect(items.map((i) => i.itemId)).toEqual(["msg:msg_4", "msg:msg_5"]);
  });

  it("mergeOlderMessagePage adds items for newly loaded messages", () => {
    let state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      snapshot(
        "task_hydrate",
        [
          message("task_hydrate", 4, {
            messageId: "msg_4",
            runId: "run_1",
            role: "user",
            content: "q4",
          }),
          message("task_hydrate", 5, {
            messageId: "msg_5",
            runId: "run_1",
            role: "assistant",
            content: "a5",
          }),
        ],
        { olderMessagesCursor: "cursor_before_4", latestSequence: 5 },
      ),
    );
    expect(state.tasksById.task_hydrate.items).toHaveLength(2);

    state = mergeOlderMessagePage(
      state,
      "task_hydrate",
      "cursor_before_4",
      {
        messages: [
          message("task_hydrate", 2, {
            messageId: "msg_2",
            runId: "run_1",
            role: "user",
            content: "q2",
          }),
          message("task_hydrate", 3, {
            messageId: "msg_3",
            runId: "run_1",
            role: "assistant",
            content: "a3",
          }),
        ],
        next_cursor: null,
      },
    );

    const items = state.tasksById.task_hydrate.items;
    expect(items.map((i) => i.itemId)).toEqual([
      "msg:msg_2",
      "msg:msg_3",
      "msg:msg_4",
      "msg:msg_5",
    ]);
  });

  it("mergeOlderMessagePage upserts rather than duplicates existing items", () => {
    let state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      snapshot(
        "task_hydrate",
        [
          message("task_hydrate", 4, {
            messageId: "msg_4",
            runId: "run_1",
            role: "user",
            content: "q4 original",
          }),
        ],
        { olderMessagesCursor: "cursor_before_4", latestSequence: 5 },
      ),
    );

    // Older page re-delivers msg_4 with same messageId but updated content
    state = mergeOlderMessagePage(
      state,
      "task_hydrate",
      "cursor_before_4",
      {
        messages: [
          message("task_hydrate", 4, {
            messageId: "msg_4",
            runId: "run_1",
            role: "user",
            content: "q4 refreshed",
          }),
        ],
        next_cursor: null,
      },
    );

    const items = state.tasksById.task_hydrate.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "user_message",
      itemId: "msg:msg_4",
      content: "q4 refreshed",
    });
  });
});
