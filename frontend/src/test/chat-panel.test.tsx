import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@/components/ChatPanel";
import { DatabaseSelector } from "@/components/DatabaseSelector";
import type { TaskRunAccepted, TaskSnapshot } from "@/runtime/contracts";
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

function seedTerminalTask(
  mode: "agent" | "fixture" = "agent",
  taskId = "task_terminal",
  olderMessagesCursor: string | null = null,
): void {
  const snapshot: TaskSnapshot = {
    task: {
      task_id: taskId,
      mode,
      databases: ["pubmed"],
      title: `${taskId} task`,
      status: "completed",
      active_run_id: null,
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      latest_sequence: 3,
    },
    runs: [
      {
        run_id: `run_${taskId}`,
        task_id: taskId,
        request_id: `req_${taskId}`,
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
        message_id: `message_${taskId}`,
        task_id: taskId,
        run_id: `run_${taskId}`,
        ordinal: 1,
        role: "user",
        content: `${taskId} question`,
        created_at: CREATED_AT,
      },
    ],
    older_messages_cursor: olderMessagesCursor,
  };
  useAgentStore.getState().hydrateTaskSnapshot(snapshot);
  useAgentStore.getState().setActiveTaskId(taskId);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

  it("renders the new conversation as a centered Agent composer", () => {
    const { container } = render(<ChatPanel startTask={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "今天想研究什么？" })).toBeVisible();
    expect(screen.getByRole("button", { name: "添加附件" })).toBeVisible();
    expect(screen.getByRole("button", { name: /切换主模型/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "开始研究" })).toBeDisabled();
    expect(container.querySelector('[data-slot="agent-composer"]')).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "研究目标" })).toHaveClass("min-h-28");
  });

  it("submits selected data sources through the semantic REST controller", async () => {
    const startTask = vi.fn().mockResolvedValue({
      request_id: "req_agent",
      task_id: "task_agent",
      run_id: "run_agent",
      status: "queued",
    } satisfies TaskRunAccepted);
    render(<ChatPanel startTask={startTask} />);
    fireEvent.change(screen.getByPlaceholderText("输入研究目标..."), {
      target: { value: "  Run research  " },
    });
    fireEvent.click(screen.getByRole("combobox", { name: /选择数据源/ }));
    fireEvent.click(await screen.findByRole("button", { name: "选择全部" }));
    fireEvent.click(screen.getByRole("button", { name: "开始研究" }));

    await waitFor(() => expect(startTask).toHaveBeenCalledWith({
      input: "Run research",
      databases: ["pubmed", "geo"],
      mode: "agent",
    }));
  });

  it("keeps a blank draft usable while another task is running", async () => {
    seedBackgroundTask();
    act(() => useAgentStore.getState().showNewDraft());
    const before = useAgentStore.getState().tasksById;
    const startTask = vi.fn().mockResolvedValue({
      request_id: "req_new",
      task_id: "task_new",
      run_id: "run_new",
      status: "queued",
    });
    render(<ChatPanel startTask={startTask} />);

    expect(screen.getByPlaceholderText("输入研究目标...")).toBeEnabled();
    expect(screen.getByRole("combobox", { name: /选择数据源/ })).toBeEnabled();
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

  it("keeps the centered draft composer inside a bounded scroll surface", () => {
    const { container } = render(<ChatPanel startTask={vi.fn()} />);
    const surface = container.firstElementChild;
    expect(surface).toHaveClass("min-h-0", "overflow-y-auto", "items-center");
    expect(surface).toContainElement(screen.getByRole("button", { name: "开始研究" }));
    expect(screen.queryByRole("tab")).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("combobox", { name: /选择数据源/ }));
    fireEvent.click(screen.getByRole("button", { name: "选择全部" }));
    expect(onToggle).toHaveBeenNthCalledWith(1, "pubmed", true);
    expect(onToggle).toHaveBeenNthCalledWith(2, "geo", true);

    fireEvent.click(screen.getByRole("button", { name: "清空全部" }));
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
    expect(input).toHaveClass("min-h-18");
    expect(input).not.toHaveClass("min-h-28");
    fireEvent.change(input, { target: { value: "follow up" } });
    fireEvent.click(screen.getByRole("button", { name: "发送继续问题" }));

    await waitFor(() =>
      expect(continueTask).toHaveBeenCalledWith("task_terminal", {
        input: "follow up",
      }),
    );
  });

  it("keeps MessageScroller as scroll owner and gives the transcript readable gutters", () => {
    seedTerminalTask();
    const { container } = render(
      <ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />,
    );

    const chatPanel = screen.getByRole("textbox", { name: "继续提问" }).closest(".flex.h-full");
    const messageScroller = container.querySelector<HTMLElement>(
      '[data-slot="message-scroller"]',
    );
    const messageViewport = container.querySelector<HTMLElement>(
      '[data-slot="message-scroller-viewport"]',
    );
    const messageContent = container.querySelector<HTMLElement>(
      '[data-slot="message-scroller-content"]',
    );

    expect(chatPanel).toHaveClass("min-h-0");
    expect(chatPanel).not.toHaveClass("overflow-y-auto");
    expect(chatPanel).toContainElement(messageScroller);
    expect(messageViewport).toHaveClass("overflow-y-auto");
    expect(messageContent).toHaveClass("px-5", "py-6", "max-w-3xl");
  });

  it("shows active Agent work until real streamed output arrives", () => {
    seedBackgroundTask();
    useAgentStore.getState().setActiveTaskId("task_background");
    const { rerender } = render(
      <ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />,
    );

    expect(screen.getByText("正在处理请求…").closest('[data-slot="marker"]')).toHaveAttribute("role", "status");

    act(() => {
      useAgentStore.getState().applyEvent({
        schema_version: "2.0",
        event_id: "event_background_delta",
        type: "assistant_delta",
        task_id: "task_background",
        run_id: "run_background",
        stage_attempt_id: null,
        sequence: 3,
        timestamp: "2026-07-14T00:00:03Z",
        payload: { type: "assistant_delta", delta: "Streaming answer" },
      });
    });
    rerender(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.queryByText("正在处理请求…")).not.toBeInTheDocument();
    expect(screen.getByText("Streaming answer")).toBeInTheDocument();
  });

  it("does not show processing status while an Agent waits for user input", () => {
    seedBackgroundTask();
    useAgentStore.setState((state) => ({
      tasksById: {
        ...state.tasksById,
        task_background: {
          ...state.tasksById.task_background,
          summary: {
            ...state.tasksById.task_background.summary,
            status: "awaiting_user_input",
          },
        },
      },
    }));
    useAgentStore.getState().setActiveTaskId("task_background");

    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.queryByText("正在处理请求…")).not.toBeInTheDocument();
  });

  it("does not show active Agent work for terminal or fixture tasks", () => {
    seedTerminalTask();
    const { rerender } = render(
      <ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />,
    );
    expect(screen.queryByText("正在处理请求…")).not.toBeInTheDocument();

    act(() => {
      useAgentStore.setState(createInitialRuntimeState());
      seedBackgroundTask();
      useAgentStore.setState((state) => ({
        tasksById: {
          ...state.tasksById,
          task_background: {
            ...state.tasksById.task_background,
            summary: {
              ...state.tasksById.task_background.summary,
              mode: "fixture",
            },
          },
        },
      }));
      useAgentStore.getState().setActiveTaskId("task_background");
    });
    rerender(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);
    expect(screen.queryByText("正在处理请求…")).not.toBeInTheDocument();
  });

  it("renders assistant Markdown through the ghost Bubble primitive", () => {
    seedTerminalTask();
    const content = "Summary line\n\n- first item\n  indented detail";
    useAgentStore.setState((state) => {
      const task = state.tasksById.task_terminal;
      return {
        tasksById: {
          ...state.tasksById,
          task_terminal: {
            ...task,
            messages: [
              {
                ...task.messages[0],
                role: "assistant",
                content,
              },
            ],
          },
        },
      };
    });
    const { container } = render(
      <ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />,
    );

    const assistant = container.querySelector<HTMLElement>('[data-message-role="assistant"]');
    expect(assistant).not.toBeNull();
    expect(assistant?.textContent).toContain("Summary line");
    expect(assistant?.querySelector("ul")).toBeInTheDocument();
    expect(assistant?.querySelector('[data-slot="bubble"]')).toHaveAttribute(
      "data-variant",
      "ghost",
    );
  });

  it("does not render a separate results tab", () => {
    seedTerminalTask();
    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.queryByRole("tab", { name: "结果" })).not.toBeInTheDocument();
  });

  it("keeps active Agent drafting editable while disabling only Send", () => {
    seedBackgroundTask();
    useAgentStore.getState().setActiveTaskId("task_background");
    const continueTask = vi.fn();
    const { rerender } = render(
      <ChatPanel startTask={vi.fn()} continueTask={continueTask} />,
    );

    const input = screen.getByRole("textbox", { name: "继续提问" });
    const send = screen.getByRole("button", { name: "发送继续问题" });
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "send this when ready" } });
    expect(input).toHaveValue("send this when ready");
    expect(send).toBeDisabled();
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(continueTask).not.toHaveBeenCalled();

    const composer = input.closest('[data-slot="agent-composer"]');
    expect(composer).toContainElement(send);

    act(() => seedTerminalTask("fixture"));
    rerender(<ChatPanel startTask={vi.fn()} continueTask={continueTask} />);
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

  it("submits the new draft when Enter follows a task view", async () => {
    seedTerminalTask();
    const startTask = vi.fn().mockResolvedValue({
      request_id: "req_new_draft",
      task_id: "task_new_draft",
      run_id: "run_new_draft",
      status: "queued",
    } satisfies TaskRunAccepted);
    render(<ChatPanel startTask={startTask} continueTask={vi.fn()} />);

    act(() => useAgentStore.getState().showNewDraft());
    const input = screen.getByPlaceholderText("输入研究目标...");
    fireEvent.change(input, { target: { value: "new draft" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(startTask).toHaveBeenCalledWith({
        input: "new draft",
        databases: [],
        mode: "agent",
      }),
    );
  });

  it("does not submit a new draft while Chinese IME composition is active", () => {
    const startTask = vi.fn();
    render(<ChatPanel startTask={startTask} />);

    const input = screen.getByPlaceholderText("输入研究目标...");
    fireEvent.change(input, { target: { value: "乳腺癌" } });
    fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
      isComposing: true,
    });

    expect(startTask).not.toHaveBeenCalled();
    expect(input).toHaveValue("乳腺癌");
  });

  it("does not submit a continuation while Chinese IME composition is active", () => {
    seedTerminalTask();
    const continueTask = vi.fn();
    render(<ChatPanel startTask={vi.fn()} continueTask={continueTask} />);

    const input = screen.getByRole("textbox", { name: "继续提问" });
    fireEvent.change(input, { target: { value: "继续分析" } });
    fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
      isComposing: true,
    });

    expect(continueTask).not.toHaveBeenCalled();
    expect(input).toHaveValue("继续分析");
  });

  it("does not let an earlier submission clear a newer draft", async () => {
    const submission = deferred<TaskRunAccepted>();
    const startTask = vi.fn().mockReturnValue(submission.promise);
    render(<ChatPanel startTask={startTask} />);

    const input = screen.getByPlaceholderText("输入研究目标...");
    fireEvent.change(input, { target: { value: "first draft" } });
    fireEvent.click(screen.getByRole("button", { name: "开始研究" }));
    act(() => useAgentStore.getState().showNewDraft());
    fireEvent.change(input, { target: { value: "newer draft" } });

    await act(async () => {
      submission.resolve({
        request_id: "req_first",
        task_id: "task_first",
        run_id: "run_first",
        status: "queued",
      });
      await submission.promise;
    });

    expect(input).toHaveValue("newer draft");
    expect(screen.getByPlaceholderText("输入研究目标...")).toBeVisible();
  });

  it("preserves a newer same-task draft while continuation submission is pending", async () => {
    seedTerminalTask("agent", "task_a");
    const continuation = deferred<TaskRunAccepted>();
    const continueTask = vi.fn().mockReturnValue(continuation.promise);
    render(<ChatPanel startTask={vi.fn()} continueTask={continueTask} />);

    const input = screen.getByRole("textbox", { name: "继续提问" });
    fireEvent.change(input, { target: { value: "question A" } });
    fireEvent.click(screen.getByRole("button", { name: "发送继续问题" }));
    fireEvent.change(input, { target: { value: "question B" } });

    await act(async () => {
      continuation.resolve({
        request_id: "req_follow_a",
        task_id: "task_a",
        run_id: "run_follow_a",
        status: "queued",
      });
      await continuation.promise;
    });

    expect(input).toHaveValue("question B");
  });

  it("keeps Task B continuation enabled while Task A is pending", async () => {
    seedTerminalTask("agent", "task_a");
    seedTerminalTask("agent", "task_b");
    useAgentStore.getState().setActiveTaskId("task_a");
    const continuation = deferred<TaskRunAccepted>();
    const continueTask = vi.fn().mockReturnValue(continuation.promise);
    render(<ChatPanel startTask={vi.fn()} continueTask={continueTask} />);

    const inputA = screen.getByRole("textbox", { name: "继续提问" });
    fireEvent.change(inputA, { target: { value: "question A" } });
    fireEvent.click(screen.getByRole("button", { name: "发送继续问题" }));
    act(() => useAgentStore.getState().setActiveTaskId("task_b"));

    const inputB = screen.getByRole("textbox", { name: "继续提问" });
    expect(inputB).toBeEnabled();
    fireEvent.change(inputB, { target: { value: "question B" } });
    expect(screen.getByRole("button", { name: "发送继续问题" })).toBeEnabled();

    await act(async () => {
      continuation.resolve({
        request_id: "req_follow_a",
        task_id: "task_a",
        run_id: "run_follow_a",
        status: "queued",
      });
      await continuation.promise;
    });
  });

  it("shows a task-scoped load-earlier action only when a cursor exists", async () => {
    seedTerminalTask("agent", "task_history", "cursor_before_latest");
    const loading = deferred<void>();
    const loadOlderMessages = vi.fn(() => loading.promise);
    render(
      <ChatPanel
        startTask={vi.fn()}
        loadOlderMessages={loadOlderMessages}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "加载更早消息" }),
    );

    expect(loadOlderMessages).toHaveBeenCalledWith("task_history");
    expect(
      screen.getByRole("button", { name: "正在加载更早消息" }),
    ).toBeDisabled();
    await act(async () => {
      loading.resolve();
      await loading.promise;
    });
    expect(
      screen.getByRole("button", { name: "加载更早消息" }),
    ).toBeEnabled();
  });

  it("keeps load-earlier errors scoped to the task when switching", async () => {
    seedTerminalTask("agent", "task_a", "cursor_a");
    seedTerminalTask("agent", "task_b", "cursor_b");
    useAgentStore.getState().setActiveTaskId("task_a");
    const loadOlderMessages = vi.fn().mockRejectedValue(new Error("history failed"));
    render(
      <ChatPanel
        startTask={vi.fn()}
        loadOlderMessages={loadOlderMessages}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "加载更早消息" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("history failed"),
    );

    act(() => useAgentStore.getState().setActiveTaskId("task_b"));
    expect(screen.queryByText("history failed")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "加载更早消息" }),
    ).toBeEnabled();

    act(() => useAgentStore.getState().setActiveTaskId("task_a"));
    expect(screen.getByRole("alert")).toHaveTextContent("history failed");
  });

  it("renders assistant messages as Markdown", () => {
    const snapshot: TaskSnapshot = {
      task: {
        task_id: "task_md",
        mode: "agent",
        databases: ["pubmed"],
        title: "Markdown task",
        status: "completed",
        active_run_id: null,
        created_at: CREATED_AT,
        updated_at: CREATED_AT,
        latest_sequence: 4,
      },
      runs: [
        {
          run_id: "run_md",
          task_id: "task_md",
          request_id: "req_md",
          status: "completed",
          input: "md question",
          created_at: CREATED_AT,
          updated_at: CREATED_AT,
          started_at: CREATED_AT,
          finished_at: CREATED_AT,
          error: null,
        },
      ],
      messages: [
        {
          message_id: "message_md",
          task_id: "task_md",
          run_id: "run_md",
          ordinal: 1,
          role: "assistant",
          content:
            "# 标题\n\n- item 1\n- item 2\n\n`code`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[link](https://example.com)",
          created_at: CREATED_AT,
        },
      ],
      older_messages_cursor: null,
    };
    useAgentStore.getState().hydrateTaskSnapshot(snapshot);
    useAgentStore.getState().setActiveTaskId("task_md");

    render(<ChatPanel startTask={vi.fn()} />);

    expect(
      screen.getByRole("heading", { level: 1, name: "标题" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("code")).toHaveClass("font-mono");
    expect(screen.getByRole("table")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "link" });
    expect(link).toHaveAttribute("href", "https://example.com");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("hides the load-earlier action after the full history is loaded", () => {
    seedTerminalTask();
    render(
      <ChatPanel
        startTask={vi.fn()}
        loadOlderMessages={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "加载更早消息" }),
    ).not.toBeInTheDocument();
  });
});
