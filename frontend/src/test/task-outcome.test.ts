import { describe, expect, it } from "vitest";

import { isNoArtifactFailure, taskHasArtifacts, taskOutcome } from "@/components/taskOutcome";
import type { RunStatus, TaskSummary } from "@/runtime/contracts";
import { createTaskProjection } from "@/runtime/reducer";

const CREATED_AT = "2026-07-14T00:00:00Z";

function summary(
  taskId: string,
  status: RunStatus,
  artifactCount?: number,
): TaskSummary {
  return {
    task_id: taskId,
    mode: "agent",
    databases: [],
    title: taskId,
    status,
    active_run_id: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    latest_sequence: 1,
    ...(artifactCount === undefined ? {} : { artifact_count: artifactCount }),
  };
}

function run(taskId: string, error: string) {
  return {
    runId: `run_${taskId}`,
    taskId,
    requestId: `req_${taskId}`,
    status: "failed",
    input: "question",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    startedAt: CREATED_AT,
    finishedAt: CREATED_AT,
    error,
    summary: null,
  } as const;
}

describe("taskOutcome", () => {
  it("classifies completed tasks by artifact count", () => {
    expect(taskOutcome(createTaskProjection(summary("a", "completed", 2)))).toBe(
      "data",
    );
    expect(taskOutcome(createTaskProjection(summary("b", "completed", 0)))).toBe(
      "no_data",
    );
  });

  it("falls back to loaded artifacts when the summary count is absent", () => {
    const task = createTaskProjection(summary("c", "completed"));
    expect(taskHasArtifacts(task)).toBe(false);
    task.artifactOrder = ["artifact_c"];
    expect(taskHasArtifacts(task)).toBe(true);
    expect(taskOutcome(task)).toBe("data");
  });

  it("keeps real failures red and silent no-artifact completions blue", () => {
    const failed = createTaskProjection(summary("f", "failed"));
    failed.runsById = {
      run_f: run("f", "model connection timeout"),
    };
    failed.runOrder = ["run_f"];
    expect(taskOutcome(failed)).toBeNull();

    const silent = createTaskProjection(summary("s", "failed"));
    silent.runsById = {
      run_s: run(
        "s",
        "agent completed without producing any artifacts (manifest missing or unchanged)",
      ),
    };
    silent.runOrder = ["run_s"];
    expect(isNoArtifactFailure(silent)).toBe(true);
    expect(taskOutcome(silent)).toBe("no_data");
  });

  it("prefers data when the task produced validated artifacts", () => {
    const task = createTaskProjection(summary("g", "failed", 2));
    expect(taskOutcome(task)).toBe("data");
  });

  it("classifies a summary-only no-artifact failure as no_data", () => {
    const task = createTaskProjection(summary("d", "failed"));
    task.runsById = {
      run_d: run(
        "d",
        "agent completed without producing any artifacts (manifest missing or unchanged)",
      ),
    };
    task.runOrder = ["run_d"];
    expect(isNoArtifactFailure(task)).toBe(true);
    expect(taskOutcome(task)).toBe("no_data");
  });
});
