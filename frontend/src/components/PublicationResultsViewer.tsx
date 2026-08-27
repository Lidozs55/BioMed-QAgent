import { useEffect, useState } from "react";

import { PublicationArtifactCard } from "@/components/artifacts/PublicationArtifactCard";
import { artifactBasename } from "@/components/artifacts/artifactPreview";
import { FamilyTopologyExplorer } from "@/components/family-host/relations/FamilyTopologyExplorer";
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
import { ProductAssessmentSummary } from "@/components/FamilyHostStatusCard";
import { productAssessmentFromManifest } from "@/lib/familyHost";
import type {
  PublicationDetail,
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
  detail: PublicationDetail;
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
          <EmptyDescription>本次发布没有主数据产物。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <PublicationArtifactCard
        entry={primary}
        publicationId={detail.requirement_id}
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
  detail: PublicationDetail;
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
        <PublicationArtifactCard
          entry={provenanceEntry}
          publicationId={detail.requirement_id}
          taskId={taskId}
        />
      )}
      {schemaEntry !== undefined && (
        <PublicationArtifactCard
          entry={schemaEntry}
          publicationId={detail.requirement_id}
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
  detail: PublicationDetail;
  taskId?: string | null;
}) {
  const validation = detail.manifest.validation_summary;
  const confidence = detail.manifest.confidence_summary;
  const productAssessment = productAssessmentFromManifest(detail.manifest);
  const validationStatus = summaryString(validation, "status");
  const checkedCount = summaryNumber(validation, "checked_count");
  const failedCount = summaryNumber(validation, "failed_count");
  const profileRef = summaryString(validation, "profile_ref");
  const statisticalAnomalies = summaryRecord(confidence, "statistical_anomalies");
  const anomalyCount =
    summaryNumber(statisticalAnomalies, "detected_count")
    ?? summaryNumber(confidence, "detected_anomaly_count");
  const reportFile =
    summaryString(statisticalAnomalies, "report_file")
    ?? summaryString(confidence, "report_file");
  const levelDistribution = summaryRecord(confidence, "level_distribution");
  const reviewDistribution = summaryRecord(confidence, "human_review_distribution");
  const reasonCounts = summaryRecord(confidence, "reason_counts");
  const pendingReviewCount = summaryNumber(confidence, "pending_human_review_count") ?? 0;
  const batchDefaultCount = summaryNumber(confidence, "batch_default_count") ?? 0;
  const recordOverrideCount = summaryNumber(confidence, "record_override_count") ?? 0;
  const evidenceReportFile = summaryString(confidence, "evidence_report_file");
  const auditEntries = detail.manifest.artifacts.filter(
    (entry) => entry.role === "audit_report",
  );
  const evidenceEntry = detail.manifest.artifacts.find(
    (entry) => evidenceReportFile !== undefined && entry.relative_path === evidenceReportFile,
  );
  const provenanceEntry = detail.manifest.artifacts.find(
    (entry) => entry.role === "provenance",
  );
  const confidenceLevels = (["high", "medium", "low"] as const).map((level) => ({
    level,
    count: summaryNumber(levelDistribution, level) ?? 0,
  }));
  const reviewStates = reviewDistribution === undefined
    ? []
    : Object.entries(reviewDistribution)
        .filter((entry): entry is [string, number] => typeof entry[1] === "number")
        .sort(([left], [right]) => left.localeCompare(right));
  const reasons = reasonCounts === undefined
    ? []
    : Object.entries(reasonCounts)
        .filter((entry): entry is [string, number] => typeof entry[1] === "number")
        .sort((left, right) => right[1] - left[1]);

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Card size="sm" className="min-w-0">
        <CardHeader>
          <CardTitle className="text-sm">校验与证据可信度</CardTitle>
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
              label="统计异常"
              value={`检测到 ${anomalyCount ?? 0} 处统计异常`}
            />
            {reportFile !== undefined && (
              <SummaryStat label="统计异常报告" value={reportFile} />
            )}
          </div>
        </CardContent>
      </Card>
      {productAssessment !== null && <ProductAssessmentSummary assessment={productAssessment} />}
      <Card size="sm" className="min-w-0">
        <CardHeader>
          <CardTitle className="text-sm">可信度分布</CardTitle>
          <CardDescription>
            批次默认 {batchDefaultCount} 个 · 记录级覆盖 {recordOverrideCount} 条
          </CardDescription>
        </CardHeader>
        <CardContent className="flex min-w-0 flex-col gap-4">
          <div className="grid grid-cols-3 gap-2">
            {confidenceLevels.map(({ level, count }) => (
              <div key={level} className="rounded-md border p-3">
                <Badge
                  variant={level === "low" ? "destructive" : level === "high" ? "secondary" : "outline"}
                >
                  {level}
                </Badge>
                <p className="mt-2 text-lg font-semibold tabular-nums">{count}</p>
              </div>
            ))}
          </div>
          <div className="flex min-w-0 flex-wrap gap-1.5" aria-label="人工审核状态">
            {reviewStates.map(([state, count]) => (
              <Badge
                key={state}
                variant={state === "pending" || state === "rejected" ? "destructive" : "outline"}
              >
                {state} {count}
              </Badge>
            ))}
            {pendingReviewCount > 0 && (
              <Badge variant="destructive">待处理审核 {pendingReviewCount}</Badge>
            )}
          </div>
          {reasons.length > 0 && (
            <div className="min-w-0">
              <p className="mb-2 text-xs font-medium text-muted-foreground">主要原因</p>
              <ul className="flex min-w-0 flex-col gap-2">
                {reasons.map(([reason, count]) => (
                  <li key={reason} className="flex min-w-0 items-start justify-between gap-3 text-sm">
                    <span className="min-w-0 break-words">{reason}</span>
                    <Badge variant="outline" className="shrink-0">{count}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
      {evidenceEntry !== undefined && (
        <PublicationArtifactCard
          entry={evidenceEntry}
          publicationId={detail.requirement_id}
          taskId={taskId}
        />
      )}
      {provenanceEntry !== undefined && (
        <PublicationArtifactCard
          entry={provenanceEntry}
          publicationId={detail.requirement_id}
          taskId={taskId}
        />
      )}
      {auditEntries.filter((entry) => entry.artifact_id !== evidenceEntry?.artifact_id).map((entry) => (
        <PublicationArtifactCard
          key={entry.artifact_id}
          entry={entry}
          publicationId={detail.requirement_id}
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
  detail: PublicationDetail;
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
          <EmptyDescription>未发现警告文件，本次发布没有需要关注的警告。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {warningEntries.map((entry) => (
        <PublicationArtifactCard
          key={entry.artifact_id}
          entry={entry}
          publicationId={detail.requirement_id}
          taskId={taskId}
          previewCsv
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  PublicationResultsViewer                                                 */
/* ------------------------------------------------------------------ */

interface PublicationResultsViewerProps {
  publicationId: string;
  taskId?: string | null;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; detail: PublicationDetail }
  | { status: "error" };

function PublicationViewerContent({
  publicationId,
  taskId,
}: {
  publicationId: string;
  taskId?: string | null;
}) {
  const api = useAPI();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void api
      .fetchPublication(publicationId, taskId)
      .then((detail) => {
        if (!cancelled) setState({ status: "ready", detail });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [api, publicationId, taskId, reloadKey]);

  if (state.status === "loading") {
    return (
      <div className="flex min-w-0 items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
        <Spinner />
        加载发布产物...
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <Empty className="min-h-48">
        <EmptyHeader>
          <EmptyTitle>无法加载发布产物</EmptyTitle>
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
  const topologyManifest = manifest.schema_version === "2.0" ? manifest : null;
  const rowCount = manifest.row_count;
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
      <Card size="sm" className="min-w-0 shrink-0">
        <CardHeader>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <CardTitle className="text-sm">数据发布产物</CardTitle>
            <Badge variant="outline">{manifest.dataset_family}</Badge>
            <Badge variant="outline">{manifest.row_granularity}</Badge>
            <Badge variant="outline">{manifest.schema_ref}</Badge>
          </div>
          <CardDescription>
            需求 {detail.requirement_id} · {detail.task_id}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <SummaryStat label="有效行数" value={`${rowCount} 行`} />
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
              label="统计异常"
              value={`${anomalyCount ?? 0} 处`}
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
          {topologyManifest !== null && <TabsTrigger value="topology">结构</TabsTrigger>}
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
          {topologyManifest !== null && (
            <TabsContent value="topology" className="min-h-0">
              <FamilyTopologyExplorer manifest={topologyManifest} publication={detail.publication} />
            </TabsContent>
          )}
        </ScrollArea>
      </Tabs>
    </div>
  );
}

export default function PublicationResultsViewer({
  publicationId,
  taskId,
}: PublicationResultsViewerProps) {
  // Remount per publication so a new immutable product starts from a fresh loading
  // state (no stale detail, no setState-in-effect reset).
  return (
    <PublicationViewerContent
      key={publicationId}
      publicationId={publicationId}
      taskId={taskId}
    />
  );
}
