import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { TaskStatusIcon } from "@/components/taskStatus";
import { TASK_STATUS_META } from "@/components/taskStatusMeta";
import ResearchPipeline from "@/components/ResearchPipeline";
import type { StageName } from "@/runtime/contracts";
import type { StageProjection, TaskProjection } from "@/runtime/types";

const AGENT_STAGE_ORDER: readonly StageName[] = [
  "discovery",
  "acquisition",
  "processing",
  "artifact_build",
  "validation",
];

const STAGE_LABELS: Record<StageName, string> = {
  discovery: "文献/数据发现",
  acquisition: "数据获取",
  processing: "数据处理",
  artifact_build: "产物构建",
  validation: "结果验证",
};

const PROGRESS_KIND_LABELS: Record<string, string> = {
  discovered_records: "已发现记录",
  downloaded_bytes: "已下载字节",
  cleaned_rows: "已清洗行数",
};

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatProgressValue(kind: string, current: number): string {
  if (kind === "downloaded_bytes") return formatBytes(current);
  return String(current);
}

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

function AgentStageList({ task }: { task: TaskProjection }) {
  const stages = AGENT_STAGE_ORDER.map(
    (stage) => task.stages[stage],
  ).filter((s): s is StageProjection => s !== undefined);
  if (stages.length === 0) return null;
  return (
    <div
      className="flex min-w-0 flex-wrap gap-1.5"
      aria-label="Agent 阶段进度"
    >
      {stages.map((stage) => {
        const progress = stage.progress;
        const kindLabel = progress
          ? PROGRESS_KIND_LABELS[progress.kind] ?? progress.kind
          : null;
        const valueText = progress
          ? formatProgressValue(progress.kind, progress.current)
          : null;
        const totalText =
          progress && progress.total !== null
            ? ` / ${formatProgressValue(progress.kind, progress.total)}`
            : "";
        return (
          <div
            key={stage.stage}
            data-stage={stage.stage}
            className="flex min-w-0 items-center gap-1 rounded-md border bg-muted/30 px-2 py-1 text-xs"
            title={STAGE_LABELS[stage.stage]}
          >
            <span className="shrink-0 font-medium">
              {STAGE_LABELS[stage.stage]}
            </span>
            {progress && (
              <span className="min-w-0 truncate text-muted-foreground">
                {kindLabel}: {valueText}
                {totalText}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
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
  const lastRunId = task.runOrder[task.runOrder.length - 1];
  const run = task.summary.active_run_id
    ? task.runsById[task.summary.active_run_id]
    : lastRunId !== undefined
      ? task.runsById[lastRunId]
      : undefined;
  const statusDescription: Record<typeof status, string> = {
    queued: "等待可用执行槽",
    running: "Agent 正在运行",
    finalizing: "正在整理最终回复和产物",
    cancel_requested: "已请求取消，正在结束",
    awaiting_user_input: "等待确认计划",
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
      <AgentStageList task={task} />
      {run?.error && (
        <p className="break-words text-sm text-muted-foreground">{run.error}</p>
      )}
    </div>
  );
}
