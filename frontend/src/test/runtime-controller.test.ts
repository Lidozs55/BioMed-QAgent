import { beforeEach, describe, expect, it, vi } from "vitest";

import type { APIClient } from "@/hooks/useAPI";
import type {
  DatabaseRecord,
  EventEnvelope,
  MessagePage,
  TaskPage,
  TaskRunAccepted,
  TaskSnapshot,
  TaskSummary,
} from "@/runtime/contracts";
import {
  RuntimeController,
  startRuntime,
  type EventTransport,
} from "@/runtime/controller";
import { saveTaskProjection } from "@/runtime/hydrationCache";
import { createInitialRuntimeState, createTaskProjection } from "@/runtime/reducer";
import { addAcceptedTask, useAgentStore } from "@/stores/agentStore";

const CREATED_AT = "2026-07-14T00:00:00Z";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

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
    title: taskId,
    status,
    active_run_id: status === "running" ? `run_${taskId}` : null,
    created_at: createdAt,
    updated_at: createdAt,
    latest_sequence: latestSequence,
  };
}

function page(
  activeItems: TaskSummary[],
  items: TaskSummary[] = [],
  nextCursor: string | null = null,
): TaskPage {
  return { active_items: activeItems, items, next_cursor: nextCursor };
}

function snapshot(
  taskId: string,
  latestSequence: number,
  mode: TaskSummary["mode"] = "agent",
  status: TaskSummary["status"] = "completed",
): TaskSnapshot {
  return {
    task: summary(taskId, status, latestSequence, mode),
    runs: [],
    messages: [],
    older_messages_cursor: null,
  };
}

function runStartedEvent(taskId: string, sequence: number): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event_${taskId}_${sequence}`,
    type: "run_started",
    task_id: taskId,
    run_id: `run_${taskId}`,
    stage_attempt_id: null,
    sequence,
    timestamp: `2026-07-14T00:00:${String(sequence % 60).padStart(2, "0")}Z`,
    payload: { type: "run_started" },
  };
}

function runCompletedEvent(taskId: string, sequence: number): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event_${taskId}_${sequence}`,
    type: "run_completed",
    task_id: taskId,
    run_id: `run_${taskId}`,
    stage_attempt_id: null,
    sequence,
    timestamp: `2026-07-14T00:00:${String(sequence % 60).padStart(2, "0")}Z`,
    payload: { type: "run_completed" },
  };
}

function runCancelRequestedEvent(
  taskId: string,
  sequence: number,
): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event_${taskId}_${sequence}`,
    type: "run_cancel_requested",
    task_id: taskId,
    run_id: `run_${taskId}`,
    stage_attempt_id: null,
    sequence,
    timestamp: `2026-07-14T00:00:${String(sequence % 60).padStart(2, "0")}Z`,
    payload: { type: "run_cancel_requested", reason: null },
  };
}

function toolStartedEvent(
  taskId: string,
  sequence: number,
  toolCallId = `call_${taskId}`,
): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event_${taskId}_${sequence}`,
    type: "tool_started",
    task_id: taskId,
    run_id: `run_${taskId}`,
    stage_attempt_id: null,
    sequence,
    timestamp: `2026-07-14T00:00:${String(sequence % 60).padStart(2, "0")}Z`,
    payload: {
      type: "tool_started",
      tool_call_id: toolCallId,
      tool_name: "search_literature",
    },
  };
}

function stageStartedEvent(taskId: string, sequence: number): EventEnvelope {
  return {
    schema_version: "1.0",
    event_id: `event_${taskId}_${sequence}`,
    type: "stage_started",
    task_id: taskId,
    run_id: null,
    stage_attempt_id: `attempt_${taskId}`,
    sequence,
    timestamp: `2026-07-14T00:00:${String(sequence % 60).padStart(2, "0")}Z`,
    payload: { type: "stage_started", stage: "discovery", attempt: 1 },
  };
}

function artifactEvent(
  taskId: string,
  sequence: number,
  artifactId: string,
  name: string,
  size: number,
  sha256: string,
): EventEnvelope {
  return {
    schema_version: "2.0",
    event_id: `event_${taskId}_${sequence}`,
    type: "artifact_produced",
    task_id: taskId,
    run_id: `run_${taskId}`,
    stage_attempt_id: null,
    sequence,
    timestamp: `2026-07-14T00:00:${String(sequence).padStart(2, "0")}Z`,
    payload: {
      type: "artifact_produced",
      artifact: {
        artifact_id: artifactId,
        name,
        relative_path: `artifacts/${name}`,
        media_type: name.endsWith(".json") ? "application/json" : "text/csv",
        size_bytes: size,
        sha256,
        generated_by_step_id: "step_artifact_builder_v1",
      },
    },
  };
}

function api(overrides: Partial<APIClient> = {}): APIClient {
  return {
    fetchDatabases: vi.fn().mockResolvedValue([]),
    fetchTasks: vi.fn().mockResolvedValue(page([])),
    fetchTask: vi.fn().mockResolvedValue(snapshot("task_default", 0)),
    fetchMessages: vi.fn(),
    fetchEvents: vi.fn((taskId, options) => {
      const latestSequence =
        useAgentStore.getState().tasksById[taskId]?.summary.latest_sequence ??
        options.afterSequence;
      const endSequence = Math.min(
        latestSequence,
        options.afterSequence + options.limit,
      );
      return Promise.resolve(
        Array.from(
          { length: Math.max(0, endSequence - options.afterSequence) },
          (_, index) =>
            runStartedEvent(taskId, options.afterSequence + index + 1),
        ),
      );
    }),
    createTask: vi.fn(),
    startImportTask: vi.fn(),
    continueTask: vi.fn(),
    cancelRun: vi.fn(),
    cancelSubagent: vi.fn(),
    compactTask: vi.fn(),
    injectTaskContext: vi.fn(),
    resumeRun: vi.fn(),
    resolvePermission: vi.fn(),
    resumeDownload: vi.fn(),
    cancelDownload: vi.fn(),
    deleteTask: vi.fn(),
    fetchArtifacts: vi.fn(),
    getArtifactUrl: vi.fn(),
    getCacheExportUrl: vi.fn(),
    fetchBuilds: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
    fetchBuild: vi.fn(),
    getBuildArtifactUrl: vi.fn(),
    ...overrides,
  };
}

