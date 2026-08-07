import { useEffect, useState } from "react";
import Papa from "papaparse";

import { useAPI } from "@/hooks/useAPI";
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
import { isActiveStatus } from "@/runtime/reducer";

function parseCSV(text: string): {
  headers: string[];
  rows: string[][];
  truncated: boolean;
} {
  if (text.trim() === "") {
    return { headers: [], rows: [], truncated: false };
  }
  const parsed = Papa.parse<string[]>(text, {
    preview: 101,
    skipEmptyLines: "greedy",
  });
  if (parsed.errors.length > 0) throw new Error(parsed.errors[0].message);
  const [headers = [], ...rows] = parsed.data;
  return {
    headers: headers.map((header) => header.trim()),
    rows: rows.map((row) => row.map((cell) => cell.trim())),
    truncated: parsed.meta.truncated,
  };
}

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

function CsvPreview({
  artifactUrl,
  noDataMessage,
}: {
  artifactUrl: string;
  noDataMessage?: string;
}) {
  const [state, setState] = useState<{
    url: string;
    data: ReturnType<typeof parseCSV> | null;
    error: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch(artifactUrl)
      .then((response) => {
        if (!response.ok) throw new Error("fetch failed");
        return response.text();
      })
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
  if (state.data === null || state.data.headers.length === 0) {
    return (
      <Empty className="border-0 py-4">
        <EmptyHeader>
          <EmptyTitle>{noDataMessage ?? "无数据"}</EmptyTitle>
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
          {state.data.rows.slice(0, 100).map((row, rowIndex) => (
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
      {state.data.truncated && (
        <p className="px-2 py-1 text-xs text-muted-foreground">仅显示前 100 行</p>
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
  const { Icon, label } = fileType(artifact.name);
  const url = getArtifactUrl(taskId, artifact.artifact_id);
  const isCsv = getExtension(artifact.name) === "csv";

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
      {isCsv && (
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
}

export default function ResultsViewer({
  taskId: taskIdOverride,
  artifacts: artifactOverride,
  activities: activityOverride,
}: ResultsViewerProps = {}) {
  const task = useAgentStore(selectActiveTask);
  const activeArtifacts = useAgentStore(selectActiveArtifacts);
  const activeActivities = useAgentStore(selectActiveActivities);
  const taskId = taskIdOverride ?? task?.summary.task_id ?? null;
  const artifacts = artifactOverride ?? activeArtifacts;
  const activities = activityOverride ?? activeActivities;
  const latestRunId = task?.runOrder[task.runOrder.length - 1];
  const latestRun =
    latestRunId === undefined ? undefined : task?.runsById[latestRunId];
  const noDataMessage =
    latestRun?.summary?.build_result?.status === "no_data"
      ? latestRun.summary.user_message ?? "无数据"
      : undefined;

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
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        <div className="flex min-w-0 flex-col gap-3">
          {artifacts.map((artifact) => (
            <ArtifactCard
              key={artifact.artifact_id}
              artifact={artifact}
              taskId={taskId}
              noDataMessage={noDataMessage}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
