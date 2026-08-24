import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ContextUsageInline } from "@/components/ContextUsageInline";

describe("ContextUsageInline", () => {
  it("allows manual compaction even when context usage is low", () => {
    const onCompact = vi.fn();
    render(
      <ContextUsageInline
        usedTokens={1024}
        totalTokens={131_072}
        onCompact={onCompact}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "上下文窗口已使用 1%" }));
    const compactButton = screen.getByRole("button", { name: "压缩上下文" });

    expect(compactButton).toBeEnabled();
    fireEvent.click(compactButton);
    expect(onCompact).toHaveBeenCalledOnce();
  });
});