function transport(overrides: Partial<EventTransport> = {}): EventTransport {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    subscribe: vi.fn(),
    isSubscribed: vi.fn().mockReturnValue(false),
    unsubscribeAndWait: vi.fn().mockResolvedValue(undefined),
    recoverSubscription: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function watermarkedTransport(
  taskId: string,
  startupWatermark: number,
  durableEvents: EventEnvelope[],
): EventTransport {
  let connected = true;
  let connectionWatermark = startupWatermark;
  const desired = new Map([[taskId, startupWatermark]]);

  const deliverAfter = (afterSequence: number) => {
    connectionWatermark = Math.max(connectionWatermark, afterSequence);
    for (const event of durableEvents) {
      if (event.sequence <= connectionWatermark) continue;
      useAgentStore.getState().applyEvent(event);
      connectionWatermark = event.sequence;
    }
  };

  const eventTransport = transport({
    disconnect: vi.fn(() => {
      connected = false;
      desired.clear();
    }),
    subscribe: vi.fn((subscribedTaskId, afterSequence) => {
      desired.set(
        subscribedTaskId,
        Math.max(desired.get(subscribedTaskId) ?? 0, afterSequence),
      );
      if (connected && subscribedTaskId === taskId) {
        deliverAfter(afterSequence);
      }
    }),
    isSubscribed: vi.fn((subscribedTaskId) => desired.has(subscribedTaskId)),
    unsubscribeAndWait: vi.fn((subscribedTaskId) => {
      desired.delete(subscribedTaskId);
      return Promise.resolve();
    }),
  });
  return Object.assign(eventTransport, {
    recoverSubscription: vi.fn((recoveredTaskId: string, afterSequence: number) => {
      desired.set(recoveredTaskId, afterSequence);
      connected = true;
      connectionWatermark = 0;
      deliverAfter(afterSequence);
      return Promise.resolve();
    }),
  });
}

describe("runtime orchestration", () => {
  beforeEach(() => {
    useAgentStore.setState(createInitialRuntimeState());
  });

  it("starts database, first-page, and socket work before awaiting any branch", async () => {
    const databases = deferred<DatabaseRecord[]>();
    const tasks = deferred<TaskPage>();
    const socket = deferred<void>();
    const apiClient = api({
      fetchDatabases: vi.fn(() => databases.promise),
      fetchTasks: vi.fn(() => tasks.promise),
    });
    const eventTransport = transport({
      connect: vi.fn(() => socket.promise),
    });

    const startup = startRuntime({ api: apiClient, transport: eventTransport });

    expect(apiClient.fetchDatabases).toHaveBeenCalledTimes(1);
    expect(apiClient.fetchTasks).toHaveBeenCalledWith({ limit: 10 });
    expect(eventTransport.connect).toHaveBeenCalledTimes(1);
    tasks.resolve(page([summary("task_active", "running", 7)]));
    await Promise.resolve();
    expect(eventTransport.subscribe).toHaveBeenCalledWith("task_active", 7);
    expect(useAgentStore.getState().activeTaskId).toBeNull();
    expect(useAgentStore.getState().draft.input).toBe("");
    databases.resolve([
      { id: "pubmed", name: "PubMed", category: "discovery", description: "" },
    ]);
    socket.resolve();
    await startup;

    expect(useAgentStore.getState().databases).toHaveLength(1);
  });

  it("selects all available databases when loading the catalog without a saved selection", async () => {
    const databases = [
      {
        id: "pubmed",
        name: "PubMed",
        category: "discovery",
        description: "Literature",
      },
      {
        id: "geo",
        name: "GEO",
        category: "acquisition",
        description: "Expression",
      },
    ];
    const apiClient = api({
      fetchDatabases: vi.fn().mockResolvedValue(databases),
    });
    const controller = new RuntimeController(apiClient, transport());

    await controller.start();

    expect(useAgentStore.getState().draft.selectedDatabaseIds).toEqual([
      "pubmed",
      "geo",
    ]);
  });

  it("preserves a task created and completed after the first history request began", async () => {
    const firstPage = deferred<TaskPage>();
    const apiClient = api({
      fetchTasks: vi.fn(() => firstPage.promise),
    });
    const startup = startRuntime({
      api: apiClient,
      transport: transport(),
    });

    useAgentStore.setState((state) =>
      addAcceptedTask(
        state,
        {
          taskId: "task_created_during_history",
          runId: "run_task_created_during_history",
          requestId: "req_task_created_during_history",
        },
        "new research",
        [],
        "agent",
        false,
      ),
    );
    useAgentStore
      .getState()
      .applyEvent(runCompletedEvent("task_created_during_history", 1));
    expect(useAgentStore.getState().taskOrder).toContain(
      "task_created_during_history",
    );

    firstPage.resolve(
      page([], [summary("task_existing_history", "completed", 1)]),
    );
    await startup;

    expect(useAgentStore.getState().taskOrder).toEqual([
      "task_existing_history",
      "task_created_during_history",
    ]);
  });

  it("preserves only history changed while the first page request is pending", async () => {
    useAgentStore.getState().mergeTaskPage(
      page(
        [
          summary(
            "task_changed_during_history",
            "running",
            0,
            "agent",
            "2026-07-16T00:00:00Z",
          ),
        ],
        [
          summary(
            "task_stale_history",
            "completed",
            1,
            "agent",
            "2026-07-13T00:00:00Z",
          ),
        ],
      ),
      false,
    );
    const firstPage = deferred<TaskPage>();
    const startup = startRuntime({
      api: api({ fetchTasks: vi.fn(() => firstPage.promise) }),
      transport: transport(),
    });

    useAgentStore
      .getState()
      .applyEvent(runCompletedEvent("task_changed_during_history", 1));
    firstPage.resolve(
      page(
        [],
        [
          summary(
            "task_current_history",
            "completed",
            1,
            "agent",
            "2026-07-15T00:00:00Z",
          ),
        ],
      ),
    );
    await startup;

    expect(useAgentStore.getState().taskOrder).toEqual([
      "task_changed_during_history",
      "task_current_history",
    ]);
    expect(useAgentStore.getState().taskOrder).not.toContain(
      "task_stale_history",
    );
  });

  it("restores immutable history order after an older task changes during refresh", async () => {
    useAgentStore.getState().mergeTaskPage(
      page(
        [
          summary(
            "task_older_changed",
            "running",
            0,
            "agent",
            "2026-07-12T00:00:00Z",
          ),
        ],
        [
          summary(
            "task_stale_history",
            "completed",
            1,
            "agent",
            "2026-07-11T00:00:00Z",
          ),
        ],
      ),
      false,
    );
    const refreshedPage = deferred<TaskPage>();
    const controller = new RuntimeController(
      api({ fetchTasks: vi.fn(() => refreshedPage.promise) }),
      transport(),
    );

    const refresh = controller.refreshTaskHistory();
    useAgentStore
      .getState()
      .applyEvent(runCompletedEvent("task_older_changed", 1));
    refreshedPage.resolve(
      page(
        [],
        [
          summary(
            "task_newer_history",
            "completed",
            1,
            "agent",
            "2026-07-16T00:00:00Z",
          ),
        ],
      ),
    );
    await refresh;

    expect(useAgentStore.getState().taskOrder).toEqual([
      "task_newer_history",
      "task_older_changed",
    ]);
    expect(useAgentStore.getState().taskOrder).not.toContain(
      "task_stale_history",
    );
  });

  it("does not merge or subscribe a confirmed deletion from a late first history page", async () => {
    const firstPage = deferred<TaskPage>();
    const apiClient = api({
      fetchTasks: vi.fn(() => firstPage.promise),
      deleteTask: vi.fn().mockResolvedValue(undefined),
    });
    const eventTransport = transport();
    const controller = new RuntimeController(apiClient, eventTransport);
    const startup = controller.start();

    useAgentStore.getState().mergeTaskPage(
      page([], [summary("task_deleted_during_startup", "completed", 2)]),
      false,
    );
    await controller.deleteTask("task_deleted_during_startup");

    firstPage.resolve(
      page(
        [
          summary("task_deleted_during_startup", "running", 3),
          summary("task_startup_survivor", "running", 1),
        ],
        [],
      ),
    );
    await startup;

    expect(
      useAgentStore.getState().tasksById.task_deleted_during_startup,
    ).toBeUndefined();
    expect(
      useAgentStore.getState().tasksById.task_startup_survivor,
    ).toBeDefined();
    expect(eventTransport.subscribe).not.toHaveBeenCalledWith(
      "task_deleted_during_startup",
      expect.any(Number),
    );
    expect(eventTransport.subscribe).toHaveBeenCalledWith(
      "task_startup_survivor",
      1,
    );
  });

  it("subscribes active startup tasks from the merged replay watermark", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_active", "running", 8)]),
      false,
    );
    const eventTransport = transport();

    await startRuntime({
      api: api({
        fetchTasks: vi.fn().mockResolvedValue(
          page([summary("task_active", "running", 10)]),
        ),
      }),
      transport: eventTransport,
    });

    expect(eventTransport.subscribe).toHaveBeenCalledWith("task_active", 8);
    expect(useAgentStore.getState().tasksById.task_active.lastSequence).toBe(8);
  });

  it("keeps successful startup branches when another branch rejects", async () => {
    const apiClient = api({
      fetchDatabases: vi.fn().mockRejectedValue(new Error("catalog unavailable")),
      fetchTasks: vi.fn().mockResolvedValue(
        page([summary("task_active", "running", 4)]),
      ),
    });
    const eventTransport = transport();

    const outcomes = await startRuntime({
      api: apiClient,
      transport: eventTransport,
    });

    expect(outcomes[0].status).toBe("rejected");
    expect(useAgentStore.getState().activeItems).toEqual(["task_active"]);
    expect(eventTransport.subscribe).toHaveBeenCalledWith("task_active", 4);
    expect(useAgentStore.getState().activeTaskId).toBeNull();
  });

  it("records a startup history error and recovers it through an explicit retry", async () => {
    const fetchTasks = vi
      .fn()
      .mockRejectedValueOnce(new Error("history unavailable"))
      .mockResolvedValueOnce(page([summary("task_recovered", "running", 5)]));
    const apiClient = api({ fetchTasks });
    const eventTransport = transport();

    await startRuntime({ api: apiClient, transport: eventTransport });
    expect(useAgentStore.getState()).toMatchObject({
      historyStatus: "error",
      historyError: "history unavailable",
    });

    await new RuntimeController(apiClient, eventTransport).refreshTaskHistory();

    expect(useAgentStore.getState()).toMatchObject({
      historyStatus: "ready",
      historyError: null,
      activeItems: ["task_recovered"],
    });
    expect(eventTransport.subscribe).toHaveBeenCalledWith("task_recovered", 5);
  });

  it("ignores an aborted startup page that resolves after a newer startup", async () => {
    const olderPage = deferred<TaskPage>();
    const newerPage = deferred<TaskPage>();
    const startupAbort = new AbortController();
    const eventTransport = transport();
    const olderStartup = startRuntime({
      api: api({ fetchTasks: vi.fn(() => olderPage.promise) }),
      transport: eventTransport,
      ...{ signal: startupAbort.signal },
    });

    startupAbort.abort();
    const newerStartup = startRuntime({
      api: api({ fetchTasks: vi.fn(() => newerPage.promise) }),
      transport: eventTransport,
      ...{ signal: new AbortController().signal },
    });
    newerPage.resolve(page([summary("task_newer", "running", 4)]));
    await Promise.resolve();
    olderPage.resolve(page([summary("task_older", "running", 2)]));
    await Promise.all([olderStartup, newerStartup]);

    expect(useAgentStore.getState().activeItems).toEqual(["task_newer"]);
    expect(useAgentStore.getState().tasksById.task_older).toBeUndefined();
    expect(eventTransport.subscribe).toHaveBeenCalledTimes(1);
    expect(eventTransport.subscribe).toHaveBeenCalledWith("task_newer", 4);
  });

  it("records foreground selection intent before the unsubscribe barrier and snapshot", async () => {
    useAgentStore.getState().mergeTaskPage(page([summary("task_a")]), false);
    const barrier = deferred<void>();
    const detail = deferred<TaskSnapshot>();
    const order: string[] = [];
    const apiClient = api({
      fetchTask: vi.fn(() => {
        order.push("fetch");
        return detail.promise;
      }),
      fetchArtifacts: vi.fn().mockResolvedValue([
        {
          artifact_id: "artifact_selected",
          name: "selected.csv",
          size: 5,
          sha256: "a".repeat(64),
          media_type: "text/csv",
        },
      ]),
    });
    const eventTransport = transport({
      isSubscribed: vi.fn().mockReturnValue(true),
      unsubscribeAndWait: vi.fn(() => {
        order.push("barrier");
        return barrier.promise;
      }),
      subscribe: vi.fn(() => order.push("subscribe")),
    });
    const controller = new RuntimeController(apiClient, eventTransport);

    const selection = controller.selectTask("task_a");
    await Promise.resolve();
    expect(order).toEqual(["barrier"]);
    expect(useAgentStore.getState().activeTaskId).toBe("task_a");
    barrier.resolve();
    await Promise.resolve();
    expect(order).toEqual(["barrier", "fetch"]);
    expect(useAgentStore.getState().activeTaskId).toBe("task_a");
    detail.resolve(snapshot("task_a", 9, "agent", "running"));
    await selection;

    expect(useAgentStore.getState().activeTaskId).toBe("task_a");
    expect(order).toEqual(["barrier", "fetch", "subscribe"]);
    expect(eventTransport.subscribe).toHaveBeenLastCalledWith("task_a", 9);
    expect(
      useAgentStore.getState().tasksById.task_a.artifactOrder,
    ).toEqual(["artifact_selected"]);
  });

  it("replays a user-input prompt emitted during an already-hydrated selection handoff", async () => {
    const taskId = "task_hil_gap";
    const runId = `run_${taskId}`;
    useAgentStore.getState().hydrateTaskSnapshot({
      task: {
        ...summary(taskId, "running", 5),
        active_run_id: runId,
      },
      runs: [
        {
          run_id: runId,
          task_id: taskId,
          request_id: "req_existing",
          status: "running",
          input: "question",
          created_at: CREATED_AT,
          updated_at: CREATED_AT,
          started_at: CREATED_AT,
          finished_at: null,
          error: null,
        },
      ],
      messages: [],
      older_messages_cursor: null,
    });
    const requiredEvent: EventEnvelope = {
      schema_version: "2.0",
      event_id: "event_task_hil_gap_6",
      type: "user_input_required",
      task_id: taskId,
      run_id: runId,
      stage_attempt_id: null,
      sequence: 6,
      timestamp: "2026-07-14T00:00:06Z",
      payload: {
        type: "user_input_required",
        request_id: "req_hil_gap",
        prompt_kind: "plan_confirmation",
        summary: "Confirm the plan",
        expires_at: null,
        fixture_exempt: false,
        detail: {},
      },
    };
    const order: string[] = [];
    const fetchEvents = vi.fn<APIClient["fetchEvents"]>(
      (_fetchedTaskId, options) => {
        if (options === undefined) {
          throw new Error("Replay options are required");
        }
        order.push(`events:${options.afterSequence}`);
        expect(useAgentStore.getState().tasksById[taskId].lastSequence).toBe(5);
        return Promise.resolve([requiredEvent]);
      },
    );
    const apiClient = api({
      fetchTask: vi.fn(async () => {
        order.push("snapshot");
        return {
          task: {
            ...summary(taskId, "awaiting_user_input", 6),
            active_run_id: runId,
          },
          runs: [
            {
              run_id: runId,
              task_id: taskId,
              request_id: "req_existing",
              status: "awaiting_user_input" as const,
              input: "question",
              created_at: CREATED_AT,
              updated_at: "2026-07-14T00:00:06Z",
              started_at: CREATED_AT,
              finished_at: null,
              error: null,
            },
          ],
          messages: [],
          older_messages_cursor: null,
        };
      }),
      fetchEvents,
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const eventTransport = transport({
      isSubscribed: vi.fn().mockReturnValue(true),
      unsubscribeAndWait: vi.fn(async () => {
        order.push("barrier");
      }),
      subscribe: vi.fn((_subscribedTaskId, afterSequence) => {
        order.push(`subscribe:${afterSequence}`);
      }),
    });

    await new RuntimeController(apiClient, eventTransport).selectTask(taskId);

    expect(fetchEvents).toHaveBeenCalledWith(taskId, {
      afterSequence: 5,
      limit: 1000,
    });
    expect(order).toEqual(["barrier", "snapshot", "events:5", "subscribe:6"]);
    expect(useAgentStore.getState().tasksById[taskId]).toMatchObject({
      hydration: "snapshot",
      lastSequence: 6,
      pendingUserInput: {
        runId,
        requestId: "req_hil_gap",
      },
    });
    expect(eventTransport.subscribe).toHaveBeenCalledWith(taskId, 6);
  });

  it("replays a summary-only terminal task through its snapshot watermark without subscribing (F1)", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([], [summary("task_fixture_history", "completed", 2, "fixture")]),
      false,
    );
    const order: string[] = [];
    const events = [
      stageStartedEvent("task_fixture_history", 1),
      {
        ...stageStartedEvent("task_fixture_history", 2),
        event_id: "event_task_fixture_history_2",
        stage_attempt_id: "attempt_task_fixture_history_processing",
        payload: {
          type: "stage_started" as const,
          stage: "processing" as const,
          attempt: 1,
        },
      },
    ];
    const apiClient = api({
      fetchTask: vi.fn(async () => {
        order.push("snapshot");
        return snapshot("task_fixture_history", 2, "fixture");
      }),
      fetchEvents: vi.fn(async () => {
        order.push("events");
        return events;
      }),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const eventTransport = transport({
      subscribe: vi.fn(() => order.push("subscribe")),
    });
    const controller = new RuntimeController(apiClient, eventTransport);

    await controller.selectTask("task_fixture_history");

    expect(apiClient.fetchEvents).toHaveBeenCalledWith(
      "task_fixture_history",
      { afterSequence: 0, limit: 1000 },
    );
    expect(order).toEqual(["snapshot", "events"]);
    expect(
      useAgentStore.getState().tasksById.task_fixture_history.stages,
    ).toMatchObject({
      discovery: { stageAttemptId: "attempt_task_fixture_history" },
      processing: {
        stageAttemptId: "attempt_task_fixture_history_processing",
      },
    });
    // A terminal history task must not keep a permanent desired
    // subscription after selection hydration (F1).
    expect(eventTransport.subscribe).not.toHaveBeenCalled();
    expect(useAgentStore.getState().activeItems).not.toContain(
      "task_fixture_history",
    );
  });

  it("windows a cold event replay to the tail when the event log is long", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([], [summary("task_window", "completed", 5000, "fixture")]),
      false,
    );
    const tailStart = 5000 - 3000 + 1; // EVENT_REPLAY_WINDOW_SIZE = 3000
    const tailEvents: EventEnvelope[] = [];
    for (let sequence = tailStart; sequence <= 5000; sequence += 1) {
      tailEvents.push(stageStartedEvent("task_window", sequence));
    }
    const apiClient = api({
      fetchTask: vi.fn(async () => snapshot("task_window", 5000, "fixture")),
      fetchEvents: vi.fn(async (_taskId, options) => {
        const after = options?.afterSequence ?? 0;
        return tailEvents
          .filter((event) => event.sequence > after)
          .slice(0, 1000);
      }),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const eventTransport = transport({ subscribe: vi.fn() });
    const controller = new RuntimeController(apiClient, eventTransport);

    await controller.selectTask("task_window");

    // The full log runs 1..5000; a cold hydration must not replay it all —
    // it starts at the window lower edge (2001) instead of sequence 0.
    expect(apiClient.fetchEvents).toHaveBeenCalledWith("task_window", {
      afterSequence: 2000,
      limit: 1000,
    });
    expect(
      useAgentStore.getState().tasksById.task_window.lastSequence,
    ).toBe(5000);
  });

  it("restarts summary event replay from zero after a later replay page fails", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([], [summary("task_replay_retry", "completed", 1001, "fixture")]),
      false,
    );
    const firstReplayPage = Array.from({ length: 1000 }, (_, index) =>
      stageStartedEvent("task_replay_retry", index + 1),
    );
    const replayedStage = stageStartedEvent("task_replay_retry", 1001);
    let replayAttempt = 0;
    const fetchEvents = vi.fn<APIClient["fetchEvents"]>((_taskId, options) => {
      if (options?.afterSequence === 0) {
        replayAttempt += 1;
        return Promise.resolve(firstReplayPage);
      }
      if (replayAttempt === 1) {
        return Promise.reject(new Error("events temporarily unavailable"));
      }
      return Promise.resolve([replayedStage]);
    });
    const apiClient = api({
      fetchTask: vi
        .fn()
        .mockResolvedValue(snapshot("task_replay_retry", 1001, "fixture")),
      fetchEvents,
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const eventTransport = transport();
    const controller = new RuntimeController(apiClient, eventTransport);

    await expect(controller.selectTask("task_replay_retry")).rejects.toThrow(
      "events temporarily unavailable",
    );
    expect(useAgentStore.getState().tasksById.task_replay_retry).toMatchObject({
      hydration: "summary",
      lastSequence: 1000,
    });
    await controller.selectTask("task_replay_retry");

    expect(fetchEvents).toHaveBeenCalledTimes(4);
    expect(fetchEvents).toHaveBeenNthCalledWith(3, "task_replay_retry", {
      afterSequence: 0,
      limit: 1000,
    });
    expect(
      useAgentStore.getState().tasksById.task_replay_retry.stages.discovery,
    ).toMatchObject({ stageAttemptId: replayedStage.stage_attempt_id });
    // The task is terminal after hydration, so the selection must not
    // keep a permanent desired subscription (F1).
    expect(eventTransport.subscribe).not.toHaveBeenCalled();
  });

  it("restores a background subscription when selection hydration fails", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_a", "running", 5)]),
      false,
    );
    const eventTransport = transport({
      isSubscribed: vi.fn().mockReturnValue(true),
    });
    const controller = new RuntimeController(
      api({ fetchTask: vi.fn().mockRejectedValue(new Error("detail unavailable")) }),
      eventTransport,
    );

    await expect(controller.selectTask("task_a")).rejects.toThrow(
      "detail unavailable",
    );

    expect(eventTransport.unsubscribeAndWait).toHaveBeenCalledWith("task_a");
    expect(eventTransport.subscribe).toHaveBeenCalledWith("task_a", 5);
    expect(useAgentStore.getState().activeTaskId).toBeNull();
  });

  it("restores a background subscription when its pong barrier fails", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_a", "running", 5)]),
      false,
    );
    const eventTransport = transport({
      isSubscribed: vi.fn().mockReturnValue(true),
      unsubscribeAndWait: vi
        .fn()
        .mockRejectedValue(new Error("socket closed before pong")),
    });
    const apiClient = api();
    const controller = new RuntimeController(apiClient, eventTransport);

    await expect(controller.selectTask("task_a")).rejects.toThrow(
      "socket closed before pong",
    );

    expect(apiClient.fetchTask).not.toHaveBeenCalled();
    expect(eventTransport.subscribe).toHaveBeenCalledWith("task_a", 5);
  });

  it("keeps the last user selection when an earlier task snapshot resolves later", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_a"), summary("task_b")]),
      false,
    );
    const taskA = deferred<TaskSnapshot>();
    const taskB = deferred<TaskSnapshot>();
    const apiClient = api({
      fetchTask: vi.fn((taskId: string) =>
        taskId === "task_a" ? taskA.promise : taskB.promise,
      ),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const controller = new RuntimeController(apiClient, transport());

    const selectA = controller.selectTask("task_a");
    const selectB = controller.selectTask("task_b");
    taskB.resolve(snapshot("task_b", 4));
    await selectB;
    expect(useAgentStore.getState().activeTaskId).toBe("task_b");
    taskA.resolve(snapshot("task_a", 3));
    await selectA;

    expect(useAgentStore.getState().activeTaskId).toBe("task_b");
  });

  it("shares one task-local selection handoff across overlapping same-task requests", async () => {
    useAgentStore.getState().mergeTaskPage(page([summary("task_a")]), false);
    const barrier = deferred<void>();
    const detail = deferred<TaskSnapshot>();
    let desired = true;
    const apiClient = api({
      fetchTask: vi.fn(() => detail.promise),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const eventTransport = transport({
      isSubscribed: vi.fn(() => desired),
      unsubscribeAndWait: vi.fn(() => {
        desired = false;
        return barrier.promise;
      }),
      subscribe: vi.fn(() => {
        desired = true;
      }),
    });
    const controller = new RuntimeController(apiClient, eventTransport);

    const first = controller.selectTask("task_a");
    const second = controller.selectTask("task_a");
    await Promise.resolve();
    const fetchesBeforeBarrier = vi.mocked(apiClient.fetchTask).mock.calls.length;
    barrier.resolve();
    await Promise.resolve();
    // Keep the task active through hydration so the handoff still
    // re-establishes its live subscription (F1).
    detail.resolve(snapshot("task_a", 7, "agent", "running"));
    await Promise.all([first, second]);

    expect(fetchesBeforeBarrier).toBe(0);
    expect(eventTransport.unsubscribeAndWait).toHaveBeenCalledTimes(1);
    expect(apiClient.fetchTask).toHaveBeenCalledTimes(1);
    expect(eventTransport.subscribe).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().activeTaskId).toBe("task_a");
  });

  it("does not subscribe a terminal history task when it is selected and hydrated (F1)", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([], [summary("task_history_terminal", "completed", 4)]),
      false,
    );
    const apiClient = api({
      fetchTask: vi
        .fn()
        .mockResolvedValue(snapshot("task_history_terminal", 4)),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const eventTransport = transport();
    const controller = new RuntimeController(apiClient, eventTransport);

    await controller.selectTask("task_history_terminal");

    expect(
      useAgentStore.getState().tasksById.task_history_terminal,
    ).toMatchObject({ hydration: "snapshot", lastSequence: 4 });
    expect(useAgentStore.getState().activeItems).not.toContain(
      "task_history_terminal",
    );
    expect(eventTransport.subscribe).not.toHaveBeenCalled();
  });

  it("subscribes an active task when it is selected and hydrated (F1)", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_history_active", "running", 3)]),
      false,
    );
    const apiClient = api({
      fetchTask: vi
        .fn()
        .mockResolvedValue(
          snapshot("task_history_active", 6, "agent", "running"),
        ),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const eventTransport = transport();
    const controller = new RuntimeController(apiClient, eventTransport);

    await controller.selectTask("task_history_active");

    expect(useAgentStore.getState().activeItems).toContain(
      "task_history_active",
    );
    expect(eventTransport.subscribe).toHaveBeenCalledWith(
      "task_history_active",
      6,
    );
  });

  it("hydrates a task from a REST snapshot and resumes after its watermark on a permanent gap (F2)", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_gap_fallback", "running", 4)]),
      false,
    );
    const apiClient = api({
      fetchTask: vi
        .fn()
        .mockResolvedValue(
          snapshot("task_gap_fallback", 8, "agent", "running"),
        ),
    });
    const eventTransport = transport();
    const controller = new RuntimeController(apiClient, eventTransport);

    await controller.hydrateTaskFromGap("task_gap_fallback");

    expect(apiClient.fetchTask).toHaveBeenCalledWith("task_gap_fallback");
    expect(
      useAgentStore.getState().tasksById.task_gap_fallback,
    ).toMatchObject({ hydration: "snapshot", lastSequence: 8 });
    expect(
      useAgentStore.getState().tasksById.task_gap_fallback.sequenceGap,
    ).toBeNull();
    expect(eventTransport.recoverSubscription).toHaveBeenCalledWith(
      "task_gap_fallback",
      8,
    );
  });

  it("subscribes an awaiting-user-input history task when it is selected and hydrated (F1)", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([], [summary("task_prompt_history", "completed", 9)]),
      false,
    );
    // The task is awaiting input per its snapshot — an active status — so
    // the selection re-establishes its live subscription.
    const apiClient = api({
      fetchTask: vi.fn().mockResolvedValue(
        snapshot("task_prompt_history", 10, "agent", "awaiting_user_input"),
      ),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const eventTransport = transport();
    const controller = new RuntimeController(apiClient, eventTransport);

    await controller.selectTask("task_prompt_history");

    expect(useAgentStore.getState().activeItems).toContain(
      "task_prompt_history",
    );
    expect(eventTransport.subscribe).toHaveBeenCalledWith(
      "task_prompt_history",
      10,
    );
  });

  it("keeps a newer task selection foreground when an earlier start resolves", async () => {
    useAgentStore.getState().mergeTaskPage(page([summary("task_b")]), false);
    const admission = deferred<TaskRunAccepted>();
    const accepted: TaskRunAccepted = {
      request_id: "req_foreground_a",
      task_id: "task_foreground_a",
      run_id: "run_foreground_a",
      status: "queued",
    };
    const apiClient = api({
      createTask: vi.fn(() => admission.promise),
      fetchTask: vi.fn((taskId: string) =>
        Promise.resolve(snapshot(taskId, taskId === "task_b" ? 2 : 1)),
      ),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const eventTransport = transport();
    const controller = new RuntimeController(apiClient, eventTransport);

    const starting = controller.startTask({
      input: "question A",
      databases: [],
      mode: "agent",
    });
    await controller.selectTask("task_b");
    admission.resolve(accepted);
    await starting;

    expect(useAgentStore.getState().activeTaskId).toBe("task_b");
    expect(
      useAgentStore.getState().tasksById.task_foreground_a.hydration,
    ).toBe("snapshot");
    expect(eventTransport.subscribe).toHaveBeenCalledWith(
      "task_foreground_a",
      1,
    );
  });

  it("keeps a newer draft foreground when an earlier start resolves", async () => {
    const admission = deferred<TaskRunAccepted>();
    const accepted: TaskRunAccepted = {
      request_id: "req_draft_foreground",
      task_id: "task_draft_foreground",
      run_id: "run_draft_foreground",
      status: "queued",
    };
    const eventTransport = transport();
    const controller = new RuntimeController(
      api({
        createTask: vi.fn(() => admission.promise),
        fetchTask: vi
          .fn()
          .mockResolvedValue(snapshot("task_draft_foreground", 1)),
        fetchArtifacts: vi.fn().mockResolvedValue([]),
      }),
      eventTransport,
    );

    const starting = controller.startTask({
      input: "question",
      databases: [],
      mode: "agent",
    });
    controller.showNewDraft();
    admission.resolve(accepted);
    await starting;

    expect(useAgentStore.getState().activeTaskId).toBeNull();
    expect(
      useAgentStore.getState().tasksById.task_draft_foreground.hydration,
    ).toBe("snapshot");
    expect(eventTransport.subscribe).toHaveBeenCalledWith(
      "task_draft_foreground",
      1,
    );
  });

  it("admits a new task through REST then hydrates and subscribes without a socket run", async () => {
    const accepted: TaskRunAccepted = {
      request_id: "req_create",
      task_id: "task_created",
      run_id: "run_created",
      status: "queued",
    };
    const apiClient = api({
      createTask: vi.fn().mockResolvedValue(accepted),
      fetchTask: vi.fn().mockResolvedValue(snapshot("task_created", 1)),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const eventTransport = transport();
    const controller = new RuntimeController(apiClient, eventTransport);

    await expect(
      controller.startTask({ input: "question", databases: [], mode: "agent" }),
    ).resolves.toEqual(accepted);

    expect(apiClient.createTask).toHaveBeenCalledWith({
      input: "question",
      databases: [],
      mode: "agent",
    });
    expect(apiClient.fetchTask).toHaveBeenCalledWith("task_created");
    expect(eventTransport.subscribe).toHaveBeenCalledWith("task_created", 1);
    expect(useAgentStore.getState().activeTaskId).toBe("task_created");
  });

  it("returns an accepted task when artifact hydration fails", async () => {
    const accepted: TaskRunAccepted = {
      request_id: "req_artifact_failure",
      task_id: "task_artifact_failure",
      run_id: "run_artifact_failure",
      status: "queued",
    };
    const controller = new RuntimeController(
      api({
        createTask: vi.fn().mockResolvedValue(accepted),
        fetchTask: vi
          .fn()
          .mockResolvedValue(snapshot("task_artifact_failure", 1)),
        fetchArtifacts: vi
          .fn()
          .mockRejectedValue(new TypeError("artifact list unavailable")),
      }),
      transport(),
    );

    await expect(
      controller.startTask({ input: "question", databases: [], mode: "agent" }),
    ).resolves.toEqual(accepted);
    expect(
      useAgentStore.getState().tasksById.task_artifact_failure.hydration,
    ).toBe("snapshot");
  });

  it("drains accepted-task replay through the snapshot watermark before hydrating", async () => {
    const accepted: TaskRunAccepted = {
      request_id: "req_replay",
      task_id: "task_replay",
      run_id: "run_replay",
      status: "queued",
    };
    const order: string[] = [];
    const apiClient = api({
      createTask: vi.fn().mockResolvedValue(accepted),
      fetchTask: vi.fn(() => {
        order.push("fetch");
        return Promise.resolve(snapshot("task_replay", 1));
      }),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const eventTransport = transport({
      subscribe: vi.fn((_taskId, afterSequence) => {
        order.push(`subscribe:${afterSequence}`);
      }),
      unsubscribeAndWait: vi.fn(() => {
        order.push("barrier");
        useAgentStore.getState().applyEvent({
          schema_version: "2.0",
          event_id: "event_replay_1",
          type: "tool_started",
          task_id: "task_replay",
          run_id: "run_replay",
          stage_attempt_id: null,
          sequence: 1,
          timestamp: "2026-07-14T00:00:01Z",
          payload: {
            type: "tool_started",
            tool_call_id: "call_replay",
            tool_name: "search_literature",
          },
        });
        return Promise.resolve();
      }),
    });
    const controller = new RuntimeController(apiClient, eventTransport);

    await controller.startTask({
      input: "question",
      databases: [],
      mode: "agent",
    });

    expect(order).toEqual([
      "fetch",
      "subscribe:0",
      "barrier",
      "subscribe:1",
    ]);
    expect(
      useAgentStore.getState().tasksById.task_replay.activityOrder,
    ).toEqual(["tool:run_replay:call_replay"]);
  });

  it("preserves equal-watermark assistant replay when hydrating the accepted snapshot", async () => {
    const accepted: TaskRunAccepted = {
      request_id: "req_delta",
      task_id: "task_delta",
      run_id: "run_delta",
      status: "queued",
    };
    const detail = snapshot("task_delta", 2);
    detail.messages = [
      {
        message_id: "message_delta_user",
        task_id: "task_delta",
        run_id: "run_delta",
        ordinal: 1,
        role: "user",
        content: "question",
        created_at: CREATED_AT,
      },
    ];
    const eventTransport = transport({
      unsubscribeAndWait: vi.fn(() => {
        useAgentStore.getState().applyEvent({
          schema_version: "2.0",
          event_id: "event_delta_queued",
          type: "run_queued",
          task_id: "task_delta",
          run_id: "run_delta",
          stage_attempt_id: null,
          sequence: 1,
          timestamp: "2026-07-14T00:00:01Z",
          payload: {
            type: "run_queued",
            request_id: "req_delta",
            input: "question",
          },
        });
        useAgentStore.getState().applyEvent({
          schema_version: "2.0",
          event_id: "event_delta_assistant",
          type: "assistant_delta",
          task_id: "task_delta",
          run_id: "run_delta",
          stage_attempt_id: null,
          sequence: 2,
          timestamp: "2026-07-14T00:00:02Z",
          payload: { type: "assistant_delta", delta: "partial answer" },
        });
        return Promise.resolve();
      }),
    });
    const controller = new RuntimeController(
      api({
        createTask: vi.fn().mockResolvedValue(accepted),
        fetchTask: vi.fn().mockResolvedValue(detail),
        fetchArtifacts: vi.fn().mockResolvedValue([]),
      }),
      eventTransport,
    );

    await controller.startTask({
      input: "question",
      databases: [],
      mode: "agent",
    });

    expect(useAgentStore.getState().tasksById.task_delta.runOrder).toEqual([
      "run_delta",
    ]);
    expect(
      useAgentStore.getState().tasksById.task_delta.messages.map((message) => ({
        role: message.role,
        content: message.content,
      })),
    ).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "partial answer" },
    ]);
  });

  it("installs an accepted shell before subscribing and keeps it when hydration fails", async () => {
    const accepted: TaskRunAccepted = {
      request_id: "req_shell",
      task_id: "task_shell",
      run_id: "run_shell",
      status: "queued",
    };
    let shellVisibleAtSubscribe = false;
    const eventTransport = transport({
      subscribe: vi.fn(() => {
        shellVisibleAtSubscribe =
          useAgentStore.getState().tasksById.task_shell?.hydration === "accepted";
      }),
    });
    const controller = new RuntimeController(
      api({
        createTask: vi.fn().mockResolvedValue(accepted),
        fetchTask: vi.fn().mockRejectedValue(new TypeError("network reset")),
      }),
      eventTransport,
    );

    await expect(
      controller.startTask({
        input: "question",
        databases: ["pubmed"],
        mode: "agent",
      }),
    ).resolves.toEqual(accepted);

    const state = useAgentStore.getState();
    expect(shellVisibleAtSubscribe).toBe(true);
    expect(state.activeTaskId).toBe("task_shell");
    expect(state.tasksById.task_shell).toMatchObject({
      hydration: "accepted",
      runOrder: ["run_shell"],
      lastSequence: 0,
    });
    expect(state.tasksById.task_shell.messages[0].content).toBe("question");
  });

  it("recovers a short replay below the startup watermark when snapshot hydration fails", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_existing", "running", 3)]),
      false,
    );
    const accepted: TaskRunAccepted = {
      request_id: "req_existing",
      task_id: "task_existing",
      run_id: "run_task_existing",
      status: "queued",
    };
    const durableEvents = [
      runStartedEvent("task_existing", 1),
      toolStartedEvent("task_existing", 2, "call_recovered"),
      runStartedEvent("task_existing", 3),
    ];
    const eventTransport = watermarkedTransport(
      "task_existing",
      3,
      durableEvents,
    );
    const fetchEvents = vi
      .fn<APIClient["fetchEvents"]>()
      .mockResolvedValue([durableEvents[0]]);
    const controller = new RuntimeController(
      api({
        createTask: vi.fn().mockResolvedValue(accepted),
        fetchTask: vi.fn().mockRejectedValue(new TypeError("detail unavailable")),
        fetchEvents,
      }),
      eventTransport,
    );

    await controller.startTask({
      input: "question",
      databases: ["pubmed"],
      mode: "agent",
    });

    const state = useAgentStore.getState();
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(state.activeTaskId).toBe("task_existing");
    expect(state.tasksById.task_existing).toMatchObject({
      hydration: "accepted",
      runOrder: ["run_task_existing"],
      lastSequence: 3,
    });
    expect(state.tasksById.task_existing.activityOrder).toEqual([
      "tool:run_task_existing:call_recovered",
    ]);
  });

  it("retains the sequence drained by the accepted-task unsubscribe barrier", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_barrier_watermark", "running", 1)]),
      false,
    );
    const accepted: TaskRunAccepted = {
      request_id: "req_barrier_watermark",
      task_id: "task_barrier_watermark",
      run_id: "run_task_barrier_watermark",
      status: "queued",
    };
    const barrier = deferred<void>();
    const recoveredTool = toolStartedEvent(
      "task_barrier_watermark",
      2,
      "call_barrier_watermark",
    );
    const eventTransport = transport({
      isSubscribed: vi.fn().mockReturnValue(true),
      unsubscribeAndWait: vi.fn(() => barrier.promise),
      recoverSubscription: vi.fn(() => {
        useAgentStore.getState().applyEvent(recoveredTool);
        return Promise.resolve();
      }),
    });
    const controller = new RuntimeController(
      api({
        createTask: vi.fn().mockResolvedValue(accepted),
        fetchTask: vi.fn().mockRejectedValue(new TypeError("detail unavailable")),
        fetchEvents: vi
          .fn<APIClient["fetchEvents"]>()
          .mockResolvedValue([runStartedEvent("task_barrier_watermark", 1)]),
      }),
      eventTransport,
    );

    const start = controller.startTask({
      input: "question",
      databases: [],
      mode: "agent",
    });
    await vi.waitFor(() =>
      expect(eventTransport.unsubscribeAndWait).toHaveBeenCalledTimes(1),
    );
    useAgentStore.getState().applyEvent(recoveredTool);
    expect(
      useAgentStore.getState().tasksById.task_barrier_watermark.lastSequence,
    ).toBe(2);
    barrier.resolve();
    await start;

    expect(eventTransport.recoverSubscription).toHaveBeenCalledWith(
      "task_barrier_watermark",
      1,
    );
    expect(
      useAgentStore.getState().tasksById.task_barrier_watermark.activityOrder,
    ).toEqual([
      "tool:run_task_barrier_watermark:call_barrier_watermark",
    ]);
  });

  it("recovers an event-only tool after a short replay instead of skipping to the snapshot", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_short_replay", "running", 3)]),
      false,
    );
    const accepted: TaskRunAccepted = {
      request_id: "req_short_replay",
      task_id: "task_short_replay",
      run_id: "run_task_short_replay",
      status: "queued",
    };
    const durableEvents = [
      runStartedEvent("task_short_replay", 1),
      toolStartedEvent("task_short_replay", 2, "call_short_replay"),
      runStartedEvent("task_short_replay", 3),
    ];
    const fetchEvents = vi
      .fn<APIClient["fetchEvents"]>()
      .mockResolvedValue([durableEvents[0]]);
    const eventTransport = watermarkedTransport(
      "task_short_replay",
      3,
      durableEvents,
    );
    const apiClient = api({
      createTask: vi.fn().mockResolvedValue(accepted),
      fetchTask: vi.fn().mockResolvedValue(snapshot("task_short_replay", 3)),
      fetchEvents,
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const controller = new RuntimeController(apiClient, eventTransport);

    await controller.startTask({
      input: "question",
      databases: [],
      mode: "agent",
    });

    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().tasksById.task_short_replay).toMatchObject({
      hydration: "snapshot",
      lastSequence: 3,
    });
    expect(
      useAgentStore.getState().tasksById.task_short_replay.activityOrder,
    ).toEqual(["tool:run_task_short_replay:call_short_replay"]);
  });

  it("recovers an event-only tool when REST replay throws instead of skipping to the snapshot", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_replay_error", "running", 2)]),
      false,
    );
    const accepted: TaskRunAccepted = {
      request_id: "req_replay_error",
      task_id: "task_replay_error",
      run_id: "run_task_replay_error",
      status: "queued",
    };
    const durableEvents = [
      runStartedEvent("task_replay_error", 1),
      toolStartedEvent("task_replay_error", 2, "call_replay_error"),
    ];
    const eventTransport = watermarkedTransport(
      "task_replay_error",
      2,
      durableEvents,
    );
    const controller = new RuntimeController(
      api({
        createTask: vi.fn().mockResolvedValue(accepted),
        fetchTask: vi.fn().mockResolvedValue(snapshot("task_replay_error", 2)),
        fetchEvents: vi.fn().mockRejectedValue(new Error("events unavailable")),
        fetchArtifacts: vi.fn().mockResolvedValue([]),
      }),
      eventTransport,
    );

    await controller.startTask({ input: "question", databases: [], mode: "agent" });

    expect(
      useAgentStore.getState().tasksById.task_replay_error.activityOrder,
    ).toEqual(["tool:run_task_replay_error:call_replay_error"]);
    expect(useAgentStore.getState().tasksById.task_replay_error.lastSequence).toBe(2);
  });

  it("does not hydrate a snapshot when target subscription recovery rejects", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_recovery_rejected", "running", 2)]),
      false,
    );
    const accepted: TaskRunAccepted = {
      request_id: "req_recovery_rejected",
      task_id: "task_recovery_rejected",
      run_id: "run_task_recovery_rejected",
      status: "queued",
    };
    const eventTransport = transport({
      isSubscribed: vi.fn().mockReturnValue(true),
      recoverSubscription: vi
        .fn()
        .mockRejectedValue(new Error("task_not_found: Task not found")),
    });
    const controller = new RuntimeController(
      api({
        createTask: vi.fn().mockResolvedValue(accepted),
        fetchTask: vi
          .fn()
          .mockResolvedValue(snapshot("task_recovery_rejected", 2)),
        fetchEvents: vi.fn().mockRejectedValue(new Error("events unavailable")),
      }),
      eventTransport,
    );

    await controller.startTask({ input: "question", databases: [], mode: "agent" });

    expect(eventTransport.recoverSubscription).toHaveBeenCalledTimes(1);
    expect(
      useAgentStore.getState().tasksById.task_recovery_rejected,
    ).toMatchObject({
      hydration: "accepted",
      lastSequence: 0,
    });
  });

  it("serializes accepted replay before a same-task selection snapshot", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_serial_handoff", "running", 2)]),
      false,
    );
    const accepted: TaskRunAccepted = {
      request_id: "req_serial_handoff",
      task_id: "task_serial_handoff",
      run_id: "run_task_serial_handoff",
      status: "queued",
    };
    const replay = deferred<EventEnvelope[]>();
    let desired = true;
    const apiClient = api({
      createTask: vi.fn().mockResolvedValue(accepted),
      fetchTask: vi
        .fn<APIClient["fetchTask"]>()
        .mockResolvedValueOnce(snapshot("task_serial_handoff", 2))
        .mockResolvedValueOnce(snapshot("task_serial_handoff", 3)),
      fetchEvents: vi
        .fn<APIClient["fetchEvents"]>()
        .mockImplementationOnce(() => replay.promise)
        .mockResolvedValueOnce([runStartedEvent("task_serial_handoff", 3)]),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const eventTransport = transport({
      isSubscribed: vi.fn(() => desired),
      unsubscribeAndWait: vi.fn(() => {
        desired = false;
        return Promise.resolve();
      }),
      subscribe: vi.fn(() => {
        desired = true;
      }),
    });
    const controller = new RuntimeController(apiClient, eventTransport);

    const starting = controller.startTask({
      input: "question",
      databases: [],
      mode: "agent",
    });
    await vi.waitFor(() => expect(apiClient.fetchEvents).toHaveBeenCalledTimes(1));
    const selection = controller.selectTask("task_serial_handoff");
    const fetchesWhileReplayPending = vi.mocked(apiClient.fetchTask).mock.calls.length;
    replay.resolve([
      runStartedEvent("task_serial_handoff", 1),
      toolStartedEvent(
        "task_serial_handoff",
        2,
        "call_serial_handoff",
      ),
    ]);
    await Promise.all([starting, selection]);

    expect(fetchesWhileReplayPending).toBe(1);
    expect(apiClient.fetchTask).toHaveBeenCalledTimes(2);
    expect(
      useAgentStore.getState().tasksById.task_serial_handoff.activityOrder,
    ).toEqual(["tool:run_task_serial_handoff:call_serial_handoff"]);
  });

  it("drains a startup subscription before resetting an accepted summary watermark", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_existing", "running", 2)]),
      false,
    );
    const accepted: TaskRunAccepted = {
      request_id: "req_existing",
      task_id: "task_existing",
      run_id: "run_task_existing",
      status: "queued",
    };
    let desiredSequence: number | null = 2;
    let serverLastSent = 2;
    const order: string[] = [];
    const replayEvents = [
      {
        schema_version: "2.0" as const,
        event_id: "event_existing_queued",
        type: "run_queued" as const,
        task_id: "task_existing",
        run_id: "run_task_existing",
        stage_attempt_id: null,
        sequence: 1,
        timestamp: "2026-07-14T00:00:01Z",
        payload: {
          type: "run_queued" as const,
          request_id: "req_existing",
          input: "question",
        },
      },
      ...["early", "late"].map((delta, index) => ({
        schema_version: "2.0" as const,
        event_id: `event_existing_delta_${index + 2}`,
        type: "assistant_delta" as const,
        task_id: "task_existing",
        run_id: "run_task_existing",
        stage_attempt_id: null,
        sequence: index + 2,
        timestamp: `2026-07-14T00:00:0${index + 2}Z`,
        payload: { type: "assistant_delta" as const, delta },
      })),
    ];
    const eventTransport = transport({
      isSubscribed: vi.fn(() => desiredSequence !== null),
      unsubscribeAndWait: vi.fn(() => {
        order.push("barrier");
        expect(
          useAgentStore.getState().tasksById.task_existing,
        ).toMatchObject({ hydration: "summary", lastSequence: 2 });
        desiredSequence = null;
        return Promise.resolve();
      }),
      subscribe: vi.fn((_taskId, afterSequence) => {
        serverLastSent = Math.max(serverLastSent, afterSequence);
        desiredSequence = serverLastSent;
        order.push(`subscribe:${serverLastSent}`);
      }),
    });
    const controller = new RuntimeController(
      api({
        createTask: vi.fn().mockResolvedValue(accepted),
        fetchTask: vi.fn().mockResolvedValue(snapshot("task_existing", 3)),
        fetchEvents: vi.fn().mockResolvedValue(replayEvents),
        fetchArtifacts: vi.fn().mockResolvedValue([]),
      }),
      eventTransport,
    );

    await controller.startTask({
      input: "question",
      databases: ["pubmed"],
      mode: "agent",
    });

    expect(order).toEqual(["barrier", "subscribe:3"]);
    expect(desiredSequence).toBe(3);
    expect(useAgentStore.getState().tasksById.task_existing).toMatchObject({
      hydration: "snapshot",
      lastSequence: 3,
    });
    expect(
      useAgentStore.getState().tasksById.task_existing.messages.map(
        (message) => message.content,
      ),
    ).toEqual(["question", "earlylate"]);
  });

  it("requests the next REST replay page after an exact 1000-event page", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_paged", "running", 1001)]),
      false,
    );
    const accepted: TaskRunAccepted = {
      request_id: "req_paged",
      task_id: "task_paged",
      run_id: "run_task_paged",
      status: "queued",
    };
    const firstPage = Array.from({ length: 1000 }, (_, index) =>
      runStartedEvent("task_paged", index + 1),
    );
    const fetchEvents = vi
      .fn<APIClient["fetchEvents"]>()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([runStartedEvent("task_paged", 1001)]);
    const eventTransport = transport({
      isSubscribed: vi.fn().mockReturnValue(true),
    });
    const controller = new RuntimeController(
      api({
        createTask: vi.fn().mockResolvedValue(accepted),
        fetchTask: vi.fn().mockResolvedValue(snapshot("task_paged", 1001)),
        fetchEvents,
        fetchArtifacts: vi.fn().mockResolvedValue([]),
      }),
      eventTransport,
    );

    await controller.startTask({ input: "question", databases: [], mode: "agent" });

    expect(fetchEvents).toHaveBeenNthCalledWith(1, "task_paged", {
      afterSequence: 0,
      limit: 1000,
    });
    expect(fetchEvents).toHaveBeenNthCalledWith(2, "task_paged", {
      afterSequence: 1000,
      limit: 1000,
    });
    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(useAgentStore.getState().tasksById.task_paged.lastSequence).toBe(1001);
    expect(eventTransport.subscribe).toHaveBeenLastCalledWith("task_paged", 1001);
  });

  it("recovers an event-only fixture stage after an empty replay instead of skipping to the snapshot", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_empty_replay", "running", 1, "fixture")]),
      false,
    );
    const accepted: TaskRunAccepted = {
      request_id: "req_empty_replay",
      task_id: "task_empty_replay",
      run_id: "run_task_empty_replay",
      status: "queued",
    };
    const durableEvents = [stageStartedEvent("task_empty_replay", 1)];
    const fetchEvents = vi.fn<APIClient["fetchEvents"]>().mockResolvedValue([]);
    const eventTransport = watermarkedTransport(
      "task_empty_replay",
      1,
      durableEvents,
    );
    const controller = new RuntimeController(
      api({
        createTask: vi.fn().mockResolvedValue(accepted),
        fetchTask: vi
          .fn()
          .mockResolvedValue(snapshot("task_empty_replay", 1, "fixture")),
        fetchEvents,
        fetchArtifacts: vi.fn().mockResolvedValue([]),
      }),
      eventTransport,
    );

    await controller.startTask({ input: "question", databases: [], mode: "fixture" });

    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(
      useAgentStore.getState().tasksById.task_empty_replay.stages.discovery,
    ).toMatchObject({
      stageAttemptId: "attempt_task_empty_replay",
      status: "running",
    });
    expect(useAgentStore.getState().tasksById.task_empty_replay.lastSequence).toBe(1);
  });

  it("recovers an event-only artifact after a replay page does not advance", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_repeated_replay", "running", 1001)]),
      false,
    );
    const accepted: TaskRunAccepted = {
      request_id: "req_repeated_replay",
      task_id: "task_repeated_replay",
      run_id: "run_task_repeated_replay",
      status: "queued",
    };
    const firstPage = Array.from({ length: 1000 }, (_, index) =>
      runStartedEvent("task_repeated_replay", index + 1),
    );
    const repeatedPage = [runStartedEvent("task_repeated_replay", 1000)];
    const recoveredArtifact = artifactEvent(
      "task_repeated_replay",
      1001,
      "artifact_recovered",
      "recovered.csv",
      21,
      "e".repeat(64),
    );
    const fetchEvents = vi
      .fn<APIClient["fetchEvents"]>()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(repeatedPage);
    const eventTransport = watermarkedTransport(
      "task_repeated_replay",
      1001,
      [...firstPage, recoveredArtifact],
    );
    const controller = new RuntimeController(
      api({
        createTask: vi.fn().mockResolvedValue(accepted),
        fetchTask: vi
          .fn()
          .mockResolvedValue(snapshot("task_repeated_replay", 1001)),
        fetchEvents,
        fetchArtifacts: vi.fn().mockResolvedValue([]),
      }),
      eventTransport,
    );

    await controller.startTask({ input: "question", databases: [], mode: "agent" });

    expect(fetchEvents).toHaveBeenNthCalledWith(1, "task_repeated_replay", {
      afterSequence: 0,
      limit: 1000,
    });
    expect(fetchEvents).toHaveBeenNthCalledWith(2, "task_repeated_replay", {
      afterSequence: 1000,
      limit: 1000,
    });
    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(
      useAgentStore.getState().tasksById.task_repeated_replay.artifactOrder,
    ).toEqual(["artifact_recovered"]);
    expect(
      useAgentStore.getState().tasksById.task_repeated_replay.artifactsById
        .artifact_recovered,
    ).toMatchObject({
      name: "recovered.csv",
      size: 21,
    });
  });

  it("does not let stale artifact hydration overwrite a newer live manifest", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_artifact_generation", "running", 0)]),
      false,
    );
    useAgentStore.getState().applyEvent(
      artifactEvent(
        "task_artifact_generation",
        1,
        "run_manifest",
        "run_manifest.json",
        10,
        "a".repeat(64),
      ),
    );
    useAgentStore.getState().applyEvent(
      artifactEvent(
        "task_artifact_generation",
        2,
        "artifact_removed",
        "removed.csv",
        20,
        "b".repeat(64),
      ),
    );
    const artifacts = deferred<Awaited<ReturnType<APIClient["fetchArtifacts"]>>>();
    const apiClient = api({
      fetchTask: vi.fn().mockResolvedValue(snapshot("task_artifact_generation", 2)),
      fetchArtifacts: vi.fn(() => artifacts.promise),
    });
    const controller = new RuntimeController(apiClient, transport());

    const selection = controller.selectTask("task_artifact_generation");
    await vi.waitFor(() => expect(apiClient.fetchArtifacts).toHaveBeenCalledTimes(1));
    useAgentStore.getState().applyEvent(
      artifactEvent(
        "task_artifact_generation",
        3,
        "run_manifest",
        "run_manifest.json",
        30,
        "c".repeat(64),
      ),
    );
    useAgentStore.getState().applyEvent(
      artifactEvent(
        "task_artifact_generation",
        4,
        "artifact_current",
        "current.csv",
        40,
        "d".repeat(64),
      ),
    );
    artifacts.resolve([
      {
        artifact_id: "run_manifest",
        name: "run_manifest.json",
        size: 10,
        sha256: "a".repeat(64),
        media_type: "application/json",
      },
      {
        artifact_id: "artifact_removed",
        name: "removed.csv",
        size: 20,
        sha256: "b".repeat(64),
        media_type: "text/csv",
      },
    ]);
    await selection;

    const task = useAgentStore.getState().tasksById.task_artifact_generation;
    expect(task.artifactOrder).toEqual(["run_manifest", "artifact_current"]);
    expect(task.artifactsById.run_manifest).toMatchObject({
      size: 30,
      sha256: "c".repeat(64),
    });
    expect(task.artifactsById.artifact_removed).toBeUndefined();
  });

  it("binds artifact hydration to each same-task snapshot handoff", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_snapshot_generation", "running", 0)]),
      false,
    );
    useAgentStore.getState().applyEvent(
      artifactEvent(
        "task_snapshot_generation",
        1,
        "run_manifest",
        "run_manifest.json",
        10,
        "a".repeat(64),
      ),
    );
    useAgentStore.getState().applyEvent(
      artifactEvent(
        "task_snapshot_generation",
        2,
        "artifact_removed",
        "removed.csv",
        20,
        "b".repeat(64),
      ),
    );
    const artifactsA = deferred<
      Awaited<ReturnType<APIClient["fetchArtifacts"]>>
    >();
    const artifactsB = deferred<
      Awaited<ReturnType<APIClient["fetchArtifacts"]>>
    >();
    const apiClient = api({
      fetchTask: vi
        .fn<APIClient["fetchTask"]>()
        .mockResolvedValueOnce(
          snapshot("task_snapshot_generation", 2, "agent", "running"),
        )
        .mockResolvedValueOnce(
          snapshot("task_snapshot_generation", 4, "agent", "running"),
        ),
      fetchEvents: vi.fn().mockResolvedValue([
        runStartedEvent("task_snapshot_generation", 1),
        runStartedEvent("task_snapshot_generation", 2),
        runStartedEvent("task_snapshot_generation", 3),
        runStartedEvent("task_snapshot_generation", 4),
      ]),
      fetchArtifacts: vi
        .fn<APIClient["fetchArtifacts"]>()
        .mockImplementationOnce(() => artifactsA.promise)
        .mockImplementationOnce(() => artifactsB.promise),
    });
    const eventTransport = transport();
    const controller = new RuntimeController(apiClient, eventTransport);

    const firstSelection = controller.selectTask("task_snapshot_generation");
    await vi.waitFor(() => expect(apiClient.fetchArtifacts).toHaveBeenCalledTimes(1));
    const secondSelection = controller.selectTask("task_snapshot_generation");
    await vi.waitFor(() => expect(eventTransport.subscribe).toHaveBeenCalledTimes(2));

    artifactsB.resolve([
      {
        artifact_id: "run_manifest",
        name: "run_manifest.json",
        size: 30,
        sha256: "c".repeat(64),
        media_type: "application/json",
      },
      {
        artifact_id: "artifact_current",
        name: "current.csv",
        size: 40,
        sha256: "d".repeat(64),
        media_type: "text/csv",
      },
    ]);
    artifactsA.resolve([
      {
        artifact_id: "run_manifest",
        name: "run_manifest.json",
        size: 10,
        sha256: "a".repeat(64),
        media_type: "application/json",
      },
      {
        artifact_id: "artifact_removed",
        name: "removed.csv",
        size: 20,
        sha256: "b".repeat(64),
        media_type: "text/csv",
      },
    ]);
    await Promise.all([firstSelection, secondSelection]);

    expect(apiClient.fetchArtifacts).toHaveBeenCalledTimes(2);
    const task = useAgentStore.getState().tasksById.task_snapshot_generation;
    expect(task.lastSequence).toBe(4);
    expect(task.artifactOrder).toEqual(["run_manifest", "artifact_current"]);
    expect(task.artifactsById.run_manifest).toMatchObject({
      size: 30,
      sha256: "c".repeat(64),
    });
    expect(task.artifactsById.artifact_removed).toBeUndefined();
  });

  it("rejects stale start-task artifacts after a newer selection snapshot", async () => {
    const accepted: TaskRunAccepted = {
      request_id: "req_start_artifact_generation",
      task_id: "task_start_artifact_generation",
      run_id: "run_start_artifact_generation",
      status: "queued",
    };
    const artifactsA = deferred<
      Awaited<ReturnType<APIClient["fetchArtifacts"]>>
    >();
    const artifactsB = deferred<
      Awaited<ReturnType<APIClient["fetchArtifacts"]>>
    >();
    const apiClient = api({
      createTask: vi.fn().mockResolvedValue(accepted),
      fetchTask: vi
        .fn<APIClient["fetchTask"]>()
        .mockResolvedValueOnce(snapshot("task_start_artifact_generation", 1))
        .mockResolvedValueOnce(snapshot("task_start_artifact_generation", 3)),
      fetchEvents: vi.fn().mockResolvedValue([
        runStartedEvent("task_start_artifact_generation", 2),
        runStartedEvent("task_start_artifact_generation", 3),
      ]),
      fetchArtifacts: vi
        .fn<APIClient["fetchArtifacts"]>()
        .mockImplementationOnce(() => artifactsA.promise)
        .mockImplementationOnce(() => artifactsB.promise),
    });
    const controller = new RuntimeController(apiClient, transport());

    const starting = controller.startTask({
      input: "question",
      databases: [],
      mode: "agent",
    });
    await vi.waitFor(() => expect(apiClient.fetchArtifacts).toHaveBeenCalledTimes(1));
    const selection = controller.selectTask("task_start_artifact_generation");
    await vi.waitFor(() => expect(apiClient.fetchArtifacts).toHaveBeenCalledTimes(2));
    artifactsB.resolve([
      {
        artifact_id: "run_manifest",
        name: "run_manifest.json",
        size: 30,
        sha256: "c".repeat(64),
        media_type: "application/json",
      },
      {
        artifact_id: "artifact_current",
        name: "current.csv",
        size: 40,
        sha256: "d".repeat(64),
        media_type: "text/csv",
      },
    ]);
    await selection;
    artifactsA.resolve([
      {
        artifact_id: "run_manifest",
        name: "run_manifest.json",
        size: 10,
        sha256: "a".repeat(64),
        media_type: "application/json",
      },
      {
        artifact_id: "artifact_removed",
        name: "removed.csv",
        size: 20,
        sha256: "b".repeat(64),
        media_type: "text/csv",
      },
    ]);
    await starting;

    const task = useAgentStore.getState().tasksById.task_start_artifact_generation;
    expect(task.lastSequence).toBe(3);
    expect(task.artifactOrder).toEqual(["run_manifest", "artifact_current"]);
    expect(task.artifactsById.run_manifest).toMatchObject({
      size: 30,
      sha256: "c".repeat(64),
    });
    expect(task.artifactsById.artifact_removed).toBeUndefined();
  });

  it("replays a queued event that arrives before accepted-task hydration", async () => {
    const accepted: TaskRunAccepted = {
      request_id: "req_race",
      task_id: "task_race",
      run_id: "run_race",
      status: "queued",
    };
    const apiClient = api({
      createTask: vi.fn().mockResolvedValue(accepted),
      fetchTask: vi.fn().mockRejectedValue(new TypeError("detail unavailable")),
    });
    const eventTransport = transport({
      subscribe: vi.fn((taskId, afterSequence) => {
        expect(taskId).toBe("task_race");
        expect(afterSequence).toBe(0);
        useAgentStore.getState().applyEvent({
          schema_version: "2.0",
          event_id: "event_race_1",
          type: "run_queued",
          task_id: "task_race",
          run_id: "run_race",
          stage_attempt_id: null,
          sequence: 1,
          timestamp: "2026-07-14T00:00:01Z",
          payload: {
            type: "run_queued",
            request_id: "req_race",
            input: "question",
          },
        });
      }),
    });
    const controller = new RuntimeController(apiClient, eventTransport);

    await controller.startTask({ input: "question", databases: [], mode: "agent" });

    const task = useAgentStore.getState().tasksById.task_race;
    expect(task.lastSequence).toBe(1);
    expect(task.messages).toHaveLength(1);
    expect(task.messages[0].messageId).toBe("live:run_race:user");
  });

  it("leaves the task projection unchanged when continuation returns 409", async () => {
    useAgentStore.getState().mergeTaskPage(page([summary("task_a")]), false);
    const before = useAgentStore.getState().tasksById;
    const apiClient = api({
      continueTask: vi.fn().mockRejectedValue(new Error("409 conflict")),
    });
    const controller = new RuntimeController(apiClient, transport());

    await expect(
      controller.continueTask("task_a", { input: "follow up" }),
    ).rejects.toThrow("409 conflict");
    expect(useAgentStore.getState().tasksById).toBe(before);
  });

  it("projects a successful continuation as queued before the next websocket event", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([], [summary("task_terminal", "completed")]),
      false,
    );
    useAgentStore.getState().setActiveTaskId("task_terminal");
    const accepted: TaskRunAccepted = {
      request_id: "req_follow_success",
      task_id: "task_terminal",
      run_id: "run_follow_success",
      status: "queued",
    };
    const apiClient = api({
      continueTask: vi.fn().mockResolvedValue(accepted),
    });
    const controller = new RuntimeController(apiClient, transport());

    await controller.continueTask("task_terminal", { input: "follow up" });

    const task = useAgentStore.getState().tasksById.task_terminal;
    expect(task.summary.status).toBe("queued");
    expect(task.summary.active_run_id).toBe("run_follow_success");
    expect(task.runsById.run_follow_success?.status).toBe("queued");
    expect(task.messages).toContainEqual(
      expect.objectContaining({
        runId: "run_follow_success",
        role: "user",
        content: "follow up",
      }),
    );
    expect(useAgentStore.getState().activeItems).toContain("task_terminal");
    expect(useAgentStore.getState().taskOrder).not.toContain("task_terminal");
    expect(useAgentStore.getState().activeTaskId).toBe("task_terminal");
  });

  it("re-subscribes a terminal task when it is continued (replacing the leaked subscription)", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([], [summary("task_terminal", "completed", 5)]),
      false,
    );
    // Model a fully-hydrated terminal task (the normal live-path case after
    // F2 unsubscribes it): its watermark must be preserved on re-subscribe.
    const merged = useAgentStore.getState().tasksById.task_terminal;
    useAgentStore.setState({
      tasksById: {
        ...useAgentStore.getState().tasksById,
        task_terminal: { ...merged, hydration: "snapshot" },
      },
    });
    const accepted: TaskRunAccepted = {
      request_id: "req_continue_subscribe",
      task_id: "task_terminal",
      run_id: "run_continue_subscribe",
      status: "queued",
    };
    const apiClient = api({
      continueTask: vi.fn().mockResolvedValue(accepted),
    });
    const eventTransport = transport();
    const controller = new RuntimeController(apiClient, eventTransport);

    await controller.continueTask("task_terminal", { input: "follow up" });

    expect(eventTransport.subscribe).toHaveBeenCalledWith(
      "task_terminal",
      5,
    );
  });

  it("sorts an older continued task among newer active tasks by immutable creation", async () => {
    useAgentStore.getState().mergeTaskPage(
      page(
        [
          summary(
            "task_newest",
            "running",
            4,
            "agent",
            "2026-07-16T00:00:00Z",
          ),
          summary(
            "task_peer_a",
            "running",
            3,
            "agent",
            "2026-07-15T00:00:00Z",
          ),
          summary(
            "task_peer_b",
            "running",
            2,
            "agent",
            "2026-07-15T00:00:00Z",
          ),
        ],
        [
          summary(
            "task_older",
            "completed",
            1,
            "agent",
            "2026-07-13T00:00:00Z",
          ),
        ],
      ),
      false,
    );
    const apiClient = api({
      continueTask: vi.fn().mockResolvedValue({
        request_id: "req_continue_older",
        task_id: "task_older",
        run_id: "run_continue_older",
        status: "queued",
      }),
    });

    await new RuntimeController(apiClient, transport()).continueTask(
      "task_older",
      { input: "follow up" },
    );

    expect(useAgentStore.getState().activeItems).toEqual([
      "task_newest",
      "task_peer_b",
      "task_peer_a",
      "task_older",
    ]);
    expect(useAgentStore.getState().taskOrder).not.toContain("task_older");
  });

  it("re-sorts an active continuation when run_queued arrives before admission", async () => {
    useAgentStore.getState().mergeTaskPage(
      page(
        [
          summary(
            "task_active_old",
            "running",
            1,
            "agent",
            "2026-07-13T00:00:00Z",
          ),
        ],
        [
          summary(
            "task_middle",
            "completed",
            1,
            "agent",
            "2026-07-15T00:00:00Z",
          ),
        ],
      ),
      false,
    );
    const accepted: TaskRunAccepted = {
      request_id: "req_continue_middle",
      task_id: "task_middle",
      run_id: "run_continue_middle",
      status: "queued",
    };
    const continuation = deferred<TaskRunAccepted>();
    const apiClient = api({
      continueTask: vi.fn(() => continuation.promise),
    });
    const controller = new RuntimeController(apiClient, transport());

    const pending = controller.continueTask("task_middle", {
      input: "follow up",
    });
    useAgentStore.getState().applyEvent({
      schema_version: "2.0",
      event_id: "event_continue_middle_queued",
      type: "run_queued",
      task_id: "task_middle",
      run_id: "run_continue_middle",
      stage_attempt_id: null,
      sequence: 2,
      timestamp: "2026-07-15T00:00:01Z",
      payload: {
        type: "run_queued",
        request_id: "req_continue_middle",
        input: "follow up",
      },
    });
    expect(useAgentStore.getState().activeItems).toEqual([
      "task_active_old",
      "task_middle",
    ]);

    continuation.resolve(accepted);
    await pending;

    expect(useAgentStore.getState().activeItems).toEqual([
      "task_middle",
      "task_active_old",
    ]);
  });

  it("hydrates the authoritative snapshot returned by run cancellation", async () => {
    useAgentStore.getState().mergeTaskPage(page([summary("task_cancel")]), false);
    const cancelledSnapshot: TaskSnapshot = {
      task: {
        ...summary("task_cancel", "running", 3),
        status: "cancel_requested",
        active_run_id: "run_task_cancel",
      },
      runs: [
        {
          run_id: "run_task_cancel",
          task_id: "task_cancel",
          request_id: "req_cancel",
          status: "cancel_requested",
          input: "question",
          created_at: CREATED_AT,
          updated_at: CREATED_AT,
          started_at: CREATED_AT,
          finished_at: null,
          error: null,
        },
      ],
      messages: [],
      older_messages_cursor: null,
    };
    const apiClient = api({
      cancelRun: vi.fn().mockResolvedValue(cancelledSnapshot),
      fetchEvents: vi.fn().mockResolvedValue([
        runStartedEvent("task_cancel", 1),
        toolStartedEvent("task_cancel", 2, "call_before_cancel"),
        runCancelRequestedEvent("task_cancel", 3),
      ]),
    });
    const controller = new RuntimeController(apiClient, transport());

    await controller.cancelRun("task_cancel", "run_task_cancel");

    expect(apiClient.cancelRun).toHaveBeenCalledWith(
      "task_cancel",
      "run_task_cancel",
    );
    expect(useAgentStore.getState().tasksById.task_cancel.summary.status).toBe(
      "cancel_requested",
    );
  });

  it("delegates one child cancellation to the API and replays through its snapshot watermark", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_child_cancel", "running", 1)]),
      false,
    );
    const cancelledSnapshot: TaskSnapshot = {
      task: {
        ...summary("task_child_cancel", "running", 2),
        active_run_id: "run_task_child_cancel",
      },
      runs: [],
      messages: [],
      older_messages_cursor: null,
    };
    const apiClient = api({
      cancelSubagent: vi.fn().mockResolvedValue(cancelledSnapshot),
      fetchEvents: vi.fn().mockResolvedValue([
        {
          schema_version: "2.0",
          event_id: "event_child_cancel_requested",
          type: "subagent_cancel_requested",
          task_id: "task_child_cancel",
          run_id: "run_task_child_cancel",
          subagent_id: "subagent_1",
          parent_tool_call_id: "tool_1",
          stage_attempt_id: null,
          sequence: 2,
          timestamp: CREATED_AT,
          payload: {
            type: "subagent_cancel_requested",
            subagent_id: "subagent_1",
            reason: null,
          },
        },
      ]),
    });
    const controller = new RuntimeController(apiClient, transport());

    await controller.cancelSubagent(
      "task_child_cancel",
      "run_task_child_cancel",
      "subagent_1",
    );

    expect(apiClient.cancelSubagent).toHaveBeenCalledWith(
      "task_child_cancel",
      "run_task_child_cancel",
      "subagent_1",
    );
    expect(apiClient.fetchEvents).toHaveBeenCalledWith("task_child_cancel", {
      afterSequence: 1,
      limit: 1000,
    });
    expect(
      useAgentStore.getState().tasksById.task_child_cancel.lastSequence,
    ).toBe(2);
  });

  it("replays diagnostic events before hydrating a cancellation snapshot", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_cancel_replay", "running", 1)]),
      false,
    );
    const cancelledSnapshot: TaskSnapshot = {
      task: {
        ...summary("task_cancel_replay", "running", 2),
        status: "cancel_requested",
        active_run_id: "run_task_cancel_replay",
      },
      runs: [
        {
          run_id: "run_task_cancel_replay",
          task_id: "task_cancel_replay",
          request_id: "req_cancel_replay",
          status: "cancel_requested",
          input: "question",
          created_at: CREATED_AT,
          updated_at: CREATED_AT,
          started_at: CREATED_AT,
          finished_at: null,
          error: null,
        },
      ],
      messages: [],
      older_messages_cursor: null,
    };
    const apiClient = api({
      cancelRun: vi.fn().mockResolvedValue(cancelledSnapshot),
      fetchEvents: vi
        .fn()
        .mockResolvedValue([
          toolStartedEvent("task_cancel_replay", 2, "call_before_cancel"),
        ]),
    });
    const controller = new RuntimeController(apiClient, transport());

    await controller.cancelRun(
      "task_cancel_replay",
      "run_task_cancel_replay",
    );

    expect(apiClient.fetchEvents).toHaveBeenCalledWith("task_cancel_replay", {
      afterSequence: 1,
      limit: 1000,
    });
    expect(
      useAgentStore.getState().tasksById.task_cancel_replay.activityOrder,
    ).toEqual(["tool:run_task_cancel_replay:call_before_cancel"]);
  });

  it("hydrates a successful cancellation when diagnostic replay fails", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_cancel_fallback", "running", 1)]),
      false,
    );
    const cancelledSnapshot: TaskSnapshot = {
      task: {
        ...summary("task_cancel_fallback", "running", 2),
        status: "cancel_requested",
        active_run_id: "run_task_cancel_fallback",
      },
      runs: [
        {
          run_id: "run_task_cancel_fallback",
          task_id: "task_cancel_fallback",
          request_id: "req_cancel_fallback",
          status: "cancel_requested",
          input: "question",
          created_at: CREATED_AT,
          updated_at: CREATED_AT,
          started_at: CREATED_AT,
          finished_at: null,
          error: null,
        },
      ],
      messages: [],
      older_messages_cursor: null,
    };
    const apiClient = api({
      cancelRun: vi.fn().mockResolvedValue(cancelledSnapshot),
      fetchEvents: vi.fn().mockRejectedValue(new Error("events unavailable")),
    });
    const controller = new RuntimeController(apiClient, transport());

    await expect(
      controller.cancelRun(
        "task_cancel_fallback",
        "run_task_cancel_fallback",
      ),
    ).resolves.toBeUndefined();

    expect(
      useAgentStore.getState().tasksById.task_cancel_fallback,
    ).toMatchObject({
      lastSequence: 2,
      summary: { status: "cancel_requested" },
    });
  });

  it("does not let stale artifact hydration overwrite a cancellation snapshot", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_cancel_generation", "running", 1)]),
      false,
    );
    const artifacts = deferred<Awaited<ReturnType<APIClient["fetchArtifacts"]>>>();
    const selectedSnapshot = snapshot("task_cancel_generation", 2);
    const cancelledSnapshot: TaskSnapshot = {
      ...selectedSnapshot,
      task: {
        ...selectedSnapshot.task,
        status: "cancel_requested",
        active_run_id: "run_task_cancel_generation",
        latest_sequence: 3,
      },
    };
    const apiClient = api({
      fetchTask: vi.fn().mockResolvedValue(selectedSnapshot),
      fetchArtifacts: vi.fn(() => artifacts.promise),
      cancelRun: vi.fn().mockResolvedValue(cancelledSnapshot),
      fetchEvents: vi
        .fn<APIClient["fetchEvents"]>()
        .mockResolvedValueOnce([
          runStartedEvent("task_cancel_generation", 1),
          runStartedEvent("task_cancel_generation", 2),
        ])
        .mockResolvedValueOnce([
          runCancelRequestedEvent("task_cancel_generation", 3),
        ]),
    });
    const controller = new RuntimeController(apiClient, transport());

    const selection = controller.selectTask("task_cancel_generation");
    await vi.waitFor(() => expect(apiClient.fetchArtifacts).toHaveBeenCalled());
    await controller.cancelRun("task_cancel_generation", "run_task_cancel_generation");
    artifacts.resolve([
      {
        artifact_id: "stale_artifact",
        name: "stale.csv",
        size: 1,
        sha256: "a".repeat(64),
        media_type: "text/csv",
      },
    ]);
    await selection;

    const task = useAgentStore.getState().tasksById.task_cancel_generation;
    expect(task.summary.status).toBe("cancel_requested");
    expect(task.artifactOrder).toEqual([]);
  });

  it("keeps a terminal task projected until authoritative deletion succeeds", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([], [summary("task_delete", "completed", 2)]),
      false,
    );
    useAgentStore.getState().setActiveTaskId("task_delete");
    const deletion = deferred<void>();
    const apiClient = api({ deleteTask: vi.fn(() => deletion.promise) });
    const eventTransport = transport({
      isSubscribed: vi.fn().mockReturnValue(true),
    });
    const controller = new RuntimeController(apiClient, eventTransport);

    const pending = controller.deleteTask("task_delete");
    expect(useAgentStore.getState().tasksById.task_delete).toBeDefined();
    expect(useAgentStore.getState().taskOrder).toContain("task_delete");
    expect(eventTransport.unsubscribeAndWait).not.toHaveBeenCalled();

    deletion.resolve();
    await pending;

    expect(apiClient.deleteTask).toHaveBeenCalledWith("task_delete");
    expect(eventTransport.unsubscribeAndWait).toHaveBeenCalledWith("task_delete");
    expect(useAgentStore.getState().tasksById.task_delete).toBeUndefined();
    expect(useAgentStore.getState().taskOrder).not.toContain("task_delete");
    expect(useAgentStore.getState().activeTaskId).toBeNull();
  });

  it("does not resurrect a deleted task when an earlier selection snapshot resolves late", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([], [summary("task_delete_race", "completed", 2)]),
      false,
    );
    const detail = deferred<TaskSnapshot>();
    const apiClient = api({
      fetchTask: vi.fn(() => detail.promise),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
      deleteTask: vi.fn().mockResolvedValue(undefined),
    });
    const eventTransport = transport();
    const controller = new RuntimeController(apiClient, eventTransport);

    const selection = controller.selectTask("task_delete_race");
    await vi.waitFor(() => expect(apiClient.fetchTask).toHaveBeenCalledTimes(1));
    await controller.deleteTask("task_delete_race");
    detail.resolve(snapshot("task_delete_race", 2));
    await selection;

    expect(useAgentStore.getState().tasksById.task_delete_race).toBeUndefined();
    expect(useAgentStore.getState().activeTaskId).toBeNull();
    expect(eventTransport.subscribe).not.toHaveBeenCalled();
    expect(apiClient.fetchArtifacts).not.toHaveBeenCalled();
  });

  it("does not resurrect a deleted task from an earlier history page request", async () => {
    useAgentStore.getState().mergeTaskPage(
      page(
        [],
        [summary("task_delete_page_race", "completed", 2)],
        "cursor_delete_race",
      ),
      false,
    );
    const nextPage = deferred<TaskPage>();
    const apiClient = api({
      fetchTasks: vi.fn(() => nextPage.promise),
      deleteTask: vi.fn().mockResolvedValue(undefined),
    });
    const controller = new RuntimeController(apiClient, transport());

    const loading = controller.loadMoreTasks();
    await vi.waitFor(() => expect(apiClient.fetchTasks).toHaveBeenCalledTimes(1));
    await controller.deleteTask("task_delete_page_race");
    nextPage.resolve(
      page(
        [],
        [
          summary("task_delete_page_race", "completed", 2),
          summary("task_history_survivor", "completed", 1),
        ],
      ),
    );
    await loading;

    expect(
      useAgentStore.getState().tasksById.task_delete_page_race,
    ).toBeUndefined();
    expect(
      useAgentStore.getState().tasksById.task_history_survivor,
    ).toBeDefined();
  });

  it("retains a terminal task when authoritative deletion fails", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([], [summary("task_delete", "completed", 2)]),
      false,
    );
    const apiClient = api({
      deleteTask: vi.fn().mockRejectedValue(new Error("delete failed")),
    });
    const controller = new RuntimeController(apiClient, transport());

    await expect(controller.deleteTask("task_delete")).rejects.toThrow(
      "delete failed",
    );
    expect(useAgentStore.getState().tasksById.task_delete).toBeDefined();
    expect(useAgentStore.getState().taskOrder).toContain("task_delete");
  });

  it("loads one more history page per call without duplicating active tasks or changing selection", async () => {
    useAgentStore.getState().mergeTaskPage(
      page(
        [summary("task_active")],
        [summary("task_history", "completed")],
        "cursor_1",
      ),
      false,
    );
    useAgentStore.getState().setActiveTaskId("task_history");
    const apiClient = api({
      fetchTasks: vi
        .fn()
        .mockResolvedValueOnce(
          page(
            [summary("task_active")],
            [
              summary(
                "task_older",
                "completed",
                0,
                "agent",
                "2026-07-13T00:00:00Z",
              ),
            ],
            "cursor_2",
          ),
        )
        .mockResolvedValueOnce(
          page(
            [],
            [
              summary(
                "task_oldest",
                "completed",
                0,
                "agent",
                "2026-07-12T00:00:00Z",
              ),
            ],
            null,
          ),
        ),
    });
    const controller = new RuntimeController(apiClient, transport());

    await controller.loadMoreTasks();

    expect(apiClient.fetchTasks).toHaveBeenNthCalledWith(1, {
      limit: 10,
      cursor: "cursor_1",
    });
    expect(useAgentStore.getState().activeItems).toEqual(["task_active"]);
    expect(useAgentStore.getState().taskOrder).toEqual([
      "task_history",
      "task_older",
    ]);
    expect(useAgentStore.getState().activeTaskId).toBe("task_history");
    expect(useAgentStore.getState().nextCursor).toBe("cursor_2");

    await controller.loadMoreTasks();

    expect(apiClient.fetchTasks).toHaveBeenNthCalledWith(2, {
      limit: 10,
      cursor: "cursor_2",
    });
    expect(useAgentStore.getState().activeItems).toEqual(["task_active"]);
    expect(useAgentStore.getState().taskOrder).toEqual([
      "task_history",
      "task_older",
      "task_oldest",
    ]);
    expect(useAgentStore.getState().activeTaskId).toBe("task_history");
    expect(useAgentStore.getState().nextCursor).toBeNull();
  });

  it("resumes loading the next page from the failed cursor", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([], [summary("task_history", "completed")], "cursor_1"),
      false,
    );
    const apiClient = api({
      fetchTasks: vi
        .fn()
        .mockResolvedValueOnce(
          page(
            [],
            [
              summary(
                "task_older",
                "completed",
                0,
                "agent",
                "2026-07-13T00:00:00Z",
              ),
            ],
            "cursor_2",
          ),
        )
        .mockRejectedValueOnce(new Error("page unavailable"))
        .mockResolvedValueOnce(
          page(
            [],
            [
              summary(
                "task_oldest",
                "completed",
                0,
                "agent",
                "2026-07-12T00:00:00Z",
              ),
            ],
            null,
          ),
        ),
    });
    const controller = new RuntimeController(apiClient, transport());

    await controller.loadMoreTasks();
    expect(useAgentStore.getState().taskOrder).toEqual([
      "task_history",
      "task_older",
    ]);
    expect(useAgentStore.getState().nextCursor).toBe("cursor_2");

    await expect(controller.loadMoreTasks()).rejects.toThrow("page unavailable");
    expect(useAgentStore.getState().taskOrder).toEqual([
      "task_history",
      "task_older",
    ]);
    expect(useAgentStore.getState().nextCursor).toBe("cursor_2");

    await controller.loadMoreTasks();

    expect(apiClient.fetchTasks).toHaveBeenNthCalledWith(3, {
      limit: 10,
      cursor: "cursor_2",
    });
    expect(useAgentStore.getState().taskOrder).toEqual([
      "task_history",
      "task_older",
      "task_oldest",
    ]);
    expect(useAgentStore.getState().nextCursor).toBeNull();
  });

  it("rejects cyclic history cursors instead of requesting forever", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([], [summary("task_history", "completed")], "cursor_1"),
      false,
    );
    const apiClient = api({
      fetchTasks: vi.fn().mockResolvedValueOnce(page([], [], "cursor_1")),
    });
    const controller = new RuntimeController(apiClient, transport());

    await expect(controller.loadMoreTasks()).rejects.toThrow(
      "Task pagination cursor did not advance",
    );
    expect(apiClient.fetchTasks).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent requests to load more history", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([], [summary("task_history", "completed")], "cursor_1"),
      false,
    );
    const nextPage = deferred<TaskPage>();
    const apiClient = api({ fetchTasks: vi.fn(() => nextPage.promise) });
    const controller = new RuntimeController(apiClient, transport());

    const first = controller.loadMoreTasks();
    const second = controller.loadMoreTasks();
    expect(first).toBe(second);
    expect(apiClient.fetchTasks).toHaveBeenCalledTimes(1);

    nextPage.resolve(page([], [summary("task_older", "completed")], null));
    await Promise.all([first, second]);

    expect(apiClient.fetchTasks).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent older-message requests for the same task", async () => {
    useAgentStore.getState().hydrateTaskSnapshot({
      ...snapshot("task_messages", 3),
      messages: [
        {
          message_id: "message_3",
          task_id: "task_messages",
          run_id: "run_3",
          ordinal: 3,
          role: "user",
          content: "message 3",
          created_at: CREATED_AT,
        },
      ],
      older_messages_cursor: "cursor_before_3",
    });
    const messagePage = deferred<MessagePage>();
    const apiClient = api({
      fetchMessages: vi.fn(() => messagePage.promise),
    });
    const controller = new RuntimeController(apiClient, transport());

    const first = controller.loadOlderMessages("task_messages");
    const second = controller.loadOlderMessages("task_messages");

    expect(apiClient.fetchMessages).toHaveBeenCalledTimes(1);
    expect(apiClient.fetchMessages).toHaveBeenCalledWith("task_messages", {
      limit: 100,
      cursor: "cursor_before_3",
    });
    messagePage.resolve({
      messages: [
        {
          message_id: "message_2",
          task_id: "task_messages",
          run_id: "run_2",
          ordinal: 2,
          role: "assistant",
          content: "message 2",
          created_at: CREATED_AT,
        },
      ],
      next_cursor: null,
    });
    await Promise.all([first, second]);

    const task = useAgentStore.getState().tasksById.task_messages;
    expect(task.messages.map((message) => message.messageId)).toEqual([
      "message_2",
      "message_3",
    ]);
    expect(task.olderMessagesCursor).toBeNull();
  });

  it("does not fetch older messages when the task has no cursor", async () => {
    useAgentStore.getState().hydrateTaskSnapshot(snapshot("task_messages", 3));
    const apiClient = api({ fetchMessages: vi.fn() });
    const controller = new RuntimeController(apiClient, transport());

    await controller.loadOlderMessages("task_messages");

    expect(apiClient.fetchMessages).not.toHaveBeenCalled();
  });

  it("marks the selected task as hydrating until selection finishes", async () => {
    const taskId = "task_hydrating_marker";
    useAgentStore.getState().mergeTaskPage(
      page([], [summary(taskId, "completed", 3)]),
      false,
    );
    const snapshotRequest = deferred<TaskSnapshot>();
    const apiClient = api({
      fetchTask: vi.fn(() => snapshotRequest.promise),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const controller = new RuntimeController(apiClient, transport());

    const selection = controller.selectTask(taskId);
    expect(useAgentStore.getState().hydratingTaskId).toBe(taskId);

    snapshotRequest.resolve(snapshot(taskId, 3, "agent", "completed"));
    await selection;

    expect(useAgentStore.getState().hydratingTaskId).toBeNull();
  });

  it("clears the hydration marker when selection fails", async () => {
    const taskId = "task_hydrating_failure";
    useAgentStore.getState().mergeTaskPage(
      page([], [summary(taskId, "completed", 3)]),
      false,
    );
    const apiClient = api({
      fetchTask: vi.fn(() => Promise.reject(new Error("snapshot failed"))),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const controller = new RuntimeController(apiClient, transport());

    await expect(controller.selectTask(taskId)).rejects.toThrow(
      "snapshot failed",
    );
    expect(useAgentStore.getState().hydratingTaskId).toBeNull();
  });

  it("opens a cached historical conversation instantly without replaying its event log", async () => {
    localStorage.clear();
    const taskId = "task_cached_history";
    const cached = createTaskProjection(summary(taskId, "completed", 5));
    cached.hydration = "snapshot";
    cached.lastSequence = 5;
    cached.items = [
      {
        itemId: `assistant:live:${taskId}:0`,
        kind: "assistant_segment",
        runId: `run_${taskId}`,
        sequence: 4,
        createdAt: CREATED_AT,
        streamId: `live:${taskId}:0`,
        content: "cached answer",
        isStreaming: false,
        finishReason: null,
      },
    ];
    saveTaskProjection(cached);

    useAgentStore.getState().mergeTaskPage(
      page([], [summary(taskId, "completed", 5)]),
      false,
    );

    const fetchEvents = vi.fn<APIClient["fetchEvents"]>();
    const apiClient = api({
      fetchTask: vi
        .fn()
        .mockResolvedValue(snapshot(taskId, 5, "agent", "completed")),
      fetchEvents,
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const eventTransport = transport();
    const controller = new RuntimeController(apiClient, eventTransport);

    await controller.selectTask(taskId);

    const task = useAgentStore.getState().tasksById[taskId];
    expect(task.hydration).toBe("snapshot");
    expect(
      task.items.some(
        (item) => "content" in item && item.content === "cached answer",
      ),
    ).toBe(true);
    expect(fetchEvents).not.toHaveBeenCalled();
    expect(eventTransport.subscribe).not.toHaveBeenCalled();
  });
});
