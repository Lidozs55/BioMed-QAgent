import { beforeEach, describe, expect, it } from "vitest";

import type { TaskSummary } from "@/runtime/contracts";
import {
  clearTaskProjection,
  loadTaskProjection,
  saveTaskProjection,
} from "@/runtime/hydrationCache";
import { createTaskProjection } from "@/runtime/reducer";

const CREATED_AT = "2026-07-14T00:00:00Z";

function summary(taskId: string, latestSequence = 3): TaskSummary {
  return {
    task_id: taskId,
    mode: "agent",
    databases: [],
    title: taskId,
    status: "completed",
    active_run_id: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    latest_sequence: latestSequence,
  };
}

describe("hydration cache", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("round-trips a fully hydrated projection", () => {
    const task = createTaskProjection(summary("task_cache", 3));
    task.items = [
      {
        itemId: "assistant:live:run_cache:0",
        kind: "assistant_segment",
        runId: "run_cache",
        sequence: 2,
        createdAt: CREATED_AT,
        streamId: "live:run_cache:0",
        content: "cached answer",
        isStreaming: false,
        finishReason: null,
      },
    ];
    saveTaskProjection(task);

    const loaded = loadTaskProjection("task_cache");
    expect(loaded).not.toBeNull();
    expect(loaded?.lastSequence).toBe(3);
    expect(loaded?.hydration).toBe("snapshot");
    expect(loaded?.items).toEqual(task.items);
  });

  it("preserves assistant stream watermarks verbatim for delta deduplication", () => {
    const task = createTaskProjection(summary("task_cache", 5));
    task.assistantStreamsByRunId = {
      run_cache: {
        durableText: "cached answer",
        liveStreamOrder: ["stream_1"],
        streamsById: {
          stream_1: {
            streamId: "stream_1",
            pendingChunks: { 41: "tail" },
            confirmedThroughChunkIndex: 40,
            active: false,
            durableSeen: true,
            finishReason: null,
          },
        },
        conflicts: [],
      },
    };
    saveTaskProjection(task);

    const loaded = loadTaskProjection("task_cache");
    expect(loaded?.assistantStreamsByRunId).toEqual(
      task.assistantStreamsByRunId,
    );
  });

  it("returns null for corrupt JSON and drops the entry", () => {
    localStorage.setItem("biomed-qagent:task-projection:v2:task_cache", "{nope");

    expect(loadTaskProjection("task_cache")).toBeNull();
    expect(
      localStorage.getItem("biomed-qagent:task-projection:v2:task_cache"),
    ).toBeNull();
  });

  it("returns null when the cached projection belongs to another task", () => {
    saveTaskProjection(createTaskProjection(summary("task_other", 1)));

    expect(loadTaskProjection("task_cache")).toBeNull();
  });

  it("clearTaskProjection removes the entry", () => {
    saveTaskProjection(createTaskProjection(summary("task_cache", 1)));

    clearTaskProjection("task_cache");

    expect(loadTaskProjection("task_cache")).toBeNull();
  });
});
