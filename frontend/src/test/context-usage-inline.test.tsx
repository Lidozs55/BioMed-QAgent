import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ContextUsageInline } from "@/components/ContextUsageInline";

describe("ContextUsageInline", () => {
  it("shows runtime context overflow above one hundred percent", () => {
    render(
      <ContextUsageInline
        usedTokens={115_487}
        totalTokens={100_000}
        source="runtime"
      />,
    );

    expect(screen.getByRole("button", { name: "上下文窗口已使用 115%（运行时）" }))
      .toBeInTheDocument();
    expect(screen.getByText("115%")).toBeInTheDocument();
  });

  it("allows manual compaction even when context usage is low", () => {
    const onCompact = vi.fn();
    render(
      <ContextUsageInline
        usedTokens={1024}
        totalTokens={131_072}
        onCompact={onCompact}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "上下文窗口已使用 1%（估算）" }));
    const compactButton = screen.getByRole("button", { name: "压缩上下文" });

    expect(compactButton).toBeEnabled();
    fireEvent.click(compactButton);
    expect(onCompact).toHaveBeenCalledOnce();
  });
});
