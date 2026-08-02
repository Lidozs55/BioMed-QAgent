import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { SessionSidebar } from "@/components/SessionSidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import type { RunStatus, TaskSummary } from "@/runtime/contracts";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

vi.mock("sonner", () => ({
  toast: { error: vi.fn() },
}));

const CREATED_AT = "2026-07-14T00:00:00Z";

function summary(
  taskId: string,
  status: RunStatus,
  title = taskId,
  artifactCount?: number,
  noArtifactFailure?: boolean,
): TaskSummary {
  return {
    task_id: taskId,
    mode: "agent",
    databases: [],
    title,
    status,
    active_run_id:
      status === "queued" ||
      status === "running" ||
      status === "finalizing" ||
      status === "cancel_requested" ||
      status === "awaiting_user_input"
        ? `run_${taskId}`
        : null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    latest_sequence: 1,
    ...(artifactCount === undefined ? {} : { artifact_count: artifactCount }),
    ...(noArtifactFailure === undefined
      ? {}
      : { no_artifact_failure: noArtifactFailure }),
  };
}

function scrollSidebarToBottom() {
  const content = document.querySelector(
    '[data-slot="sidebar-content"]',
  ) as HTMLElement;
  Object.defineProperty(content, "scrollHeight", {
    value: 1000,
    configurable: true,
  });
  Object.defineProperty(content, "clientHeight", {
    value: 200,
    configurable: true,
  });
  Object.defineProperty(content, "scrollTop", {
    value: 760,
    configurable: true,
  });
  fireEvent.scroll(content);
}

function renderSidebar(
  props: Partial<React.ComponentProps<typeof SessionSidebar>> = {},
) {
  return render(
    <SidebarProvider>
      <SessionSidebar
        onNewDraft={vi.fn()}
        onSelectTask={vi.fn()}
        onRetryHistory={vi.fn().mockResolvedValue(undefined)}
        onLoadMore={vi.fn().mockResolvedValue(undefined)}
        onCancelRun={vi.fn().mockResolvedValue(undefined)}
        onDeleteTask={vi.fn().mockResolvedValue(undefined)}
        {...props}
      />
    </SidebarProvider>,
  );
}

