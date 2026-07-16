import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { TaskStatusIcon } from "@/components/taskStatus";
import { TASK_STATUS_META } from "@/components/taskStatusMeta";
import ResearchPipeline from "@/components/ResearchPipeline";
import type { TaskProjection } from "@/runtime/types";

export interface AgentProgressProps {
  task?: TaskProjection;
}

function activeTool(task: TaskProjection): string | null {
  const runId = task.summary.active_run_id;
  if (runId === null) return null;
  for (let index = task.activityOrder.length - 1; index >= 0; index -= 1) {
    const activity = task.activitiesById[task.activityOrder[index]];
    if (
      activity?.kind === "tool" &&
      activity.status === "started" &&
      activity.runId === runId
    ) {
      return activity.name;
    }
  }
  return null;
}

export function AgentProgress({ task }: AgentProgressProps) {
  if (task === undefined) {
    return (
      <Empty className="min-h-20 border-0 p-4">
        <EmptyHeader>
          <EmptyTitle>选择任务查看进度</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }

  if (task.summary.mode === "fixture") {
    return <ResearchPipeline task={task} />;
  }

  const status = task.summary.status;
  const meta = TASK_STATUS_META[status];
  const tool = activeTool(task);
  const run = task.summary.active_run_id
    ? task.runsById[task.summary.active_run_id]
    : task.runOrder.length > 0
      ? task.runsById[task.runOrder[task.runOrder.length - 1]]
      : undefined;
  const statusDescription: Record<typeof status, string> = {
    queued: "等待可用执行槽",
    running: "Agent 正在运行",
    finalizing: "正在整理最终回复和产物",
    cancel_requested: "已请求取消，正在结束",
    completed: "任务已完成",
    failed: "任务执行失败",
    cancelled: "任务已取消",
    interrupted: "任务已中断",
  };

  return (
    <div className="flex min-w-0 flex-col gap-2 rounded-lg border p-3" aria-live="polite">
      <div className="flex min-w-0 items-center gap-2">
        <TaskStatusIcon status={status} />
        <span className="min-w-0 flex-1 truncate">{statusDescription[status]}</span>
        <Badge variant={meta.badgeVariant} className="shrink-0">
          {meta.label}
        </Badge>
      </div>
      {status === "running" && tool && (
        <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" />
          <span className="shrink-0">当前工具</span>
          <span className="min-w-0 truncate font-mono" title={tool}>
            {tool}
          </span>
        </div>
      )}
      {run?.error && (
        <p className="break-words text-sm text-muted-foreground">{run.error}</p>
      )}
    </div>
  );
}
