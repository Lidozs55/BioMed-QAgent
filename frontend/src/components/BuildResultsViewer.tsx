import { useEffect, useState } from "react";
import {
  InfoIcon,
  WarningCircleIcon,
} from "@phosphor-icons/react";

import { BuildArtifactCard } from "@/components/artifacts/BuildArtifactCard";
import { artifactBasename } from "@/components/artifacts/artifactPreview";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { useAPI } from "@/hooks/useAPI";
import { cn } from "@/lib/utils";
import type {
  BuildDetail,
  BuildResult,
  BuildResultStatus,
  JsonValue,
} from "@/runtime/contracts";

/* ------------------------------------------------------------------ */
/*  Manifest summary helpers (defensive narrowing over JsonValue)      */
/* ------------------------------------------------------------------ */

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

function summaryRecord(
  record: Record<string, JsonValue> | undefined,
  key: string,
): Record<string, JsonValue> | undefined {
  const value = record?.[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function formatCoverage(ratio: number | undefined): string {
  if (ratio === undefined || !Number.isFinite(ratio)) return "—";
  return `${(ratio * 100).toFixed(2)}%`;
}

/* ------------------------------------------------------------------ */
/*  Outcome banner: NO_DATA / PARTIAL_SUCCESS / SPEC_REJECTED          */
/*  NO_DATA is informational (sky) — never a red internal error.       */
/* ------------------------------------------------------------------ */

const BANNER_STYLES: Partial<
  Record<BuildResultStatus, { className: string; iconClass: string; Icon: typeof InfoIcon }>
> = {
  no_data: {
    className: "border-info/30 bg-info/5",
    iconClass: "text-info",
    Icon: InfoIcon,
  },
  partial_success: {
    className: "border-warning/30 bg-warning/5",
    iconClass: "text-warning",
    Icon: WarningCircleIcon,
  },
  spec_rejected: {
    className: "border-warning/30 bg-warning/5",
    iconClass: "text-warning",
    Icon: WarningCircleIcon,
  },
};

function BuildBanner({ result }: { result: BuildResult }) {
  if (result.status === "succeeded") return null;
  const style = BANNER_STYLES[result.status];
  if (style === undefined) return null;
  const { className, iconClass, Icon } = style;
  const title = result.user_summary !== "" ? result.user_summary : "构建未完成";
  return (
    <div
      data-status={result.status}
      className={cn("flex min-w-0 items-start gap-2 rounded-lg border p-3", className)}
    >
      <Icon
        aria-hidden="true"
        className={cn("mt-0.5 size-4 shrink-0", iconClass)}
      />
      <div className="min-w-0">
        <p className="text-sm font-medium leading-snug">{title}</p>
        {result.recommended_next_action !== "" && (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {result.recommended_next_action}
          </p>
        )}
        {result.reason_codes.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {result.reason_codes.map((code) => (
              <Badge key={code} variant="outline">{code}</Badge>
            ))}
          </div>
        )}
        {result.binding_failures !== undefined && result.binding_failures.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1 border-t pt-2 text-xs text-muted-foreground">
            {result.binding_failures.map((failure) => (
              <li key={failure.binding_id} className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium text-foreground">{failure.binding_id}</span>
                <Badge variant="outline">{failure.reason_code}</Badge>
                {failure.message !== "" && <span>{failure.message}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Small building blocks                                              */
/* ------------------------------------------------------------------ */

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate text-sm font-medium">{value}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Tab contents                                                       */
/* ------------------------------------------------------------------ */

function PrimaryDataTab({
  detail,
  taskId,
}: {
  detail: BuildDetail;
  taskId?: string | null;
}) {
  const primary = detail.manifest.artifacts.find(
    (entry) => entry.role === "primary_dataset",
  );
  if (primary === undefined) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>无主数据</EmptyTitle>
          <EmptyDescription>本次构建没有生成主数据产物。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <BuildArtifactCard
        entry={primary}
        buildId={detail.build_id}
        taskId={taskId}
        previewCsv
      />
    </div>
  );
}

function SourceTab({
  detail,
  taskId,
}: {
  detail: BuildDetail;
  taskId?: string | null;
}) {
  const provenance = detail.manifest.provenance_summary;
  const coverage = summaryRecord(provenance, "coverage");
  const traced = summaryNumber(coverage, "traced_rows");
  const untraced = summaryNumber(coverage, "untraced_rows");
  const ratio = summaryNumber(coverage, "coverage_ratio");
  const sourceCount = summaryNumber(provenance, "source_count");
  const mappingCount = summaryNumber(provenance, "field_mapping_count");
  const dedupCount = summaryNumber(provenance, "dedup_count");
  const conflictCount = summaryNumber(provenance, "conflict_count");
  const provenanceEntry = detail.manifest.artifacts.find(
    (entry) => entry.role === "provenance",
  );
  const schemaEntry = detail.manifest.artifacts.find(
    (entry) => entry.role === "schema",
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Card size="sm" className="min-w-0">
        <CardHeader>
          <CardTitle className="text-sm">溯源覆盖详情</CardTitle>
          <CardDescription>主数据行与来源资产的关联统计</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <SummaryStat label="覆盖率" value={formatCoverage(ratio)} />
            <SummaryStat label="已追踪行" value={String(traced ?? "—")} />
            <SummaryStat label="未追踪行" value={String(untraced ?? "—")} />
            <SummaryStat label="来源数" value={String(sourceCount ?? "—")} />
            <SummaryStat label="字段映射" value={String(mappingCount ?? "—")} />
            <SummaryStat label="去重 / 冲突" value={`${dedupCount ?? "—"} / ${conflictCount ?? "—"}`} />
          </div>
        </CardContent>
      </Card>
      {provenanceEntry !== undefined && (
        <BuildArtifactCard
          entry={provenanceEntry}
          buildId={detail.build_id}
          taskId={taskId}
        />
      )}
      {schemaEntry !== undefined && (
        <BuildArtifactCard
          entry={schemaEntry}
          buildId={detail.build_id}
          taskId={taskId}
        />
      )}
    </div>
  );
}

function ProcessingTab({
  detail,
  taskId,
}: {
  detail: BuildDetail;
  taskId?: string | null;
}) {
  const validation = detail.manifest.validation_summary;
  const confidence = detail.manifest.confidence_summary;
  const validationStatus = summaryString(validation, "status");
  const checkedCount = summaryNumber(validation, "checked_count");
  const failedCount = summaryNumber(validation, "failed_count");
  const profileRef = summaryString(validation, "profile_ref");
  const anomalyCount = summaryNumber(confidence, "detected_anomaly_count");
  const reportFile = summaryString(confidence, "report_file");
  const auditEntries = detail.manifest.artifacts.filter(
    (entry) => entry.role === "audit_report",
  );

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Card size="sm" className="min-w-0">
        <CardHeader>
          <CardTitle className="text-sm">校验与置信度</CardTitle>
          <CardDescription>{profileRef ?? "Validation profile"}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Validation</p>
              <Badge
                variant={validationStatus === "failed" ? "destructive" : "secondary"}
              >
                {validationStatus ?? "unknown"}
              </Badge>
            </div>
            <SummaryStat
              label="检查项"
              value={`${checkedCount ?? "—"} / ${failedCount ?? "—"}`}
            />
            <SummaryStat
              label="置信度异常"
              value={`检测到 ${anomalyCount ?? 0} 处异常`}
            />
            {reportFile !== undefined && (
              <SummaryStat label="置信度报告" value={reportFile} />
            )}
          </div>
        </CardContent>
      </Card>
      {auditEntries.map((entry) => (
        <BuildArtifactCard
          key={entry.artifact_id}
          entry={entry}
          buildId={detail.build_id}
          taskId={taskId}
          previewCsv
        />
      ))}
    </div>
  );
}

function WarningsTab({
  detail,
  taskId,
}: {
  detail: BuildDetail;
  taskId?: string | null;
}) {
  const warningEntries = detail.manifest.artifacts.filter((entry) =>
    /warning/i.test(artifactBasename(entry)),
  );
  if (warningEntries.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>无警告</EmptyTitle>
          <EmptyDescription>未发现警告文件，本次构建没有需要关注的警告。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {warningEntries.map((entry) => (
        <BuildArtifactCard
          key={entry.artifact_id}
          entry={entry}
          buildId={detail.build_id}
          taskId={taskId}
          previewCsv
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  BuildResultsViewer                                                 */
/* ------------------------------------------------------------------ */

interface BuildResultsViewerProps {
  buildId: string;
  taskId?: string | null;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; detail: BuildDetail }
  | { status: "error" };

function BuildViewerContent({
  buildId,
  taskId,
}: {
  buildId: string;
  taskId?: string | null;
}) {
  const api = useAPI();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api
      .fetchBuild(buildId, taskId)
      .then((detail) => {
        if (!cancelled) setState({ status: "ready", detail });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [api, buildId, taskId, reloadKey]);

  if (state.status === "loading") {
    return (
      <div className="flex min-w-0 items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Spinner />
        加载构建结果...
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <Empty className="min-h-48">
        <EmptyHeader>
          <EmptyTitle>无法加载构建结果</EmptyTitle>
          <EmptyDescription>请稍后重试或检查任务状态。</EmptyDescription>
        </EmptyHeader>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setReloadKey((key) => key + 1)}
        >
          重试
        </Button>
      </Empty>
    );
  }

  const { detail } = state;
  const manifest = detail.manifest;
  const result = detail.build_result;
  const rowCount = result?.valid_row_count ?? manifest.row_count;
  const successfulSources = result?.successful_sources.length ?? 0;
  const rejectedSources = result?.rejected_sources.length ?? 0;
  const validation = manifest.validation_summary;
  const checkedCount = summaryNumber(validation, "checked_count");
  const failedCount = summaryNumber(validation, "failed_count");
  const anomalyCount = summaryNumber(
    manifest.confidence_summary,
    "detected_anomaly_count",
  );
  const coverage = summaryRecord(manifest.provenance_summary, "coverage");
  const coverageRatio = formatCoverage(summaryNumber(coverage, "coverage_ratio"));

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-4">
      {result !== null && <BuildBanner result={result} />}
      <Card size="sm" className="min-w-0 shrink-0">
        <CardHeader>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <CardTitle className="text-sm">数据构建结果</CardTitle>
            <Badge variant="outline">{manifest.dataset_family}</Badge>
            <Badge variant="outline">{manifest.row_granularity}</Badge>
            <Badge variant="outline">{manifest.schema_ref}</Badge>
          </div>
          <CardDescription>
            构建 {detail.build_id} · {detail.task_id}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <SummaryStat label="有效行数" value={`${rowCount} 行`} />
            <SummaryStat
              label="来源成功"
              value={`${successfulSources} 个来源成功`}
            />
            <SummaryStat
              label="来源被拒"
              value={`${rejectedSources} 个来源被拒绝`}
            />
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Validation</p>
              <Badge
                variant={
                  summaryString(validation, "status") === "failed"
                    ? "destructive"
                    : "secondary"
                }
              >
                {summaryString(validation, "status") ?? "unknown"}
              </Badge>
            </div>
            <SummaryStat
              label="检查项"
              value={`${checkedCount ?? "—"} / ${failedCount ?? "—"}`}
            />
            <SummaryStat
              label="置信度"
              value={`${anomalyCount ?? 0} 处异常`}
            />
            <SummaryStat label="溯源覆盖率" value={coverageRatio} />
          </div>
        </CardContent>
      </Card>
      <Tabs defaultValue="primary" className="min-h-0 min-w-0 flex-1">
        <TabsList>
          <TabsTrigger value="primary">主数据</TabsTrigger>
          <TabsTrigger value="sources">来源</TabsTrigger>
          <TabsTrigger value="processing">处理</TabsTrigger>
          <TabsTrigger value="warnings">警告</TabsTrigger>
        </TabsList>
        <ScrollArea className="min-h-0 min-w-0 flex-1">
          <TabsContent value="primary" className="min-h-0">
            <PrimaryDataTab detail={detail} taskId={taskId} />
          </TabsContent>
          <TabsContent value="sources" className="min-h-0">
            <SourceTab detail={detail} taskId={taskId} />
          </TabsContent>
          <TabsContent value="processing" className="min-h-0">
            <ProcessingTab detail={detail} taskId={taskId} />
          </TabsContent>
          <TabsContent value="warnings" className="min-h-0">
            <WarningsTab detail={detail} taskId={taskId} />
          </TabsContent>
        </ScrollArea>
      </Tabs>
    </div>
  );
}

export default function BuildResultsViewer({
  buildId,
  taskId,
}: BuildResultsViewerProps) {
  // Remount per build id so a new build always starts from a fresh loading
  // state (no stale detail, no setState-in-effect reset).
  return (
    <BuildViewerContent
      key={buildId}
      buildId={buildId}
      taskId={taskId}
    />
  );
}
