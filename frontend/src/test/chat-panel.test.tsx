import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@/components/ChatPanel";
import { DatabaseSelector } from "@/components/DatabaseSelector";
import type { StartTaskInput, TaskRunAccepted, TaskSnapshot } from "@/runtime/contracts";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

const CREATED_AT = "2026-07-14T00:00:00Z";

function seedBackgroundTask(): void {
  useAgentStore.getState().mergeTaskPage(
    {
      active_items: [
        {
          task_id: "task_background",
          mode: "agent",
          databases: ["pubmed"],
          title: "Background research",
          status: "running",
          active_run_id: "run_background",
          created_at: CREATED_AT,
          updated_at: CREATED_AT,
          latest_sequence: 2,
        },
      ],
      items: [],
      next_cursor: null,
    },
    false,
  );
}

function seedTerminalTask(mode: "agent" | "fixture" = "agent"): void {
  const snapshot: TaskSnapshot = {
    task: {
      task_id: "task_terminal",
      mode,
      databases: ["pubmed"],
      title: "Terminal task",
      status: "completed",
      active_run_id: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      latest_sequence: 3,
    },
    runs: [
      {
        run_id: "run_terminal",
        task_id: "task_terminal",
        request_id: "req_terminal",
        status: "completed",
        input: "initial question",
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
        started_at: CREATED_AT,
        finished_at: CREATED_AT,
        error: null,
      },
    ],
    messages: [
      {
        message_id: "message_terminal",
        task_id: "task_terminal",
        run_id: "run_terminal",
        ordinal: 1,
        role: "user",
        content: "initial question",
        created_at: CREATED_AT,
      },
    ],
    older_messages_cursor: null,
  };
  useAgentStore.getState().hydrateTaskSnapshot(snapshot);
  useAgentStore.getState().setActiveTaskId("task_terminal");
}

describe("ChatPanel", () => {
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
    useAgentStore.setState({
      ...createInitialRuntimeState(),
      connectionStatus: "connected",
      databases: [
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
      ],
    });
  });

  it("shows fixture source validation without mutating task projections", () => {
    seedBackgroundTask();
    const before = useAgentStore.getState().tasksById;
    const startTask = vi.fn<(input: StartTaskInput) => Promise<TaskRunAccepted>>();
    render(<ChatPanel startTask={startTask} />);

    fireEvent.change(screen.getByPlaceholderText("输入研究目标..."), {
      target: { value: "Review validation" },
    });
    fireEvent.click(screen.getByRole("button", { name: "运行固定验收案例" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "固定验收案例只能选择 PubMed 和 GEO。",
    );
    expect(startTask).not.toHaveBeenCalled();
    expect(useAgentStore.getState().tasksById).toBe(before);
  });

  it("submits corrected fixture input through the semantic REST controller", async () => {
    const accepted: TaskRunAccepted = {
      request_id: "req_fixture",
      task_id: "task_fixture",
      run_id: "run_fixture",
      status: "queued",
    };
    const startTask = vi.fn().mockResolvedValue(accepted);
    render(<ChatPanel startTask={startTask} />);
    fireEvent.change(screen.getByPlaceholderText("输入研究目标..."), {
      target: { value: "  Run fixture  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: "运行固定验收案例" }));

    await waitFor(() =>
      expect(startTask).toHaveBeenCalledWith({
        input: "Run fixture",
        databases: ["pubmed", "geo"],
        mode: "fixture",
      }),
    );
    expect(useAgentStore.getState().draft.error).toBeNull();
  });

  it("keeps a blank draft usable while another task is running", async () => {
    seedBackgroundTask();
    const before = useAgentStore.getState().tasksById;
    const startTask = vi.fn().mockResolvedValue({
      request_id: "req_new",
      task_id: "task_new",
      run_id: "run_new",
      status: "queued",
    });
    render(<ChatPanel startTask={startTask} />);

    expect(screen.getByPlaceholderText("输入研究目标...")).toBeEnabled();
    expect(screen.getByRole("button", { name: "全选" })).toBeEnabled();
    fireEvent.change(screen.getByPlaceholderText("输入研究目标..."), {
      target: { value: "  New research  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始研究" }));

    await waitFor(() =>
      expect(startTask).toHaveBeenCalledWith({
        input: "New research",
        databases: [],
        mode: "agent",
      }),
    );
    expect(useAgentStore.getState().tasksById).toBe(before);
  });

  it("stores draft text canonically and clears it for new research", () => {
    render(<ChatPanel startTask={vi.fn()} />);
    const input = screen.getByPlaceholderText("输入研究目标...");

    fireEvent.change(input, { target: { value: "draft question" } });
    expect(useAgentStore.getState().draft.input).toBe("draft question");
    act(() => useAgentStore.getState().showNewDraft());

    expect(input).toHaveValue("");
  });

  it("notifies consumers when selecting and clearing all draft databases", () => {
    const onToggle = vi.fn();
    render(<DatabaseSelector onToggle={onToggle} />);

    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect(onToggle).toHaveBeenNthCalledWith(1, "pubmed", true);
    expect(onToggle).toHaveBeenNthCalledWith(2, "geo", true);

    fireEvent.click(screen.getByRole("button", { name: "取消全选" }));
    expect(onToggle).toHaveBeenNthCalledWith(3, "pubmed", false);
    expect(onToggle).toHaveBeenNthCalledWith(4, "geo", false);
  });

  it("enables continuation only for an idle terminal agent task", async () => {
    seedTerminalTask();
    const continueTask = vi.fn().mockResolvedValue({
      request_id: "req_follow",
      task_id: "task_terminal",
      run_id: "run_follow",
      status: "queued",
    });
    render(<ChatPanel startTask={vi.fn()} continueTask={continueTask} />);

    const input = screen.getByRole("textbox", { name: "继续提问" });
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "follow up" } });
    fireEvent.click(screen.getByRole("button", { name: "发送继续问题" }));

    await waitFor(() =>
      expect(continueTask).toHaveBeenCalledWith("task_terminal", {
        input: "follow up",
      }),
    );
  });

  it("disables continuation while a task is active or fixture-only", () => {
    seedBackgroundTask();
    useAgentStore.getState().setActiveTaskId("task_background");
    const { rerender } = render(
      <ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />,
    );
    expect(screen.getByRole("textbox", { name: "继续提问" })).toBeDisabled();

    act(() => seedTerminalTask("fixture"));
    rerender(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);
    expect(screen.getByRole("textbox", { name: "继续提问" })).toBeDisabled();
  });

  it("keeps continuation text and projection unchanged on a 409 response", async () => {
    seedTerminalTask();
    const before = useAgentStore.getState().tasksById.task_terminal;
    const continueTask = vi.fn().mockRejectedValue(new Error("409 conflict"));
    render(<ChatPanel startTask={vi.fn()} continueTask={continueTask} />);

    const input = screen.getByRole("textbox", { name: "继续提问" });
    fireEvent.change(input, { target: { value: "keep this" } });
    fireEvent.click(screen.getByRole("button", { name: "发送继续问题" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("409 conflict"));
    expect(input).toHaveValue("keep this");
    expect(useAgentStore.getState().tasksById.task_terminal).toBe(before);
  });
});
