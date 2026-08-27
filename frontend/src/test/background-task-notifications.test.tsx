import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { BackgroundTaskNotifications } from "@/components/BackgroundTaskNotifications";
import type { APIClient } from "@/hooks/useAPI";
import type {
  EventEnvelope,
  TaskSnapshot,
  TaskSummary,
} from "@/runtime/contracts";
import {
  RuntimeController,
  type EventTransport,
} from "@/runtime/controller";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

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
  status: TaskSummary["status"],
  mode: TaskSummary["mode"] = "agent",
): TaskSummary {
  const active = status === "running";
  return {
    task_id: taskId,
    mode,
    databases: [],
    title: `Title ${taskId}`,
    status,
    active_run_id: active ? `run_${taskId}` : null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    latest_sequence: 0,
  };
}

function terminalEvent(
  taskId: string,
  status: "completed" | "failed" | "interrupted",
): EventEnvelope {
  const type = status === "completed" ? "run_completed" : status === "failed" ? "run_failed" : "run_interrupted";
  return {
    schema_version: "2.0",
    event_id: `event_${taskId}`,
    type,
    task_id: taskId,
    run_id: `run_${taskId}`,
    stage_attempt_id: null,
    sequence: 1,
    timestamp: "2026-07-14T00:00:01Z",
    payload:
      status === "completed"
        ? { type: "run_completed" }
        : status === "failed"
          ? { type: "run_failed", error: "failed reason" }
          : { type: "run_interrupted", reason: "interrupted reason" },
  };
}

