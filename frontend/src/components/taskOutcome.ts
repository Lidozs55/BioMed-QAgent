import type { BuildResultStatus, RunStatus } from "@/runtime/contracts";
import type { TaskProjection } from "@/runtime/types";

export type TaskOutcome = "data" | "neutral" | "problem";

const ACTIVE_STATUSES = new Set<RunStatus>([
  "queued",
  "running",
  "finalizing",
  "cancel_requested",
  "awaiting_user_input",
]);

const LEGACY_NO_ARTIFACT_FAILURE_MARKERS = [
  "without producing any artifacts",
  "manifest missing or unchanged",
] as const;

/**
 * Return the structured build result of the latest run, or null when the run
 * has not been hydrated (history list rows start with summary only) or the
 * snapshot predates structured run summaries.
 */
export function latestBuildStatus(task: TaskProjection): BuildResultStatus | null {
  const latestRunId = task.runOrder[task.runOrder.length - 1];
  if (latestRunId === undefined) return null;
  const latestRun = task.runsById[latestRunId] ?? null;
  return latestRun?.summary?.build_result?.status ?? null;
}

export function taskHasArtifacts(task: TaskProjection): boolean {
  const counted = task.summary.artifact_count;
  if (typeof counted === "number") return counted > 0;
  return (
    task.artifactOrder.length > 0 || Object.keys(task.artifactsById).length > 0
  );
}

/**
 * Older runs failed with a message like "without producing any artifacts"
 * instead of a structured NO_DATA result. Treat those as a normal no-product
 * outcome, not as a genuine problem.
 */
function isLegacyNoArtifactFailure(task: TaskProjection): boolean {
  if (task.summary.status !== "failed") return false;
  const latestRunId = task.runOrder[task.runOrder.length - 1];
  if (latestRunId === undefined) return false;
  const error = task.runsById[latestRunId]?.error ?? null;
  return (
    error !== null &&
    LEGACY_NO_ARTIFACT_FAILURE_MARKERS.some((marker) => error.includes(marker))
  );
}

/**
 * Terminal sidebar outcome:
 * - "data"    → green: the conversation produced artifacts;
 * - "neutral" → default color: normal completion without artifacts, or a
 *               user-initiated cancellation;
 * - "problem" → red: failed execution, interruption, or a rejected build spec.
 * Active runs return null and are rendered with the primary color by the caller.
 */
export function taskOutcome(task: TaskProjection): TaskOutcome | null {
  const status = task.summary.status;
  if (ACTIVE_STATUSES.has(status)) return null;

  const buildStatus = latestBuildStatus(task);
  if (buildStatus !== null) {
    switch (buildStatus) {
      case "succeeded":
      case "partial_success":
        return "data";
      case "no_data":
        return "neutral";
      case "spec_rejected":
        return "problem";
    }
  }

  if (taskHasArtifacts(task)) return "data";

  switch (status) {
    case "completed":
    case "cancelled":
      return "neutral";
    case "failed":
      return isLegacyNoArtifactFailure(task) ? "neutral" : "problem";
    case "interrupted":
      return "problem";
    default:
      return null;
  }
}
