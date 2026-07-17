import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentProgress } from "@/components/AgentProgress";
import type { RunStatus, TaskMode } from "@/runtime/contracts";
import { createTaskProjection } from "@/runtime/reducer";
import type { TaskProjection } from "@/runtime/types";

const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "排队中",
  running: "运行中",
  finalizing: "收尾中",
  cancel_requested: "正在取消",
  awaiting_user_input: "等待确认",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

function projectedTask(status: RunStatus, mode: TaskMode = "agent"): TaskProjection {
  const active =
    status === "queued" ||
    status === "running" ||
    status === "finalizing" ||
    status === "cancel_requested" ||
    status === "awaiting_user_input";
  const task = createTaskProjection({
    task_id: `task_${status}`,
    mode,
    databases: [],
    title: `${status} task`,
    status,
    active_run_id: active ? "run_1" : null,
    created_at: "2026-07-14T00:00:00Z",
    updated_at: "2026-07-14T00:00:00Z",
    latest_sequence: 3,
  });
  return {
    ...task,
    runsById: {
      run_1: {
        runId: "run_1",
        taskId: task.summary.task_id,
        requestId: "req_1",
        status,
        input: "question",
        createdAt: "2026-07-14T00:00:00Z",
        updatedAt: "2026-07-14T00:00:00Z",
        startedAt: null,
        finishedAt: active ? null : "2026-07-14T00:01:00Z",
        error: status === "failed" ? "model unavailable" : null,
      },
    },
    runOrder: ["run_1"],
  };
}

describe("AgentProgress", () => {
  it.each(Object.entries(STATUS_LABELS) as [RunStatus, string][])(
    "shows the authoritative %s lifecycle without a percentage",
    (status, label) => {
      render(<AgentProgress task={projectedTask(status)} />);

      expect(screen.getByText(label)).toBeVisible();
      expect(screen.queryByRole("progressbar")).toBeNull();
      expect(screen.queryByText("文献/数据发现")).toBeNull();
    },
  );

  it("shows only the current tool for the active run", () => {
    const base = projectedTask("running");
    const task: TaskProjection = {
      ...base,
      activitiesById: {
        previous: {
          activityId: "previous",
          taskId: base.summary.task_id,
          runId: "run_1",
          sequence: 1,
          timestamp: "2026-07-14T00:00:01Z",
          kind: "tool",
          status: "completed",
          name: "old_tool",
          input: null,
          output: "done",
          isError: false,
          code: null,
          message: null,
        },
        current: {
          activityId: "current",
          taskId: base.summary.task_id,
          runId: "run_1",
          sequence: 2,
          timestamp: "2026-07-14T00:00:02Z",
          kind: "tool",
          status: "started",
          name: "analyze_records",
          input: null,
          output: null,
          isError: false,
          code: null,
          message: null,
        },
      },
      activityOrder: ["previous", "current"],
    };

    render(<AgentProgress task={task} />);

    expect(screen.getByText("analyze_records")).toBeVisible();
    expect(screen.queryByText("old_tool")).toBeNull();
    expect(screen.queryByText(/文献搜索/)).toBeNull();
  });

  it("replaces progress from the foreground task only", () => {
    const { rerender } = render(<AgentProgress task={projectedTask("running")} />);
    expect(screen.getByText("运行中")).toBeVisible();

    rerender(<AgentProgress task={projectedTask("failed")} />);
    expect(screen.getByText("失败")).toBeVisible();
    expect(screen.queryByText("运行中")).toBeNull();
  });
});
