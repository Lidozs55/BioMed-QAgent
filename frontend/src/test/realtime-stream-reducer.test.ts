import { describe, expect, it } from "vitest";

import type {
  AssistantStreamFrame,
  EventEnvelope,
  EventPayload,
  TaskSummary,
} from "@/runtime/contracts";
import {
  createInitialRuntimeState,
  deactivateAssistantStreams,
  hydrateTaskSnapshot,
  mergeTaskPage,
  reduceAssistantStreamFrames,
  reduceRuntimeEvent,
} from "@/runtime/reducer";
import type { AgentRuntimeData } from "@/runtime/types";

const TIMESTAMP = "2026-07-18T00:00:00Z";

function summary(taskId: string): TaskSummary {
  return {
    task_id: taskId,
    mode: "agent",
    databases: [],
    title: taskId,
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
    { active_items: [summary("task_a")], items: [], next_cursor: null },
    false,
  );
}

function delta(
  chunkIndex: number,
  text: string,
  runId = "run_a",
  streamId = `assistant:${runId}`,
): AssistantStreamFrame {
  return {
    type: "assistant_stream_delta",
    task_id: "task_a",
    run_id: runId,
    stream_id: streamId,
    chunk_index: chunkIndex,
    delta: text,
  };
}

function envelope(
  sequence: number,
  payload: EventPayload,
  runId = "run_a",
): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event_${sequence}`,
    type: payload.type,
    task_id: "task_a",
    run_id: runId,
    stage_attempt_id: null,
    sequence,
    timestamp: TIMESTAMP,
    payload,
  };
}

function assistantText(state: AgentRuntimeData, runId = "run_a"): string {
  return (
    state.tasksById.task_a.messages.find(
      (message) => message.runId === runId && message.role === "assistant",
    )?.content ?? ""
  );
}

describe("realtime assistant projection", () => {
  it("keeps chunks after a gap pending until the missing index arrives", () => {
    let state = reduceAssistantStreamFrames(stateWithTask(), [delta(2, "C")]);
    expect(assistantText(state)).toBe("");

    state = reduceAssistantStreamFrames(state, [delta(0, "A")]);
    expect(assistantText(state)).toBe("A");

    state = reduceAssistantStreamFrames(state, [delta(1, "B")]);
    expect(assistantText(state)).toBe("ABC");
  });

  it("reconciles duplicate and out-of-order Unicode chunks with a durable range", () => {
    let state = reduceAssistantStreamFrames(stateWithTask(), [
      delta(1, "🙂"),
      delta(0, "你好"),
      delta(1, "🙂"),
      delta(0, "conflict"),
    ]);

    expect(assistantText(state)).toBe("你好🙂");
    expect(state.tasksById.task_a.lastSequence).toBe(0);
    expect(state.tasksById.task_a.assistantStreamsByRunId.run_a).toMatchObject({
      streamId: "assistant:run_a",
      durableText: "",
      confirmedThroughChunkIndex: -1,
      active: true,
      pendingChunks: { 0: "你好", 1: "🙂" },
    });

    state = reduceRuntimeEvent(
      state,
      envelope(1, {
        type: "assistant_delta",
        delta: "你好🙂",
        stream_id: "assistant:run_a",
        from_chunk_index: 0,
        through_chunk_index: 1,
      }),
    );

    expect(assistantText(state)).toBe("你好🙂");
    expect(state.tasksById.task_a.assistantStreamsByRunId.run_a).toMatchObject({
      durableText: "你好🙂",
      confirmedThroughChunkIndex: 1,
      pendingChunks: {},
    });
  });

  it("ignores late realtime chunks at or below the durable watermark", () => {
    let state = reduceRuntimeEvent(
      stateWithTask(),
      envelope(1, {
        type: "assistant_delta",
        delta: "先到",
        stream_id: "assistant:run_a",
        from_chunk_index: 0,
        through_chunk_index: 1,
      }),
    );

    state = reduceAssistantStreamFrames(state, [
      delta(0, "先"),
      delta(1, "到"),
      delta(2, "🙂"),
    ]);

    expect(assistantText(state)).toBe("先到🙂");
    expect(
      state.tasksById.task_a.assistantStreamsByRunId.run_a.pendingChunks,
    ).toEqual({ 2: "🙂" });
    expect(state.tasksById.task_a.lastSequence).toBe(1);
  });

  it("replaces a wrong live stream identity with the authoritative durable stream", () => {
    let state = reduceAssistantStreamFrames(stateWithTask(), [
      delta(0, "wrong", "run_a", "wrong-stream"),
    ]);
    expect(assistantText(state)).toBe("wrong");

    state = reduceRuntimeEvent(
      state,
      envelope(1, {
        type: "assistant_delta",
        delta: "correct🙂",
        stream_id: "assistant:run_a",
        from_chunk_index: 0,
        through_chunk_index: 0,
      }),
    );

    expect(assistantText(state)).toBe("correct🙂");
    expect(state.tasksById.task_a.lastSequence).toBe(1);
    expect(state.tasksById.task_a.assistantStreamsByRunId.run_a).toEqual({
      streamId: "assistant:run_a",
      durableText: "correct🙂",
      pendingChunks: {},
      confirmedThroughChunkIndex: 0,
      active: false,
    });
    expect(
      state.tasksById.task_a.messages.find(
        (message) => message.runId === "run_a" && message.role === "assistant",
      )?.sequence,
    ).toBe(1);
  });

  it("only ends the matching run and stream", () => {
    let state = reduceAssistantStreamFrames(stateWithTask(), [
      delta(0, "A", "run_a"),
      delta(0, "B", "run_b"),
    ]);

    state = reduceAssistantStreamFrames(state, [
      {
        type: "assistant_stream_end",
        task_id: "task_a",
        run_id: "run_a",
        stream_id: "wrong",
        last_chunk_index: 0,
        finish_reason: "stop",
      },
      {
        type: "assistant_stream_end",
        task_id: "task_a",
        run_id: "run_a",
        stream_id: "assistant:run_a",
        last_chunk_index: 0,
        finish_reason: "stop",
      },
    ]);

    expect(
      state.tasksById.task_a.assistantStreamsByRunId.run_a.active,
    ).toBe(false);
    expect(
      state.tasksById.task_a.assistantStreamsByRunId.run_b.active,
    ).toBe(true);
  });

  it.each<EventPayload>([
    { type: "tool_started", tool_call_id: "call_1", tool_name: "search" },
    { type: "run_finalizing" },
    { type: "run_completed" },
    { type: "run_failed", error: "boom" },
    { type: "run_cancelled", reason: "stop" },
    { type: "run_interrupted", reason: "restart" },
  ])("deactivates an active stream on $type", (payload) => {
    const streaming = reduceAssistantStreamFrames(stateWithTask(), [
      delta(0, "visible"),
    ]);

    const state = reduceRuntimeEvent(streaming, envelope(1, payload));

    expect(
      state.tasksById.task_a.assistantStreamsByRunId.run_a.active,
    ).toBe(false);
    expect(assistantText(state)).toBe("visible");
  });

  it("deactivates all streams without deleting visible pending text", () => {
    const streaming = reduceAssistantStreamFrames(stateWithTask(), [
      delta(0, "保留🙂"),
    ]);

    const state = deactivateAssistantStreams(streaming);

    expect(assistantText(state)).toBe("保留🙂");
    expect(
      state.tasksById.task_a.assistantStreamsByRunId.run_a.pendingChunks,
    ).toEqual({ 0: "保留🙂" });
    expect(
      state.tasksById.task_a.assistantStreamsByRunId.run_a.active,
    ).toBe(false);
  });

  it("lets an authoritative snapshot replace a pending realtime message", () => {
    const streaming = reduceAssistantStreamFrames(stateWithTask(), [
      delta(0, "最终🙂"),
    ]);

    const state = hydrateTaskSnapshot(streaming, {
      task: { ...summary("task_a"), latest_sequence: 1 },
      runs: [],
      messages: [
        {
          message_id: "message_durable",
          task_id: "task_a",
          run_id: "run_a",
          ordinal: 1,
          role: "assistant",
          content: "最终🙂",
          created_at: TIMESTAMP,
        },
      ],
      older_messages_cursor: null,
    });

    expect(assistantText(state)).toBe("最终🙂");
    expect(state.tasksById.task_a.messages).toHaveLength(1);
    expect(state.tasksById.task_a.assistantStreamsByRunId.run_a).toBeUndefined();
  });

  it("keeps legacy metadata-free durable deltas append-compatible", () => {
    let state = reduceRuntimeEvent(
      stateWithTask(),
      envelope(1, { type: "assistant_delta", delta: "旧" }),
    );
    state = reduceRuntimeEvent(
      state,
      envelope(2, { type: "assistant_delta", delta: "协议🙂" }),
    );

    expect(assistantText(state)).toBe("旧协议🙂");
    expect(state.tasksById.task_a.lastSequence).toBe(2);
  });
});
