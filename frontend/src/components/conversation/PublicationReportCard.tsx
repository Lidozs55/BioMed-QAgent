import { useEffect, useState } from "react";
import { ArrowsOutIcon, DownloadIcon } from "@phosphor-icons/react";

import PublicationResultsViewer from "@/components/PublicationResultsViewer";
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
import type { PublicationDetail, JsonValue } from "@/runtime/contracts";
import type { PublicationReportItem } from "@/runtime/types";

interface PublicationReportCardProps {
  item: PublicationReportItem;
  download?: (url: string, filename: string) => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; detail: PublicationDetail }
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

export function PublicationReportCard({ item, download = triggerArtifactDownload }: PublicationReportCardProps) {
  const api = useAPI();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .fetchPublication(item.publicationId, item.taskId)
      .then((detail) => {
        if (!cancelled) setState({ status: "ready", detail });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [api, item.publicationId, item.taskId, reloadKey]);

  if (state.status === "loading") {
    return (
      <Card size="sm" className="w-full min-w-0">
        <CardContent className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Spinner />
          加载发布产物...
        </CardContent>
      </Card>
    );
  }

  if (state.status === "error") {
    return (
      <Card size="sm" className="w-full min-w-0">
        <Empty className="min-h-40">
          <EmptyHeader>
            <EmptyTitle>无法加载发布产物</EmptyTitle>
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
  const primary = manifest.artifacts.find((entry) => entry.role === "primary_dataset");
  const validation = manifest.validation_summary;
  const checkedCount = summaryNumber(validation, "checked_count");
  const failedCount = summaryNumber(validation, "failed_count");
  const anomalyCount = summaryNumber(manifest.confidence_summary, "detected_anomaly_count");
  const warningCount = manifest.artifacts.filter((entry) => /warning/i.test(artifactName(entry.relative_path))).length;
  const rowCount = manifest.row_count;

  const downloadAll = () => {
    for (const entry of detail.artifacts) {
      download(
        api.getPublicationArtifactUrl(detail.publication_id, entry.artifact_id, item.taskId),
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
                <CardTitle className="text-sm">数据发布产物</CardTitle>
                <Badge variant="outline">{manifest.dataset_family}</Badge>
                <Badge variant="outline">{manifest.row_granularity}</Badge>
                <Badge variant="secondary">已发布</Badge>
              </div>
              <CardDescription>
                {rowCount} 行 · 需求 {detail.requirement_id}
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
                  <EmptyDescription>本次发布没有主数据产物。</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <CsvPreview
                artifactUrl={api.getPublicationArtifactUrl(detail.publication_id, primary.artifact_id, item.taskId)}
                noDataMessage="无数据"
                maxRows={10}
              />
            )}
          </div>
          <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
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
            <DialogTitle>发布详情</DialogTitle>
            <DialogDescription>
              {manifest.dataset_family} · {detail.requirement_id}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <PublicationResultsViewer publicationId={detail.publication_id} taskId={item.taskId} />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
