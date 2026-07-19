import {
  CheckCircleIcon,
  DatabaseIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import type { StageName } from "@/runtime/contracts";
import type { ActivityProjection, TaskProjection } from "@/runtime/types";

const STAGE_LABELS: Record<StageName, string> = {
  discovery: "文献/数据发现",
  acquisition: "数据获取",
  processing: "数据处理",
  artifact_build: "产物构建",
  validation: "结果验证",
};

const PROGRESS_LABELS: Record<string, string> = {
  discovered_records: "已发现记录",
  downloaded_bytes: "已下载",
  downloaded_records: "已下载记录",
  parsed: "已解析",
  cleaned_rows: "已清洗行数",
};

type BadgeVariant = "secondary" | "outline" | "destructive";

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatProgressValue(kind: string, value: number): string {
  return kind === "downloaded_bytes" ? formatBytes(value) : String(value);
}

function toolStatus(activity: ActivityProjection): {
  label: string;
  variant: BadgeVariant;
} {
  if (activity.status === "started") {
    return { label: "工具运行中", variant: "secondary" };
  }
  if (activity.isError) {
    return { label: "工具错误", variant: "destructive" };
  }
  return { label: "工具完成", variant: "outline" };
}

function stageStatus(activity: ActivityProjection): {
  label: string;
  variant: BadgeVariant;
} {
  if (activity.status === "started") {
    return { label: "阶段运行中", variant: "secondary" };
  }
  if (activity.status === "failed") {
    return {
      label: activity.stage === "validation" ? "验证失败" : "阶段失败",
      variant: "destructive",
    };
  }
  if (activity.status === "skipped") {
    return { label: "阶段跳过", variant: "outline" };
  }
  return {
    label: activity.stage === "validation" ? "验证通过" : "阶段完成",
    variant: "outline",
  };
}

function SummaryActivity({ activity }: { activity: ActivityProjection }) {
  if (activity.kind === "reasoning") {
    return (
      <div className="rounded-md bg-muted/50 px-3 py-2 text-sm leading-6 whitespace-pre-wrap">
        {activity.output}
      </div>
    );
  }

  if (activity.kind === "tool") {
    const status = toolStatus(activity);
    return (
      <Marker>
        <MarkerIcon><DatabaseIcon aria-hidden="true" /></MarkerIcon>
        <MarkerContent className="flex flex-1 items-center justify-between gap-2">
          <span className="min-w-0 truncate font-mono">{activity.name}</span>
          <Badge variant={status.variant}>{status.label}</Badge>
        </MarkerContent>
      </Marker>
    );
  }

  if (activity.kind === "stage" && activity.stage !== undefined) {
    const status = stageStatus(activity);
    return (
      <Marker>
        <MarkerIcon><CheckCircleIcon aria-hidden="true" /></MarkerIcon>
        <MarkerContent className="flex flex-1 items-center justify-between gap-2">
          <span>{STAGE_LABELS[activity.stage]}</span>
          <Badge variant={status.variant}>{status.label}</Badge>
        </MarkerContent>
      </Marker>
    );
  }

  if (activity.kind === "progress" && activity.progress !== undefined) {
    const { stage, kind, current, total } = activity.progress;
    const label = PROGRESS_LABELS[kind] ?? "进度值";
    const value = formatProgressValue(kind, current);
    const totalText = total === null
      ? ""
      : ` / ${formatProgressValue(kind, total)}`;
    return (
      <Marker>
        <MarkerIcon><DatabaseIcon aria-hidden="true" /></MarkerIcon>
        <MarkerContent className="flex flex-1 items-center justify-between gap-2">
          <span>{STAGE_LABELS[stage]} · {label}：{value}{totalText}</span>
          <Badge variant="secondary">进度</Badge>
        </MarkerContent>
      </Marker>
    );
  }

  if (activity.kind === "warning") {
    const text = [activity.code, activity.message].filter(Boolean).join("：");
    return (
      <Marker>
        <MarkerIcon><WarningCircleIcon aria-hidden="true" /></MarkerIcon>
        <MarkerContent className="flex flex-1 items-center justify-between gap-2">
          <span>{text || "执行警告"}</span>
          <Badge variant={activity.isError ? "destructive" : "outline"}>警告</Badge>
        </MarkerContent>
      </Marker>
    );
  }

  return null;
}

interface ExecutionSummaryProps {
  task: TaskProjection;
  runId: string;
  active: boolean;
}

export function ExecutionSummary({ task, runId }: ExecutionSummaryProps) {
  const activities = task.activityOrder
    .map((activityId) => task.activitiesById[activityId])
    .filter(
      (activity): activity is ActivityProjection =>
        activity !== undefined &&
        activity.runId === runId &&
        (activity.kind === "tool" ||
          activity.kind === "reasoning" ||
          activity.kind === "stage" ||
          activity.kind === "progress" ||
          activity.kind === "warning"),
    );
  if (activities.length === 0) return null;

  return (
    <Accordion
      defaultValue={[]}
      className="mt-2"
      data-execution-summary="true"
    >
      <AccordionItem value="execution">
        <AccordionTrigger>
          <span className="flex items-center gap-2">
            思考过程 · 执行摘要
            <Badge variant="secondary">{activities.length}</Badge>
          </span>
        </AccordionTrigger>
        <AccordionContent className="flex flex-col gap-2 pt-1">
          {activities.map((activity) => (
            <SummaryActivity key={activity.activityId} activity={activity} />
          ))}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
