import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  EventEnvelope,
  MessagePage,
  TaskPage,
  TaskSnapshot,
  TaskSummary,
} from "@/runtime/contracts";
import { createInitialRuntimeState } from "@/runtime/reducer";
import {
  addAcceptedTask,
  AGENT_STORE_NAME,
  mergeTaskArtifacts,
  useAgentStore,
} from "@/stores/agentStore";

const CREATED_AT = "2026-07-14T00:00:00Z";

function summary(
  taskId: string,
  status: TaskSummary["status"],
  latestSequence: number,
  createdAt = CREATED_AT,
): TaskSummary {
  return {
    task_id: taskId,
    mode: "agent",
    databases: ["pubmed"],
    title: `Task ${taskId}`,
    status,
    active_run_id:
      status === "queued" ||
      status === "running" ||
      status === "finalizing" ||
      status === "cancel_requested"
        ? `run_${taskId}`
        : null,
    created_at: createdAt,
    updated_at: createdAt,
    latest_sequence: latestSequence,
  };
}

function page(
  activeItems: TaskSummary[],
  items: TaskSummary[],
  nextCursor: string | null,
): TaskPage {
  return {
    schema_version: "1.0",
    active_items: activeItems,
    items,
    next_cursor: nextCursor,
  };
}

function completedEvent(taskId: string, sequence: number): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event_${taskId}_${sequence}`,
    type: "run_completed",
    task_id: taskId,
    run_id: `run_${taskId}`,
    stage_attempt_id: null,
    sequence,
    timestamp: "2026-07-14T01:00:00Z",
    payload: { type: "run_completed" },
  };
}

function snapshot(taskId: string, latestSequence: number): TaskSnapshot {
  const task = summary(taskId, "completed", latestSequence);
  return {
    schema_version: "1.0",
    task,
    runs: [
      {
        schema_version: "1.0",
        run_id: `run_${taskId}`,
        task_id: taskId,
        request_id: `req_${taskId}`,
        status: "completed",
        input: "question",
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
        started_at: CREATED_AT,
        finished_at: CREATED_AT,
        error: null,
      },
    ],
    messages: [
      {
        schema_version: "1.0",
        message_id: `message_${taskId}`,
        task_id: taskId,
        run_id: `run_${taskId}`,
        ordinal: 1,
        role: "user",
        content: "question",
        created_at: CREATED_AT,
      },
    ],
    older_messages_cursor: "older_cursor",
  };
}

describe("agent task projection store", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useAgentStore.setState(createInitialRuntimeState());
  });

  it("merges active and inactive pages without selecting a task", () => {
    useAgentStore.getState().mergeTaskPage(
      page(
        [summary("task_active", "running", 2)],
        [
          summary("task_new", "completed", 4, "2026-07-14T02:00:00Z"),
          summary("task_old", "completed", 3),
        ],
        "cursor_1",
      ),
      false,
    );

    const state = useAgentStore.getState();
    expect(state.activeItems).toEqual(["task_active"]);
    expect(state.taskOrder).toEqual(["task_new", "task_old"]);
    expect(state.nextCursor).toBe("cursor_1");
    expect(state.activeTaskId).toBeNull();
    expect(state.draft.input).toBe("");
  });

  it("deduplicates repeated active summaries and preserves hydrated detail", () => {
    const store = useAgentStore.getState();
    store.mergeTaskPage(
      page(
        [summary("task_active", "running", 2)],
        [summary("task_history", "completed", 3)],
        "cursor_1",
      ),
      false,
    );
    useAgentStore.getState().hydrateTaskSnapshot(snapshot("task_history", 3));

    useAgentStore.getState().mergeTaskPage(
      page(
        [summary("task_active", "running", 2)],
        [
          summary("task_history", "completed", 3),
          summary("task_older", "completed", 1, "2026-07-13T00:00:00Z"),
        ],
        null,
      ),
      true,
    );

    const state = useAgentStore.getState();
    expect(state.activeItems).toEqual(["task_active"]);
    expect(state.taskOrder).toEqual(["task_history", "task_older"]);
    expect(state.tasksById.task_history.hydration).toBe("snapshot");
    expect(state.tasksById.task_history.messages).toHaveLength(1);
    expect(state.nextCursor).toBeNull();
  });

  it("moves only a terminal task to history and rejects a stale page regression", () => {
    useAgentStore.getState().mergeTaskPage(
      page(
        [
          summary("task_a", "running", 2),
          summary("task_b", "running", 0),
        ],
        [],
        null,
      ),
      false,
    );
    useAgentStore.getState().applyEvent(completedEvent("task_a", 3));
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_a", "running", 2)], [], null),
      true,
    );

    const state = useAgentStore.getState();
    expect(state.tasksById.task_a.summary.status).toBe("completed");
    expect(state.tasksById.task_a.lastSequence).toBe(3);
    expect(state.activeItems).toEqual(["task_b"]);
    expect(state.taskOrder).toContain("task_a");
    expect(state.tasksById.task_b.summary.status).toBe("running");
  });

  it("keeps a locally terminal task in history when a stale first page still calls it active", () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_terminal", "running", 2)], [], null),
      false,
    );
    useAgentStore.getState().applyEvent(completedEvent("task_terminal", 3));

    useAgentStore.getState().mergeTaskPage(
      page([summary("task_terminal", "running", 2)], [], null),
      false,
    );

    const state = useAgentStore.getState();
    expect(state.tasksById.task_terminal.summary.status).toBe("completed");
    expect(state.activeItems).not.toContain("task_terminal");
    expect(state.taskOrder).toContain("task_terminal");
  });

  it("hydrates an authoritative snapshot without implicitly selecting it", () => {
    useAgentStore.getState().hydrateTaskSnapshot(snapshot("task_detail", 8));

    const state = useAgentStore.getState();
    expect(state.activeTaskId).toBeNull();
    expect(state.tasksById.task_detail).toMatchObject({
      runOrder: ["run_task_detail"],
      olderMessagesCursor: "older_cursor",
      lastSequence: 8,
      hydration: "snapshot",
    });
    expect(state.tasksById.task_detail.messages[0].messageId).toBe(
      "message_task_detail",
    );
  });

  it("merges a captured older-message page through the store action", () => {
    const detail = snapshot("task_detail", 8);
    detail.messages[0] = { ...detail.messages[0], ordinal: 2 };
    useAgentStore.getState().hydrateTaskSnapshot(detail);
    const olderPage: MessagePage = {
      messages: [
        {
          message_id: "message_older",
          task_id: "task_detail",
          run_id: "run_older",
          ordinal: 1,
          role: "user",
          content: "older question",
          created_at: CREATED_AT,
        },
      ],
      next_cursor: null,
    };

    useAgentStore
      .getState()
      .mergeOlderMessagePage("task_detail", "older_cursor", olderPage);

    const task = useAgentStore.getState().tasksById.task_detail;
    expect(task.messages.map((message) => message.messageId)).toEqual([
      "message_older",
      "message_task_detail",
    ]);
    expect(task.olderMessagesCursor).toBeNull();
  });

  it("removes only the specified authoritative task projection", () => {
    useAgentStore.getState().mergeTaskPage(
      page(
        [summary("task_active", "running", 1)],
        [
          summary("task_delete", "completed", 2),
          summary("task_keep", "completed", 3),
        ],
        null,
      ),
      false,
    );
    useAgentStore.getState().setActiveTaskId("task_delete");

    useAgentStore.getState().removeTask("task_delete");

    const state = useAgentStore.getState();
    expect(state.tasksById.task_delete).toBeUndefined();
    expect(state.tasksById.task_keep).toBeDefined();
    expect(state.tasksById.task_active).toBeDefined();
    expect(state.taskOrder).toEqual(["task_keep"]);
    expect(state.activeItems).toEqual(["task_active"]);
    expect(state.activeTaskId).toBeNull();
  });

  it.each(["completed", "failed", "cancelled", "interrupted"] as const)(
    "moves a task hydrated as %s from active items into history",
    (status) => {
      useAgentStore.getState().mergeTaskPage(
        page([summary("task_terminal", "running", 2)], [], null),
        false,
      );

      useAgentStore.getState().hydrateTaskSnapshot({
        ...snapshot("task_terminal", 5),
        task: summary("task_terminal", status, 5),
      });

      const state = useAgentStore.getState();
      expect(state.activeItems).not.toContain("task_terminal");
      expect(state.taskOrder).toContain("task_terminal");
      expect(state.tasksById.task_terminal.summary.status).toBe(status);
    },
  );

  it("ignores a stale snapshot after a newer live event", () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_live", "running", 4)], [], null),
      false,
    );
    useAgentStore.getState().applyEvent(completedEvent("task_live", 5));
    const before = useAgentStore.getState().tasksById.task_live;

    useAgentStore.getState().hydrateTaskSnapshot({
      ...snapshot("task_live", 4),
      task: summary("task_live", "running", 4),
    });

    expect(useAgentStore.getState().tasksById.task_live).toBe(before);
  });

  it("upserts run_queued into the accepted shell without duplicating the user message", () => {
    useAgentStore.setState((state) =>
      addAcceptedTask(
        state,
        { taskId: "task_shell", runId: "run_shell", requestId: "req_shell" },
        "question",
        ["pubmed"],
        "agent",
      ),
    );
    useAgentStore.getState().applyEvent({
      schema_version: "2.0",
      event_id: "event_shell_1",
      type: "run_queued",
      task_id: "task_shell",
      run_id: "run_shell",
      stage_attempt_id: null,
      sequence: 1,
      timestamp: "2026-07-14T00:00:01Z",
      payload: { type: "run_queued", request_id: "req_shell", input: "question" },
    });

    const task = useAgentStore.getState().tasksById.task_shell;
    expect(task.messages).toHaveLength(1);
    expect(task.messages[0].messageId).toBe("live:run_shell:user");
  });

  it("keeps an immediately accepted brand-new task first until its creation time hydrates", () => {
    useAgentStore.getState().mergeTaskPage(
      page(
        [
          summary(
            "task_existing",
            "running",
            2,
            "2026-07-16T00:00:00Z",
          ),
        ],
        [],
        null,
      ),
      false,
    );

    useAgentStore.setState((current) =>
      addAcceptedTask(
        current,
        {
          taskId: "task_brand_new",
          runId: "run_brand_new",
          requestId: "req_new",
        },
        "new question",
        ["pubmed"],
        "agent",
      ),
    );

    expect(useAgentStore.getState().activeItems).toEqual([
      "task_brand_new",
      "task_existing",
    ]);
  });

  it("does not carry an older Run prompt into a newly accepted Run", () => {
    useAgentStore.setState((state) =>
      addAcceptedTask(
        state,
        { taskId: "task_shell", runId: "run_old", requestId: "req_old" },
        "old question",
        ["pubmed"],
        "agent",
      ),
    );
    useAgentStore.getState().applyEvent({
      schema_version: "2.0",
      event_id: "event_prompt_1",
      type: "user_input_required",
      task_id: "task_shell",
      run_id: "run_old",
      stage_attempt_id: null,
      sequence: 1,
      timestamp: "2026-07-14T00:00:01Z",
      payload: {
        type: "user_input_required",
        request_id: "prompt_old",
        prompt_kind: "plan_confirmation",
        summary: "Confirm the old plan",
        expires_at: null,
        fixture_exempt: false,
        detail: {},
      },
    });

    useAgentStore.setState((state) =>
      addAcceptedTask(
        state,
        { taskId: "task_shell", runId: "run_new", requestId: "req_new" },
        "new question",
        ["pubmed"],
        "agent",
      ),
    );

    expect(
      useAgentStore.getState().tasksById.task_shell.pendingUserInput,
    ).toBeNull();
  });

  it("retains an accepted user shell when the first snapshot has no messages", () => {
    useAgentStore.setState((state) =>
      addAcceptedTask(
        state,
        { taskId: "task_shell", runId: "run_shell", requestId: "req_shell" },
        "question",
        [],
        "agent",
      ),
    );
    useAgentStore.getState().hydrateTaskSnapshot({
      task: {
        ...summary("task_shell", "queued", 1),
        active_run_id: "run_shell",
      },
      runs: [],
      messages: [],
      older_messages_cursor: null,
    });

    expect(useAgentStore.getState().tasksById.task_shell.messages).toEqual([
      expect.objectContaining({
        messageId: "live:run_shell:user",
        content: "question",
      }),
    ]);
  });

  it("merges REST artifact records into only the addressed task", () => {
    useAgentStore.getState().mergeTaskPage(
      page(
        [summary("task_a", "running", 0), summary("task_b", "running", 0)],
        [],
        null,
      ),
      false,
    );
    const beforeTaskB = useAgentStore.getState().tasksById.task_b;

    useAgentStore.setState((state) =>
      mergeTaskArtifacts(state, "task_a", [
        {
          artifact_id: "artifact_a",
          name: "result.csv",
          size: 42,
          sha256: "a".repeat(64),
          media_type: "text/csv",
        },
      ], 0),
    );

    const state = useAgentStore.getState();
    expect(state.tasksById.task_a.artifactOrder).toEqual(["artifact_a"]);
    expect(state.tasksById.task_a.artifactsById.artifact_a).toMatchObject({
      taskId: "task_a",
      size: 42,
    });
    expect(state.tasksById.task_b).toBe(beforeTaskB);
  });

  it("keeps a fixture live artifact visible without a manifest boundary", () => {
    useAgentStore.getState().mergeTaskPage(
      page(
        [{ ...summary("task_artifacts", "running", 0), mode: "fixture" }],
        [],
        null,
      ),
      false,
    );
    useAgentStore.getState().applyEvent({
      schema_version: "2.0",
      event_id: "event_artifact_live",
      type: "artifact_produced",
      task_id: "task_artifacts",
      run_id: "run_task_artifacts",
      stage_attempt_id: null,
      sequence: 1,
      timestamp: "2026-07-14T00:00:01Z",
      payload: {
        type: "artifact_produced",
        artifact: {
          artifact_id: "artifact_live",
          name: "live.csv",
          relative_path: "artifacts/live.csv",
          media_type: "text/csv",
          size_bytes: 5,
          sha256: "b".repeat(64),
          generated_by_step_id: "step_live",
        },
      },
    });

    useAgentStore.setState((state) =>
      mergeTaskArtifacts(state, "task_artifacts", [
        {
          artifact_id: "artifact_rest",
          name: "rest.csv",
          role: "audit_report",
          size: 4,
          sha256: "a".repeat(64),
          media_type: "text/csv",
        },
      ], 0),
    );

    const task = useAgentStore.getState().tasksById.task_artifacts;
    expect(task.artifactOrder).toEqual(["artifact_live", "artifact_rest"]);
    expect(Object.keys(task.artifactsById)).toEqual(
      expect.arrayContaining(["artifact_live", "artifact_rest"]),
    );
  });

  it("persists only version 2 draft database preferences", () => {
    useAgentStore.getState().setDraftSelectedDatabaseIds(["pubmed", "geo"]);
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_private", "running", 2)], [], null),
      false,
    );
    useAgentStore.getState().setDraftInput("not persisted");
    useAgentStore.getState().setDraftError("not persisted");

    const stored = JSON.parse(
      window.localStorage.getItem(AGENT_STORE_NAME) ?? "{}",
    ) as {
      state?: Record<string, unknown>;
      version?: number;
    };
    expect(stored.version).toBe(2);
    expect(stored.state).toEqual({
      draftPreferences: { selectedDatabaseIds: ["pubmed", "geo"] },
    });
  });

  it("destructively discards v1 browser sessions during real rehydration", async () => {
    window.localStorage.setItem(
      AGENT_STORE_NAME,
      JSON.stringify({
        version: 1,
        state: {
          sessions: [
            {
              taskId: "legacy_task",
              messages: [{ role: "user", content: "private history" }],
              artifacts: [{ artifactId: "legacy_artifact" }],
            },
          ],
          currentSessionId: "legacy_task",
          traces: [{ output: "private trace" }],
        },
      }),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await useAgentStore.persist.rehydrate();

    const state = useAgentStore.getState();
    expect(state.tasksById).toEqual({});
    expect(state.taskOrder).toEqual([]);
    expect(state.activeTaskId).toBeNull();
    expect(state.draft.input).toBe("");
    expect(fetchSpy).not.toHaveBeenCalled();
    const rewritten = window.localStorage.getItem(AGENT_STORE_NAME) ?? "";
    expect(rewritten).not.toContain("legacy_task");
    expect(rewritten).not.toContain("private history");
    expect(rewritten).not.toContain("legacy_artifact");
    fetchSpy.mockRestore();
  });

  it("discards legacy v1 database selections with session content", async () => {
    window.localStorage.setItem(
      AGENT_STORE_NAME,
      JSON.stringify({
        version: 1,
        state: {
          selectedDatabases: ["pubmed", "geo"],
          sessions: [{ taskId: "legacy_task" }],
        },
      }),
    );

    await useAgentStore.persist.rehydrate();

    expect(useAgentStore.getState().draft.selectedDatabaseIds).toEqual([]);
  });

  it("drops backend task projections during version 2 rehydration", async () => {
    window.localStorage.setItem(
      AGENT_STORE_NAME,
      JSON.stringify({
        version: 2,
        state: {
          draftPreferences: { selectedDatabaseIds: ["pubmed"] },
          tasksById: { leaked_task: { messages: ["private"] } },
          activeTaskId: "leaked_task",
        },
      }),
    );

    await useAgentStore.persist.rehydrate();

    const state = useAgentStore.getState();
    expect(state.tasksById).toEqual({});
    expect(state.activeTaskId).toBeNull();
    expect(state.draft.selectedDatabaseIds).toEqual(["pubmed"]);
  });
});
