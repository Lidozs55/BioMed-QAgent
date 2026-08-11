import { useEffect, useState } from "react";

import { useAPI } from "@/hooks/useAPI";
import { useAgentStore } from "@/stores/agentStore";

export interface TaskBuildState {
  status: "idle" | "loading" | "ready";
  buildId: string | null;
}

/**
 * Resolve the V2 build of a task from the builds API.
 *
 * Completed run summaries now carry a stable `build_id` when the backend
 * emits one. This hook remains a task-level legacy fallback: it lists builds
 * and resolves the newest manifest for old surfaces that do not have a
 * per-run report item. Tasks without a completed run summary (or without a
 * build_result) never hit the network, so the legacy artifact path stays
 * untouched.
 *
 * The fetch result is keyed by the task's latest run id and build-result
 * presence, and the exposed status is derived so switching tasks never shows
 * a stale build or calls setState synchronously.
 */
export function useTaskBuildId(taskId: string | null): TaskBuildState {
  const api = useAPI();
  const task = useAgentStore((state) =>
    taskId === null ? undefined : state.tasksById[taskId],
  );
  const latestRunId = task?.runOrder[task.runOrder.length - 1];
  const latestRun =
    latestRunId === undefined ? undefined : task?.runsById[latestRunId];
  // A primitive signal so the effect only re-runs when the run outcome
  // actually changes (never on unrelated store churn). The latest run id is
  // part of the key: a NEW run producing its own build_result must refetch
  // (F3/R1S-02) — (taskId, hasBuildResult) alone stays true across runs.
  const hasBuildResult = latestRun?.summary?.build_result != null;

  const [result, setResult] = useState<{
    key: string;
    buildId: string | null;
  }>({ key: "", buildId: null });

  useEffect(() => {
    if (taskId === null || !hasBuildResult) return;
    const key = `${taskId}:${latestRunId ?? ""}:${hasBuildResult}`;
    let cancelled = false;
    void api
      .fetchBuilds({ limit: 50 })
      .then((page) => {
        if (cancelled) return;
        const match = page.items.find((item) => item.task_id === taskId);
        setResult({ key, buildId: match?.build_id ?? null });
      })
      .catch(() => {
        if (!cancelled) setResult({ key, buildId: null });
      });
    return () => {
      cancelled = true;
    };
  }, [api, taskId, latestRunId, hasBuildResult]);

  const active = taskId !== null && hasBuildResult;
  const key = active ? `${taskId}:${latestRunId ?? ""}:${hasBuildResult}` : "";
  if (!active) {
    return { status: "idle", buildId: null };
  }
  if (result.key !== key) {
    return { status: "loading", buildId: null };
  }
  return { status: "ready", buildId: result.buildId };
}
