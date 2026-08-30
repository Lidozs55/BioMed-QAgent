import PublicationResultsViewer from "@/components/PublicationResultsViewer";
import QuarantinePanel from "@/components/QuarantinePanel";
import { ArtifactCard } from "@/components/artifacts/ArtifactCard";
import { useTaskPublicationId } from "@/hooks/useTaskPublication";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { DatabaseIcon } from "@phosphor-icons/react";
import type { ActivityProjection, ArtifactProjection } from "@/runtime/types";
import {
  selectActiveActivities,
  selectActiveArtifacts,
  selectActiveTask,
} from "@/stores/agentSelectors";
import { useAgentStore } from "@/stores/agentStore";
import { isActiveStatus } from "@/runtime/reducer";

interface SourceEntry {
  id: string;
  tool: string;
  summary: string;
  details: string;
}

function parseSourceManifest(activities: readonly ActivityProjection[]): SourceEntry[] {
  return activities.flatMap((activity) => {
    if (
      activity.kind !== "tool" ||
      activity.status !== "completed" ||
      activity.output === null ||
      !activity.name?.toLowerCase().includes("search")
    ) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(activity.output);
      if (typeof parsed !== "object" || parsed === null) {
        return [{ id: activity.activityId, tool: activity.name, summary: "来源信息已获取", details: activity.output }];
      }
      const record = parsed as Record<string, unknown>;
      if (Array.isArray(record.databases)) {
        return [{
          id: activity.activityId,
          tool: activity.name,
          summary: `${record.databases.length} 个数据库`,
          details: record.databases.join("、"),
        }];
      }
      if (typeof record.count === "number") {
        return [{
          id: activity.activityId,
          tool: activity.name,
          summary: `${record.count} 条记录`,
          details: JSON.stringify(record.results ?? record).slice(0, 200),
        }];
      }
      const results = record.results;
      return [{
        id: activity.activityId,
        tool: activity.name,
        summary: `${Array.isArray(results) ? results.length : "?"} 条结果`,
        details: JSON.stringify(results ?? record).slice(0, 200),
      }];
    } catch {
      return [{
        id: activity.activityId,
        tool: activity.name,
        summary: "来源信息已获取",
        details: activity.output.slice(0, 200),
      }];
    }
  });
}

interface ResultsViewerProps {
  taskId?: string | null;
  artifacts?: readonly ArtifactProjection[];
  activities?: readonly ActivityProjection[];
  /** Immutable Publication id for the manifest-driven product view. */
  publicationId?: string | null;
}

export default function ResultsViewer({
  taskId: taskIdOverride,
  artifacts: artifactOverride,
  activities: activityOverride,
  publicationId: publicationIdOverride,
}: ResultsViewerProps = {}) {
  const task = useAgentStore(selectActiveTask);
  const activeArtifacts = useAgentStore(selectActiveArtifacts);
  const activeActivities = useAgentStore(selectActiveActivities);
  const taskId = taskIdOverride ?? task?.summary.task_id ?? null;
  const artifacts = artifactOverride ?? activeArtifacts;
  const activities = activityOverride ?? activeActivities;
  // Publications are loaded from the product API. Without an explicit id, use
  // the current task projection only for the full task view; an artifact-sheet
  // override remains scoped to that artifact.
  const hasViewOverrides =
    artifactOverride !== undefined || activityOverride !== undefined;
  const executionState = useTaskPublicationId(
    publicationIdOverride == null && !hasViewOverrides ? taskId : null,
  );
  const resolvedPublicationId = publicationIdOverride ?? executionState.publicationId;

  if (resolvedPublicationId !== null) {
    return (
      <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto">
        <PublicationResultsViewer publicationId={resolvedPublicationId} taskId={taskId} />
        {taskId !== null && <QuarantinePanel taskId={taskId} />}
      </div>
    );
  }

  if (taskId === null) {
    return (
      <Empty className="min-h-48">
        <EmptyHeader>
          <EmptyTitle>选择任务查看结果</EmptyTitle>
          <EmptyDescription>选择一个任务后，这里会显示其产物和来源。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const isActive = artifactOverride === undefined &&
    task !== undefined &&
    isActiveStatus(task.summary.status);
  if (artifacts.length === 0 && isActive) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col gap-4 overflow-y-auto">
        <div className="flex min-w-0 items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Spinner />
          处理中...
        </div>
        <QuarantinePanel taskId={taskId} />
      </div>
    );
  }
  if (artifacts.length === 0) {
    return (
      <div className="flex h-full min-h-0 min-w-0 flex-col gap-4 overflow-y-auto">
        <Empty className="min-h-48">
          <EmptyHeader>
            <EmptyTitle>暂无结果</EmptyTitle>
            <EmptyDescription>该任务尚未生成可下载的产物。</EmptyDescription>
          </EmptyHeader>
        </Empty>
        <QuarantinePanel taskId={taskId} />
      </div>
    );
  }

  const sourceData = parseSourceManifest(activities);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-4">
      {sourceData.length > 0 && (
        <Accordion>
          <AccordionItem value="source-manifest">
            <AccordionTrigger>
              <DatabaseIcon aria-hidden="true" />
              数据来源
            </AccordionTrigger>
            <AccordionContent>
              <div className="flex min-w-0 flex-col gap-2">
                {sourceData.map((entry) => (
                  <Card key={entry.id} size="sm" className="min-w-0">
                    <CardHeader>
                      <CardTitle className="truncate text-xs font-mono" title={entry.tool}>{entry.tool}</CardTitle>
                      <CardDescription>{entry.summary}</CardDescription>
                    </CardHeader>
                    <CardContent>
                      <pre className="max-w-full whitespace-pre-wrap break-words font-mono text-[0.625rem] leading-relaxed text-muted-foreground">{entry.details}</pre>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      )}
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="flex min-w-0 flex-col gap-3">
          {artifacts.map((artifact) => (
            <ArtifactCard
              key={artifact.artifact_id}
              artifact={artifact}
              taskId={taskId}
            />
          ))}
          <QuarantinePanel taskId={taskId} />
        </div>
      </ScrollArea>
    </div>
  );
}
