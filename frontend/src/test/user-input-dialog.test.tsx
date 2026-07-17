import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UserInputDialog } from "@/components/UserInputDialog";
import type { ResumeRunInput, TaskSummary } from "@/runtime/contracts";
import { createTaskProjection } from "@/runtime/reducer";
import type { TaskProjection } from "@/runtime/types";

const CREATED_AT = "2026-07-14T00:00:00Z";

function taskWithPrompt(
  taskId: string,
  activeRunId: string,
  pendingRunId: string,
  requestId: string,
): TaskProjection {
  const summary: TaskSummary = {
    task_id: taskId,
    mode: "agent",
    databases: [],
    title: `Task ${taskId}`,
    status: "awaiting_user_input",
    active_run_id: activeRunId,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    latest_sequence: 1,
  };
  return {
    ...createTaskProjection(summary),
    pendingUserInput: {
      runId: pendingRunId,
      requestId,
      promptKind: "plan_confirmation",
      summary: `Confirm ${taskId}`,
      expiresAt: null,
      fixtureExempt: false,
      detail: {},
      sequence: 1,
      timestamp: CREATED_AT,
    },
  };
}

describe("UserInputDialog", () => {
  it("isolates an in-flight prompt from its replacement and submits the pending Run", async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    const firstResume = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const onResumeRun = vi.fn<
      (
        taskId: string,
        runId: string,
        input: ResumeRunInput,
      ) => Promise<void>
    >();
    onResumeRun
      .mockReturnValueOnce(firstResume)
      .mockResolvedValueOnce(undefined);
    const taskA = taskWithPrompt(
      "task_a",
      "run_a",
      "run_a",
      "request_a",
    );
    const taskB = taskWithPrompt(
      "task_b",
      "run_unrelated_b",
      "run_b",
      "request_b",
    );

    const { rerender } = render(
      <UserInputDialog task={taskA} onResumeRun={onResumeRun} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();

    rerender(<UserInputDialog task={taskB} onResumeRun={onResumeRun} />);
    expect(screen.getByText("Confirm task_b")).toBeVisible();
    expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled();

    act(() => rejectFirst?.(new Error("Task A resume failed")));
    await waitFor(() => {
      expect(screen.queryByText("Task A resume failed")).toBeNull();
      expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled();
    });

    rerender(<UserInputDialog task={taskA} onResumeRun={onResumeRun} />);
    expect(screen.queryByText("Task A resume failed")).toBeNull();
    expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled();

    rerender(<UserInputDialog task={taskB} onResumeRun={onResumeRun} />);
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    await waitFor(() => expect(onResumeRun).toHaveBeenCalledTimes(2));
    expect(onResumeRun).toHaveBeenLastCalledWith("task_b", "run_b", {
      request_id: "request_b",
      decision: "approve",
      detail: {},
    });
  });
});
