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
    // JsonBlock 高亮会把行拆进多个 span,用 textContent 断言整行。
    expect(screen.getByTestId("json-block").textContent).toContain(
      '"query": "lung cancer"',
    );
    expect(screen.getByText("search completed")).toBeInTheDocument();
  });

  it("collapses again on second click", () => {
    render(<ToolCallStep item={makeToolCall({})} />);
    const trigger = () => screen.getByRole("button", { name: /检索/ });
    fireEvent.click(trigger());
    fireEvent.click(trigger());
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

describe("ToolCallStep dedicated renderers", () => {
  it("dispatches workspace_write to FileWriteTool (server sandbox tool name)", () => {
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "workspace_write",
          arguments: { path: "hello.py", content: "print(1)\nprint(2)" },
          output: "ok",
        })}
      />,
    );
    expect(screen.getByText("hello.py")).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /hello\.py/ }));
    expect(screen.getAllByText("+", { selector: "span[aria-hidden='true']" })).toHaveLength(2);
  });

  it("dispatches workspace_exec to BashTool with executable + args command", () => {
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "workspace_exec",
          arguments: {
            executable: "C:\\Program Files\\Python313\\python.exe",
            args: ["hello.py"],
          },
          output: "Hello, World!",
        })}
      />,
    );
    expect(
      screen.getByText(/python\.exe hello\.py/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /python\.exe/ }));
    expect(screen.getByText("Hello, World!")).toBeInTheDocument();
  });

  it("shows unwrapped exec stdout instead of the JSON envelope", () => {
    const envelope = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ exitCode: 0, stdout: "Modified\n", stderr: "" }) }],
      details: { command: ["python", "hello.py"], exitCode: 0, stdout: "Modified\n", stderr: "" },
    });
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "workspace_exec",
          arguments: { executable: "python", args: ["hello.py"] },
          output: envelope,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /python hello\.py/ }));
    expect(screen.getByText(/Modified/)).toBeInTheDocument();
    expect(screen.queryByText(/"details"/)).not.toBeInTheDocument();
  });

  it("shows an error message instead of the diff for a failed edit", () => {
    const envelope = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ code: "PRECONDITION_FAILED", message: "expectedOccurrences is required" }) }],
      details: { code: "PRECONDITION_FAILED", message: "expectedOccurrences is required" },
    });
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "workspace_edit",
          status: "error",
          arguments: { path: "hello.py", oldText: "a", newText: "b" },
          output: envelope,
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /hello\.py/ }));
    expect(screen.queryByText("+", { selector: "span[aria-hidden='true']" })).not.toBeInTheDocument();
    expect(
      screen.getByText("PRECONDITION_FAILED: expectedOccurrences is required"),
    ).toBeInTheDocument();
  });

  it("shows workspace_read text content with a character-count badge", () => {
    const envelope = JSON.stringify({
      content: [{ type: "text", text: JSON.stringify({ path: "hello.py", text: 'print("Hello, World!")\n', offset: 0, characters: 23, truncated: false }) }],
      details: { path: "hello.py", text: 'print("Hello, World!")\n', offset: 0, characters: 23, truncated: false },
    });
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "workspace_read",
          arguments: { path: "hello.py" },
          output: envelope,
        })}
      />,
    );
    expect(screen.getByText("23 字符")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /hello\.py/ }));
    expect(screen.getByText(/print\("Hello, World!"\)/)).toBeInTheDocument();
    expect(screen.queryByText(/"details"/)).not.toBeInTheDocument();
  });

  it("dispatches read to FileReadTool with path title and line range badge", () => {
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "read",
          arguments: { path: "src/lib/utils.ts" },
          output: "line1\nline2\nline3",
        })}
      />,
    );
    expect(screen.getByText("src/lib/utils.ts")).toBeInTheDocument();
    expect(screen.getByText("L1–L3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /utils\.ts/ }));
    // pre 文本经 testing-library 归一化后换行折叠为空格,用正则匹配。
    expect(screen.getByText(/line1\s+line2\s+line3/)).toBeInTheDocument();
  });

  it("dispatches write to FileWriteTool with added-line count and green view", () => {
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "write",
          arguments: { path: "docs/notes.md", content: "alpha\nbeta" },
          output: "ok",
        })}
      />,
    );
    expect(screen.getByText("docs/notes.md")).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /notes\.md/ }));
    expect(screen.getAllByText("+", { selector: "span[aria-hidden='true']" })).toHaveLength(2);
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });

  it("dispatches edit to FileEditTool with ±badge and diff rows", () => {
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "edit",
          arguments: { path: "src/a.ts", oldText: "const a = 1;", newText: "const a = 2;\nconst b = 3;" },
          output: "edited",
        })}
      />,
    );
    expect(screen.getByText("src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /a\.ts/ }));
    const removed = screen.getByText("const a = 1;").closest("[class*='border-l-destructive']");
    expect(removed).not.toBeNull();
    expect(screen.getByText("const a = 2;").closest("[class*='border-l-success']")).not.toBeNull();
  });

  it("dispatches bash to BashTool with first-line title and terminal block", () => {
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "bash",
          arguments: { command: "pnpm test\n--coverage" },
          output: "all good",
        })}
      />,
    );
    expect(screen.getByText("pnpm test")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /pnpm test/ }));
    expect(screen.getByText(/--coverage/)).toBeInTheDocument();
    expect(screen.getByText("all good")).toBeInTheDocument();
    expect(screen.getByText("$", { selector: "span.select-none" })).toBeInTheDocument();
  });

  it("keeps non-builtin tools on the generic path", () => {
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "grep",
          arguments: { pattern: "EGFR" },
          output: null,
        })}
      />,
    );
    expect(screen.getByText(/搜索/)).toBeInTheDocument();
    expect(screen.getByText(/EGFR/)).toBeInTheDocument();
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

  it("collapses the progress strip once the download completes and reveals it on expand", () => {
    const completed = downloadToolCall(1_642_160_120, 1_642_160_120, TIMESTAMP, "completed");
    render(<ToolCallStep item={completed} />);
    expect(screen.queryByTestId("download-percent")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByTestId("download-percent")).toHaveTextContent("100.0%");
    expect(screen.getByText(/1\.53 GB/)).toBeInTheDocument();
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
