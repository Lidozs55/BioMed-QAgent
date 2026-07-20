import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReasoningBlock } from "@/components/conversation/ReasoningBlock";
import type { ReasoningItem } from "@/runtime/types";

const TIMESTAMP = "2026-07-20T00:00:00Z";

function makeReasoning(overrides: Partial<ReasoningItem>): ReasoningItem {
  return {
    itemId: "reasoning-1",
    runId: "run-1",
    sequence: 1,
    createdAt: TIMESTAMP,
    kind: "reasoning",
    content: "先分析用户意图。",
    isStreaming: false,
    ...overrides,
  };
}

describe("ReasoningBlock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is collapsed by default when isStreaming=false", () => {
    render(<ReasoningBlock item={makeReasoning({ isStreaming: false })} />);
    expect(screen.getByText("思维链")).toBeInTheDocument();
    expect(screen.queryByText("先分析用户意图。")).not.toBeInTheDocument();
  });

  it("auto-expands when isStreaming=true", () => {
    render(<ReasoningBlock item={makeReasoning({ isStreaming: true })} />);
    expect(screen.getByText("思考中...")).toBeInTheDocument();
    expect(screen.getByText("先分析用户意图。")).toBeInTheDocument();
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  });

  it("shows streaming cursor while streaming", () => {
    const { container } = render(
      <ReasoningBlock item={makeReasoning({ isStreaming: true })} />,
    );
    expect(container.textContent).toContain("▋");
  });

  it("does not show streaming cursor when not streaming", () => {
    const { container } = render(
      <ReasoningBlock item={makeReasoning({ isStreaming: false })} />,
    );
    expect(container.textContent).not.toContain("▋");
  });

  it("user can manually expand a collapsed block", () => {
    render(<ReasoningBlock item={makeReasoning({ isStreaming: false })} />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("先分析用户意图。")).toBeInTheDocument();
  });

  it("user can manually collapse an expanded streaming block (overrides auto behavior)", () => {
    render(<ReasoningBlock item={makeReasoning({ isStreaming: true })} />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("先分析用户意图。")).not.toBeInTheDocument();
  });

  it("auto-collapses 500ms after isStreaming transitions from true to false", () => {
    const { rerender } = render(
      <ReasoningBlock item={makeReasoning({ isStreaming: true })} />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");

    rerender(<ReasoningBlock item={makeReasoning({ isStreaming: false })} />);
    // Before the 500ms timer fires, still expanded
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("先分析用户意图。")).not.toBeInTheDocument();
  });

  it("does not auto-collapse if the user manually toggled", () => {
    const { rerender } = render(
      <ReasoningBlock item={makeReasoning({ isStreaming: true })} />,
    );
    const button = screen.getByRole("button");
    fireEvent.click(button); // user collapses
    expect(button).toHaveAttribute("aria-expanded", "false");

    rerender(<ReasoningBlock item={makeReasoning({ isStreaming: false })} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(button).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps expanded state when user manually expanded a non-streaming block", () => {
    render(<ReasoningBlock item={makeReasoning({ isStreaming: false })} />);
    const button = screen.getByRole("button");
    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(button).toHaveAttribute("aria-expanded", "true");
  });
});
