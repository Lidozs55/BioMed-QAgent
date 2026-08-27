import { describe, expect, it } from "vitest";

import { taskHasArtifacts, taskOutcome } from "@/components/taskOutcome";
import type { TaskSummary } from "@/runtime/contracts";
import { createTaskProjection } from "@/runtime/reducer";

const CREATED_AT = "2026-07-14T00:00:00Z";

function projection(
  status: TaskSummary["status"],
  options: { artifactCount?: number; publicationId?: string } = {},
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
  return options.publicationId === undefined
    ? task
    : { ...task, currentPublicationId: options.publicationId };
}

describe("taskOutcome", () => {
  it("treats a verified Publication or artifact inventory as data", () => {
    expect(taskOutcome(projection("completed", { publicationId: "pub_1" }))).toBe("data");
    expect(taskOutcome(projection("completed", { artifactCount: 2 }))).toBe("data");
  });

  it("classifies terminal runs independently from product production", () => {
    expect(taskOutcome(projection("completed", { artifactCount: 0 }))).toBe("neutral");
    expect(taskOutcome(projection("cancelled"))).toBe("neutral");
    expect(taskOutcome(projection("failed"))).toBe("problem");
    expect(taskOutcome(projection("interrupted"))).toBe("problem");
  });

  it("keeps active statuses out of the terminal outcome", () => {
    for (const status of ["queued", "running", "finalizing", "cancel_requested", "awaiting_user_input"] as const) {
      expect(taskOutcome(projection(status))).toBeNull();
    }
  });

  it("detects artifacts from hydrated artifact collections", () => {
    const task = projection("completed");
    expect(taskHasArtifacts(task)).toBe(false);
    expect(taskHasArtifacts({ ...task, artifactOrder: ["artifact_1"] })).toBe(true);
  });
});
