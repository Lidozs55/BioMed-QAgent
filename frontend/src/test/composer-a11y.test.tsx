import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentComposer } from "@/components/AgentComposer";

describe("AgentComposer accessibility", () => {
  it("exposes an accessible input, attachment control, and send button", () => {
    render(
      <AgentComposer
        value=""
        onChange={() => undefined}
        onSubmit={() => undefined}
        onKeyDown={() => undefined}
        placeholder="输入研究目标..."
        ariaLabel="研究目标"
      />,
    );

    expect(screen.getByRole("textbox", { name: "研究目标" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "添加附件" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送" })).toBeInTheDocument();
  });

  it("shows an enabled stop square and calls onStop when active with empty input", () => {
    const onStop = vi.fn();
    const onSubmit = vi.fn();
    render(
      <AgentComposer
        value=""
        onChange={() => undefined}
        onSubmit={onSubmit}
        onKeyDown={() => undefined}
        placeholder="输入研究目标..."
        ariaLabel="研究目标"
        canStop
        onStop={onStop}
      />,
    );

    const stop = screen.getByRole("button", { name: "停止生成" });
    expect(stop).toBeEnabled();
    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("keeps the send arrow while active but the input has text", () => {
    render(
      <AgentComposer
        value="继续提问"
        onChange={() => undefined}
        onSubmit={() => undefined}
        onKeyDown={() => undefined}
        placeholder="输入研究目标..."
        ariaLabel="研究目标"
        canStop
        onStop={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "发送" })).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: "停止生成" }),
    ).not.toBeInTheDocument();
  });

  it("disables the stop square and shows progress while cancellation is in flight", () => {
    render(
      <AgentComposer
        value=""
        onChange={() => undefined}
        onSubmit={() => undefined}
        onKeyDown={() => undefined}
        placeholder="输入研究目标..."
        ariaLabel="研究目标"
        canStop
        onStop={() => undefined}
        stopping
      />,
    );

    expect(screen.getByRole("button", { name: "正在取消…" })).toBeDisabled();
  });
});
