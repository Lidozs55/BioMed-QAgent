import { useEffect, useState } from "react";
import { ArrowsOutIcon, DownloadIcon } from "@phosphor-icons/react";

import BuildResultsViewer from "@/components/BuildResultsViewer";
import { CsvPreview } from "@/components/artifacts/CsvPreview";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { useAPI } from "@/hooks/useAPI";
import { fileType, formatSize, triggerArtifactDownload } from "@/lib/fileUtils";
import type { BuildDetail, JsonValue } from "@/runtime/contracts";
import type { BuildReportItem } from "@/runtime/types";

interface BuildReportCardProps {
  item: BuildReportItem;
  download?: (url: string, filename: string) => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; detail: BuildDetail }
  | { status: "error" };

function summaryNumber(
  record: Record<string, JsonValue> | undefined,
  key: string,
): number | undefined {
  const value = record?.[key];
  return typeof value === "number" ? value : undefined;
}

function summaryString(
  record: Record<string, JsonValue> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function artifactName(relativePath: string): string {
  return relativePath.split("/").pop() ?? relativePath;
}

function SummaryCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/20 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="break-words text-sm font-medium">{value}</p>
    </div>
  );
}

function statusLabel(status: BuildDetail["build_result"] extends infer R
  ? R extends { status: infer S }
    ? S
    : never
  : never): string {
  switch (status) {
    case "succeeded":
      return "已完成";
    case "partial_success":
      return "部分完成";
    case "no_data":
      return "无主数据";
    case "spec_rejected":
      return "规格未通过";
    default:
      return "构建完成";
  }
}

export function BuildReportCard({ item, download = triggerArtifactDownload }: BuildReportCardProps) {
  const api = useAPI();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .fetchBuild(item.buildId, item.taskId)
      .then((detail) => {
        if (!cancelled) setState({ status: "ready", detail });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [api, item.buildId, item.taskId, reloadKey]);

  if (state.status === "loading") {
    return (
      <Card size="sm" className="w-full min-w-0">
        <CardContent className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Spinner />
          加载构建结果...
        </CardContent>
      </Card>
    );
  }

  if (state.status === "error") {
    return (
      <Card size="sm" className="w-full min-w-0">
        <Empty className="min-h-40">
          <EmptyHeader>
            <EmptyTitle>无法加载构建结果</EmptyTitle>
            <EmptyDescription>请稍后重试或检查任务状态。</EmptyDescription>
          </EmptyHeader>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setState({ status: "loading" });
              setReloadKey((key) => key + 1);
            }}
          >
            重试
          </Button>
        </Empty>
      </Card>
    );
  }

  const { detail } = state;
  const manifest = detail.manifest;
  const result = detail.build_result;
  const primary = manifest.artifacts.find((entry) => entry.role === "primary_dataset");
  const validation = manifest.validation_summary;
  const successfulSources = result?.successful_sources.length ?? 0;
  const rejectedSources = result?.rejected_sources.length ?? 0;
  const checkedCount = summaryNumber(validation, "checked_count");
  const failedCount = summaryNumber(validation, "failed_count");
  const anomalyCount = summaryNumber(manifest.confidence_summary, "detected_anomaly_count");
  const warningCount = manifest.artifacts.filter((entry) => /warning/i.test(artifactName(entry.relative_path))).length;
  const rowCount = result?.valid_row_count ?? manifest.row_count;

  const downloadAll = () => {
    for (const entry of detail.artifacts) {
      download(
        api.getBuildArtifactUrl(detail.build_id, entry.artifact_id, item.taskId),
        artifactName(entry.relative_path),
      );
    }
  };

  return (
    <>
      <Card size="sm" className="w-full min-w-0">
        <CardHeader>
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <CardTitle className="text-sm">数据构建结果</CardTitle>
                <Badge variant="outline">{manifest.dataset_family}</Badge>
                <Badge variant="outline">{manifest.row_granularity}</Badge>
                {result !== null && (
                  <Badge variant={result.status === "succeeded" ? "secondary" : "outline"}>
                    {statusLabel(result.status)}
                  </Badge>
                )}
              </div>
              <CardDescription>
                {rowCount} 行 · 构建 {detail.build_id}
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="展开详情"
              onClick={() => setDialogOpen(true)}
            >
              <ArrowsOutIcon aria-hidden="true" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          {result !== null && result.status !== "succeeded" && (
            <div
              className={
                result.status === "no_data"
                  ? "rounded-md border border-info/30 bg-info/5 px-3 py-2 text-sm"
                  : "rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-sm"
              }
            >
              <p className="font-medium">{result.user_summary || statusLabel(result.status)}</p>
              {result.recommended_next_action !== "" && (
                <p className="mt-1 text-xs text-muted-foreground">{result.recommended_next_action}</p>
              )}
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 items-baseline justify-between gap-2">
              <p className="text-sm font-medium">主数据预览</p>
              <p className="truncate text-xs text-muted-foreground">
                {primary === undefined
                  ? "没有主数据产物"
                  : `${artifactName(primary.relative_path)} · ${formatSize(primary.size_bytes)}`}
              </p>
            </div>
            {primary === undefined ? (
              <Empty className="border-0 py-5">
                <EmptyHeader>
                  <EmptyTitle>无主数据</EmptyTitle>
                  <EmptyDescription>本次构建没有生成主数据产物。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <CsvPreview
                artifactUrl={api.getBuildArtifactUrl(detail.build_id, primary.artifact_id, item.taskId)}
                noDataMessage="无数据"
                maxRows={10}
              />
            )}
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
            <SummaryCell
              label="来源"
              value={`${successfulSources} 成功 · ${rejectedSources} 被拒`}
            />
            <SummaryCell
              label="处理"
              value={`${summaryString(validation, "status") ?? "未知"} · ${checkedCount ?? "—"} 项 / ${failedCount ?? "—"} 失败 · ${anomalyCount ?? 0} 异常`}
            />
            <SummaryCell label="警告" value={`${warningCount} 个警告文件`} />
          </div>
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-3">
          {detail.artifacts.length > 0 && (
            <div className="flex min-w-0 flex-col gap-1.5">
              <p className="text-xs font-medium text-muted-foreground">生成产物</p>
              <ul aria-label="生成产物" className="flex min-w-0 flex-col gap-1">
                {detail.artifacts.map((artifact) => {
                  const name = artifactName(artifact.relative_path);
                  const { Icon } = fileType(name, artifact.role);
                  return (
                    <li
                      key={artifact.artifact_id}
                      className="flex min-w-0 items-center gap-2 rounded-md bg-background/60 px-2 py-1.5 text-xs"
                      title={`${name} · ${formatSize(artifact.size_bytes)}`}
                    >
                      <Icon aria-hidden="true" className="shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <span className="shrink-0 text-muted-foreground">{formatSize(artifact.size_bytes)}</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={downloadAll}
            disabled={detail.artifacts.length === 0}
          >
            <DownloadIcon data-icon="inline-start" aria-hidden="true" />
            下载所有
          </Button>
        </CardFooter>
      </Card>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="flex max-h-[85vh] max-w-[min(1120px,calc(100vw-2rem))] flex-col sm:max-w-[min(1120px,calc(100vw-2rem))]">
          <DialogHeader>
            <DialogTitle>构建详情</DialogTitle>
            <DialogDescription>
              {manifest.dataset_family} · {detail.build_id}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <BuildResultsViewer buildId={detail.build_id} taskId={item.taskId} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
