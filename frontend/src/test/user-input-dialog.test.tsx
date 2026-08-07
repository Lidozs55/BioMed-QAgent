import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UserInputDialog } from "@/components/UserInputDialog";
import type { ResumeRunInput, TaskSummary } from "@/runtime/contracts";
import { createTaskProjection } from "@/runtime/reducer";
import type { PendingUserInput, TaskProjection } from "@/runtime/types";

const CREATED_AT = "2026-07-14T00:00:00Z";

function taskWithPrompt(
  taskId: string,
  activeRunId: string,
  pendingRunId: string,
  requestId: string,
  overrides: {
    promptKind?: PendingUserInput["promptKind"];
    detail?: PendingUserInput["detail"];
    summary?: string;
    expiresAt?: string | null;
  } = {},
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
      promptKind: overrides.promptKind ?? "plan_confirmation",
      summary: overrides.summary ?? `Confirm ${taskId}`,
      expiresAt: overrides.expiresAt ?? null,
      fixtureExempt: false,
      detail: overrides.detail ?? {},
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

  it("ignores an old attempt after returning to the same prompt and retrying", async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    const firstResume = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const secondResume = new Promise<void>((resolve) => {
      resolveSecond = resolve;
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
      .mockReturnValueOnce(secondResume);
    const taskA = taskWithPrompt(
      "task_a",
      "run_a",
      "run_a",
      "request_a",
    );
    const taskB = taskWithPrompt(
      "task_b",
      "run_b",
      "run_b",
      "request_b",
    );

    const { rerender } = render(
      <UserInputDialog task={taskA} onResumeRun={onResumeRun} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    rerender(<UserInputDialog task={taskB} onResumeRun={onResumeRun} />);
    rerender(<UserInputDialog task={taskA} onResumeRun={onResumeRun} />);
    expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "确认执行" }));
    expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();

    await act(async () => {
      rejectFirst?.(new Error("Stale A1 failure"));
      await firstResume.catch(() => undefined);
    });
    await waitFor(() => {
      expect(screen.queryByText("Stale A1 failure")).toBeNull();
      expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
    });

    await act(async () => {
      resolveSecond?.();
      await secondResume;
    });
    await waitFor(() => {
      expect(screen.queryByText("Stale A1 failure")).toBeNull();
      expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled();
    });
    expect(onResumeRun).toHaveBeenCalledTimes(2);
  });

  it("renders plan_confirmation detail as structured fields instead of raw JSON", () => {
    const detail: PendingUserInput["detail"] = {
      topic: "阿尔茨海默病与骨质疏松症共病机制",
      queries: [
        {
          query_id: "q1_pubmed_search",
          database: "pubmed",
          query: "(Alzheimer's disease AND osteoporosis)",
          generated_by: "agent",
          purpose: "Initial literature discovery",
          order: 1,
          page_size: 20,
          max_results: 20,
        },
      ],
      datasets: [
        {
          dataset_id: "gse12345",
          database: "geo",
          accession: "GSE12345",
          reason: "Differential expression analysis",
        },
      ],
      requested_outputs: ["main_data", "literature"],
    };
    const task = taskWithPrompt(
      "task_plan",
      "run_plan",
      "run_plan",
      "request_plan",
      { detail },
    );
    render(<UserInputDialog task={task} onResumeRun={vi.fn()} />);

    // 研究主题分段显示
    expect(screen.getByText("研究主题")).toBeVisible();
    expect(
      screen.getByText("阿尔茨海默病与骨质疏松症共病机制"),
    ).toBeVisible();

    // 检索查询分段显示，包含 query_id 和 database badge
    expect(screen.getByText("检索查询 (1)")).toBeVisible();
    expect(screen.getByText("#1")).toBeVisible();
    expect(screen.getByText("pubmed")).toBeVisible();
    expect(screen.getByText("(Alzheimer's disease AND osteoporosis)")).toBeVisible();
    expect(screen.getByText("Initial literature discovery")).toBeVisible();

    // 数据集分段显示
    expect(screen.getByText("数据集 (1)")).toBeVisible();
    expect(screen.getByText("GSE12345", { exact: false })).toBeVisible();

    // 请求输出 badge
    expect(screen.getByText("请求输出")).toBeVisible();
    expect(screen.getByText("main_data")).toBeVisible();
    expect(screen.getByText("literature")).toBeVisible();

    // 不应出现原始 JSON
    expect(
      screen.queryByText(/"schema_version"/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/"query_id": "q1_pubmed_search"/),
    ).not.toBeInTheDocument();
  });

  it("falls back gracefully when plan_confirmation detail has no topic", () => {
    // detail 缺少 topic 字段,parsePlanSpec 返回 null,不渲染结构化卡片
    const task = taskWithPrompt(
      "task_no_topic",
      "run_no_topic",
      "run_no_topic",
      "request_no_topic",
      { detail: { queries: [] } },
    );
    render(<UserInputDialog task={task} onResumeRun={vi.fn()} />);
    expect(screen.queryByText("研究主题")).not.toBeInTheDocument();
    expect(screen.queryByText("检索查询")).not.toBeInTheDocument();
  });

  it("renders max_turns_reached prompt without structured plan card", () => {
    const task = taskWithPrompt(
      "task_max_turns",
      "run_max_turns",
      "run_max_turns",
      "request_max_turns",
      {
        promptKind: "max_turns_reached",
        summary: "Agent 已达到最大轮次 (15)，是否继续工作？",
        detail: { max_turns: 15, resume_count: 0 },
      },
    );
    render(<UserInputDialog task={task} onResumeRun={vi.fn()} />);

    expect(screen.getByText("Agent 已达到最大轮次")).toBeVisible();
    expect(
      screen.getByText("Agent 已达到最大轮次 (15)，是否继续工作？"),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "继续工作" })).toBeVisible();
    expect(screen.getByRole("button", { name: "停止" })).toBeVisible();
    // max_turns_reached 不应渲染 plan card
    expect(screen.queryByText("研究主题")).not.toBeInTheDocument();
  });

  it("renders data_correction prompt with title, summary, textarea and both actions", () => {
    const task = taskWithPrompt(
      "task_correction",
      "run_correction",
      "run_correction",
      "request_correction",
      {
        promptKind: "data_correction",
        summary: "候选 GSE 无法判断，请确认使用哪个数据集？",
        detail: {
          field: "dataset_id",
          options: ["GSE100500", "GSE12345"],
        },
      },
    );
    render(<UserInputDialog task={task} onResumeRun={vi.fn()} />);

    expect(screen.getByText("需要人工修正")).toBeVisible();
    // summary 同时出现在描述与修正卡片中（突出展示）
    expect(
      screen.getAllByText("候选 GSE 无法判断，请确认使用哪个数据集？").length,
    ).toBeGreaterThan(0);
    expect(screen.getByRole("textbox")).toBeVisible();
    expect(screen.getByRole("button", { name: "提交修正" })).toBeVisible();
    expect(screen.getByRole("button", { name: "跳过并继续" })).toBeVisible();
    // detail 字段只读展示（field/options 建议选项）
    expect(screen.getByText("field")).toBeVisible();
    expect(screen.getByText("options")).toBeVisible();
    expect(screen.getByText("GSE100500")).toBeVisible();
    expect(screen.getByText("GSE12345")).toBeVisible();
    // data_correction 不应渲染 plan card
    expect(screen.queryByText("研究主题")).not.toBeInTheDocument();
  });

  it("disables 提交修正 while the correction text is empty and enables it once typed", () => {
    const task = taskWithPrompt(
      "task_correction",
      "run_correction",
      "run_correction",
      "request_correction",
      {
        promptKind: "data_correction",
        summary: "请修正检索词",
      },
    );
    render(<UserInputDialog task={task} onResumeRun={vi.fn()} />);

    const submit = screen.getByRole("button", { name: "提交修正" });
    expect(submit).toBeDisabled();
    // 跳过并继续始终可用（拒绝并继续，空修正）
    expect(screen.getByRole("button", { name: "跳过并继续" })).toBeEnabled();

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "使用 GSE12345 并检索 PubMed" },
    });
    expect(screen.getByRole("button", { name: "提交修正" })).toBeEnabled();
  });

  it("submits approve with the correction text and skip rejects with an empty correction", async () => {
    const onResumeRun = vi.fn<
      (
        taskId: string,
        runId: string,
        input: ResumeRunInput,
      ) => Promise<void>
    >();
    onResumeRun.mockResolvedValue(undefined);
    const task = taskWithPrompt(
      "task_correction",
      "run_correction",
      "run_correction",
      "request_correction",
      {
        promptKind: "data_correction",
        summary: "请确认数据源",
      },
    );
    render(<UserInputDialog task={task} onResumeRun={onResumeRun} />);

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "改用 GEO 数据 GSE12345" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交修正" }));
    await waitFor(() => expect(onResumeRun).toHaveBeenCalledTimes(1));
    expect(onResumeRun).toHaveBeenLastCalledWith(
      "task_correction",
      "run_correction",
      {
        request_id: "request_correction",
        decision: "approve",
        detail: { correction: "改用 GEO 数据 GSE12345" },
      },
    );

    // 跳过并继续总是发送 reject + 空修正，忽略已输入的文本
    fireEvent.click(screen.getByRole("button", { name: "跳过并继续" }));
    await waitFor(() => expect(onResumeRun).toHaveBeenCalledTimes(2));
    expect(onResumeRun).toHaveBeenLastCalledWith(
      "task_correction",
      "run_correction",
      {
        request_id: "request_correction",
        decision: "reject",
        detail: { correction: "" },
      },
    );
  });

  it("shows the expiry hint when expires_at is present and hides it otherwise", () => {
    const withExpiry = taskWithPrompt(
      "task_expiry",
      "run_expiry",
      "run_expiry",
      "request_expiry",
      {
        promptKind: "data_correction",
        summary: "请尽快修正数据源",
        expiresAt: "2026-07-14T00:05:00Z",
      },
    );
    const withoutExpiry = taskWithPrompt(
      "task_no_expiry",
      "run_no_expiry",
      "run_no_expiry",
      "request_no_expiry",
      {
        promptKind: "data_correction",
        summary: "请尽快修正数据源",
      },
    );

    const { rerender } = render(
      <UserInputDialog task={withExpiry} onResumeRun={vi.fn()} />,
    );
    expect(
      screen.getByText(/需在 .*前答复，超时后将记录到 corrections_todo\.csv 并继续/),
    ).toBeVisible();

    rerender(<UserInputDialog task={withoutExpiry} onResumeRun={vi.fn()} />);
    expect(screen.queryByText(/corrections_todo\.csv/)).not.toBeInTheDocument();
  });

  it("renders no_progress prompt without structured plan card", () => {
    const task = taskWithPrompt(
      "task_no_progress",
      "run_no_progress",
      "run_no_progress",
      "request_no_progress",
      {
        promptKind: "no_progress",
        summary: "检测到无进展：同一工具调用在短时间内密集重复 (search_pubmed × 3)，是否继续工作？",
        detail: {
          tool_name: "search_pubmed",
          args_hash: "abc",
          occurrences: 3,
          window_seconds: 300,
        },
      },
    );
    render(<UserInputDialog task={task} onResumeRun={vi.fn()} />);

    expect(screen.getByText("检测到无进展")).toBeVisible();
    expect(screen.getByRole("button", { name: "继续工作" })).toBeVisible();
    expect(screen.getByRole("button", { name: "停止" })).toBeVisible();
    // no_progress 不应渲染 plan card
    expect(screen.queryByText("研究主题")).not.toBeInTheDocument();
  });
});
