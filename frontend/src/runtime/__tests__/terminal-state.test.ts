import { describe, expect, it } from "vitest";

import type {
  AgentRuntimeData,
  TaskProjection,
} from "@/runtime/types";
import type {
  EventEnvelope,
  EventPayload,
  TaskSummary,
} from "@/runtime/contracts";
import {
  createInitialRuntimeState,
  hydrateTaskSnapshot,
  mergeTaskPage,
  reduceRuntimeEvent,
} from "@/runtime/reducer";

const CREATED_AT = "2026-08-06T00:00:00Z";

function summary(taskId: string): TaskSummary {
  return {
    task_id: taskId,
    mode: "agent",
    databases: [],
    title: taskId,
    status: "running",
    active_run_id: "run_1",
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    latest_sequence: 0,
  };
}

function buildInitialTask(taskId: string): TaskProjection {
  const state = mergeTaskPage(
    createInitialRuntimeState(),
    { active_items: [summary(taskId)], items: [], next_cursor: null },
    false,
  );
  return state.tasksById[taskId];
}

function envelope(
  sequence: number,
  payload: EventPayload,
  runId: string | null = "run_1",
): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event_${sequence}`,
    type: payload.type,
    task_id: "task_1",
    run_id: runId,
    stage_attempt_id: null,
    sequence,
    timestamp: CREATED_AT,
    payload,
  } as EventEnvelope;
}

function stateWith(task: TaskProjection): AgentRuntimeData {
  return {
    ...createInitialRuntimeState(),
    tasksById: { [task.summary.task_id]: task },
    taskOrder: [task.summary.task_id],
  };
}

function applyEvent(
  task: TaskProjection,
  event: EventEnvelope,
): TaskProjection {
  const state = reduceRuntimeEvent(stateWith(task), event);
  return state.tasksById[task.summary.task_id];
}

function completedEnvelope(overrides?: object): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: "event_2",
    type: "run_completed",
    task_id: "task_1",
    run_id: "run_1",
    stage_attempt_id: null,
    sequence: 2,
    timestamp: CREATED_AT,
    payload: { type: "run_completed", build_result: null },
    ...overrides,
  } as EventEnvelope;
}

describe("terminal state projection", () => {
  it("aggregates run.summary from run_completed build_result", () => {
    const task = applyEvent(
      buildInitialTask("task_1"),
      completedEnvelope({
        payload: {
          type: "run_completed",
          build_result: {
            status: "no_data",
            valid_row_count: 0,
            successful_sources: [],
            rejected_sources: [],
            available_artifact_roles: [],
            publication_id: null,
            reason_codes: ["no_primary_data"],
            user_summary: "任务完成，但未产出可发布的主数据。",
            recommended_next_action: "调整检索条件后重试。",
          },
        },
      }),
    );
    const run = task.runsById["run_1"];
    expect(run.summary?.run_status).toBe("completed");
    expect(run.summary?.build_result?.status).toBe("no_data");
    expect(run.summary?.user_message).toBe("任务完成，但未产出可发布的主数据。");
  });

  it("keeps run.summary partial for a legacy run_completed without build_result", () => {
    const task = applyEvent(buildInitialTask("task_1"), completedEnvelope());
    const run = task.runsById["run_1"];
    expect(run.summary?.run_status).toBe("completed");
    expect(run.summary?.build_result).toBeNull();
    expect(run.summary?.user_message).toBeNull();
  });

  it("projects error_code and user_message on run_failed", () => {
    const task = applyEvent(
      buildInitialTask("task_1"),
      envelope(2, {
        type: "run_failed",
        error: "download aborted",
        error_code: "download_incomplete",
      }),
    );
    const run = task.runsById["run_1"];
    expect(run.summary?.run_status).toBe("failed");
    expect(run.summary?.error_code).toBe("download_incomplete");
    expect(run.summary?.user_message).toBe("download aborted");
    expect(run.error).toBe("download aborted");
  });

  it("projects cancelled_at_stage on run_cancelled", () => {
    const task = applyEvent(
      buildInitialTask("task_1"),
      envelope(2, {
        type: "run_cancelled",
        reason: "user stopped",
        cancelled_at_stage: "processing",
      }),
    );
    const run = task.runsById["run_1"];
    expect(run.summary?.run_status).toBe("cancelled");
    expect(run.summary?.cancelled_at_stage).toBe("processing");
    expect(run.summary?.user_message).toBe("user stopped");
  });

  it("tracks current_publication_id from publication_created", () => {
    let task = applyEvent(
      buildInitialTask("task_1"),
      envelope(2, {
        type: "publication_created",
        publication_id: "pub_1",
        run_id: "run_1",
        manifest_sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        supersedes_publication_id: null,
        published_at: CREATED_AT,
      }),
    );
    expect(task.currentPublicationId).toBe("pub_1");
    expect(task.publications).toHaveLength(1);
    expect(task.publications[0]).toMatchObject({
      publication_id: "pub_1",
      supersedes_publication_id: null,
    });

    task = applyEvent(
      task,
      envelope(3, {
        type: "publication_created",
        publication_id: "pub_2",
        run_id: "run_1",
        manifest_sha256:
          "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        supersedes_publication_id: null,
        published_at: CREATED_AT,
      }),
    );
    expect(task.currentPublicationId).toBe("pub_2");
    expect(task.publications).toHaveLength(2);
    expect(task.publications[1].supersedes_publication_id).toBe("pub_1");
  });

  it("rejects publication_created when payload run_id mismatches the envelope", () => {
    expect(() =>
      applyEvent(
        buildInitialTask("task_1"),
        envelope(2, {
          type: "publication_created",
          publication_id: "pub_1",
          run_id: "run_other",
          manifest_sha256:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          supersedes_publication_id: null,
          published_at: CREATED_AT,
        }),
      ),
    ).toThrow("payload run_id must match envelope run_id");
  });

  it("rejects publication_created without an envelope run_id", () => {
    expect(() =>
      applyEvent(
        buildInitialTask("task_1"),
        envelope(
          2,
          {
            type: "publication_created",
            publication_id: "pub_1",
            run_id: "run_1",
            manifest_sha256:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            supersedes_publication_id: null,
            published_at: CREATED_AT,
          },
          null,
        ),
      ),
    ).toThrow("publication events require run_id");
  });

  it("ignores a duplicate publication_created for the same publication_id", () => {
    const payload = (publicationId: string) => ({
      type: "publication_created" as const,
      publication_id: publicationId,
      run_id: "run_1",
      manifest_sha256:
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      supersedes_publication_id: null,
      published_at: CREATED_AT,
    });
    let task = applyEvent(buildInitialTask("task_1"), envelope(2, payload("pub_1")));
    expect(task.publications).toHaveLength(1);
    task = applyEvent(task, envelope(3, payload("pub_1")));
    expect(task.publications).toHaveLength(1);
    expect(task.currentPublicationId).toBe("pub_1");
    expect(task.publications[0].publication_id).toBe("pub_1");
  });

  it("clears a previously projected publication when the snapshot has null current_publication_id", () => {
    let task = buildInitialTask("task_1");
    task = applyEvent(
      task,
      envelope(2, {
        type: "publication_created",
        publication_id: "pub_1",
        run_id: "run_1",
        manifest_sha256:
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        supersedes_publication_id: null,
        published_at: CREATED_AT,
      }),
    );
    expect(task.currentPublicationId).toBe("pub_1");
    const hydrated = hydrateTaskSnapshot(stateWith(task), {
      task: {
        ...summary("task_1"),
        status: "completed",
        active_run_id: null,
        latest_sequence: 2,
      },
      runs: [],
      messages: [],
      current_publication_id: null,
      publications: [],
      older_messages_cursor: null,
    });
    expect(hydrated.tasksById["task_1"].currentPublicationId).toBeNull();
    expect(hydrated.tasksById["task_1"].publications).toHaveLength(0);
  });

  it("hydrates currentPublicationId and publications from a snapshot", () => {
    const state = hydrateTaskSnapshot(
      createInitialRuntimeState(),
      {
        task: { ...summary("task_1"), status: "completed", active_run_id: null },
        runs: [],
        messages: [],
        current_publication_id: "pub_1",
        publications: [
          {
            publication_id: "pub_1",
            manifest_sha256:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            supersedes_publication_id: null,
            published_at: CREATED_AT,
          },
        ],
        older_messages_cursor: null,
      },
    );
    expect(state.tasksById["task_1"].currentPublicationId).toBe("pub_1");
    expect(state.tasksById["task_1"].publications).toHaveLength(1);
    expect(state.tasksById["task_1"].publications[0].publication_id).toBe(
      "pub_1",
    );
  });
});
