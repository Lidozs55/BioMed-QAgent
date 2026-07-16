import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ResearchPipeline from "@/components/ResearchPipeline";
import type { StageName } from "@/runtime/contracts";
import { createTaskProjection } from "@/runtime/reducer";
import type { FixtureStageProjection, TaskProjection } from "@/runtime/types";

const STAGES: StageName[] = [
  "discovery",
  "acquisition",
  "processing",
  "artifact_build",
  "validation",
];

function fixtureTask(
  statuses: Partial<Record<StageName, FixtureStageProjection["status"]>>,
  runStatus: TaskProjection["summary"]["status"] = "running",
): TaskProjection {
  const task = createTaskProjection({
    task_id: "fixture_task",
    mode: "fixture",
    databases: ["pubmed", "geo"],
    title: "Fixture",
    status: runStatus,
    active_run_id: runStatus === "running" ? "run_fixture" : null,
    created_at: "2026-07-14T00:00:00Z",
    updated_at: "2026-07-14T00:00:00Z",
    latest_sequence: 5,
  });
  const fixtureStages = Object.fromEntries(
    Object.entries(statuses).map(([stage, status], index) => [
      stage,
      {
        stage: stage as StageName,
        stageAttemptId: `attempt_${stage}`,
        attempt: 1,
        status,
        startedAt: "2026-07-14T00:00:00Z",
        finishedAt: status === "running" ? null : "2026-07-14T00:00:01Z",
        outputDigest: status === "succeeded" ? `digest_${index}` : null,
        error: status === "failed" ? "stage error" : null,
        skipReason: status === "skipped" ? "reused" : null,
        reusedStageAttemptId: null,
      },
    ]),
  );
  return { ...task, fixtureStages };
}

describe("ResearchPipeline", () => {
  it("renders exactly five deterministic backend stages in stable order", () => {
    const { container } = render(<ResearchPipeline task={fixtureTask({})} />);

    expect(
      Array.from(container.querySelectorAll("[data-stage]")).map((node) =>
        node.getAttribute("data-stage"),
      ),
    ).toEqual(STAGES);
    expect(screen.getByText("文献/数据发现")).toBeVisible();
    expect(screen.getByText("数据获取")).toBeVisible();
    expect(screen.getByText("数据处理")).toBeVisible();
    expect(screen.getByText("产物构建")).toBeVisible();
    expect(screen.getByText("结果验证")).toBeVisible();
    expect(screen.queryByText("完成", { exact: true })).toBeNull();
  });

  it("counts only succeeded and skipped stages toward deterministic progress", () => {
    render(
      <ResearchPipeline
        task={fixtureTask({
          discovery: "succeeded",
          acquisition: "skipped",
          processing: "running",
        })}
      />,
    );

    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "40");
    expect(screen.getByText("40%")).toBeVisible();
  });

  it("shows failed and cancelled stages without completing later stages", () => {
    render(
      <ResearchPipeline
        task={fixtureTask(
          { discovery: "succeeded", acquisition: "failed", processing: "cancelled" },
          "failed",
        )}
      />,
    );

    expect(screen.getAllByText("失败", { exact: true })).toHaveLength(2);
    expect(screen.getByText("已取消", { exact: true })).toBeVisible();
    expect(screen.getByText("20%")).toBeVisible();
    expect(screen.getAllByText("待处理").length).toBeGreaterThan(0);
  });
});
