import { useEffect } from "react";
import { toast } from "sonner";

import { isActiveStatus } from "@/runtime/reducer";
import { useAgentStore } from "@/stores/agentStore";

function errorDescription(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

export function BackgroundTaskNotifications({
  onViewTask,
}: {
  onViewTask: (taskId: string) => void | Promise<void>;
}) {
  useEffect(() => {
    const notifiedTransitions = new Set<string>();
    const viewTask = async (taskId: string) => {
      try {
        await onViewTask(taskId);
      } catch (error) {
        toast.error("打开任务失败", { description: errorDescription(error) });
      }
    };
    return useAgentStore.subscribe((state, previousState) => {
      for (const [taskId, task] of Object.entries(state.tasksById)) {
        const status = task.summary.status;
        const previous = previousState.tasksById[taskId]?.summary.status;
        if (
          previous === undefined ||
          !isActiveStatus(previous) ||
          isActiveStatus(status) ||
          taskId === state.activeTaskId
        ) {
          continue;
        }

        const latestRunId = task.runOrder[task.runOrder.length - 1] ?? "summary";
        const transitionKey = `${taskId}:${latestRunId}:${status}`;
        if (notifiedTransitions.has(transitionKey)) continue;
        notifiedTransitions.add(transitionKey);

        const action = {
          label: "查看",
          onClick: () => void viewTask(taskId),
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
    });
  }, [onViewTask]);

  return null;
}
