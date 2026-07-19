import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@/components/ChatPanel";
import type { EventPayload } from "@/runtime/contracts";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

const TIMESTAMP = "2026-07-18T00:00:00Z";

function seedTask(): void {
  useAgentStore.getState().mergeTaskPage(
    {
      active_items: [
        {
          task_id: "task_summary",
          mode: "agent",
          databases: [],
          title: "Summary",
          status: "running",
          active_run_id: "run_summary",
          created_at: TIMESTAMP,
          updated_at: TIMESTAMP,
          latest_sequence: 0,
        },
      ],
      items: [],
      next_cursor: null,
    },
    false,
  );
  useAgentStore.getState().setActiveTaskId("task_summary");
}

let sequence = 0;

function apply(payload: EventPayload, stageAttemptId: string | null = null): void {
  sequence += 1;
  useAgentStore.getState().applyEvent({
    schema_version: "2.0",
    event_id: `event_${sequence}`,
    type: payload.type,
    task_id: "task_summary",
    run_id: "run_summary",
    stage_attempt_id: stageAttemptId,
    sequence,
    timestamp: TIMESTAMP,
    payload,
  });
}

function seedActivities(includeAssistant = true): void {
  apply({
    type: "tool_started",
    tool_call_id: "call_search",
    tool_name: "search_pubmed",
  });
  apply({
    type: "tool_completed",
    tool_call_id: "call_search",
    tool_name: "search_pubmed",
    output: "RAW_TOOL_OUTPUT_DO_NOT_SHOW_IN_SUMMARY",
    is_error: false,
  });
  apply(
    { type: "stage_started", stage: "validation", attempt: 1 },
    "attempt_validation",
  );
  apply(
    {
      type: "stage_completed",
      stage: "validation",
      status: "succeeded",
      output_digest: "a".repeat(64),
    },
    "attempt_validation",
  );
  apply({
    type: "stage_progress",
    stage: "acquisition",
    kind: "downloaded_bytes",
    current: 2048,
    total: 4096,
    detail: { signed_url: "ARBITRARY_PROGRESS_DETAIL" },
  });
  apply({
    type: "stage_progress",
    stage: "processing",
    kind: "unknown_metric",
    current: 7,
    total: null,
    detail: { reasoning: "HIDDEN_REASONING" },
  });
  apply({
    type: "warning",
    code: "partial_results",
    message: "部分记录不可用",
  });
  if (includeAssistant) {
    apply({ type: "assistant_delta", delta: "结果正在生成" });
  }
}

describe("execution summary", () => {
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
    sequence = 0;
    useAgentStore.setState({
      ...createInitialRuntimeState(),
      connectionStatus: "connected",
    });
    seedTask();
  });

  it("renders safe tool, stage, progress, and warning labels without raw detail", () => {
    seedActivities();
    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    const trigger = screen.getByRole("button", { name: /执行摘要/ });
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const summary = trigger.closest('[data-execution-summary="true"]');
    expect(summary).not.toBeNull();
    const scoped = within(summary as HTMLElement);
    expect(scoped.getByText("search_pubmed")).toBeInTheDocument();
    expect(scoped.getByText("工具完成")).toBeInTheDocument();
    expect(scoped.getByText("结果验证")).toBeInTheDocument();
    expect(scoped.getByText("验证通过")).toBeInTheDocument();
    expect(scoped.getByText(/已下载.*2\.0 KB.*4\.0 KB/)).toBeInTheDocument();
    expect(scoped.getByText(/进度值.*7/)).toBeInTheDocument();
    expect(scoped.getByText(/partial_results.*部分记录不可用/)).toBeInTheDocument();
    expect(summary).not.toHaveTextContent("RAW_TOOL_OUTPUT_DO_NOT_SHOW_IN_SUMMARY");
    expect(summary).not.toHaveTextContent("ARBITRARY_PROGRESS_DETAIL");
    expect(summary).not.toHaveTextContent("HIDDEN_REASONING");
    expect(summary).not.toHaveTextContent("unknown_metric");

  });

  it("initially collapses a historical run summary", () => {
    seedActivities();
    apply({ type: "run_completed" });

    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.getByRole("button", { name: /执行摘要/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("shows running and error tool states without exposing their output", () => {
    apply({
      type: "tool_started",
      tool_call_id: "call_running",
      tool_name: "download_records",
    });
    apply({
      type: "tool_started",
      tool_call_id: "call_error",
      tool_name: "parse_records",
    });
    apply({
      type: "tool_completed",
      tool_call_id: "call_error",
      tool_name: "parse_records",
      output: "PRIVATE_ERROR_OUTPUT",
      is_error: true,
    });
    apply({ type: "assistant_delta", delta: "处理中" });

    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.getByText("工具运行中")).toHaveAttribute(
      "data-variant",
      "secondary",
    );
    expect(screen.getByText("工具错误")).toHaveAttribute(
      "data-variant",
      "destructive",
    );
    expect(screen.getByText("执行摘要", { exact: false }).closest('[data-execution-summary="true"]'))
      .not.toHaveTextContent("PRIVATE_ERROR_OUTPUT");
  });

  it("marks a failed validation stage as destructive", () => {
    apply(
      { type: "stage_started", stage: "validation", attempt: 1 },
      "attempt_validation",
    );
    apply(
      {
        type: "stage_failed",
        stage: "validation",
        status: "failed",
        error: {
          code: "validation_failed",
          message: "private validation detail",
          retryable: false,
          stage: "validation",
          details: {},
        },
      },
      "attempt_validation",
    );
    apply({ type: "assistant_delta", delta: "验证未通过" });

    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    const failed = screen.getByText("验证失败");
    expect(failed).toHaveAttribute("data-variant", "destructive");
    expect(screen.getByText("执行摘要", { exact: false }).closest('[data-execution-summary="true"]'))
      .not.toHaveTextContent("private validation detail");
  });

  it("does not reset the user's open state when progress updates in place", () => {
    seedActivities();
    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);
    const trigger = screen.getByRole("button", { name: /执行摘要/ });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    act(() => {
      apply({
        type: "stage_progress",
        stage: "acquisition",
        kind: "downloaded_bytes",
        current: 3072,
        total: 4096,
        detail: {},
      });
    });

    expect(screen.getByRole("button", { name: /执行摘要/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("moves one summary from the active status row into the assistant response", () => {
    seedActivities(false);
    render(<ChatPanel startTask={vi.fn()} continueTask={vi.fn()} />);

    expect(screen.getAllByRole("button", { name: /执行摘要/ })).toHaveLength(1);
    expect(screen.getByText("正在处理请求…")).toBeInTheDocument();

    act(() => apply({ type: "assistant_delta", delta: "现在有文本" }));

    expect(screen.getAllByRole("button", { name: /执行摘要/ })).toHaveLength(1);
    expect(screen.queryByText("正在处理请求…")).not.toBeInTheDocument();
    expect(screen.getByText("现在有文本")).toBeInTheDocument();
  });
});
