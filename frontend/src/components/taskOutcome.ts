import type { TaskProjection } from "@/runtime/types";

export type TaskOutcome = "data" | "no_data";

const NO_ARTIFACT_FAILURE_MARKERS = [
  "without producing any artifacts",
  "manifest missing or unchanged",
] as const;

export function taskHasArtifacts(task: TaskProjection): boolean {
  const counted = task.summary.artifact_count;
  if (typeof counted === "number") return counted > 0;
  return (
    task.artifactOrder.length > 0 || Object.keys(task.artifactsById).length > 0
  );
}

export function isNoArtifactFailure(task: TaskProjection): boolean {
  if (task.summary.status !== "failed") return false;
  const latestRunId = task.runOrder[task.runOrder.length - 1];
  const error =
    latestRunId === undefined ? null : task.runsById[latestRunId]?.error ?? null;
  return (
    error !== null &&
    NO_ARTIFACT_FAILURE_MARKERS.some((marker) => error.includes(marker))
  );
}

/** Terminal sidebar outcome: green/data wins, red error stays null, blue/no-data is explicit. */
export function taskOutcome(task: TaskProjection): TaskOutcome | null {
  if (taskHasArtifacts(task)) return "data";
  if (task.summary.status === "completed" || isNoArtifactFailure(task)) {
    return "no_data";
  }
  return null;
}
