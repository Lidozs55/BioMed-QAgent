import type { RunStatus } from "@/runtime/contracts";
import type { TaskProjection } from "@/runtime/types";

export type TaskOutcome = "data" | "neutral" | "problem";

const ACTIVE_STATUSES = new Set<RunStatus>([
  "queued", "running", "finalizing", "cancel_requested", "awaiting_user_input",
]);

export function taskHasArtifacts(task: TaskProjection): boolean {
  const counted = task.summary.artifact_count;
  return typeof counted === "number"
    ? counted > 0
    : task.artifactOrder.length > 0 || Object.keys(task.artifactsById).length > 0;
}

export function taskOutcome(task: TaskProjection): TaskOutcome | null {
  const status = task.summary.status;
  if (ACTIVE_STATUSES.has(status)) return null;
  if (task.currentPublicationId !== null || taskHasArtifacts(task)) return "data";
  if (status === "completed" || status === "cancelled") return "neutral";
  return status === "failed" || status === "interrupted" ? "problem" : null;
}
