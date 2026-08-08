import { describe, expect, it } from "vitest";

import {
  taskHasArtifacts,
  taskOutcome,
} from "@/components/taskOutcome";
import type { BuildResultStatus, TaskSummary } from "@/runtime/contracts";
import { createTaskProjection } from "@/runtime/reducer";

const CREATED_AT = "2026-07-14T00:00:00Z";

function projection(
  status: TaskSummary["status"],
  options: {
    artifactCount?: number;
    buildStatus?: BuildResultStatus;
  } = {},
) {
  const task = createTaskProjection({
    task_id: "task",
    mode: "agent",
    databases: [],
    title: "Task",
    status,
    active_run_id: null,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    latest_sequence: 1,
    artifact_count: options.artifactCount,
  });
  if (options.buildStatus !== undefined) {
    return {
      ...task,
      runsById: {
        run_latest: {
          runId: "run_latest",
          taskId: "task",
          requestId: null,
          status,
          input: null,
          createdAt: CREATED_AT,
          updatedAt: CREATED_AT,
          startedAt: CREATED_AT,
          finishedAt: CREATED_AT,
          error: null,
          summary: {
            run_status: status,
            build_result: {
              status: options.buildStatus,
              valid_row_count: 0,
              successful_sources: [],
              rejected_sources: [],
              available_artifact_roles: [],
              publication_id: null,
              reason_codes: [],
              user_summary: "",
              recommended_next_action: "",
            },
            error_code: null,
            cancelled_at_stage: null,
            user_message: null,
          },
        },
      },
      runOrder: ["run_latest"],
    };
  }
  return task;
}

describe("taskOutcome", () => {
  it("treats structured succeeded/partial_success as data", () => {
    expect(
      taskOutcome(projection("completed", { buildStatus: "succeeded" })),
    ).toBe("data");
    expect(
      taskOutcome(projection("completed", { buildStatus: "partial_success" })),
    ).toBe("data");
  });

  it("treats structured no_data as neutral", () => {
    expect(
      taskOutcome(projection("completed", { buildStatus: "no_data" })),
    ).toBe("neutral");
  });

  it("treats spec_rejected as a problem", () => {
    expect(
      taskOutcome(projection("completed", { buildStatus: "spec_rejected" })),
    ).toBe("problem");
  });

  it("uses artifact_count when no run summary is hydrated (history rows)", () => {
    expect(taskOutcome(projection("completed", { artifactCount: 2 }))).toBe(
      "data",
    );
    expect(taskOutcome(projection("completed", { artifactCount: 0 }))).toBe(
      "neutral",
    );
  });

  it("treats cancellation as neutral and interruption as a problem", () => {
    expect(taskOutcome(projection("cancelled"))).toBe("neutral");
    expect(taskOutcome(projection("interrupted"))).toBe("problem");
  });

  it("keeps active statuses out of the terminal outcome", () => {
    for (const status of [
      "queued",
      "running",
      "finalizing",
      "cancel_requested",
      "awaiting_user_input",
    ] as const) {
      expect(taskOutcome(projection(status))).toBeNull();
    }
  });

  it("detects artifacts from hydrated artifact collections as fallback", () => {
    const task = projection("completed");
    expect(taskHasArtifacts(task)).toBe(false);
    expect(
      taskHasArtifacts({
        ...task,
        artifactOrder: ["artifact_1"],
      }),
    ).toBe(true);
  });
});
