import { useCallback, useEffect, useState } from "react";
import { DownloadSimpleIcon, ShieldWarningIcon, UploadSimpleIcon } from "@phosphor-icons/react";

import type { QuarantineCoverageStatus, QuarantineReceipt } from "@/api/quarantine";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAPI } from "@/hooks/useAPI";
import { formatSize, triggerArtifactDownload } from "@/lib/fileUtils";
import { errorMessage } from "@/lib/utils";

const COVERAGE_LABELS: Record<QuarantineCoverageStatus, string> = {
  complete: "覆盖完整",
  partial: "覆盖部分范围",
  unknown: "覆盖范围未知",
};

function isCoverageStatus(value: string | null): value is QuarantineCoverageStatus {
  return value === "complete" || value === "partial" || value === "unknown";
}

function splitScope(value: string): string[] {
  return value.split(/[\n,]/u).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}

function formatScope(scope: readonly string[]): string {
  return scope.length === 0 ? "无" : scope.join("、");
}

/** Label map so the trigger shows Chinese labels instead of raw enum keys. */
const COVERAGE_ITEMS = [
  { value: "complete", label: "覆盖完整" },
  { value: "partial", label: "覆盖部分范围" },
  { value: "unknown", label: "覆盖范围未知" },
] as const;

interface QuarantinePanelProps {
  taskId: string;
}

export default function QuarantinePanel({ taskId }: QuarantinePanelProps) {
  const api = useAPI();
  const [items, setItems] = useState<QuarantineReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [sourceNote, setSourceNote] = useState("");
  const [coverageStatus, setCoverageStatus] = useState<QuarantineCoverageStatus>("unknown");
  const [coveredScope, setCoveredScope] = useState("");
  const [missingScope, setMissingScope] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    const fetchQuarantine = api.fetchQuarantine;
    if (fetchQuarantine === undefined) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setItems(await fetchQuarantine(taskId));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [api, taskId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadItems(), 0);
    return () => window.clearTimeout(timer);
  }, [loadItems]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (file === null || api.submitQuarantine === undefined) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await api.submitQuarantine(taskId, {
        file,
        ...(sourceNote.trim().length > 0 ? { source_note: sourceNote.trim() } : {}),
        coverage_status: coverageStatus,
        covered_scope: splitScope(coveredScope),
        missing_scope: splitScope(missingScope),
      });
      setFile(null);
      setSourceNote("");
      setCoveredScope("");
      setMissingScope("");
      await loadItems();
    } catch (cause) {
      setSubmitError(errorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="shrink-0">
      <CardHeader>
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle className="flex items-center gap-2">
              <ShieldWarningIcon aria-hidden="true" />
              待检隔离区
            </CardTitle>
            <CardDescription>个人本地提交的文件仅作为未经准入的非权威参考。</CardDescription>
          </div>
          <Badge variant="destructive">非权威 / 未经准入</Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {api.submitQuarantine !== undefined && (
          <form className="flex flex-col gap-3 rounded-lg border border-dashed p-3" onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor={`quarantine-file-${taskId}`}>选择文件</FieldLabel>
                <Input
                  id={`quarantine-file-${taskId}`}
                  type="file"
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                />
                <FieldDescription>文件会保存到该任务的本地隔离区，不进入正式发布。</FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor={`quarantine-note-${taskId}`}>来源备注（可选）</FieldLabel>
                <Textarea
                  id={`quarantine-note-${taskId}`}
                  value={sourceNote}
                  onChange={(event) => setSourceNote(event.target.value)}
                  rows={2}
                />
              </Field>
              <div className="grid gap-3 md:grid-cols-3">
                <Field>
                  <FieldLabel htmlFor={`quarantine-coverage-${taskId}`}>覆盖状态</FieldLabel>
                  <Select items={COVERAGE_ITEMS} value={coverageStatus} onValueChange={(value) => {
                    if (isCoverageStatus(value)) setCoverageStatus(value);
                  }}>
                    <SelectTrigger id={`quarantine-coverage-${taskId}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="complete">覆盖完整</SelectItem>
                      <SelectItem value="partial">覆盖部分范围</SelectItem>
                      <SelectItem value="unknown">覆盖范围未知</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`quarantine-covered-${taskId}`}>已覆盖范围</FieldLabel>
                  <Input id={`quarantine-covered-${taskId}`} value={coveredScope} onChange={(event) => setCoveredScope(event.target.value)} placeholder="例如：样本、基因" />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`quarantine-missing-${taskId}`}>缺失范围</FieldLabel>
                  <Input id={`quarantine-missing-${taskId}`} value={missingScope} onChange={(event) => setMissingScope(event.target.value)} placeholder="例如：临床结局" />
                </Field>
              </div>
            </FieldGroup>
            {submitError !== null && <Alert variant="destructive"><AlertTitle>提交失败</AlertTitle><AlertDescription>{submitError}</AlertDescription></Alert>}
            <div className="flex justify-end">
              <Button type="submit" disabled={file === null || submitting}>
                <UploadSimpleIcon data-icon="inline-start" aria-hidden="true" />
                {submitting ? "提交中…" : "提交到隔离区"}
              </Button>
            </div>
          </form>
        )}

        {loading ? (
          <p className="text-sm text-muted-foreground">正在加载隔离文件…</p>
        ) : error !== null ? (
          <Alert variant="destructive">
            <AlertTitle>隔离区加载失败</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : items.length === 0 ? (
          <Empty className="min-h-24 border-0 p-2">
            <EmptyHeader>
              <EmptyTitle>暂无隔离文件</EmptyTitle>
              <EmptyDescription>提交的非权威文件会显示在这里，不会改变任务结果。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex flex-col gap-3">
            {items.map((item) => (
              <Card key={item.submission_id} size="sm">
                <CardHeader>
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <div className="min-w-0">
                      <CardTitle className="truncate" title={item.name}>{item.name}</CardTitle>
                      <CardDescription>{item.media_type} · {formatSize(item.size_bytes)} · {new Date(item.submitted_at).toLocaleString()}</CardDescription>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const url = api.getQuarantineContentUrl?.(taskId, item.submission_id);
                        if (url !== undefined) triggerArtifactDownload(url, item.name);
                      }}
                    >
                      <DownloadSimpleIcon data-icon="inline-start" aria-hidden="true" />
                      下载
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="flex flex-col gap-2 text-xs">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="secondary">{COVERAGE_LABELS[item.coverage_status]}</Badge>
                    <Badge variant="outline">trust: {item.trust}</Badge>
                    <span className="text-muted-foreground">{item.size_bytes.toLocaleString()} bytes</span>
                  </div>
                  <dl className="grid gap-1 break-words text-muted-foreground md:grid-cols-2">
                    <div><dt className="font-medium text-foreground">已覆盖范围</dt><dd>{formatScope(item.covered_scope)}</dd></div>
                    <div><dt className="font-medium text-foreground">缺失范围</dt><dd>{formatScope(item.missing_scope)}</dd></div>
                    <div className="md:col-span-2"><dt className="font-medium text-foreground">sha256</dt><dd className="font-mono">{item.sha256}</dd></div>
                    <div className="md:col-span-2"><dt className="font-medium text-foreground">来源备注</dt><dd>{item.source_note ?? "无"}</dd></div>
                  </dl>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
