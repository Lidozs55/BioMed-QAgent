import { WarningCircleIcon } from "@phosphor-icons/react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import type { ActivityProjection, SubagentProjection } from "@/runtime/types";

export type CancelSubagent = (
  taskId: string,
  runId: string,
  subagentId: string,
) => Promise<void>;

const agentTypeLabels = {
  source_research: "SourceResearchAgent",
  skill_builder: "SkillBuilderAgent",
} as const;

const statusLabels = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  cancel_requested: "正在取消",
  cancelled: "已取消",
  interrupted: "已中断",
} as const;

function duration(subagent: SubagentProjection): string | null {
  if (subagent.startedAt === null) return null;
  const start = Date.parse(subagent.startedAt);
  const end = Date.parse(subagent.finishedAt ?? new Date().toISOString());
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return `${Math.max(0, Math.floor((end - start) / 1000))} 秒`;
}

interface SubagentCardProps {
  subagent: SubagentProjection;
  activities: readonly ActivityProjection[];
  cancelSubagent?: CancelSubagent;
}

export function SubagentCard({
  subagent,
  activities,
  cancelSubagent,
}: SubagentCardProps) {
  const progress = subagent.progressTotal === null || subagent.progressTotal === 0
    ? null
    : (subagent.progressCurrent / subagent.progressTotal) * 100;
  const isCancellable = subagent.status === "queued" || subagent.status === "running";
  const elapsed = duration(subagent);
  const errorDetail = subagent.errorMessage ?? subagent.errorCode;

  return (
    <AccordionItem value={subagent.subagentId}>
      <div className="flex items-center gap-2">
        <AccordionTrigger className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            {subagent.status === "running" ? <Spinner /> : null}
            <span className="truncate">{agentTypeLabels[subagent.agentType]}</span>
            <Badge variant={subagent.status === "failed" ? "destructive" : "secondary"}>
              {statusLabels[subagent.status]}
            </Badge>
          </span>
        </AccordionTrigger>
        {isCancellable && cancelSubagent !== undefined ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void cancelSubagent(subagent.taskId, subagent.runId, subagent.subagentId)}
          >
            取消此子任务
          </Button>
        ) : null}
      </div>
      <AccordionContent>
        <div className="flex flex-col gap-3 pb-1 text-sm">
          <p>{subagent.objective}</p>
          <dl className="grid gap-1 text-muted-foreground">
            <div className="flex justify-between gap-2"><dt>来源</dt><dd>{subagent.targetSource ?? "自动探索"}</dd></div>
            {elapsed === null ? null : <div className="flex justify-between gap-2"><dt>耗时</dt><dd>{elapsed}</dd></div>}
            {subagent.progressMessage === null ? null : <div className="flex justify-between gap-2"><dt>当前步骤</dt><dd className="text-right">{subagent.progressMessage}</dd></div>}
          </dl>
          <Progress value={progress} aria-label="子任务进度" />
          {subagent.resultSummary === null ? null : <p className="text-muted-foreground">{subagent.resultSummary}</p>}
          {activities.length === 0 ? null : (
            <div className="flex flex-col gap-1 text-muted-foreground">
              <span className="font-medium text-foreground">执行记录</span>
              {activities.map((activity) => (
                <span key={activity.activityId} className="flex flex-col gap-0.5">
                  <span>{activity.name ?? activity.kind}</span>
                  {activity.message === null ? null : <span>{activity.message}</span>}
                  {activity.output === null ? null : <span>{activity.output}</span>}
                  {!activity.isError || activity.code === null ? null : <span>{activity.code}</span>}
                </span>
              ))}
            </div>
          )}
          {subagent.warnings.length === 0 ? null : (
            <div className="flex flex-col gap-1 text-muted-foreground">
              <span className="font-medium text-foreground">警告</span>
              {subagent.warnings.map((warning) => <span key={warning}>{warning}</span>)}
            </div>
          )}
          {errorDetail === null ? null : (
            <p className="flex items-start gap-2 text-destructive"><WarningCircleIcon data-icon="inline-start" />{errorDetail}</p>
          )}
          {subagent.sourceAssetIds.length === 0 ? null : <p className="text-muted-foreground">SourceAsset: {subagent.sourceAssetIds.join(", ")}</p>}
          {subagent.recipeId === null ? null : <p className="text-muted-foreground">Recipe: {subagent.recipeId}</p>}
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}
