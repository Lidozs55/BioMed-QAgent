import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CompactionStep } from "@/components/conversation/CompactionStep";
import type { CompactionItem } from "@/runtime/types";

describe("CompactionStep", () => {
  it("renders running and completed status in the timeline", () => {
    const base = {
      itemId: "compaction:1",
      runId: "run_1",
      sequence: 1,
      createdAt: "2026-08-25T00:00:00.000Z",
      kind: "compaction" as const,
      message: null,
    };
    const { rerender } = render(
      <CompactionStep
        item={{ ...base, status: "running" } as CompactionItem}
      />,
    );
    expect(screen.getByText("正在压缩上下文…")).toBeInTheDocument();

    rerender(
      <CompactionStep
        item={{ ...base, status: "completed" } as CompactionItem}
      />,
    );
    expect(screen.getByText("上下文压缩完成")).toBeInTheDocument();
  });
});
