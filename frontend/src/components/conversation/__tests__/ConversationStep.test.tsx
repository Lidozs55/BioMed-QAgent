import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConversationStep } from "@/components/conversation/ConversationStep";
import type { ConversationItem } from "@/runtime/types";

vi.mock("@/components/MarkdownContent", () => ({
  MarkdownContent: ({ content, streaming }: { content: string; streaming?: boolean }) => (
    <div data-testid="markdown-content" data-streaming={streaming ? "true" : "false"}>
      {content}
    </div>
  ),
}));

const TIMESTAMP = "2026-07-20T00:00:00Z";

function makeItem(partial: Partial<ConversationItem> & { kind: ConversationItem["kind"] }): ConversationItem {
  return {
    itemId: `item-${partial.kind}`,
    runId: "run-1",
    sequence: 1,
    createdAt: TIMESTAMP,
    ...partial,
  } as ConversationItem;
}

describe("ConversationStep dispatcher", () => {
  it("renders user_message items via UserMessageBubble", () => {
    const item = makeItem({
      kind: "user_message",
      content: "你好，请帮我查文献",
    });
    render(<ConversationStep item={item} isActive={false} />);
    expect(screen.getByText("你好，请帮我查文献")).toBeInTheDocument();
  });

  it("renders assistant_segment items via AssistantSegment", () => {
    const item = makeItem({
      kind: "assistant_segment",
      streamId: "assistant:run-1:0",
      content: "正在为您检索文献。",
      isStreaming: false,
      finishReason: null,
    });
    render(<ConversationStep item={item} isActive={false} />);
    expect(screen.getByTestId("markdown-content")).toHaveTextContent(
      "正在为您检索文献。",
    );
  });

  it("renders reasoning items via ReasoningBlock (collapsed by default)", () => {
    const item = makeItem({
      kind: "reasoning",
      content: "先分析用户意图。",
      isStreaming: false,
    });
    render(<ConversationStep item={item} isActive={false} />);
    expect(screen.getByText("思维链")).toBeInTheDocument();
    expect(screen.queryByText("先分析用户意图。")).not.toBeInTheDocument();
  });

  it("renders tool_call items via ToolCallStep with formatted label", () => {
    const item = makeItem({
      kind: "tool_call",
      toolCallId: "call-1",
      toolName: "search_pubmed_adapter",
      arguments: { query: "lung cancer" },
      status: "completed",
      output: "ok",
      completedSequence: 2,
    });
    render(<ConversationStep item={item} isActive={false} />);
    expect(screen.getByText(/检索\s+PubMed/)).toBeInTheDocument();
    expect(screen.getByText(/lung cancer/)).toBeInTheDocument();
  });

  it("renders stage items via StageStep", () => {
    const item = makeItem({
      kind: "stage",
      stage: "discovery",
      status: "running",
      attempt: 1,
      error: null,
    });
    render(<ConversationStep item={item} isActive={false} />);
    expect(screen.getByText(/文献\/数据发现/)).toBeInTheDocument();
    expect(screen.getByText("运行中")).toBeInTheDocument();
  });

  it("renders progress items via ProgressStep", () => {
    const item = makeItem({
      kind: "progress",
      stage: "acquisition",
      progressKind: "downloaded_bytes",
      current: 1024,
      total: 4096,
    });
    render(<ConversationStep item={item} isActive={false} />);
    expect(screen.getByText(/数据获取.*已下载.*1024.*4096/)).toBeInTheDocument();
  });

  it("renders warning items via WarningStep", () => {
    const item = makeItem({
      kind: "warning",
      code: "partial_results",
      message: "部分记录不可用",
    });
    render(<ConversationStep item={item} isActive={false} />);
    expect(screen.getByText("部分记录不可用")).toBeInTheDocument();
    expect(screen.queryByText("partial_results")).not.toBeInTheDocument();
  });

  it("renders artifact items via ArtifactStep with formatted bytes", () => {
    const item = makeItem({
      kind: "artifact",
      artifactId: "art-1",
      name: "result.csv",
      sizeBytes: 2048,
      mediaType: "text/csv",
    });
    render(<ConversationStep item={item} isActive={false} />);
    expect(screen.getByText("生成产物：result.csv")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
  });
});
