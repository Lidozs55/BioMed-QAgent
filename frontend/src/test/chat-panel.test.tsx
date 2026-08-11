import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@/components/ChatPanel";
import { DatabaseSelector } from "@/components/DatabaseSelector";
import type {
  BuildResultStatus,
  TaskRunAccepted,
  TaskSnapshot,
} from "@/runtime/contracts";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";
import { usePreferencesStore } from "@/stores/preferencesStore";

const CREATED_AT = "2026-07-14T00:00:00Z";

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

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

function seedRunBuildResult(
  buildStatus: BuildResultStatus,
  userMessage: string,
): void {
  useAgentStore.setState((state) => {
    const task = state.tasksById.task_terminal;
    const runId = task.runOrder[task.runOrder.length - 1];
    if (runId === undefined) return state;
    return {
      ...state,
      tasksById: {
        ...state.tasksById,
        task_terminal: {
          ...task,
          runsById: {
            ...task.runsById,
            [runId]: {
              ...task.runsById[runId],
              status: "completed",
              summary: {
                run_status: "completed",
                build_result: {
                  status: buildStatus,
                  valid_row_count: 0,
                  successful_sources: [],
                  rejected_sources: [],
                  available_artifact_roles: [],
                  publication_id: null,
                  reason_codes: [],
                  user_summary: userMessage,
                  recommended_next_action: "",
                },
                error_code: null,
                cancelled_at_stage: null,
                user_message: userMessage,
              },
            },
          },
        },
      },
    };
  });
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

function chooseFiles(container: HTMLElement, files: File[]): void {
  fireEvent.click(screen.getByRole("button", { name: "添加附件" }));
  fireEvent.click(screen.getByText("上传文件（从本地缓存）"));
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("File picker was not rendered");
  fireEvent.change(input, { target: { files } });
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
    setViewportWidth(1024);
    usePreferencesStore.setState({
      showContextUsage: true,
      sendShortcut: "enter",
      followUpMode: "queue",
      translucentSidebar: false,
      contrast: 50,
      pointerCursor: true,
      reducedMotion: "system",
      uiFontSize: 16,
      lightColors: { background: "", foreground: "" },
      darkColors: { background: "", foreground: "" },
    });
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
    expect(screen.getByRole("button", { name: /未配置 API Key/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "开始研究" })).toBeDisabled();
    expect(container.querySelector('[data-slot="agent-composer"]')).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "研究目标" })).toHaveClass("min-h-28");
  });

  it("shows active task artifacts before the attachment control", () => {
    seedTerminalTask();
    const state = useAgentStore.getState();
    const task = state.tasksById.task_terminal;
    useAgentStore.setState({
      tasksById: {
        ...state.tasksById,
        task_terminal: {
          ...task,
          artifactsById: {
            artifact_main: {
              artifact_id: "artifact_main",
              name: "main_data.csv",
              size: 128,
              sha256: "a".repeat(64),
              media_type: "text/csv",
              taskId: "task_terminal",
              generatedByStepId: null,
            },
          },
          artifactOrder: ["artifact_main"],
        },
      },
    });

    const { container } = render(<ChatPanel startTask={vi.fn()} />);
    const composer = container.querySelector('[data-slot="agent-composer"]');
    const artifactButton = screen.getByRole("button", {
      name: "查看 1 个产物",
    });
    const attachmentButton = screen.getByRole("button", { name: "添加附件" });

    expect(artifactButton).toBeVisible();
    expect(
      artifactButton.compareDocumentPosition(attachmentButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(composer).toContainElement(artifactButton);
  });

  it("renders attachments, removes one, and submits the remaining file with its note", async () => {
    const first = new File(["first"], "first.csv", { type: "text/csv" });
    const second = new File(["second"], "second.csv", { type: "text/csv" });
    const uploadFiles = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <ChatPanel startTask={vi.fn()} uploadFiles={uploadFiles} />,
    );

    chooseFiles(container, [first, second]);

    expect(container.querySelectorAll('[data-slot="attachment"]')).toHaveLength(2);
    expect(screen.getByText("first.csv")).toBeVisible();
    expect(screen.getByText("5 B")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "移除 first.csv" }));
    expect(container.querySelectorAll('[data-slot="attachment"]')).toHaveLength(1);

    fireEvent.change(screen.getByRole("textbox", { name: "研究目标" }), {
      target: { value: "keep this sample" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始研究" }));

    await waitFor(() =>
      expect(uploadFiles).toHaveBeenCalledWith([second], "keep this sample"),
    );
  });

  it("rejects selections over the ten-file limit without discarding valid attachments", () => {
    const initial = new File(["initial"], "initial.csv");
    const excessive = Array.from(
      { length: 10 },
      (_, index) => new File([String(index)], `extra-${index}.csv`),
    );
    const { container } = render(
      <ChatPanel startTask={vi.fn()} uploadFiles={vi.fn()} />,
    );

    chooseFiles(container, [initial]);
    chooseFiles(container, excessive);

    expect(screen.getByRole("alert")).toHaveTextContent("最多上传 10 个文件");
    expect(container.querySelectorAll('[data-slot="attachment"]')).toHaveLength(1);
    expect(screen.getByText("initial.csv")).toBeVisible();
  });

  it("rejects a file larger than five hundred MiB", () => {
    const tooLarge = new File(["x"], "too-large.csv");
    Object.defineProperty(tooLarge, "size", { value: 500 * 1024 * 1024 + 1 });
    const { container } = render(
      <ChatPanel startTask={vi.fn()} uploadFiles={vi.fn()} />,
    );

    chooseFiles(container, [tooLarge]);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "单个文件不能超过 500 MiB",
    );
    expect(container.querySelector('[data-slot="attachment"]')).toBeNull();
  });

  it("rejects selections whose combined size exceeds two GiB", () => {
    const files = Array.from({ length: 5 }, (_, index) => {
      const file = new File(["x"], `large-${index}.csv`);
      Object.defineProperty(file, "size", { value: 450 * 1024 * 1024 });
      return file;
    });
    const { container } = render(
      <ChatPanel startTask={vi.fn()} uploadFiles={vi.fn()} />,
    );

    chooseFiles(container, files);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "单次上传总大小不能超过 2 GiB",
    );
    expect(container.querySelector('[data-slot="attachment"]')).toBeNull();
  });

  it("rejects duplicate sanitized filenames without adding the second file", () => {
    const first = new File(["first"], "result?.csv");
    const duplicate = new File(["second"], "result_.csv");
    const { container } = render(
      <ChatPanel startTask={vi.fn()} uploadFiles={vi.fn()} />,
    );

    chooseFiles(container, [first]);
    chooseFiles(container, [duplicate]);

    expect(screen.getByRole("alert")).toHaveTextContent("文件名重复");
    expect(container.querySelectorAll('[data-slot="attachment"]')).toHaveLength(1);
    expect(screen.getByText("result?.csv")).toBeVisible();
  });

  it("retains selected files and note after a rejected import", async () => {
    const file = new File(["rows"], "samples.csv");
    const uploadFiles = vi.fn().mockRejectedValue(new Error("上传失败"));
    const { container } = render(
      <ChatPanel startTask={vi.fn()} uploadFiles={uploadFiles} />,
    );

    chooseFiles(container, [file]);
    const input = screen.getByRole("textbox", { name: "研究目标" });
    fireEvent.change(input, { target: { value: "retry note" } });
    fireEvent.click(screen.getByRole("button", { name: "开始研究" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("上传失败"),
    );
    expect(input).toHaveValue("retry note");
    expect(container.querySelector('[data-slot="attachment"]')).toHaveTextContent(
      "samples.csv",
    );
  });

  it("clears selected files and note after a successful import", async () => {
    const file = new File(["rows"], "samples.csv");
    const uploadFiles = vi.fn().mockResolvedValue(undefined);
    const { container } = render(
      <ChatPanel startTask={vi.fn()} uploadFiles={uploadFiles} />,
    );

    chooseFiles(container, [file]);
    const input = screen.getByRole("textbox", { name: "研究目标" });
    fireEvent.change(input, { target: { value: "successful note" } });
    fireEvent.click(screen.getByRole("button", { name: "开始研究" }));

    await waitFor(() => expect(uploadFiles).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(container.querySelector('[data-slot="attachment"]')).toBeNull(),
    );
    expect(input).toHaveValue("");
  });

  it("blocks new attachment selections while an import upload is unresolved", async () => {
    const uploaded = new File(["uploaded"], "uploaded.csv");
    const blocked = new File(["blocked"], "blocked.csv");
    const upload = deferred<void>();
    const uploadFiles = vi.fn().mockReturnValue(upload.promise);
    const { container } = render(
      <ChatPanel startTask={vi.fn()} uploadFiles={uploadFiles} />,
    );

    chooseFiles(container, [uploaded]);
    fireEvent.click(screen.getByRole("button", { name: "开始研究" }));

    await waitFor(() => expect(uploadFiles).toHaveBeenCalledWith([uploaded], ""));
    expect(screen.getByRole("button", { name: "添加附件" })).toBeDisabled();

    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (input === null) throw new Error("File picker was not rendered");
    fireEvent.change(input, { target: { files: [blocked] } });

    expect(container.querySelectorAll('[data-slot="attachment"]')).toHaveLength(1);
    expect(screen.queryByText("blocked.csv")).not.toBeInTheDocument();

    await act(async () => upload.resolve());
    await waitFor(() =>
      expect(container.querySelector('[data-slot="attachment"]')).toBeNull(),
    );
    expect(uploadFiles).toHaveBeenCalledTimes(1);
  });

  it("blocks submission and explains that at least one data source is required", () => {
    const startTask = vi.fn();
    render(<ChatPanel startTask={startTask} />);
    fireEvent.change(screen.getByPlaceholderText("输入研究目标..."), {
      target: { value: "BRCA1 expression" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始研究" }));

    expect(startTask).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "请至少选择一个数据源",
    );
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
    act(() =>
      useAgentStore.getState().setDraftSelectedDatabaseIds(["pubmed", "geo"]),
    );
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
        databases: ["pubmed", "geo"],
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

    expect(screen.getByText("正在思考…").closest('[data-slot="marker"]')).toHaveAttribute("role", "status");

    act(() => {
      // Live stream frame 使 segment active=true, isStreaming=true
      useAgentStore.getState().applyAssistantStreamFrames([
        {
          type: "assistant_stream_delta",
          task_id: "task_background",
          run_id: "run_background",
          stream_id: "assistant:run_background",
          chunk_index: 0,
          delta: "Streaming answer",
        },
      ]);
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

    expect(screen.queryByText("正在思考…")).not.toBeInTheDocument();
    expect(screen.getByText("Streaming answer")).toBeInTheDocument();
  });

  it("shows failed status without duplicating the run failure alert", () => {
    seedTerminalTask();
    useAgentStore.setState((state) => {
      const task = state.tasksById.task_terminal;
      const runId = task.runOrder[task.runOrder.length - 1];
      if (runId === undefined) return state;
      return {
        ...state,
        tasksById: {
          ...state.tasksById,
          task_terminal: {
            ...task,
            summary: { ...task.summary, status: "failed" },
            runsById: {
              ...task.runsById,
              [runId]: { ...task.runsById[runId], status: "failed", error: "模型未产出有效产物" },
            },
          },
        },
      };
    });

    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("任务执行失败");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("模型未产出有效产物")).not.toBeInTheDocument();
  });

  it("shows the no_data build label from the latest run summary", () => {
    seedTerminalTask();
    useAgentStore.setState((state) => {
      const task = state.tasksById.task_terminal;
      const runId = task.runOrder[task.runOrder.length - 1];
      if (runId === undefined) return state;
      return {
        ...state,
        tasksById: {
          ...state.tasksById,
          task_terminal: {
            ...task,
            runsById: {
              ...task.runsById,
              [runId]: {
                ...task.runsById[runId],
                status: "completed",
                summary: {
                  run_status: "completed",
                  build_result: {
                    status: "no_data",
                    valid_row_count: 0,
                    successful_sources: [],
                    rejected_sources: ["pubmed"],
                    available_artifact_roles: [],
                    publication_id: null,
                    reason_codes: ["no_records"],
                    user_summary: "未检索到数据",
                    recommended_next_action: "调整检索词后重试",
                  },
                  error_code: null,
                  cancelled_at_stage: null,
                  user_message: "未检索到数据",
                },
              },
            },
          },
        },
      };
    });

    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("无数据");
    expect(
      screen.getByRole("status").querySelector("svg path")?.getAttribute("d"),
    ).toContain("M112,84a12,12,0,1,1"); // InfoIcon, not CheckCircleIcon
  });

  it("shows the spec_rejected build label from the latest run summary", () => {
    seedTerminalTask();
    useAgentStore.setState((state) => {
      const task = state.tasksById.task_terminal;
      const runId = task.runOrder[task.runOrder.length - 1];
      if (runId === undefined) return state;
      return {
        ...state,
        tasksById: {
          ...state.tasksById,
          task_terminal: {
            ...task,
            runsById: {
              ...task.runsById,
              [runId]: {
                ...task.runsById[runId],
                status: "completed",
                summary: {
                  run_status: "completed",
                  build_result: {
                    status: "spec_rejected",
                    valid_row_count: 0,
                    successful_sources: [],
                    rejected_sources: ["pubmed"],
                    available_artifact_roles: [],
                    publication_id: null,
                    reason_codes: ["spec_rejected"],
                    user_summary: "产物未通过规格校验",
                    recommended_next_action: "修正规格后重试",
                  },
                  error_code: null,
                  cancelled_at_stage: null,
                  user_message: "产物未通过规格校验",
                },
              },
            },
          },
        },
      };
    });

    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("规格被拒");
    expect(
      screen.getByRole("status").querySelector("svg path")?.getAttribute("d"),
    ).toContain("m88,104a87.56"); // ProhibitIcon, not CheckCircleIcon
  });

  it("shows the succeeded build label from the latest run summary", () => {
    seedTerminalTask();
    seedRunBuildResult("succeeded", "检索完成");
    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("构建成功");
    expect(
      screen.getByRole("status").querySelector("svg path")?.getAttribute("d"),
    ).toContain("M173.66,98.34a8,8"); // CheckCircleIcon
  });

  it("shows the partial_success build label from the latest run summary", () => {
    seedTerminalTask();
    seedRunBuildResult("partial_success", "部分来源未收录");
    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("部分成功");
    expect(
      screen.getByRole("status").querySelector("svg path")?.getAttribute("d"),
    ).toContain("M173.66,98.34a8,8"); // CheckCircleIcon
  });

  it("keeps the generic completed label when the run summary has no build result", () => {
    seedTerminalTask();

    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("任务已完成");
  });

  it("renders the latest run summary and recommended action for partial_success", () => {
    seedTerminalTask();
    useAgentStore.setState((state) => {
      const task = state.tasksById.task_terminal;
      const runId = task.runOrder[task.runOrder.length - 1];
      if (runId === undefined) return state;
      return {
        ...state,
        tasksById: {
          ...state.tasksById,
          task_terminal: {
            ...task,
            runsById: {
              ...task.runsById,
              [runId]: {
                ...task.runsById[runId],
                status: "completed",
                summary: {
                  run_status: "completed",
                  build_result: {
                    status: "partial_success",
                    valid_row_count: 42,
                    successful_sources: ["pubmed"],
                    rejected_sources: ["geo"],
                    available_artifact_roles: ["primary_dataset"],
                    publication_id: "pub-1",
                    reason_codes: ["partial_source_rejected"],
                    user_summary: "部分来源未收录，已生成可用结果",
                    recommended_next_action: "补充 GEO 检索后重新生成",
                  },
                  error_code: null,
                  cancelled_at_stage: null,
                  user_message: "部分来源未收录，已生成可用结果",
                },
              },
            },
          },
        },
      };
    });

    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(
      screen.getByText("部分来源未收录，已生成可用结果"),
    ).toBeVisible();
    expect(
      screen.getByText("补充 GEO 检索后重新生成"),
    ).toBeVisible();
  });

  it("renders the latest run rejection summary and recommended action for spec_rejected", () => {
    seedTerminalTask();
    useAgentStore.setState((state) => {
      const task = state.tasksById.task_terminal;
      const runId = task.runOrder[task.runOrder.length - 1];
      if (runId === undefined) return state;
      return {
        ...state,
        tasksById: {
          ...state.tasksById,
          task_terminal: {
            ...task,
            runsById: {
              ...task.runsById,
              [runId]: {
                ...task.runsById[runId],
                status: "completed",
                summary: {
                  run_status: "completed",
                  build_result: {
                    status: "spec_rejected",
                    valid_row_count: 0,
                    successful_sources: [],
                    rejected_sources: ["pubmed"],
                    available_artifact_roles: [],
                    publication_id: null,
                    reason_codes: ["spec_rejected"],
                    user_summary: "产物未通过规格校验",
                    recommended_next_action: "修正数据映射后重新生成",
                  },
                  error_code: null,
                  cancelled_at_stage: null,
                  user_message: "产物未通过规格校验",
                },
              },
            },
          },
        },
      };
    });

    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.getByText("产物未通过规格校验")).toBeVisible();
    expect(screen.getByText("修正数据映射后重新生成")).toBeVisible();
  });

  it("renders the latest run stable error code and user message for failed", () => {
    seedTerminalTask();
    useAgentStore.setState((state) => {
      const task = state.tasksById.task_terminal;
      const runId = task.runOrder[task.runOrder.length - 1];
      if (runId === undefined) return state;
      return {
        ...state,
        tasksById: {
          ...state.tasksById,
          task_terminal: {
            ...task,
            summary: { ...task.summary, status: "failed" },
            runsById: {
              ...task.runsById,
              [runId]: {
                ...task.runsById[runId],
                status: "failed",
                summary: {
                  run_status: "failed",
                  build_result: null,
                  error_code: "download_incomplete",
                  cancelled_at_stage: null,
                  user_message: "下载中断，记录不完整",
                },
              },
            },
          },
        },
      };
    });

    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.getByText("下载中断，记录不完整")).toBeVisible();
    expect(screen.getByText(/download_incomplete/)).toBeVisible();
  });

  it("renders the latest run cancellation stage for cancelled", () => {
    seedTerminalTask();
    useAgentStore.setState((state) => {
      const task = state.tasksById.task_terminal;
      const runId = task.runOrder[task.runOrder.length - 1];
      if (runId === undefined) return state;
      return {
        ...state,
        tasksById: {
          ...state.tasksById,
          task_terminal: {
            ...task,
            summary: { ...task.summary, status: "cancelled" },
            runsById: {
              ...task.runsById,
              [runId]: {
                ...task.runsById[runId],
                status: "cancelled",
                summary: {
                  run_status: "cancelled",
                  build_result: null,
                  error_code: null,
                  cancelled_at_stage: "processing",
                  user_message: "用户取消",
                },
              },
            },
          },
        },
      };
    });

    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.getByText("取消于数据处理阶段")).toBeVisible();
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

    expect(screen.queryByText("正在思考…")).not.toBeInTheDocument();
  });

  it("does not show active Agent work for terminal or fixture tasks", () => {
    seedTerminalTask();
    const { rerender } = render(
      <ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />,
    );
    expect(screen.queryByText("正在思考…")).not.toBeInTheDocument();

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
    expect(screen.queryByText("正在思考…")).not.toBeInTheDocument();
  });

  it("renders assistant Markdown through the ghost Bubble primitive", () => {
    seedTerminalTask();
    const content = "Summary line\n\n- first item\n  indented detail";
    useAgentStore.setState((state) => {
      const task = state.tasksById.task_terminal;
      const userItem = task.items.find((item) => item.kind === "user_message");
      const assistantItem = {
        kind: "assistant_segment",
        itemId: "msg:assistant_ghost",
        runId: "run_task_terminal",
        sequence: 2,
        createdAt: CREATED_AT,
        streamId: "hydrate:assistant_ghost",
        content,
        isStreaming: false,
        finishReason: null,
      } as const;
      return {
        tasksById: {
          ...state.tasksById,
          task_terminal: {
            ...task,
            items: userItem === undefined ? [assistantItem] : [userItem, assistantItem],
          },
        },
      };
    });
    const { container } = render(
      <ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />,
    );

    const assistantBubble = container.querySelector<HTMLElement>(
      '[data-slot="bubble"][data-variant="ghost"]',
    );
    expect(assistantBubble).not.toBeNull();
    expect(assistantBubble?.querySelector("svg")).not.toBeInTheDocument();
    expect(assistantBubble?.textContent).toContain("Summary line");
    expect(assistantBubble?.querySelector("ul")).toBeInTheDocument();
  });

  it("does not render a separate results tab", () => {
    seedTerminalTask();
    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.queryByRole("tab", { name: "结果" })).not.toBeInTheDocument();
  });

  it("queues a follow-up while the agent runs and sends it once idle", async () => {
    seedBackgroundTask();
    useAgentStore.getState().setActiveTaskId("task_background");
    const continueTask = vi.fn().mockResolvedValue({
      request_id: "req_follow",
      task_id: "task_background",
      run_id: "run_follow",
      status: "queued",
    } satisfies TaskRunAccepted);
    render(
      <ChatPanel
        startTask={vi.fn()}
        continueTask={continueTask}
        cancelRun={vi.fn()}
      />,
    );

    const input = screen.getByRole("textbox", { name: "继续提问" });
    const send = screen.getByRole("button", { name: "发送继续问题" });
    expect(input).toBeEnabled();
    fireEvent.change(input, { target: { value: "send this when ready" } });
    expect(input).toHaveValue("send this when ready");
    expect(send).toBeEnabled();
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    expect(continueTask).not.toHaveBeenCalled();
    expect(screen.getByText(/已加入队列/)).toBeVisible();

    const composer = input.closest('[data-slot="agent-composer"]');
    expect(composer).toContainElement(send);

    // 当前回答结束后自动发送排队消息
    act(() => {
      useAgentStore.setState((state) => {
        const task = state.tasksById.task_background;
        return {
          tasksById: {
            ...state.tasksById,
            task_background: {
              ...task,
              summary: {
                ...task.summary,
                status: "completed",
                active_run_id: null,
              },
              runsById: {
                ...task.runsById,
                run_background: {
                  runId: "run_background",
                  taskId: "task_background",
                  requestId: "req_bg",
                  status: "completed",
                  input: "initial",
                  createdAt: CREATED_AT,
                  updatedAt: CREATED_AT,
                  startedAt: CREATED_AT,
                  finishedAt: CREATED_AT,
                  error: null,
                  summary: null,
                },
              },
              runOrder: ["run_background"],
            },
          },
        };
      });
    });

    await waitFor(() =>
      expect(continueTask).toHaveBeenCalledWith("task_background", {
        input: "send this when ready",
      }),
    );
  });

  it("steers the running agent by cancelling and sending the new direction when idle", async () => {
    seedBackgroundTask();
    useAgentStore.getState().setActiveTaskId("task_background");
    usePreferencesStore.getState().setFollowUpMode("steer");
    const cancelRun = vi.fn().mockResolvedValue(undefined);
    const continueTask = vi.fn().mockResolvedValue({
      request_id: "req_steer",
      task_id: "task_background",
      run_id: "run_steer",
      status: "queued",
    } satisfies TaskRunAccepted);
    render(
      <ChatPanel
        startTask={vi.fn()}
        continueTask={continueTask}
        cancelRun={cancelRun}
      />,
    );

    const input = screen.getByRole("textbox", { name: "继续提问" });
    fireEvent.change(input, { target: { value: "new direction" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(cancelRun).toHaveBeenCalledWith("task_background", "run_background"),
    );
    expect(continueTask).not.toHaveBeenCalled();
    expect(screen.getByText(/正在切换方向/)).toBeVisible();

    act(() => {
      useAgentStore.setState((state) => {
        const task = state.tasksById.task_background;
        return {
          tasksById: {
            ...state.tasksById,
            task_background: {
              ...task,
              summary: {
                ...task.summary,
                status: "cancelled",
                active_run_id: null,
              },
              runsById: {
                ...task.runsById,
                run_background: {
                  runId: "run_background",
                  taskId: "task_background",
                  requestId: "req_bg",
                  status: "cancelled",
                  input: "initial",
                  createdAt: CREATED_AT,
                  updatedAt: CREATED_AT,
                  startedAt: CREATED_AT,
                  finishedAt: CREATED_AT,
                  error: null,
                  summary: null,
                },
              },
              runOrder: ["run_background"],
            },
          },
        };
      });
    });

    await waitFor(() =>
      expect(continueTask).toHaveBeenCalledWith("task_background", {
        input: "new direction",
      }),
    );
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
    act(() =>
      useAgentStore.getState().setDraftSelectedDatabaseIds(["pubmed", "geo"]),
    );
    const input = screen.getByPlaceholderText("输入研究目标...");
    fireEvent.change(input, { target: { value: "new draft" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    await waitFor(() =>
      expect(startTask).toHaveBeenCalledWith({
        input: "new draft",
        databases: ["pubmed", "geo"],
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

  it("passes model props to draft composer when provided", () => {
    const onModelChange = vi.fn();
    render(
      <ChatPanel
        startTask={vi.fn()}
        models={[{ id: "qwen-plus", name: "Qwen Plus", description: "", context_window: 131072, suggested_max_tokens: 8192, capabilities: { text: true, image: false, video: false, audio: false }, recommended: true, api_available: true, capability_source: "api" }]}
        hasApiKey={true}
        onOpenSettings={vi.fn()}
        onModelChange={onModelChange}
        selectedModelId="qwen-plus"
      />,
    );

    // The model selector should show the selected model name
    expect(screen.getByText("Qwen Plus")).toBeVisible();
  });

  it("shows the active subagent count in the mobile task header", () => {
    setViewportWidth(390);
    seedBackgroundTask();
    useAgentStore.getState().hydrateTaskSnapshot({
      task: {
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
      runs: [],
      messages: [],
      subagents: [
        {
          subagent_id: "subagent_1",
          task_id: "task_background",
          run_id: "run_background",
          agent_type: "source_research",
          objective: "Explore a public source",
          target_source: "example",
          status: "running",
          parent_tool_call_id: "tool_1",
          created_at: CREATED_AT,
          started_at: CREATED_AT,
          finished_at: null,
          progress_current: 1,
          progress_total: 3,
          progress_message: "正在解析公开页面",
          result_summary: null,
          source_asset_ids: [],
          recipe_id: null,
          error_code: null,
          error_message: null,
          pending_request_id: null,
        },
      ],
      older_messages_cursor: null,
    });
    useAgentStore.getState().setActiveTaskId("task_background");

    const { container } = render(<ChatPanel startTask={vi.fn()} />);

    const button = screen.getByRole("button", { name: "查看 1 个子任务" });
    expect(button).toBeVisible();
    expect(button).toHaveTextContent("1 个运行中");
    expect(
      button.querySelector('[data-slot="spinner"]'),
    ).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="resizable-panel-group"]'),
    ).not.toBeInTheDocument();
  });
});
