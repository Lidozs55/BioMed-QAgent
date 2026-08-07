import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ArtifactFab } from "@/components/ArtifactFab";
import { ArtifactSheet } from "@/components/ArtifactSheet";
import type { ArtifactProjection } from "@/runtime/types";

function artifact(name: string): ArtifactProjection {
  return {
    artifact_id: name,
    name,
    role: "audit_report",
    size: 128,
    sha256: `sha-${name}`,
    media_type: "text/csv",
    taskId: "task-artifacts",
    generatedByStepId: null,
  };
}

describe("artifact FAB", () => {
  it("stays hidden when there are no artifacts", () => {
    render(<ArtifactFab artifacts={[]} taskId="task-artifacts" />);

    expect(
      screen.queryByRole("button", { name: /查看 .* 个产物/ }),
    ).not.toBeInTheDocument();
  });

  it("shows artifact count and opens the bottom sheet", () => {
    render(
      <ArtifactFab
        artifacts={[artifact("main_data.csv"), artifact("warnings.csv")]}
        taskId="task-artifacts"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "查看 2 个产物" }));

    expect(screen.getByRole("dialog", { name: "任务产物" })).toBeVisible();
    expect(screen.getByText("main_data.csv")).toBeVisible();
  });
});

describe("artifact sheet", () => {
  it("labels artifacts by role instead of the generic extension fallback (F7)", () => {
    render(
      <ArtifactSheet
        open
        onOpenChange={vi.fn()}
        artifacts={[artifact("rejections-v2.csv")]}
        taskId="task-artifacts"
      />,
    );

    expect(screen.getByText("审计报告 · 128 B")).toBeVisible();
    expect(screen.queryByText("CSV · 128 B")).not.toBeInTheDocument();
  });

  it("downloads an individual artifact with its filename", () => {
    const download = vi.fn();
    render(
      <ArtifactSheet
        open
        onOpenChange={vi.fn()}
        artifacts={[artifact("main_data.csv")]}
        taskId="task-artifacts"
        download={download}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "下载 main_data.csv" }),
    );

    expect(download).toHaveBeenCalledWith(
      expect.stringContaining("main_data.csv"),
      "main_data.csv",
    );
  });

  it("downloads every artifact from save all", () => {
    const download = vi.fn();
    render(
      <ArtifactSheet
        open
        onOpenChange={vi.fn()}
        artifacts={[artifact("a.csv"), artifact("b.csv")]}
        taskId="task-artifacts"
        download={download}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "保存全部产物" }));

    expect(download).toHaveBeenCalledTimes(2);
    expect(download).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      "a.csv",
    );
    expect(download).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      "b.csv",
    );
  });

  it("previews the selected artifact", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    render(
      <ArtifactSheet
        open
        onOpenChange={vi.fn()}
        artifacts={[artifact("main_data.csv"), artifact("warnings.csv")]}
        taskId="task-artifacts"
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "预览" }));
      await Promise.resolve();
    });

    const preview = screen
      .getAllByRole("tabpanel", { hidden: true })
      .find((panel) => !panel.hasAttribute("inert"));
    if (preview === undefined) throw new Error("Preview panel was not active");
    expect(within(preview).getByText("main_data.csv")).toBeVisible();
    expect(within(preview).queryByText("warnings.csv")).not.toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
