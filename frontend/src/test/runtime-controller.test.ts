import { beforeEach, describe, expect, it, vi } from "vitest";

import type { APIClient } from "@/hooks/useAPI";
import type {
  DatabaseRecord,
  EventEnvelope,
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
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

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
): TaskSummary {
  return {
    task_id: taskId,
    mode: "agent",
    databases: [],
    title: taskId,
    status,
    active_run_id: status === "running" ? `run_${taskId}` : null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
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

function snapshot(taskId: string, latestSequence: number): TaskSnapshot {
  return {
    task: summary(taskId, "completed", latestSequence),
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
    fetchEvents: vi.fn(),
    createTask: vi.fn(),
    continueTask: vi.fn(),
    cancelRun: vi.fn(),
    fetchArtifacts: vi.fn(),
    getArtifactUrl: vi.fn(),
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
    ...overrides,
  };
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
    expect(apiClient.fetchTasks).toHaveBeenCalledWith({ limit: 30 });
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

  it("selects a background task only after the unsubscribe barrier and snapshot", async () => {
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
    barrier.resolve();
    await Promise.resolve();
    expect(order).toEqual(["barrier", "fetch"]);
    expect(useAgentStore.getState().activeTaskId).toBeNull();
    detail.resolve(snapshot("task_a", 9));
    await selection;

    expect(useAgentStore.getState().activeTaskId).toBe("task_a");
    expect(order).toEqual(["barrier", "fetch", "subscribe"]);
    expect(eventTransport.subscribe).toHaveBeenLastCalledWith("task_a", 9);
    expect(
      useAgentStore.getState().tasksById.task_a.artifactOrder,
    ).toEqual(["artifact_selected"]);
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
    detail.resolve(snapshot("task_a", 7));
    await Promise.all([first, second]);

    expect(fetchesBeforeBarrier).toBe(0);
    expect(eventTransport.unsubscribeAndWait).toHaveBeenCalledTimes(1);
    expect(apiClient.fetchTask).toHaveBeenCalledTimes(1);
    expect(eventTransport.subscribe).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().activeTaskId).toBe("task_a");
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

  it("merges an accepted shell into startup history and replays from zero when snapshot hydration fails", async () => {
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
    const replayEvents = [
      {
        schema_version: "2.0" as const,
        event_id: "event_existing_1",
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
      {
        schema_version: "2.0" as const,
        event_id: "event_existing_2",
        type: "run_started" as const,
        task_id: "task_existing",
        run_id: "run_task_existing",
        stage_attempt_id: null,
        sequence: 2,
        timestamp: "2026-07-14T00:00:02Z",
        payload: { type: "run_started" as const },
      },
    ];
    let desiredSequence: number | null = 2;
    let serverLastSent = 2;
    const subscribedFrom: number[] = [];
    const eventTransport = transport({
      isSubscribed: vi.fn(() => desiredSequence !== null),
      unsubscribeAndWait: vi.fn(() => {
        desiredSequence = null;
        return Promise.resolve();
      }),
      subscribe: vi.fn((_taskId, afterSequence) => {
        serverLastSent = Math.max(serverLastSent, afterSequence);
        desiredSequence = serverLastSent;
        subscribedFrom.push(serverLastSent);
      }),
    });
    const controller = new RuntimeController(
      api({
        createTask: vi.fn().mockResolvedValue(accepted),
        fetchTask: vi.fn().mockRejectedValue(new TypeError("detail unavailable")),
        fetchEvents: vi.fn().mockResolvedValue(replayEvents),
      }),
      eventTransport,
    );

    await controller.startTask({
      input: "question",
      databases: ["pubmed"],
      mode: "agent",
    });

    const state = useAgentStore.getState();
    expect(subscribedFrom).toEqual([2]);
    expect(state.activeTaskId).toBe("task_existing");
    expect(state.tasksById.task_existing).toMatchObject({
      hydration: "accepted",
      runOrder: ["run_task_existing"],
      lastSequence: 2,
    });
    expect(state.tasksById.task_existing.messages).toHaveLength(1);
    expect(state.tasksById.task_existing.summary.status).toBe("running");
  });

  it("hydrates the authoritative snapshot when REST event replay is unavailable", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_fallback", "running", 2)]),
      false,
    );
    const accepted: TaskRunAccepted = {
      request_id: "req_fallback",
      task_id: "task_fallback",
      run_id: "run_task_fallback",
      status: "queued",
    };
    let desiredSequence: number | null = 2;
    let serverLastSent = 2;
    const detail = snapshot("task_fallback", 2);
    const eventTransport = transport({
      isSubscribed: vi.fn(() => desiredSequence !== null),
      unsubscribeAndWait: vi.fn(() => {
        desiredSequence = null;
        return Promise.resolve();
      }),
      subscribe: vi.fn((_taskId, afterSequence) => {
        serverLastSent = Math.max(serverLastSent, afterSequence);
        desiredSequence = serverLastSent;
      }),
    });
    const apiClient = api({
      createTask: vi.fn().mockResolvedValue(accepted),
      fetchTask: vi.fn().mockResolvedValue(detail),
      fetchEvents: vi.fn().mockRejectedValue(new Error("events unavailable")),
      fetchArtifacts: vi.fn().mockResolvedValue([]),
    });
    const controller = new RuntimeController(apiClient, eventTransport);

    await controller.startTask({
      input: "question",
      databases: [],
      mode: "agent",
    });

    expect(apiClient.fetchEvents).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().tasksById.task_fallback).toMatchObject({
      hydration: "snapshot",
      lastSequence: 2,
    });
    expect(serverLastSent).toBe(2);
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

  it("falls back to the snapshot after one empty replay page misses its target", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_empty_replay", "running", 2)]),
      false,
    );
    const accepted: TaskRunAccepted = {
      request_id: "req_empty_replay",
      task_id: "task_empty_replay",
      run_id: "run_task_empty_replay",
      status: "queued",
    };
    const fetchEvents = vi.fn<APIClient["fetchEvents"]>().mockResolvedValue([]);
    const eventTransport = transport({
      isSubscribed: vi.fn().mockReturnValue(true),
    });
    const controller = new RuntimeController(
      api({
        createTask: vi.fn().mockResolvedValue(accepted),
        fetchTask: vi.fn().mockResolvedValue(snapshot("task_empty_replay", 2)),
        fetchEvents,
        fetchArtifacts: vi.fn().mockResolvedValue([]),
      }),
      eventTransport,
    );

    await controller.startTask({ input: "question", databases: [], mode: "agent" });

    expect(fetchEvents).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().tasksById.task_empty_replay).toMatchObject({
      hydration: "snapshot",
      lastSequence: 2,
    });
    expect(eventTransport.subscribe).toHaveBeenLastCalledWith(
      "task_empty_replay",
      2,
    );
  });

  it("stops after a repeated REST replay page does not advance", async () => {
    useAgentStore.getState().mergeTaskPage(
      page([summary("task_repeated_replay", "running", 2)]),
      false,
    );
    const accepted: TaskRunAccepted = {
      request_id: "req_repeated_replay",
      task_id: "task_repeated_replay",
      run_id: "run_task_repeated_replay",
      status: "queued",
    };
    const repeatedPage = [runStartedEvent("task_repeated_replay", 1)];
    const fetchEvents = vi
      .fn<APIClient["fetchEvents"]>()
      .mockResolvedValue(repeatedPage);
    const controller = new RuntimeController(
      api({
        createTask: vi.fn().mockResolvedValue(accepted),
        fetchTask: vi.fn().mockResolvedValue(snapshot("task_repeated_replay", 2)),
        fetchEvents,
        fetchArtifacts: vi.fn().mockResolvedValue([]),
      }),
      transport({ isSubscribed: vi.fn().mockReturnValue(true) }),
    );

    await controller.startTask({ input: "question", databases: [], mode: "agent" });

    expect(fetchEvents).toHaveBeenNthCalledWith(1, "task_repeated_replay", {
      afterSequence: 0,
      limit: 1000,
    });
    expect(fetchEvents).toHaveBeenNthCalledWith(2, "task_repeated_replay", {
      afterSequence: 1,
      limit: 1000,
    });
    expect(fetchEvents).toHaveBeenCalledTimes(2);
    expect(useAgentStore.getState().tasksById.task_repeated_replay).toMatchObject({
      hydration: "snapshot",
      lastSequence: 2,
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

  it("loads another page without duplicating active tasks or changing selection", async () => {
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
      fetchTasks: vi.fn().mockResolvedValue(
        page(
          [summary("task_active")],
          [summary("task_older", "completed")],
          null,
        ),
      ),
    });
    const controller = new RuntimeController(apiClient, transport());

    await controller.loadMoreTasks();

    expect(apiClient.fetchTasks).toHaveBeenCalledWith({
      limit: 30,
      cursor: "cursor_1",
    });
    expect(useAgentStore.getState().activeItems).toEqual(["task_active"]);
    expect(useAgentStore.getState().taskOrder).toEqual([
      "task_history",
      "task_older",
    ]);
    expect(useAgentStore.getState().activeTaskId).toBe("task_history");
  });
});
