import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SubagentWorkspace } from "@/components/SubagentWorkspace";
import { openSubagentPanel } from "@/components/subagentPanelControl";
import type {
  SubagentRecord,
  SubagentStatus,
  TaskSnapshot,
} from "@/runtime/contracts";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

const CREATED_AT = "2026-07-30T00:00:00Z";

function subagentRecord(
  status: SubagentStatus,
  taskId: string,
  subagentId: string,
): SubagentRecord {
  const runId = taskId === "task_1" ? "run_1" : `run_${taskId}`;
  return {
    subagent_id: subagentId,
    task_id: taskId,
    run_id: runId,
    agent_type: "source_research",
    objective: "检索 PubMed 来源",
    target_source: "pubmed",
    status,
    parent_tool_call_id: "tool_1",
    created_at: CREATED_AT,
    started_at: status === "queued" ? null : CREATED_AT,
    finished_at: null,
    progress_current: status === "running" ? 1 : 0,
    progress_total: 3,
    progress_message: status === "running" ? "正在检索" : null,
    result_summary: null,
    source_asset_ids: [],
    recipe_id: null,
    error_code: null,
    error_message: null,
    pending_request_id: null,
  };
}

function taskSnapshot(
  status: SubagentStatus,
  taskId = "task_1",
  subagentCount = 1,
): TaskSnapshot {
  const runId = taskId === "task_1" ? "run_1" : `run_${taskId}`;
  return {
    task: {
      task_id: taskId,
      mode: "agent",
      databases: ["pubmed"],
      title: "Subagent task",
      status: "running",
      active_run_id: runId,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      latest_sequence: 1,
    },
    runs: [
      {
        run_id: runId,
        task_id: taskId,
        request_id: "request_1",
        status: "running",
        input: "research",
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
        started_at: CREATED_AT,
        finished_at: null,
        error: null,
      },
    ],
    messages: [],
    subagents: Array.from({ length: subagentCount }, (_, index) =>
      subagentRecord(status, taskId, `subagent_${index + 1}`),
    ),
    older_messages_cursor: null,
  };
}

function seedTask(
  status: SubagentStatus,
  taskId = "task_1",
  subagentCount = 1,
): void {
  useAgentStore.getState().hydrateTaskSnapshot(
    taskSnapshot(status, taskId, subagentCount),
  );
  useAgentStore.getState().setActiveTaskId(taskId);
}

describe("SubagentWorkspace", () => {
  beforeEach(() => {
    useAgentStore.setState(createInitialRuntimeState());
  });

  it("opens the workspace when the first subagent is queued", async () => {
    const { container } = render(
      <SubagentWorkspace>
        <div>Conversation</div>
      </SubagentWorkspace>,
    );

    expect(
      container.querySelector('[data-slot="resizable-panel-group"]'),
    ).not.toBeInTheDocument();

    act(() => seedTask("queued"));

    expect(
      await screen.findByRole("heading", { name: "子任务" }),
    ).toBeVisible();
    expect(screen.getByText("SourceResearchAgent")).toBeVisible();
  });

  it("cancels only the selected running subagent", async () => {
    const cancelSubagent = vi.fn().mockResolvedValue(undefined);
    seedTask("running");

    render(
      <SubagentWorkspace cancelSubagent={cancelSubagent}>
        <div>Conversation</div>
      </SubagentWorkspace>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "取消此子任务" }),
    );

    expect(cancelSubagent).toHaveBeenCalledTimes(1);
    expect(cancelSubagent).toHaveBeenCalledWith(
      "task_1",
      "run_1",
      "subagent_1",
    );
  });

  it("does not reopen after a replay preserves the first subagent", async () => {
    seedTask("running");
    const { container } = render(
      <SubagentWorkspace>
        <div>Conversation</div>
      </SubagentWorkspace>,
    );

    await screen.findByRole("heading", { name: "子任务" });
    fireEvent.click(screen.getByRole("button", { name: "关闭子任务面板" }));
    expect(
      container.querySelector('[data-slot="resizable-panel-group"]'),
    ).not.toBeInTheDocument();

    act(() => seedTask("running"));

    expect(
      container.querySelector('[data-slot="resizable-panel-group"]'),
    ).not.toBeInTheDocument();
  });

  it("opens once for a new task that hydrates multiple subagents", async () => {
    seedTask("running");
    const { container } = render(
      <SubagentWorkspace>
        <div>Conversation</div>
      </SubagentWorkspace>,
    );

    await screen.findByRole("heading", { name: "子任务" });
    fireEvent.click(screen.getByRole("button", { name: "关闭子任务面板" }));

    act(() => seedTask("running", "task_2", 2));
    expect(
      await screen.findByRole("heading", { name: "子任务" }),
    ).toBeVisible();
    expect(screen.getByText("2")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "关闭子任务面板" }));
    act(() => seedTask("running", "task_2", 2));
    expect(
      container.querySelector('[data-slot="resizable-panel-group"]'),
    ).not.toBeInTheDocument();
  });

  it("shows the empty state when opened without subagents", async () => {
    render(
      <SubagentWorkspace>
        <div>Conversation</div>
      </SubagentWorkspace>,
    );

    await act(async () => {
      openSubagentPanel();
      await Promise.resolve();
    });

    expect(screen.getByText("暂无子任务")).toBeVisible();
  });

  it("renders the selected subagent warnings and activity timeline", async () => {
    seedTask("completed");
    useAgentStore.setState((state) => {
      const task = state.tasksById.task_1;
      return {
        tasksById: {
          ...state.tasksById,
          task_1: {
            ...task,
            subagentsById: {
              ...task.subagentsById,
              subagent_1: {
                ...task.subagentsById.subagent_1,
                warnings: ["已使用备用网页抓取"],
              },
            },
            activitiesById: {
              ...task.activitiesById,
              child_tool: {
                activityId: "child_tool",
                taskId: "task_1",
                runId: "run_1",
                subagentId: "subagent_1",
                sequence: 2,
                timestamp: CREATED_AT,
                kind: "tool",
                status: "completed",
                name: "search_pubmed",
                input: null,
                output: "Found 4 records",
                isError: false,
                code: null,
                message: null,
              },
            },
            activityOrder: [...task.activityOrder, "child_tool"],
          },
        },
      };
    });

    render(
      <SubagentWorkspace>
        <div>Conversation</div>
      </SubagentWorkspace>,
    );

    fireEvent.click(await screen.findByText("SourceResearchAgent"));

    expect(screen.getByText("执行记录")).toBeVisible();
    expect(screen.getByText("search_pubmed")).toBeVisible();
    expect(screen.getByText("警告")).toBeVisible();
    expect(screen.getByText("已使用备用网页抓取")).toBeVisible();
  });
});