describe("SessionSidebar", () => {
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
    vi.clearAllMocks();
    useAgentStore.setState(createInitialRuntimeState());
  });

  it("renders the v2 logo at the top of the sidebar", () => {
    renderSidebar();

    const logo = screen.getByRole("img", { name: "BioMed QAgent" });
    expect(logo).toHaveAttribute("alt", "BioMed QAgent");
    expect(logo).toHaveAttribute("draggable", "false");
  });

  it("renders active and history tasks in one shared list", () => {
    const history = Array.from({ length: 10 }, (_, index) =>
      summary(`history_${index}`, "completed", `History ${index + 1}`),
    );
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [
          summary("task_running", "running", "Running task"),
          summary("task_queued", "queued", "Queued task"),
        ],
        items: history,
        next_cursor: "page_2",
      },
      false,
    );

    renderSidebar();

    expect(screen.queryByText("正在进行")).toBeNull();
    expect(screen.queryByText("历史任务")).toBeNull();
    const group = screen
      .getByText("Running task")
      .closest('[data-slot="sidebar-group"]');
    expect(group).not.toBeNull();
    expect(within(group as HTMLElement).getByText("Queued task")).toBeVisible();
    expect(within(group as HTMLElement).getByText("History 1")).toBeVisible();
    expect(within(group as HTMLElement).getByText("History 10")).toBeVisible();
    expect(
      within(group as HTMLElement).getAllByRole("button", {
        name: /^History \d+ 已完成$/,
      }),
    ).toHaveLength(10);
  });

  it("loads another stable page without changing foreground selection", async () => {
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [summary("active_a", "running", "Active A")],
        items: [summary("history_a", "completed", "History A")],
        next_cursor: "page_2",
      },
      false,
    );
    useAgentStore.getState().setActiveTaskId("history_a");
    let resolveLoad: (() => void) | undefined;
    const onLoadMore = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveLoad = () => {
            useAgentStore.getState().mergeTaskPage(
              {
                active_items: [summary("active_a", "running", "Active A")],
                items: [summary("history_b", "completed", "History B")],
                next_cursor: null,
              },
              true,
            );
            resolve();
          };
        }),
    );
    renderSidebar({ onLoadMore });

    scrollSidebarToBottom();

    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toBeVisible();
    expect(screen.getAllByText("Active A")).toHaveLength(1);
    act(() => resolveLoad?.());

    await waitFor(() => expect(screen.getByText("History B")).toBeVisible());
    expect(useAgentStore.getState().activeTaskId).toBe("history_a");
  });

  it("shows a visible error when loading another history page fails", async () => {
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [],
        items: [summary("history_a", "completed", "History A")],
        next_cursor: "page_2",
      },
      false,
    );
    const onLoadMore = vi.fn().mockRejectedValue(new Error("history unavailable"));
    renderSidebar({ onLoadMore });

    scrollSidebarToBottom();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "历史任务加载失败",
        expect.objectContaining({ description: "history unavailable" }),
      ),
    );
  });

  it("keeps a retry action visible after initial history loading fails", async () => {
    useAgentStore.setState({
      historyStatus: "error",
      historyError: "history unavailable",
    });
    const onRetryHistory = vi.fn().mockResolvedValue(undefined);
    renderSidebar({ onRetryHistory });

    expect(screen.getByRole("alert")).toHaveTextContent("history unavailable");
    fireEvent.click(screen.getByRole("button", { name: "重试加载历史" }));

    await waitFor(() => expect(onRetryHistory).toHaveBeenCalledTimes(1));
  });

  it("shows a visible error when selecting a task fails", async () => {
    useAgentStore.getState().mergeTaskPage(
      { active_items: [], items: [summary("history_a", "completed", "History A")], next_cursor: null },
      false,
    );
    const onSelectTask = vi.fn().mockRejectedValue(new Error("task unavailable"));
    renderSidebar({ onSelectTask });

    fireEvent.click(screen.getByRole("button", { name: "History A 已完成" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "打开任务失败",
        expect.objectContaining({ description: "task unavailable" }),
      ),
    );
  });

  it("shows a visible error when cancelling a task fails", async () => {
    useAgentStore.getState().mergeTaskPage(
      { active_items: [summary("running", "running", "Running")], items: [], next_cursor: null },
      false,
    );
    const onCancelRun = vi.fn().mockRejectedValue(new Error("cancel unavailable"));
    renderSidebar({ onCancelRun });

    fireEvent.click(screen.getByRole("button", { name: "取消 Running" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "取消任务失败",
        expect.objectContaining({ description: "cancel unavailable" }),
      ),
    );
  });

  it("shows a visible error when deleting a task fails", async () => {
    useAgentStore.getState().mergeTaskPage(
      { active_items: [], items: [summary("finished", "completed", "Finished")], next_cursor: null },
      false,
    );
    const onDeleteTask = vi.fn().mockRejectedValue(new Error("delete unavailable"));
    renderSidebar({ onDeleteTask });

    fireEvent.click(screen.getByRole("button", { name: "删除 Finished" }));
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "删除任务失败",
        expect.objectContaining({ description: "delete unavailable" }),
      ),
    );
  });

  it("keeps navigation and new research available while other tasks run", () => {
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [
          summary("task_a", "running", "Task A"),
          summary("task_b", "running", "Task B"),
        ],
        items: [],
        next_cursor: null,
      },
      false,
    );
    useAgentStore.getState().setDraftInput("independent draft");
    const onNewDraft = vi.fn();
    const onSelectTask = vi.fn();
    renderSidebar({ onNewDraft, onSelectTask });

    fireEvent.click(screen.getByRole("button", { name: "Task B 运行中" }));
    expect(onSelectTask).toHaveBeenCalledWith("task_b");
    const newResearch = screen.getByRole("button", { name: /新建研究/ });
    expect(newResearch).toBeEnabled();
    fireEvent.click(newResearch);
    expect(onNewDraft).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState().tasksById.task_a.summary.status).toBe("running");
  });
  it("creates a new draft with Ctrl+N and shows the shortcut blocks", () => {
    const onNewDraft = vi.fn();
    renderSidebar({ onNewDraft });

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });

    expect(onNewDraft).toHaveBeenCalledTimes(1);
    const newResearch = screen.getByRole("button", { name: /新建研究/ });
    expect(within(newResearch).getByText("Ctrl")).toBeInTheDocument();
    expect(within(newResearch).getByText("N")).toBeInTheDocument();
  });

  it("uses status icons as the only visible status treatment", () => {
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [
          summary("running", "running", "Running"),
          summary("queued", "queued", "Queued"),
        ],
        items: [
          summary("completed", "completed", "Completed"),
          summary("failed", "failed", "Failed"),
          summary("cancelled", "cancelled", "Cancelled"),
          summary("interrupted", "interrupted", "Interrupted"),
        ],
        next_cursor: null,
      },
      false,
    );
    const { container } = renderSidebar();

    const iconFor = (name: string) =>
      screen.getByRole("button", { name }).querySelector("svg");
    expect(iconFor("Running 运行中")).toHaveClass("text-primary");
    expect(iconFor("Queued 排队中")).toHaveClass("text-primary");
    expect(iconFor("Completed 已完成")).toHaveClass(
      "text-sky-600",
      "dark:text-sky-400",
    );
    expect(iconFor("Failed 失败")).toHaveClass("text-destructive");
    expect(iconFor("Cancelled 已取消")).toHaveClass("text-destructive");
    expect(iconFor("Interrupted 已中断")).toHaveClass("text-destructive");
    expect(container.querySelector('[data-slot="badge"]')).not.toHaveTextContent(
      /运行中|排队中|已完成|失败|已取消|已中断/,
    );
  });

  it("colors terminal indicators by structured data outcome", () => {
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [],
        items: [
          summary("with_data", "completed", "With Data", 3),
          summary("without_data", "completed", "No Data", 0),
          summary("error", "failed", "Error"),
          summary("silent_summary", "failed", "Silent Summary", 0, true),
        ],
        next_cursor: null,
      },
      false,
    );
    useAgentStore.getState().hydrateTaskSnapshot({
      task: summary("silent", "failed", "Silent", 0),
      runs: [
        {
          run_id: "run_silent",
          task_id: "silent",
          request_id: "req_silent",
          status: "failed",
          input: "question",
          created_at: CREATED_AT,
          updated_at: CREATED_AT,
          started_at: CREATED_AT,
          finished_at: CREATED_AT,
          error:
            "agent completed without producing any artifacts (manifest missing or unchanged)",
        },
      ],
      messages: [],
      older_messages_cursor: null,
    });

    renderSidebar();

    const iconFor = (name: string) =>
      screen.getByRole("button", { name }).querySelector("svg");
    expect(iconFor("With Data 已完成")).toHaveClass(
      "text-emerald-600",
      "dark:text-emerald-400",
    );
    expect(iconFor("No Data 已完成")).toHaveClass(
      "text-sky-600",
      "dark:text-sky-400",
    );
    expect(iconFor("Error 失败")).toHaveClass("text-destructive");
    expect(iconFor("Silent 失败")).toHaveClass(
      "text-sky-600",
      "dark:text-sky-400",
    );
    expect(iconFor("Silent Summary 失败")).toHaveClass(
      "text-sky-600",
      "dark:text-sky-400",
    );
  });

  it("separates active cancellation from terminal deletion", async () => {
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [
          summary("running", "running", "Running"),
          summary("cancelling", "cancel_requested", "Cancelling"),
        ],
        items: [summary("finished", "completed", "Finished")],
        next_cursor: null,
      },
      false,
    );
    const onCancelRun = vi.fn().mockResolvedValue(undefined);
    const onDeleteTask = vi.fn().mockResolvedValue(undefined);
    renderSidebar({ onCancelRun, onDeleteTask });

    expect(screen.getByRole("button", { name: "取消 Running" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "正在取消 Cancelling" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "删除 Running" })).toBeNull();
    expect(screen.queryByRole("button", { name: "取消 Finished" })).toBeNull();

    const taskButton = screen.getByRole("button", { name: "Finished 已完成" });
    expect(taskButton).toHaveClass(
      "group-hover/menu-item:bg-sidebar-accent",
      "group-hover/menu-item:text-sidebar-accent-foreground",
    );
    const deleteAction = screen.getByRole("button", { name: "删除 Finished" });
    expect(deleteAction).toHaveClass(
      "transition-[transform,opacity]",
      "md:opacity-0",
      "group-hover/menu-item:opacity-100",
      "group-focus-within/menu-item:opacity-100",
    );
    fireEvent.click(deleteAction);
    expect(onDeleteTask).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(onDeleteTask).toHaveBeenCalledWith("finished"));
  });

  it("keeps the full long title accessible without nested buttons", () => {
    const title = "A very long biomedical research task title ".repeat(8).trim();
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [summary("long", "running", title)],
        items: [],
        next_cursor: null,
      },
      false,
    );
    const { container } = renderSidebar();

    expect(
      screen.getByRole("button", { name: `${title} 运行中` }),
    ).toBeVisible();
    expect(screen.getByText(title)).toHaveClass("truncate", "min-w-0");
    expect(container.querySelector("button button")).toBeNull();
  });

  it("shows connection and worker occupancy as separate footer rows", () => {
    useAgentStore.setState({ connectionStatus: "reconnecting" });
    useAgentStore.getState().mergeTaskPage(
      {
        active_items: [
          summary("running", "running"),
          summary("finalizing", "finalizing"),
          summary("cancelling", "cancel_requested"),
          summary("paused", "awaiting_user_input"),
          summary("queued", "queued"),
        ],
        items: [],
        next_cursor: null,
      },
      false,
    );
    renderSidebar();

    expect(screen.getByText("重新连接中")).toBeVisible();
    expect(screen.getByText("运行中 4 / 4")).toBeVisible();
    expect(screen.getByText("重新连接中").parentElement).not.toBe(
      screen.getByText("运行中 4 / 4").parentElement,
    );
  });

  it("renders the export cache button only when onExportCache is provided", () => {
    useAgentStore.getState().mergeTaskPage(
      { active_items: [], items: [], next_cursor: null },
      false,
    );

    // Without onExportCache: button is absent.
    renderSidebar();
    expect(screen.queryByRole("button", { name: "导出本地缓存为 ZIP" })).toBeNull();

    // With onExportCache: button is present and invokes the callback.
    const onExportCache = vi.fn();
    renderSidebar({ onExportCache });
    const btn = screen.getByRole("button", { name: "导出本地缓存为 ZIP" });
    fireEvent.click(btn);
    expect(onExportCache).toHaveBeenCalledTimes(1);
  });

  it("renders settings button only when onOpenSettings is provided", () => {
    useAgentStore.getState().mergeTaskPage(
      { active_items: [], items: [], next_cursor: null },
      false,
    );

    // Without onOpenSettings: button is absent.
    renderSidebar();
    expect(screen.queryByRole("button", { name: "打开设置" })).toBeNull();

    // With onOpenSettings: button is present and invokes the callback.
    const onOpenSettings = vi.fn();
    renderSidebar({ onOpenSettings });
    const btn = screen.getByRole("button", { name: "打开设置" });
    fireEvent.click(btn);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("coexists with both settings and export cache buttons simultaneously", () => {
    useAgentStore.getState().mergeTaskPage(
      { active_items: [], items: [], next_cursor: null },
      false,
    );

    const onExportCache = vi.fn();
    const onOpenSettings = vi.fn();
    renderSidebar({ onExportCache, onOpenSettings });

    expect(screen.getByRole("button", { name: "打开设置" })).toBeVisible();
    expect(screen.getByRole("button", { name: "导出本地缓存为 ZIP" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "导出本地缓存为 ZIP" }));
    expect(onExportCache).toHaveBeenCalledTimes(1);
  });
});
