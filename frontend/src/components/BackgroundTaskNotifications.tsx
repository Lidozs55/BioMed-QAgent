import { useEffect, useRef } from "react";
import { toast } from "sonner";

import type { RunStatus } from "@/runtime/contracts";
import { isActiveStatus } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

export function BackgroundTaskNotifications({
  onViewTask,
}: {
  onViewTask: (taskId: string) => void | Promise<void>;
}) {
  const tasksById = useAgentStore((state) => state.tasksById);
  const activeTaskId = useAgentStore((state) => state.activeTaskId);
  const previousStatuses = useRef(new Map<string, RunStatus>());
  const notifiedTransitions = useRef(new Set<string>());

  useEffect(() => {
    const currentIds = new Set(Object.keys(tasksById));
    for (const taskId of previousStatuses.current.keys()) {
      if (!currentIds.has(taskId)) previousStatuses.current.delete(taskId);
    }

    for (const [taskId, task] of Object.entries(tasksById)) {
      const status = task.summary.status;
      const previous = previousStatuses.current.get(taskId);
      previousStatuses.current.set(taskId, status);
      if (
        previous === undefined ||
        !isActiveStatus(previous) ||
        isActiveStatus(status) ||
        taskId === activeTaskId
      ) {
        continue;
      }

      const latestRunId = task.runOrder[task.runOrder.length - 1] ?? "summary";
      const transitionKey = `${taskId}:${latestRunId}:${status}`;
      if (notifiedTransitions.current.has(transitionKey)) continue;
      notifiedTransitions.current.add(transitionKey);

      const action = {
        label: "查看",
        onClick: () => void onViewTask(taskId),
      };
      if (status === "completed") {
        toast.success("后台任务已完成", {
          description: task.summary.title,
          action,
        });
      } else if (status === "failed" || status === "interrupted") {
        const latestRun = task.runsById[latestRunId];
        toast.error(status === "failed" ? "后台任务失败" : "后台任务已中断", {
          description: latestRun?.error ?? task.summary.title,
          action,
        });
      }
    }
  }, [activeTaskId, onViewTask, tasksById]);

  return null;
}