describe("BackgroundTaskNotifications", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentStore.setState(createInitialRuntimeState());
  });

  it("emits one actionable success toast for a background completion", () => {
    useAgentStore.getState().mergeTaskPage(
      { active_items: [summary("background", "running")], items: [], next_cursor: null },
      false,
    );
    const onViewTask = vi.fn();
    render(<BackgroundTaskNotifications onViewTask={onViewTask} />);

    act(() => useAgentStore.getState().applyEvent(terminalEvent("background", "completed")));
    expect(toast.success).toHaveBeenCalledTimes(1);
    const options = vi.mocked(toast.success).mock.calls[0][1];
    expect(options?.action).toMatchObject({ label: "查看" });
    if (
      options?.action !== null &&
      typeof options?.action === "object" &&
      "onClick" in options.action
    ) {
      options.action.onClick({} as React.MouseEvent<HTMLButtonElement>);
    }
    expect(onViewTask).toHaveBeenCalledWith("background");

    act(() => useAgentStore.getState().applyEvent(terminalEvent("background", "completed")));
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("shows the existing selection error toast when View rejects", async () => {
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [summary("background", "running")],
        items: [],
        next_cursor: null,
      },
      false,
    );
    const selection = deferred<void>();
    const onViewTask = vi.fn(() => selection.promise);
    render(<BackgroundTaskNotifications onViewTask={onViewTask} />);

    act(() =>
      useAgentStore
        .getState()
        .applyEvent(terminalEvent("background", "completed")),
    );
    const options = vi.mocked(toast.success).mock.calls[0][1];
    if (
      options?.action !== null &&
      typeof options?.action === "object" &&
      "onClick" in options.action
    ) {
      options.action.onClick({} as React.MouseEvent<HTMLButtonElement>);
    }

    await act(async () => {
      selection.reject(new Error("task unavailable"));
      await selection.promise.catch(() => undefined);
    });

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "打开任务失败",
        expect.objectContaining({ description: "task unavailable" }),
      ),
    );
  });

  it("does not lose a fast background transition batched into one render", () => {
    render(<BackgroundTaskNotifications onViewTask={vi.fn()} />);

    act(() => {
      useAgentStore.getState().mergeTaskPage(
        {
          active_items: [summary("fast", "running")],
          items: [],
          next_cursor: null,
        },
        false,
      );
      useAgentStore.getState().applyEvent(terminalEvent("fast", "completed"));
    });

    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it("uses error toast for failed and interrupted background tasks", () => {
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [summary("failed", "running"), summary("interrupted", "running")],
        items: [],
        next_cursor: null,
      },
      false,
    );
    render(<BackgroundTaskNotifications onViewTask={vi.fn()} />);

    act(() => useAgentStore.getState().applyEvent(terminalEvent("failed", "failed")));
    act(() => useAgentStore.getState().applyEvent(terminalEvent("interrupted", "interrupted")));
    expect(toast.error).toHaveBeenCalledTimes(2);
  });

  it("does not toast for initial terminal history or foreground completion", () => {
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [summary("foreground", "running")],
        items: [summary("history", "completed")],
        next_cursor: null,
      },
      false,
    );
    useAgentStore.getState().setActiveTaskId("foreground");
    render(<BackgroundTaskNotifications onViewTask={vi.fn()} />);

    act(() => useAgentStore.getState().applyEvent(terminalEvent("foreground", "completed")));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("treats a task being selected as foreground while its terminal snapshot hydrates", async () => {
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [summary("selected", "running")],
        items: [],
        next_cursor: null,
      },
      false,
    );
    render(<BackgroundTaskNotifications onViewTask={vi.fn()} />);
    const selectedSnapshot: TaskSnapshot = {
      task: summary("selected", "completed"),
      runs: [],
      messages: [],
      older_messages_cursor: null,
    };
    const apiClient: APIClient = {
      fetchDatabases: vi.fn(),
      fetchTasks: vi.fn(),
      fetchTask: vi.fn().mockResolvedValue(selectedSnapshot),
      fetchMessages: vi.fn(),
      fetchEvents: vi.fn(),
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
      fetchArtifacts: vi.fn().mockResolvedValue([]),
      getArtifactUrl: vi.fn(),
      getCacheExportUrl: vi.fn(),
      fetchCacheDatasets: vi.fn().mockResolvedValue({ items: [] }),
      deleteCacheDataset: vi.fn().mockResolvedValue(undefined),
      clearCacheDatasets: vi.fn().mockResolvedValue(0),
      fetchPublications: vi.fn().mockResolvedValue({ items: [], next_cursor: null }),
      fetchPublication: vi.fn(),
      getPublicationArtifactUrl: vi.fn(),
    };
    const eventTransport: EventTransport = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      subscribe: vi.fn(),
      isSubscribed: vi.fn().mockReturnValue(false),
      unsubscribeAndWait: vi.fn().mockResolvedValue(undefined),
      recoverSubscription: vi.fn().mockResolvedValue(undefined),
    };

    await act(async () => {
      await new RuntimeController(apiClient, eventTransport).selectTask(
        "selected",
      );
    });

    expect(useAgentStore.getState().activeTaskId).toBe("selected");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("notifies once from the authoritative Run terminal after fixture terminal activity", () => {
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [summary("fixture", "running", "fixture")],
        items: [],
        next_cursor: null,
      },
      false,
    );
    render(<BackgroundTaskNotifications onViewTask={vi.fn()} />);

    act(() =>
      useAgentStore.getState().applyEvent({
        schema_version: "2.0",
        event_id: "fixture_task_completed",
        type: "task_completed",
        task_id: "fixture",
        run_id: "run_fixture",
        stage_attempt_id: null,
        sequence: 1,
        timestamp: "2026-07-14T00:00:01Z",
        payload: {
          type: "task_completed",
          validation: {
            status: "valid",
            checked_count: 1,
            failed_count: 0,
            report_path: "logs/validation_report.json",
          },
        },
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();

    act(() =>
      useAgentStore.getState().applyEvent({
        schema_version: "2.0",
        event_id: "fixture_run_finalizing",
        type: "run_finalizing",
        task_id: "fixture",
        run_id: "run_fixture",
        stage_attempt_id: null,
        sequence: 2,
        timestamp: "2026-07-14T00:00:02Z",
        payload: { type: "run_finalizing" },
      }),
    );
    expect(toast.success).not.toHaveBeenCalled();

    act(() =>
      useAgentStore.getState().applyEvent({
        schema_version: "2.0",
        event_id: "fixture_run_completed",
        type: "run_completed",
        task_id: "fixture",
        run_id: "run_fixture",
        stage_attempt_id: null,
        sequence: 3,
        timestamp: "2026-07-14T00:00:03Z",
        payload: { type: "run_completed" },
      }),
    );
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
