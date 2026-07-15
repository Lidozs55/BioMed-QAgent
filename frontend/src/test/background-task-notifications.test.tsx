import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { BackgroundTaskNotifications } from "@/components/BackgroundTaskNotifications";
import type { EventEnvelope, TaskSummary } from "@/runtime/contracts";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const CREATED_AT = "2026-07-14T00:00:00Z";

function summary(taskId: string, status: TaskSummary["status"]): TaskSummary {
  const active = status === "running";
  return {
    task_id: taskId,
    mode: "agent",
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
});
