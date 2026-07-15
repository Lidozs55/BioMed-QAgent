import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@/components/ChatPanel";
import { DatabaseSelector } from "@/components/DatabaseSelector";
import type { StartTaskInput, TaskRunAccepted } from "@/runtime/contracts";
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
});
