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

function subagentToolEnvelope(sequence: number): EventEnvelope {
  return {
    ...envelope(sequence, {
      type: "tool_started",
      tool_call_id: "child_tool_1",
      tool_name: "search_sources",
    }),
    subagent_id: "subagent_1",
    parent_tool_call_id: "call_parent_1",
  } as EventEnvelope;
}

function assistantText(state: AgentRuntimeData, runId = "run_a"): string {
  return (
    state.tasksById.task_a.messages.find(
      (message) => message.runId === runId && message.role === "assistant",
    )?.content ?? ""
  );
}

describe("realtime assistant projection", () => {
  it("keeps child tool events out of the main conversation", () => {
    const state = reduceRuntimeEvent(stateWithTask(), subagentToolEnvelope(1));

    const task = state.tasksById.task_a;
    expect(task.items).toEqual([]);
    expect(task.activitiesById["tool:run_a:child_tool_1"]).toMatchObject({
      kind: "tool",
      name: "search_sources",
    });
  });

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
      durableText: "",
      liveStreamOrder: ["assistant:run_a"],
      streamsById: {
        "assistant:run_a": {
          confirmedThroughChunkIndex: -1,
          active: true,
          pendingChunks: { 0: "你好", 1: "🙂" },
        },
      },
      conflicts: [
        {
          taskId: "task_a",
          runId: "run_a",
          streamId: "assistant:run_a",
          chunkIndex: 0,
          count: 1,
        },
      ],
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
      streamsById: {
        "assistant:run_a": {
          confirmedThroughChunkIndex: 1,
          pendingChunks: {},
        },
      },
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
      state.tasksById.task_a.assistantStreamsByRunId.run_a.streamsById[
        "assistant:run_a"
      ].pendingChunks,
    ).toEqual({ 2: "🙂" });
    expect(state.tasksById.task_a.lastSequence).toBe(1);
  });

  it("drops unknown live-only segments when the first durable identity is authoritative", () => {
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
    expect(state.tasksById.task_a.assistantStreamsByRunId.run_a).toMatchObject({
      durableText: "correct🙂",
      liveStreamOrder: ["assistant:run_a"],
      streamsById: {
        "assistant:run_a": {
          pendingChunks: {},
          confirmedThroughChunkIndex: 0,
          active: false,
          durableSeen: true,
        },
      },
    });
    expect(
      state.tasksById.task_a.messages.find(
        (message) => message.runId === "run_a" && message.role === "assistant",
      )?.sequence,
    ).toBe(1);
  });

  it("keeps multiple ended and active segments per run without cross-ending them", () => {
    let state = reduceAssistantStreamFrames(stateWithTask(), [
      delta(0, "A", "run_a", "opaque-a"),
      {
        type: "assistant_stream_end",
        task_id: "task_a",
        run_id: "run_a",
        stream_id: "opaque-a",
        last_chunk_index: 0,
        finish_reason: "tool",
      },
      delta(0, "B", "run_a", "opaque-b"),
    ]);

    expect(assistantText(state)).toBe("AB");

    state = reduceAssistantStreamFrames(state, [
      {
        type: "assistant_stream_end",
        task_id: "task_a",
        run_id: "run_a",
        stream_id: "opaque-a",
        last_chunk_index: 0,
        finish_reason: "late",
      },
    ]);

    expect(
      state.tasksById.task_a.assistantStreamsByRunId.run_a.streamsById[
        "opaque-a"
      ].active,
    ).toBe(false);
    expect(
      state.tasksById.task_a.assistantStreamsByRunId.run_a.streamsById[
        "opaque-b"
      ].active,
    ).toBe(true);

    state = reduceRuntimeEvent(
      state,
      envelope(1, {
        type: "assistant_delta",
        delta: "A",
        stream_id: "opaque-a",
        from_chunk_index: 0,
        through_chunk_index: 0,
      }),
    );
    expect(assistantText(state)).toBe("AB");

    state = reduceRuntimeEvent(
      state,
      envelope(2, {
        type: "assistant_delta",
        delta: "B",
        stream_id: "opaque-b",
        from_chunk_index: 0,
        through_chunk_index: 0,
      }),
    );
    expect(assistantText(state)).toBe("AB");
  });

  it.each<EventPayload>([
    { type: "tool_started", tool_call_id: "call_1", tool_name: "search" },
    { type: "run_finalizing" },
    { type: "run_completed" },
    { type: "run_failed", error: "boom" },
    { type: "run_cancel_requested", reason: "stop" },
    { type: "run_cancelled", reason: "stop" },
    { type: "run_interrupted", reason: "restart" },
  ])("deactivates an active stream on $type", (payload) => {
    const streaming = reduceAssistantStreamFrames(stateWithTask(), [
      delta(0, "visible"),
    ]);

    const state = reduceRuntimeEvent(streaming, envelope(1, payload));

    expect(
      Object.values(
        state.tasksById.task_a.assistantStreamsByRunId.run_a.streamsById,
      ).some((stream) => stream.active),
    ).toBe(false);
    expect(assistantText(state)).toBe("visible");
  });

  it("rolls unconfirmed text back on disconnect and removes an empty ephemeral message", () => {
    const streaming = reduceAssistantStreamFrames(stateWithTask(), [
      delta(0, "保留🙂"),
    ]);

    const state = deactivateAssistantStreams(streaming);

    expect(assistantText(state)).toBe("");
    expect(state.tasksById.task_a.messages).toHaveLength(0);
    expect(
      state.tasksById.task_a.assistantStreamsByRunId.run_a.streamsById[
        "assistant:run_a"
      ].pendingChunks,
    ).toEqual({});
  });

  it("rolls back to durable text while retaining watermarks for late dedupe", () => {
    let state = reduceRuntimeEvent(
      stateWithTask(),
      envelope(1, {
        type: "assistant_delta",
        delta: "durable",
        stream_id: "opaque-a",
        from_chunk_index: 0,
        through_chunk_index: 0,
      }),
    );
    state = reduceAssistantStreamFrames(state, [
      delta(1, "+pending", "run_a", "opaque-a"),
    ]);
    expect(assistantText(state)).toBe("durable+pending");

    state = deactivateAssistantStreams(state, "task_a");

    expect(assistantText(state)).toBe("durable");
    expect(
      state.tasksById.task_a.assistantStreamsByRunId.run_a.streamsById[
        "opaque-a"
      ],
    ).toMatchObject({
      pendingChunks: {},
      confirmedThroughChunkIndex: 0,
      active: false,
    });
  });

  it("replaces pending realtime text when a legacy durable delta arrives", () => {
    let state = reduceAssistantStreamFrames(stateWithTask(), [
      delta(0, "legacy"),
    ]);

    state = reduceRuntimeEvent(
      state,
      envelope(1, {
        type: "assistant_delta",
        delta: "legacy",
        stream_id: null,
        from_chunk_index: null,
        through_chunk_index: null,
      }),
    );

    expect(assistantText(state)).toBe("legacy");
    expect(
      state.tasksById.task_a.assistantStreamsByRunId.run_a.durableText,
    ).toBe("legacy");
  });

  it("bounds conflicting duplicate diagnostics without storing chunk text", () => {
    const frames: AssistantStreamFrame[] = [];
    for (let index = 0; index < 40; index += 1) {
      frames.push(delta(index, `first-${index}`));
      frames.push(delta(index, `second-${index}`));
    }
    const state = reduceAssistantStreamFrames(stateWithTask(), frames);
    const diagnostics =
      state.tasksById.task_a.assistantStreamsByRunId.run_a.conflicts;

    expect(diagnostics).toHaveLength(32);
    expect(diagnostics[0]).toEqual({
      taskId: "task_a",
      runId: "run_a",
      streamId: "assistant:run_a",
      chunkIndex: 0,
      count: 1,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("first-");
    expect(JSON.stringify(diagnostics)).not.toContain("second-");
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
