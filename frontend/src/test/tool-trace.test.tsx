import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ToolTrace } from "@/components/ToolTrace";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

describe("ToolTrace", () => {
  beforeAll(() => {
    window.matchMedia = () => ({
      matches: false,
      media: "",
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
  });

  beforeEach(() => {
    useAgentStore.setState(createInitialRuntimeState());
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [
          {
            task_id: "task_trace",
            mode: "agent",
            databases: [],
            title: "Trace",
            status: "running",
            active_run_id: "run_trace",
            created_at: "2026-07-14T00:00:00Z",
            updated_at: "2026-07-14T00:00:00Z",
            latest_sequence: 0,
          },
        ],
        items: [],
        next_cursor: null,
      },
      false,
    );
    useAgentStore.getState().setActiveTaskId("task_trace");
    useAgentStore.getState().applyEvent({
      schema_version: "2.0",
      event_id: "event_tool",
      type: "tool_started",
      task_id: "task_trace",
      run_id: "run_trace",
      stage_attempt_id: null,
      sequence: 1,
      timestamp: "2026-07-14T00:00:01Z",
      payload: {
        type: "tool_started",
        tool_call_id: "call_1",
        tool_name: "search",
      },
    });
    useAgentStore.getState().applyEvent({
      schema_version: "2.0",
      event_id: "event_tool_completed",
      type: "tool_completed",
      task_id: "task_trace",
      run_id: "run_trace",
      stage_attempt_id: null,
      sequence: 2,
      timestamp: "2026-07-14T00:00:02Z",
      payload: {
        type: "tool_completed",
        tool_call_id: "call_1",
        tool_name: "search",
        output: "RAW_TOOL_OUTPUT_REMAINS_IN_TRACE",
        is_error: false,
      },
    });
  });

  it("closes locally without changing authoritative task projection", () => {
    const before = useAgentStore.getState().tasksById.task_trace;
    render(<ToolTrace />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle tool trace" }));
    expect(screen.getByText("RAW_TOOL_OUTPUT_REMAINS_IN_TRACE")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    expect(useAgentStore.getState().tasksById.task_trace).toBe(before);
    expect(before.lastSequence).toBe(2);
  });

  it("keeps the trace trigger in normal layout so it cannot cover chat controls", () => {
    render(<ToolTrace />);

    const trigger = screen.getByRole("button", { name: "Toggle tool trace" });
    expect(trigger).not.toHaveClass("fixed");
    expect(trigger).not.toHaveClass("right-4");
    expect(trigger).not.toHaveClass("bottom-4");
  });

  it("clears an activity whose stable row was updated after a later row", () => {
    useAgentStore.setState(createInitialRuntimeState());
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [
          {
            task_id: "task_progress",
            mode: "agent",
            databases: [],
            title: "Progress",
            status: "running",
            active_run_id: "run_progress",
            created_at: "2026-07-14T00:00:00Z",
            updated_at: "2026-07-14T00:00:00Z",
            latest_sequence: 0,
          },
        ],
        items: [],
        next_cursor: null,
      },
      false,
    );
    useAgentStore.getState().setActiveTaskId("task_progress");

    const applyProgress = (sequence: number, current: number) => {
      useAgentStore.getState().applyEvent({
        schema_version: "2.0",
        event_id: `event_progress_${sequence}`,
        type: "stage_progress",
        task_id: "task_progress",
        run_id: "run_progress",
        stage_attempt_id: null,
        sequence,
        timestamp: `2026-07-14T00:00:0${sequence}Z`,
        payload: {
          type: "stage_progress",
          stage: "processing",
          kind: "cleaned_rows",
          current,
          total: 10,
          detail: {},
        },
      });
    };
    applyProgress(1, 2);
    useAgentStore.getState().applyEvent({
      schema_version: "2.0",
      event_id: "event_warning_2",
      type: "warning",
      task_id: "task_progress",
      run_id: "run_progress",
      stage_attempt_id: null,
      sequence: 2,
      timestamp: "2026-07-14T00:00:02Z",
      payload: {
        type: "warning",
        code: "partial_results",
        message: "部分结果",
      },
    });
    applyProgress(3, 8);

    render(<ToolTrace />);
    fireEvent.click(screen.getByRole("button", { name: "Toggle tool trace" }));
    expect(screen.getByText("部分结果")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "清除当前显示" }));

    expect(screen.getByText("尚无工具调用")).toBeVisible();
    expect(screen.queryByText("部分结果")).not.toBeInTheDocument();
  });
});
