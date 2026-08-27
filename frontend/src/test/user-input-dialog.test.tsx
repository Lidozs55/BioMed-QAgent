import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UserInputDialog } from "@/components/UserInputDialog";
import type { ResumeRunInput, TaskSummary } from "@/runtime/contracts";
import {
  createInitialRuntimeState,
  createTaskProjection,
  mergeTaskPage,
  reduceRuntimeEvent,
} from "@/runtime/reducer";
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
    fixtureExempt?: boolean;
    hilRequest?: PendingUserInput["hilRequest"];
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
    runsById: {
      [pendingRunId]: {
        runId: pendingRunId,
        taskId,
        requestId,
        status: "awaiting_user_input" as const,
        input: null,
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        startedAt: CREATED_AT,
        finishedAt: null,
        error: null,
        summary: null,
      },
    },
    runOrder: [pendingRunId],
    pendingUserInput: {
      runId: pendingRunId,
      requestId,
      promptKind: overrides.promptKind ?? "plan_confirmation",
      summary: overrides.summary ?? `Confirm ${taskId}`,
      expiresAt: overrides.expiresAt ?? null,
      fixtureExempt: overrides.fixtureExempt ?? false,
      detail: overrides.detail ?? {},
      hilRequest: overrides.hilRequest ?? null,
      sequence: 1,
      timestamp: CREATED_AT,
    },
  };
}

function formalMappingTask(requestId: string): TaskProjection {
  const taskId = `task_${requestId}`;
  const runId = `run_${requestId}`;
  return taskWithPrompt(taskId, runId, runId, requestId, {
    promptKind: "data_correction",
    summary: `Review ${requestId}`,
    hilRequest: {
      schema_version: "1.0",
      request_id: requestId,
      task_id: taskId,
      run_id: runId,
      requirement_id: "build_1",
      kind: "semantic_review",
      review_type: "field_mapping",
      status: "pending",
      blocking: true,
      subject: { mapping_ids: [`map_${requestId}`] },
      review_items: [{
        item_id: `map_${requestId}`,
        summary: `Mapping ${requestId}`,
        subject: { mapping_ids: [`map_${requestId}`] },
        evidence: { source_field: requestId },
        proposed_value: "gene_id",
        confidence_level: "low",
      }],
      summary: `Review ${requestId}`,
      evidence_digest: "c".repeat(64),
      policy_ref: "dataset.field_mapping.v1",
      created_at: CREATED_AT,
      resolved_at: null,
    },
  });
}

