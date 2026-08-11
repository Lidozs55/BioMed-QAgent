import { useEffect, useState } from "react";

import BuildResultsViewer from "@/components/BuildResultsViewer";
import { useAPI } from "@/hooks/useAPI";
import { useTaskBuildId } from "@/hooks/useTaskBuild";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DatabaseIcon,
  DownloadIcon,
  InfoIcon,
} from "@phosphor-icons/react";
import type { ActivityProjection, ArtifactProjection } from "@/runtime/types";
import {
  selectActiveActivities,
  selectActiveArtifacts,
  selectActiveTask,
} from "@/stores/agentSelectors";
import { useAgentStore } from "@/stores/agentStore";
import {
  fileType,
  formatSize,
  getExtension,
  triggerArtifactDownload,
} from "@/lib/fileUtils";
import { fetchPreviewText, parseCSV } from "@/lib/csvUtils";
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

export function CsvPreview({
  artifactUrl,
  noDataMessage,
  maxRows = 100,
}: {
  artifactUrl: string;
  noDataMessage?: string;
  maxRows?: number;
}) {
  const [state, setState] = useState<{
    url: string;
    data: ReturnType<typeof parseCSV> | null;
    error: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPreviewText(artifactUrl)
      .then((text) => {
        if (!cancelled) setState({ url: artifactUrl, data: parseCSV(text), error: false });
      })
      .catch(() => {
        if (!cancelled) setState({ url: artifactUrl, data: null, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [artifactUrl]);

  if (state?.url !== artifactUrl) {
    return (
      <div className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground">
        <Spinner />
        加载中...
      </div>
    );
  }
  if (state.error) {
    return <Empty className="border-0 py-4"><EmptyHeader><EmptyTitle>无法加载 CSV 数据</EmptyTitle></EmptyHeader></Empty>;
  }
  if (state.data === null || state.data.headers.length === 0 || state.data.rows.length === 0) {
    const headerNote =
      state.data !== null && state.data.headers.length > 0
        ? `仅含表头：${state.data.headers.join("、")}`
        : undefined;
    return (
      <Empty className="border-0 py-4">
        <EmptyHeader>
          <EmptyTitle>{noDataMessage ?? "无数据"}</EmptyTitle>
          {headerNote !== undefined && (
            <EmptyDescription>{headerNote}</EmptyDescription>
          )}
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="max-w-full overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {state.data.headers.map((header, index) => (
              <TableHead key={`${header}-${index}`} className="whitespace-nowrap text-xs">
                {header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
            {state.data.rows.slice(0, maxRows).map((row, rowIndex) => (
            <TableRow key={`row-${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <TableCell key={`${rowIndex}-${cellIndex}`} className="whitespace-nowrap text-xs">
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {(state.data.truncated || state.data.rows.length > maxRows) && (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          仅显示前 {maxRows} 行
        </p>
      )}
    </div>
  );
}

function ArtifactCard({
  artifact,
  taskId,
  noDataMessage,
}: {
  artifact: ArtifactProjection;
  taskId: string;
  noDataMessage?: string;
}) {
  const { getArtifactUrl } = useAPI();
  const { Icon, label } = fileType(artifact.name, artifact.role);
  const ext = getExtension(artifact.name);
  const url = getArtifactUrl(taskId, artifact.artifact_id);
  const isCsvPreviewable = ext === "csv" || ext === "tsv" || ext === "txt";
  const isPreviewable = isCsvPreviewable;

  return (
    <Card size="sm" className="min-w-0">
      <CardHeader>
        <div className="flex min-w-0 items-center gap-2">
          <Icon aria-hidden="true" className="shrink-0 text-muted-foreground" />
          <CardTitle className="min-w-0 truncate" title={artifact.name}>
            {artifact.name}
          </CardTitle>
          <Badge variant="outline" className="shrink-0">{label}</Badge>
        </div>
        <CardDescription>{formatSize(artifact.size)}</CardDescription>
      </CardHeader>
      {isPreviewable && (
        <CardContent>
          <Accordion>
            <AccordionItem value={`csv-preview-${artifact.artifact_id}`}>
              <AccordionTrigger>CSV 预览</AccordionTrigger>
              <AccordionContent><CsvPreview artifactUrl={url} noDataMessage={noDataMessage} /></AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
      )}
      <CardFooter>
        <Button
          variant="outline"
          size="sm"
          onClick={() => triggerArtifactDownload(url, artifact.name)}
        >
          <DownloadIcon data-icon="inline-start" />
          下载
        </Button>
      </CardFooter>
    </Card>
  );
}

interface ResultsViewerProps {
  taskId?: string | null;
  artifacts?: readonly ArtifactProjection[];
  activities?: readonly ActivityProjection[];
  /** V2 build id — renders the manifest-driven view for this build. */
  buildId?: string | null;
}

export default function ResultsViewer({
  taskId: taskIdOverride,
  artifacts: artifactOverride,
  activities: activityOverride,
  buildId: buildIdOverride,
}: ResultsViewerProps = {}) {
  const task = useAgentStore(selectActiveTask);
  const tasksById = useAgentStore((state) => state.tasksById);
  const activeArtifacts = useAgentStore(selectActiveArtifacts);
  const activeActivities = useAgentStore(selectActiveActivities);
  const taskId = taskIdOverride ?? task?.summary.task_id ?? null;
  const artifacts = artifactOverride ?? activeArtifacts;
  const activities = activityOverride ?? activeActivities;
  // V2 builds are served by the builds API, not the legacy artifact store
  // (Phase 7 T1: V2 build files are deliberately not emitted as V1 artifact
  // events). When a buildId is not given, derive it from the task's latest
  // completed run via the builds API — but only for the full task view
  // (no overrides), so the ArtifactSheet single-artifact preview keeps its
  // legacy behavior.
  const hasViewOverrides =
    artifactOverride !== undefined || activityOverride !== undefined;
  const buildState = useTaskBuildId(
    buildIdOverride == null && !hasViewOverrides ? taskId : null,
  );
  const resolvedBuildId = buildIdOverride ?? buildState.buildId;
  // The run summary (latestRun/buildResult/noDataMessage) must describe the
  // SAME task the rendered artifacts belong to. The store keeps every loaded
  // task keyed by task_id, so when overrides target another task the summary
  // resolves from that task's own runs; when the overridden task is not in
  // the store the summary is suppressed entirely rather than misattributing
  // the active task's outcome to another task's artifacts (final review
  // FIX 3). The no-override path stays byte-identical.
  const hasRunOverrides =
    taskIdOverride !== undefined || artifactOverride !== undefined;
  const runSourceTask = hasRunOverrides
    ? (taskId === null ? undefined : tasksById[taskId])
    : task;
  const latestRunId =
    runSourceTask?.runOrder[runSourceTask.runOrder.length - 1];
  const latestRun =
    latestRunId === undefined
      ? undefined
      : runSourceTask?.runsById[latestRunId];
  const buildResult = latestRun?.summary?.build_result;
  // The empty-state title and the per-artifact preview message describe the
  // LATEST run's outcome. The empty state is only rendered when NO artifacts
  // exist (ownership is trivially satisfied), so it may use the plain latest
  // NO_DATA message. The preview message, however, renders over whatever
  // artifacts are listed — the artifact list is reset at each run_manifest
  // and accumulates that cycle's artifacts, so when the latest NO_DATA run
  // produced none (available_artifact_roles: [] — e.g. acquisition found
  // nothing), the visible artifacts belong to an EARLIER run and must not
  // carry this run's NO_DATA message.
  const noDataMessage =
    buildResult?.status === "no_data"
      ? latestRun?.summary?.user_message ?? "无数据"
      : undefined;
  const noDataOwnsArtifacts =
    buildResult?.status === "no_data" &&
    buildResult != null &&
    buildResult.available_artifact_roles.length > 0 &&
    artifacts.length > 0;
  const previewNoDataMessage = noDataOwnsArtifacts
    ? noDataMessage
    : undefined;
  const noDataContext =
    buildResult?.status === "no_data" &&
    (buildResult.user_summary !== "" ||
      buildResult.recommended_next_action !== "")
      ? {
          userSummary:
            buildResult.user_summary === ""
              ? "无数据"
              : buildResult.user_summary,
          recommendedNextAction: buildResult.recommended_next_action,
        }
      : undefined;
  // The banner describes the LATEST run's outcome, so it may only render
  // over that run's OWN artifacts (see noDataOwnsArtifacts above).
  const showNoDataBanner =
    noDataContext !== undefined && noDataOwnsArtifacts;

  if (resolvedBuildId !== null) {
    return <BuildResultsViewer buildId={resolvedBuildId} taskId={taskId} />;
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
      <div className="flex min-w-0 items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Spinner />
        处理中...
      </div>
    );
  }
  if (artifacts.length === 0) {
    return (
      <Empty className="min-h-48">
        <EmptyHeader>
          <EmptyTitle>{noDataMessage ?? "暂无结果"}</EmptyTitle>
          <EmptyDescription>该任务尚未生成可下载的产物。</EmptyDescription>
        </EmptyHeader>
      </Empty>
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
      {showNoDataBanner && (
        <div className="flex min-w-0 items-start gap-2 rounded-lg border border-sky-600/30 bg-sky-600/5 p-3">
          <InfoIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-sky-600 dark:text-sky-400"
          />
          <div className="min-w-0">
            <p className="text-sm font-medium leading-snug">
              {noDataContext.userSummary}
            </p>
            {noDataContext.recommendedNextAction !== "" && (
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {noDataContext.recommendedNextAction}
              </p>
            )}
          </div>
        </div>
      )}
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="flex min-w-0 flex-col gap-3">
          {artifacts.map((artifact) => (
            <ArtifactCard
              key={artifact.artifact_id}
              artifact={artifact}
              taskId={taskId}
              noDataMessage={previewNoDataMessage}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
