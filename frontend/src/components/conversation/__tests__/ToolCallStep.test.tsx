import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ToolCallStep } from "@/components/conversation/ToolCallStep";
import { toolRenderers } from "@/components/conversation/toolRenderers";
import type { ToolCallItem } from "@/runtime/types";

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
  it("renders find_skill via SkillMarker instead of '调用 find_skill'", () => {
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "find_skill",
          arguments: { text: "网页截图" },
          output: null,
        })}
      />,
    );
    expect(screen.getByText("检索技能")).toBeInTheDocument();
    expect(screen.queryByText(/调用 find_skill/)).not.toBeInTheDocument();
  });

  it("renders invoke_skill via SkillMarker with the skill name", () => {
    render(
      <ToolCallStep
        item={makeToolCall({
          toolName: "invoke_skill",
          arguments: { skill: "web_visual_capture" },
          output: null,
        })}
      />,
    );
    expect(screen.getByText("调用 web_visual_capture")).toBeInTheDocument();
  });

  it("registers custom renderers for find_skill and invoke_skill", () => {
    expect(Object.keys(toolRenderers).sort()).toEqual([
      "find_skill",
      "invoke_skill",
    ]);
  });
});
