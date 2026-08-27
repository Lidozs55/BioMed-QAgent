import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { useTaskPublicationId } from "@/hooks/useTaskPublication";
import { createTaskProjection } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

function Harness({ taskId }: { taskId: string | null }) {
  const state = useTaskPublicationId(taskId);
  return <div>{state.status}:{state.publicationId ?? ""}</div>;
}

describe("useTaskPublicationId", () => {
  beforeEach(() => useAgentStore.setState({ tasksById: {} }));

  it("reads the current immutable Publication from task projection", async () => {
    const task = createTaskProjection({
      task_id: "task_1",
      mode: "agent",
      databases: [],
      title: "Task",
      status: "completed",
      active_run_id: null,
      created_at: "2026-08-27T00:00:00Z",
      updated_at: "2026-08-27T00:00:00Z",
      latest_sequence: 1,
    });
    render(<Harness taskId="task_1" />);
    expect(screen.getByText("idle:")).toBeVisible();
    await act(async () => {
      useAgentStore.setState({
        tasksById: { task_1: { ...task, currentPublicationId: "pub_1" } },
      });
    });
    expect(screen.getByText("ready:pub_1")).toBeVisible();
  });
});
