import { beforeEach, describe, expect, it, vi } from "vitest";

import type { APIClient } from "@/hooks/useAPI";
import type {
  DatabaseRecord,
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