describe("UserInputDialog", () => {
  it("renders a durable batch review and submits an evidence-bound decision", async () => {
    const onResumeRun = vi.fn().mockResolvedValue(undefined);
    const task = taskWithPrompt(
      "task_batch_review",
      "run_batch_review",
      "run_batch_review",
      "hil_batch_1",
      {
        promptKind: "data_correction",
        summary: "2 个字段映射需要审核",
        hilRequest: {
          schema_version: "1.0",
          request_id: "hil_batch_1",
          task_id: "task_batch_review",
          run_id: "run_batch_review",
          requirement_id: "build_1",
          kind: "semantic_review",
          review_type: "field_mapping",
          status: "pending",
          blocking: true,
          subject: { mapping_ids: ["map_gene", "map_unit"] },
          review_items: [
            {
              item_id: "map_gene",
              summary: "Gene Symbol → gene_id",
              subject: { mapping_ids: ["map_gene"] },
              evidence: { source_field: "Gene Symbol" },
              proposed_value: "gene_id",
              confidence_level: "low",
            },
            {
              item_id: "map_unit",
              summary: "Unit → expression_unit",
              subject: { mapping_ids: ["map_unit"] },
              evidence: { source_field: "Unit" },
              proposed_value: "expression_unit",
              confidence_level: "medium",
            },
          ],
          summary: "2 个字段映射需要审核",
          evidence_digest: "a".repeat(64),
          policy_ref: "dataset.field_mapping.v1",
          created_at: CREATED_AT,
          resolved_at: null,
        },
      },
    );
    render(<UserInputDialog task={task} onResumeRun={onResumeRun} />);

    expect(screen.getByText("需要人工审核")).toBeVisible();
    expect(screen.getByText("Gene Symbol → gene_id")).toBeVisible();
    expect(screen.getByText("Unit → expression_unit")).toBeVisible();
    expect(screen.getByText(/evidence aaaaaaaaaaaa/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "接受整个审核批次" }));

    await waitFor(() => expect(onResumeRun).toHaveBeenCalledWith(
      "task_batch_review",
      "run_batch_review",
      {
        request_id: "hil_batch_1",
        evidence_digest: "a".repeat(64),
        decision: { action: "accept" },
        reason: null,
      },
    ));
  });

  it("limits durable permission requests to approve or reject", async () => {
    const onResumeRun = vi.fn().mockResolvedValue(undefined);
    const task = taskWithPrompt(
      "task_permission",
      "run_permission",
      "run_permission",
      "hil_permission_1",
      {
        promptKind: "api_key_or_credential",
        summary: "允许本次调用使用 GDC API Key",
        hilRequest: {
          schema_version: "1.0",
          request_id: "hil_permission_1",
          task_id: "task_permission",
          run_id: "run_permission",
          requirement_id: null,
          kind: "permission",
          review_type: null,
          status: "pending",
          blocking: true,
          subject: { binding_id: "gdc" },
          review_items: [],
          summary: "允许本次调用使用 GDC API Key",
          evidence_digest: "b".repeat(64),
          policy_ref: "runtime.credentials.v1",
          created_at: CREATED_AT,
          resolved_at: null,
        },
      },
    );
    render(<UserInputDialog task={task} onResumeRun={onResumeRun} />);

    expect(screen.getByText("需要凭据授权")).toBeVisible();
    expect(screen.getByRole("button", { name: "授权本次调用" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "修正整个审核批次" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "跳过整个审核批次" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "授权本次调用" }));

    await waitFor(() => expect(onResumeRun).toHaveBeenCalledWith(
      "task_permission",
      "run_permission",
      {
        request_id: "hil_permission_1",
        evidence_digest: "b".repeat(64),
        decision: { action: "approve" },
        reason: null,
      },
    ));
  });

  it("resets batch action and correction JSON when the formal request changes", async () => {
    const onResumeRun = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <UserInputDialog task={formalMappingTask("hil_a")} onResumeRun={onResumeRun} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "修正" }));
    fireEvent.change(screen.getByLabelText("结构化修正（JSON）"), {
      target: { value: '{"mappings":{"map_hil_a":{"target_field":"gene_symbol"}}}' },
    });
    expect(screen.getByDisplayValue(/map_hil_a/)).toBeInTheDocument();

    await act(async () => {
      rerender(
        <UserInputDialog task={formalMappingTask("hil_b")} onResumeRun={onResumeRun} />,
      );
    });

    expect(screen.getByText("Mapping hil_b")).toBeInTheDocument();
    expect(screen.queryByLabelText("结构化修正（JSON）")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "接受整个审核批次" })).toBeEnabled();
  });

  it("closes the dialog when the owning run is cancel-requested (F3 reducer path)", () => {
    let state = mergeTaskPage(
      createInitialRuntimeState(),
      {
        active_items: [
          {
            task_id: "task_cancel",
            mode: "agent",
            databases: [],
            title: "Cancel",
            status: "awaiting_user_input",
            active_run_id: "run_cancel",
            created_at: CREATED_AT,
            updated_at: CREATED_AT,
            latest_sequence: 0,
          },
        ],
        items: [],
        next_cursor: null,
      },
      false,
    );
    state = reduceRuntimeEvent(
      state,
      {
        schema_version: "2.0",
        event_id: "event_cancel_1",
        type: "user_input_required",
        task_id: "task_cancel",
        run_id: "run_cancel",
        stage_attempt_id: null,
        sequence: 1,
        timestamp: CREATED_AT,
        payload: {
          type: "user_input_required",
          request_id: "request_cancel",
          prompt_kind: "data_correction",
          summary: "请修正数据源",
          expires_at: null,
          fixture_exempt: false,
          detail: {},
        },
      },
    );
    state = reduceRuntimeEvent(
      state,
      {
        schema_version: "2.0",
        event_id: "event_cancel_2",
        type: "run_cancel_requested",
        task_id: "task_cancel",
        run_id: "run_cancel",
        stage_attempt_id: null,
        sequence: 2,
        timestamp: CREATED_AT,
        payload: { type: "run_cancel_requested", reason: "user cancelled" },
      },
    );
    const task = state.tasksById.task_cancel;
    expect(task.pendingUserInput).toBeNull();

    render(<UserInputDialog task={task} onResumeRun={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "提交修正" })).not.toBeInTheDocument();
  });

  it("disables actions while the prompt's run is no longer awaiting input (F3 defensive)", () => {
    const task = taskWithPrompt(
      "task_stale",
      "run_stale",
      "run_stale",
      "request_stale",
      { promptKind: "data_correction", summary: "请修正" },
    );
    const staleRun: TaskProjection["runsById"][string] = {
      runId: "run_stale",
      taskId: "task_stale",
      requestId: "request_stale",
      status: "cancel_requested",
      input: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      startedAt: null,
      finishedAt: null,
      error: null,
      summary: null,
    };
    render(
      <UserInputDialog
        task={{
          ...task,
          runsById: { run_stale: staleRun },
        }}
        onResumeRun={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "提交修正" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "跳过并继续" })).toBeDisabled();
  });

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
      // FIX 3: after a SUCCESSFUL resume the in-flight decision is retained
      // while the same prompt stays pending — buttons stay disabled instead
      // of briefly re-enabling before user_input_resumed arrives.
      expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
    });
    expect(onResumeRun).toHaveBeenCalledTimes(2);

    // The in-flight state clears only with the prompt lifecycle: removing the
    // prompt (pendingUserInput -> null) resets the submission; re-showing the
    // same prompt starts fresh and re-enables the buttons.
    const noPromptSummary: TaskSummary = {
      task_id: "task_a",
      mode: "agent",
      databases: [],
      title: "Task task_a",
      status: "running",
      active_run_id: "run_a",
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      latest_sequence: 1,
    };
    rerender(
      <UserInputDialog
        task={createTaskProjection(noPromptSummary)}
        onResumeRun={onResumeRun}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "确认执行" })).not.toBeInTheDocument();
    });
    rerender(<UserInputDialog task={taskA} onResumeRun={onResumeRun} />);
    expect(screen.getByRole("button", { name: "确认执行" })).toBeEnabled();
  });

  it("retains the in-flight decision while the same prompt stays pending (FIX 3)", async () => {
    // Regression (final review FIX 3): after an accepted resumeRun returns,
    // the dialog used to clear pendingDecision even though the snapshot may
    // still report awaiting_user_input — the buttons briefly re-enabled and a
    // second click was rejected by the backend submitter. The in-flight
    // decision must be retained while the SAME prompt remains pending and
    // cleared only when the prompt disappears (promptKey reset effect).
    const onResumeRun = vi.fn<
      (
        taskId: string,
        runId: string,
        input: ResumeRunInput,
      ) => Promise<void>
    >();
    onResumeRun.mockResolvedValue(undefined);
    const task = taskWithPrompt(
      "task_inflight",
      "run_inflight",
      "run_inflight",
      "request_inflight",
      {
        promptKind: "data_correction",
        summary: "请修正数据源",
      },
    );

    const { rerender } = render(
      <UserInputDialog task={task} onResumeRun={onResumeRun} />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "改用 GSE12345" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交修正" }));
    expect(screen.getByRole("button", { name: "提交修正" })).toBeDisabled();

    // resumeRun resolves (the manager returned its snapshot as-is), but the
    // prompt is STILL pending: the dialog must stay in-flight — both buttons
    // remain disabled and the spinner stays.
    await waitFor(() => expect(onResumeRun).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "提交修正" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "跳过并继续" })).toBeDisabled();

    // The prompt disappears (reducer processed user_input_resumed): the
    // dialog closes and nothing in-flight leaks.
    const noPromptSummary: TaskSummary = {
      task_id: "task_inflight",
      mode: "agent",
      databases: [],
      title: "Task task_inflight",
      status: "running",
      active_run_id: "run_inflight",
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      latest_sequence: 1,
    };
    rerender(
      <UserInputDialog
        task={createTaskProjection(noPromptSummary)}
        onResumeRun={onResumeRun}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "提交修正" })).not.toBeInTheDocument();
    });

    // Re-showing the same prompt starts fresh: the retained in-flight state
    // was cleared with the prompt lifecycle.
    rerender(<UserInputDialog task={task} onResumeRun={onResumeRun} />);
    expect(screen.getByRole("button", { name: "提交修正" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "跳过并继续" })).toBeEnabled();
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
    // T5 polish: summary 仅渲染一次(卡片突出展示;描述不再重复)。
    expect(
      screen.getAllByText("候选 GSE 无法判断，请确认使用哪个数据集？"),
    ).toHaveLength(1);
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
    const { rerender } = render(
      <UserInputDialog task={task} onResumeRun={onResumeRun} />,
    );

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

    // FIX 3: after a successful resume the SAME prompt stays in-flight — both
    // buttons stay disabled until the prompt disappears (user_input_resumed).
    expect(screen.getByRole("button", { name: "提交修正" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "跳过并继续" })).toBeDisabled();

    // A second decision needs a fresh prompt lifecycle: remove the prompt and
    // re-show it (the promptKey reset effect clears the in-flight state).
    const noPromptSummary: TaskSummary = {
      task_id: "task_correction",
      mode: "agent",
      databases: [],
      title: "Task task_correction",
      status: "running",
      active_run_id: "run_correction",
      created_at: CREATED_AT,
      updated_at: CREATED_AT,
      latest_sequence: 1,
    };
    rerender(
      <UserInputDialog
        task={createTaskProjection(noPromptSummary)}
        onResumeRun={onResumeRun}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "跳过并继续" })).not.toBeInTheDocument();
    });
    rerender(<UserInputDialog task={task} onResumeRun={onResumeRun} />);

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
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
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

  it("clears the correction text when the prompt kind changes with the same task/run/request ids", () => {
    // Regression (T4 review): the reset effect was keyed only on taskId/runId/requestId,
    // so a promptKind switch with identical ids kept the previous correction text and
    // leaked it back into the next data_correction prompt.
    const correctionTask = taskWithPrompt(
      "task_same",
      "run_same",
      "run_same",
      "request_same",
      {
        promptKind: "data_correction",
        summary: "请修正检索词",
      },
    );
    const noProgressTask = taskWithPrompt(
      "task_same",
      "run_same",
      "run_same",
      "request_same",
      {
        promptKind: "no_progress",
        summary: "检测到无进展",
      },
    );

    const { rerender } = render(
      <UserInputDialog task={correctionTask} onResumeRun={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "改用 GEO 数据 GSE12345" },
    });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "改用 GEO 数据 GSE12345",
    );

    // Same task/run/request ids, different prompt kind → no textarea rendered.
    rerender(<UserInputDialog task={noProgressTask} onResumeRun={vi.fn()} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    // Back to data_correction with the same ids: stale text must NOT leak back.
    rerender(<UserInputDialog task={correctionTask} onResumeRun={vi.fn()} />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("clears the correction text when a same-kind prompt arrives with a new request id", () => {    // Guards the existing reset behavior: a new data_correction request id still
    // resets the textarea even when task/run ids are unchanged.
    const requestATask = taskWithPrompt(
      "task_reset",
      "run_reset",
      "run_reset",
      "request_a",
      {
        promptKind: "data_correction",
        summary: "请修正数据源",
      },
    );
    const requestBTask = taskWithPrompt(
      "task_reset",
      "run_reset",
      "run_reset",
      "request_b",
      {
        promptKind: "data_correction",
        summary: "请修正数据源",
      },
    );

    const { rerender } = render(
      <UserInputDialog task={requestATask} onResumeRun={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "GSE12345" },
    });

    rerender(<UserInputDialog task={requestBTask} onResumeRun={vi.fn()} />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("uses prompt-kind-aware wording for the fixture-exempt alert", () => {
    // T5 polish: the fixtureExempt Alert previously always used plan-
    // confirmation wording even for data_correction prompts.
    const correctionTask = taskWithPrompt(
      "task_fixture_correction",
      "run_fixture_correction",
      "run_fixture_correction",
      "request_fixture_correction",
      {
        promptKind: "data_correction",
        summary: "请修正数据源",
        fixtureExempt: true,
      },
    );
    const planTask = taskWithPrompt(
      "task_fixture_plan",
      "run_fixture_plan",
      "run_fixture_plan",
      "request_fixture_plan",
      { fixtureExempt: true },
    );

    const { rerender } = render(
      <UserInputDialog task={correctionTask} onResumeRun={vi.fn()} />,
    );
    expect(
      screen.getByText(
        "当前为固定验收模式，仅供查看修正请求，提交修正仅触发流程继续。",
      ),
    ).toBeVisible();
    // 其他分支(plan_confirmation 等)保留原有计划语义文案
    rerender(<UserInputDialog task={planTask} onResumeRun={vi.fn()} />);
    expect(
      screen.getByText(
        "当前为固定验收模式，仅供查看计划，确认按钮仅触发流程继续。",
      ),
    ).toBeVisible();
  });

  it("suppresses an old data_correction submission error after a prompt-kind switch", async () => {
    // T5 (T4 re-review residual): same task/run/request ids, prompt kind flips
    // data_correction → no_progress while the first resume is in flight; the
    // OLD onResumeRun rejection must not surface on the new prompt (the
    // runtime-level twin of the T4 promptKey fix).
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
    const correctionTask = taskWithPrompt(
      "task_same",
      "run_same",
      "run_same",
      "request_same",
      {
        promptKind: "data_correction",
        summary: "请修正检索词",
      },
    );
    const noProgressTask = taskWithPrompt(
      "task_same",
      "run_same",
      "run_same",
      "request_same",
      {
        promptKind: "no_progress",
        summary: "检测到无进展",
      },
    );

    const { rerender } = render(
      <UserInputDialog task={correctionTask} onResumeRun={onResumeRun} />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "改用 GEO 数据 GSE12345" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交修正" }));
    expect(screen.getByRole("button", { name: "提交修正" })).toBeDisabled();

    // Same task/run/request ids, different prompt kind → new promptKey.
    rerender(
      <UserInputDialog task={noProgressTask} onResumeRun={onResumeRun} />,
    );
    expect(screen.getByRole("button", { name: "继续工作" })).toBeEnabled();

    // The OLD data_correction resume fails: the error is keyed to the old
    // prompt and must NOT appear on the no_progress prompt.
    act(() => rejectFirst?.(new Error("old correction resume failed")));
    await waitFor(() => {
      expect(screen.queryByText("old correction resume failed")).toBeNull();
      expect(screen.getByRole("button", { name: "继续工作" })).toBeEnabled();
    });
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

  it("renders an expired state with disabled actions once the deadline has passed (F5)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T00:10:00Z"));
    const task = taskWithPrompt(
      "task_expired",
      "run_expired",
      "run_expired",
      "request_expired",
      {
        promptKind: "data_correction",
        summary: "请尽快修正数据源",
        expiresAt: "2026-07-14T00:09:59Z",
      },
    );

    render(<UserInputDialog task={task} onResumeRun={vi.fn()} />);

    expect(screen.getByText(/已超时/)).toBeVisible();
    expect(screen.queryByText(/需在 .*前答复/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "提交修正" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "跳过并继续" })).toBeDisabled();
    vi.useRealTimers();
  });

  it("re-evaluates expiry while the dialog stays mounted (F3)", () => {
    vi.useFakeTimers();
    const now = new Date("2026-07-14T00:10:00Z");
    vi.setSystemTime(now);
    const task = taskWithPrompt(
      "task_live_expiry",
      "run_live_expiry",
      "run_live_expiry",
      "request_live_expiry",
      {
        promptKind: "data_correction",
        summary: "请尽快修正数据源",
        expiresAt: new Date(now.getTime() + 2_000).toISOString(),
      },
    );

    render(<UserInputDialog task={task} onResumeRun={vi.fn()} />);

    // Deadline is 2s away: actions enabled, no expired state yet.
    expect(screen.queryByText(/已超时/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跳过并继续" })).toBeEnabled();

    // Cross the deadline while the dialog stays mounted: an interval tick
    // must re-render and flip to the expired state, disabling the actions.
    act(() => {
      vi.advanceTimersByTime(3_000);
    });

    expect(screen.getByText(/已超时/)).toBeVisible();
    expect(screen.queryByText(/需在 .*前答复/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跳过并继续" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "提交修正" })).toBeDisabled();
    vi.useRealTimers();
  });

  it("keeps actions enabled for a future deadline and treats an invalid deadline as expired (F5)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T00:10:00Z"));
    const futureTask = taskWithPrompt(
      "task_future",
      "run_future",
      "run_future",
      "request_future",
      {
        promptKind: "data_correction",
        summary: "请尽快修正数据源",
        expiresAt: "2026-07-14T00:11:00Z",
      },
    );
    const invalidTask = taskWithPrompt(
      "task_invalid",
      "run_invalid",
      "run_invalid",
      "request_invalid",
      {
        promptKind: "data_correction",
        summary: "请尽快修正数据源",
        expiresAt: "not-a-date",
      },
    );

    const { rerender } = render(
      <UserInputDialog task={futureTask} onResumeRun={vi.fn()} />,
    );
    expect(screen.queryByText(/已超时/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "跳过并继续" })).toBeEnabled();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "改用 GEO 数据" },
    });
    expect(screen.getByRole("button", { name: "提交修正" })).toBeEnabled();

    rerender(<UserInputDialog task={invalidTask} onResumeRun={vi.fn()} />);
    expect(screen.getByText(/已超时/)).toBeVisible();
    expect(screen.getByRole("button", { name: "提交修正" })).toBeDisabled();
    vi.useRealTimers();
  });
});
