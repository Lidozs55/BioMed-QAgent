import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import ResultsViewer from "@/components/ResultsViewer";
import { createInitialRuntimeState } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

describe("ResultsViewer", () => {
  beforeEach(() => useAgentStore.setState(createInitialRuntimeState()));

  it("asks for a task when no task is selected", () => {
    render(<ResultsViewer />);
    expect(screen.getByText("选择任务查看结果")).toBeVisible();
  });

  it("shows an honest empty state without a Publication or artifacts", () => {
    render(<ResultsViewer taskId="task_1" artifacts={[]} activities={[]} />);
    expect(screen.getByText("暂无结果")).toBeVisible();
    expect(screen.getByText("该任务尚未生成可下载的产物。")).toBeVisible();
  });
});
