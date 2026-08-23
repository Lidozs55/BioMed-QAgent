import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ProductAssessment } from "@/runtime/contracts";
import type {
  DynamicFamilyToolOutput,
  ProductAssessmentSummaryData,
} from "@/lib/familyHost";
import { statusLabel } from "@/lib/familyHost";

const SCORE_LABELS: Record<ProductAssessment["scores"][number]["dimension"], string> = {
  schema: "Schema",
  relations: "Relations",
  identifiers: "Identifiers",
  provenance: "Provenance",
  confidence: "Confidence",
  reproducibility: "Reproducibility",
};

const PRODUCT_STATUS_LABELS: Record<ProductAssessment["product_status"], string> = {
  incomplete: "未完成",
  validated: "已验证",
  publishable: "可发布",
};

interface FamilyHostStatusCardProps {
  output: DynamicFamilyToolOutput;
}

function digest(value: string | null): string {
  if (value === null) return "未提供";
  return `${value.slice(0, 12)}…`;
}

function ProductAssessmentSummary({ assessment }: { assessment: ProductAssessmentSummaryData }) {
  return (
    <Card size="sm" className="border-border/70 shadow-none">
      <CardHeader className="gap-2 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm">ProductAssessment</CardTitle>
          <Badge
            variant={
              assessment.product_status === "publishable"
                ? "secondary"
                : assessment.product_status === "validated"
                  ? "outline"
                  : "destructive"
            }
          >
            {PRODUCT_STATUS_LABELS[assessment.product_status]}
          </Badge>
        </div>
        <CardDescription>
          {assessment.package_id ?? "package 未提供"} · requirement {assessment.requirement_id ?? "未提供"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {assessment.scores.map((score) => (
            <div key={score.dimension} className="rounded-md border p-2">
              <p className="text-xs text-muted-foreground">{SCORE_LABELS[score.dimension]}</p>
              <p className="text-sm font-medium tabular-nums">
                {score.satisfied} / {score.required}
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {(score.score * 100).toFixed(0)}%
              </p>
            </div>
          ))}
        </div>
        {assessment.blockers.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">阻塞项</p>
            <ul className="flex flex-col gap-2">
              {assessment.blockers.map((blocker) => (
                <li key={`${blocker.requirement_id}:${blocker.code}`} className="rounded-md border border-destructive/30 bg-destructive/5 p-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="destructive">{blocker.code}</Badge>
                    <span className="font-mono text-xs">{blocker.requirement_id}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{blocker.message}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
        {assessment.missing_requirements.length > 0 && (
          <p className="text-xs text-muted-foreground">
            缺少要求：{assessment.missing_requirements.join("、")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/** Compact status/evidence presentation for submit_dynamic_family_build output. */
export function FamilyHostStatusCard({ output }: FamilyHostStatusCardProps) {
  const successful = output.ok && output.status === "published";
  return (
    <div data-testid="family-host-status" className="mt-2 flex min-w-0 flex-col gap-2">
      <Card size="sm" className="border-border/70 shadow-none">
        <CardHeader className="gap-2 pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm">Family Host 生命周期</CardTitle>
            <Badge variant={successful ? "secondary" : "destructive"}>
              {successful ? <CheckCircleIcon aria-hidden="true" /> : <WarningCircleIcon aria-hidden="true" />}
              {successful ? "已完成" : statusLabel(output.status)}
            </Badge>
          </div>
          <CardDescription>
            动态 FamilySpec / Transform 结果（仅展示当前工具返回字段）
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-xs">
          <Alert className="border-warning/40 bg-warning/5">
            <WarningCircleIcon aria-hidden="true" className="text-warning" />
            <AlertTitle>执行边界</AlertTitle>
            <AlertDescription>
              {output.backend === "in_process_unisolated" ? (
                <>
                  <span className="font-mono">in_process_unisolated</span> · 明确不是安全边界，也不是 sandbox。
                </>
              ) : (
                "当前工具响应未提供执行后端或安全边界声明。"
              )}
            </AlertDescription>
          </Alert>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <div><span className="text-muted-foreground">状态</span><p className="font-medium">{statusLabel(output.status)}</p></div>
            <div><span className="text-muted-foreground">build_id</span><p className="break-all font-mono">{output.build_id ?? "未提供"}</p></div>
            <div><span className="text-muted-foreground">publication_id</span><p className="break-all font-mono">{output.publication_id ?? "未发布"}</p></div>
            <div><span className="text-muted-foreground">manifest</span><p className="break-all font-mono">{output.manifest_id ?? "未提供"}</p></div>
            <div><span className="text-muted-foreground">manifest digest</span><p className="break-all font-mono">{digest(output.manifest_sha256)}</p></div>
            <div><span className="text-muted-foreground">operation result</span><p className="break-all font-mono">{output.operation_result_manifest_id ?? "未提供"}</p></div>
          </div>
          {output.error !== null && (
            <Alert variant="destructive">
              <AlertTitle>{output.error.code ?? "dynamic_build_rejected"}</AlertTitle>
              <AlertDescription>{output.error.message ?? "动态构建被拒绝。"}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export { ProductAssessmentSummary };
