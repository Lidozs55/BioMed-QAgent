import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ToolCallStep } from "@/components/conversation/ToolCallStep";
import type { DownloadControl, ToolCallItem } from "@/runtime/types";

const TIMESTAMP = "2026-07-20T00:00:00Z";

function makeToolCall(overrides: Partial<ToolCallItem>): ToolCallItem {
  return {
    itemId: "tool-call-1",
    runId: "run-1",
    sequence: 1,
    createdAt: TIMESTAMP,
    kind: "tool_call",
    toolCallId: "call-1",
    toolName: "search_pubmed_adapter",
    arguments: { query: "lung cancer" },
    status: "completed",
    output: "search completed",
    completedSequence: 2,
    ...overrides,
  };
}

describe("ToolCallStep", () => {
  it("renders the formatted label from formatToolCall", () => {
    render(<ToolCallStep item={makeToolCall({})} />);
    expect(screen.getByText(/检索\s+PubMed/)).toBeInTheDocument();
    expect(screen.getByText(/lung cancer/)).toBeInTheDocument();
  });

  it("shows spinner icon when status is running", () => {
    render(<ToolCallStep item={makeToolCall({ status: "running" })} />);
    expect(document.querySelector('[data-slot="spinner"]')).not.toBeNull();
  });

  it("shows check icon when status is completed", () => {
    render(<ToolCallStep item={makeToolCall({ status: "completed" })} />);
    expect(document.querySelector('[data-slot="spinner"]')).toBeNull();
  });

  it("shows warning icon when status is error", () => {
    render(
      <ToolCallStep
        item={makeToolCall({ status: "error", output: "boom" })}
      />,
    );
    expect(document.querySelector('[data-slot="spinner"]')).toBeNull();
  });

  it("starts collapsed and does not show arguments/output", () => {
    render(<ToolCallStep item={makeToolCall({})} />);
    expect(screen.queryByText("输入参数")).not.toBeInTheDocument();
    expect(screen.queryByText("输出")).not.toBeInTheDocument();
  });

  it("expands on click to reveal arguments and output", () => {
    render(<ToolCallStep item={makeToolCall({})} />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    expect(screen.getByText("输入参数")).toBeInTheDocument();
    expect(screen.getByText("输出")).toBeInTheDocument();
    expect(screen.getByText(/"query": "lung cancer"/)).toBeInTheDocument();
    expect(screen.getByText("search completed")).toBeInTheDocument();
  });

  it("collapses again on second click", () => {
    render(<ToolCallStep item={makeToolCall({})} />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.queryByText("输入参数")).not.toBeInTheDocument();
    expect(screen.queryByText("输出")).not.toBeInTheDocument();
  });

  it("renders error output with destructive background when status is error", () => {
    render(
      <ToolCallStep
        item={makeToolCall({
          status: "error",
          output: "PRIVATE_ERROR",
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("输出（错误）")).toBeInTheDocument();
    expect(screen.getByText("PRIVATE_ERROR")).toBeInTheDocument();
  });

  it("falls back to '调用 {toolName}' for unknown tools", () => {
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "mystery_tool",
          arguments: null,
          output: null,
        })}
      />,
    );
    expect(screen.getByText(/调用\s+mystery_tool/)).toBeInTheDocument();
  });

  it("does not render arguments section when arguments is null", () => {
    render(
      <ToolCallStep
        item={makeToolCall({ arguments: null, output: "ok" })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("输入参数")).not.toBeInTheDocument();
    expect(screen.getByText("输出")).toBeInTheDocument();
  });

  it("does not render output section when output is null", () => {
    render(
      <ToolCallStep
        item={makeToolCall({ output: null, arguments: { a: 1 } })}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText("输出")).not.toBeInTheDocument();
    expect(screen.getByText("输入参数")).toBeInTheDocument();
  });
  it("renders retired gateway tool names through the default label fallback", () => {
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "find_skill",
          arguments: { text: "网页截图" },
          output: null,
        })}
      />,
    );
    expect(screen.getByText("调用 find_skill")).toBeInTheDocument();
  });

  it("renders a direct data-source tool with its mapped label", () => {
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "search_geo",
          arguments: { query: "METTL5" },
          output: null,
        })}
      />,
    );
    expect(screen.getByText(/检索\s+GEO/)).toBeInTheDocument();
    expect(screen.getByText(/METTL5/)).toBeInTheDocument();
  });
});

describe("ToolCallStep download progress", () => {
  function downloadToolCall(
    current: number,
    total: number,
    updatedAt = TIMESTAMP,
    status: ToolCallItem["status"] = "running",
  ): ToolCallItem {
    return makeToolCall({
      toolName: "download_xena",
      arguments: { dataset_id: "TCGA.BRCA.sampleMap/HiSeqV2" },
      status,
      progress: {
        kind: "downloaded_bytes",
        current,
        total,
        detail: { filename: "TCGA.BRCA.sampleMap.HiSeqV2.gz" },
        updatedAt,
      },
    });
  }

  it("renders a live progress strip inside the tool-call bubble", () => {
    render(<ToolCallStep item={downloadToolCall(3_411_477, 1_642_160_120)} />);
    expect(screen.getByTestId("download-percent")).toHaveTextContent("0.2%");
    expect(screen.getByText("3.3 MB / 1.53 GB")).toBeInTheDocument();
  });

  it("shows pause while running and calls onPause", () => {
    const onPause = vi.fn();
    const control: DownloadControl = {
      taskId: "task-1",
      onPause,
      onResume: vi.fn(),
    };
    render(
      <ToolCallStep
        item={downloadToolCall(1024, 4096, new Date().toISOString())}
        downloadControl={control}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(onPause).toHaveBeenCalledWith("task-1");
  });

  it("switches to resume once the tool call stops and calls onResume", () => {
    const onResume = vi.fn();
    const control: DownloadControl = {
      taskId: "task-1",
      onPause: vi.fn(),
      onResume,
    };
    render(
      <ToolCallStep
        item={downloadToolCall(3_411_477, 1_642_160_120, TIMESTAMP, "error")}
        downloadControl={control}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "恢复下载" }));
    expect(onResume).toHaveBeenCalledWith("task-1", {
      runId: "run-1",
      toolCallId: "call-1",
      toolName: "download_xena",
      arguments: { dataset_id: "TCGA.BRCA.sampleMap/HiSeqV2" },
    });
  });

  it("expands to reveal speed, ETA and the filename", () => {
    const first = downloadToolCall(3_000, 10_000, "2026-07-20T00:00:01Z");
    const { rerender } = render(<ToolCallStep item={first} />);
    const second = downloadToolCall(5_000, 10_000, "2026-07-20T00:00:02Z");
    rerender(<ToolCallStep item={second} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("download-speed")).toHaveTextContent("2.0 KB/s");
    expect(screen.getByTestId("download-eta")).toHaveTextContent(
      "剩余 约 3 秒",
    );
    expect(
      screen.getByText("TCGA.BRCA.sampleMap.HiSeqV2.gz"),
    ).toBeInTheDocument();
  });
});
