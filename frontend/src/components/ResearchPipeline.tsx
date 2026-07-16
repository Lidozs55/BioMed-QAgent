import { Badge } from "@/components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress";
import { TaskStatusIcon } from "@/components/taskStatus";
import { TASK_STATUS_META } from "@/components/taskStatusMeta";
import type { AttemptStatus, StageName } from "@/runtime/contracts";
import type { FixtureStageProjection, TaskProjection } from "@/runtime/types";

const FIXTURE_STAGE_ORDER: readonly StageName[] = [
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

const ATTEMPT_LABELS: Record<AttemptStatus, string> = {
  pending: "待处理",
  running: "执行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  skipped: "已跳过",
};

const ATTEMPT_VARIANTS: Record<
  AttemptStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "outline",
  running: "default",
  succeeded: "secondary",
  failed: "destructive",
  cancelled: "destructive",
  skipped: "outline",
};

function stageProjection(
  task: TaskProjection,
  stage: StageName,
): FixtureStageProjection {
  return (
    task.fixtureStages[stage] ?? {
      stage,
      stageAttemptId: `pending:${stage}`,
      attempt: 0,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      outputDigest: null,
      error: null,
      skipReason: null,
      reusedStageAttemptId: null,
    }
  );
}

export interface ResearchPipelineProps {
  task?: TaskProjection;
}

export default function ResearchPipeline({ task }: ResearchPipelineProps) {
  if (task === undefined || task.summary.mode !== "fixture") {
    return (
      <Empty className="min-h-24 border-0 p-4">
        <EmptyHeader>
          <EmptyTitle>暂无固定流程</EmptyTitle>
          <EmptyDescription>固定验收任务的阶段进度会显示在这里。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const stages = FIXTURE_STAGE_ORDER.map((stage) => stageProjection(task, stage));
  const completedStages = stages.filter(
    (stage) => stage.status === "succeeded" || stage.status === "skipped",
  ).length;
  const progress = Math.round((completedStages / FIXTURE_STAGE_ORDER.length) * 100);
  const terminalMeta = TASK_STATUS_META[task.summary.status];

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="research-pipeline">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <Progress value={progress} className="min-w-0 flex-1" aria-label="固定流程进度">
          <ProgressLabel>固定流程进度</ProgressLabel>
          <ProgressValue>{() => `${progress}%`}</ProgressValue>
        </Progress>
        <Badge variant={terminalMeta.badgeVariant} className="shrink-0">
          <TaskStatusIcon status={task.summary.status} />
          {terminalMeta.label}
        </Badge>
      </div>

      <div className="flex min-w-0 gap-2 overflow-x-auto pb-1" aria-label="固定流程阶段">
        {stages.map((stage) => (
          <div
            key={stage.stage}
            data-stage={stage.stage}
            className="flex min-w-32 shrink-0 flex-col gap-2 rounded-lg border p-2"
          >
            <span className="truncate text-xs font-medium" title={STAGE_LABELS[stage.stage]}>
              {STAGE_LABELS[stage.stage]}
            </span>
            <Badge variant={ATTEMPT_VARIANTS[stage.status]} className="w-fit">
              {ATTEMPT_LABELS[stage.status]}
            </Badge>
            {stage.error && (
              <span className="break-words text-xs text-muted-foreground">{stage.error}</span>
            )}
            {stage.skipReason && (
              <span className="break-words text-xs text-muted-foreground">{stage.skipReason}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
