import {
  CheckCircleIcon,
  ProhibitIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react";
import type { HILDecision, HILRequest } from "@biomed/contracts";

import { parsePublicationAcceptanceEvidence } from "@/lib/familyHost";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface PublicationAcceptanceReviewProps {
  request: HILRequest;
  disabled: boolean;
  submittingAction: string | null;
  onSubmit: (decision: HILDecision) => Promise<void>;
}

function value(value: string | number | null): string {
  return value === null ? "未提供" : String(value);
}

function shortDigest(valueToShorten: string): string {
  return `${valueToShorten.slice(0, 16)}…${valueToShorten.slice(-8)}`;
}

/**
 * Dedicated presentation for the only publication HIL contract currently
 * emitted by the Family Host. Publication acceptance is evidence-bound and
 * deliberately exposes only accept/reject decisions.
 */
export function PublicationAcceptanceReview({
  request,
  disabled,
  submittingAction,
  onSubmit,
}: PublicationAcceptanceReviewProps) {
  const evidence = parsePublicationAcceptanceEvidence(request);
  const candidate = evidence.candidate;
  const provisional = evidence.provisionalAssessment;
  const b3 = evidence.b3;

  return (
    <Card data-testid="publication-acceptance-review" className="min-w-0 border-border/70 shadow-none">
      <CardHeader className="gap-2 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">发布前人工验收</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">publication_acceptance</Badge>
            <Badge variant="destructive">阻塞发布</Badge>
          </div>
        </div>
        <CardDescription>{request.summary}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <Alert className="border-warning/40 bg-warning/5">
          <ShieldCheckIcon aria-hidden="true" className="text-warning" />
          <AlertTitle>仅接受或拒绝此候选</AlertTitle>
          <AlertDescription>
            决策只适用于下方 evidence digest 绑定的候选快照；拒绝不会修改候选数据。
          </AlertDescription>
        </Alert>

        <Card size="sm" className="min-w-0 bg-muted/20 shadow-none">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">候选摘要</CardTitle>
            <CardDescription className="break-all font-mono text-xs">
              candidate {value(candidate.candidate_id)}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs sm:grid-cols-3">
              <div><dt className="text-muted-foreground">数据族</dt><dd className="mt-1 break-words font-medium">{value(candidate.dataset_family)}</dd></div>
              <div><dt className="text-muted-foreground">行粒度</dt><dd className="mt-1 break-words font-medium">{value(candidate.row_granularity)}</dd></div>
              <div><dt className="text-muted-foreground">requirement_id</dt><dd className="mt-1 break-all font-mono">{value(candidate.requirement_id)}</dd></div>
              <div><dt className="text-muted-foreground">候选规范 digest</dt><dd className="mt-1 break-all font-mono">{candidate.canonical_sha256 === null ? "未提供" : shortDigest(candidate.canonical_sha256)}</dd></div>
              <div><dt className="text-muted-foreground">注册来源数</dt><dd className="mt-1 font-medium tabular-nums">{candidate.registered_asset_ids.length}</dd></div>
              <div><dt className="text-muted-foreground">表数量</dt><dd className="mt-1 font-medium tabular-nums">{evidence.tables.length}</dd></div>
            </dl>
          </CardContent>
        </Card>

        {evidence.tables.length > 0 && (
          <div className="min-w-0 rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>表</TableHead>
                  <TableHead>角色</TableHead>
                  <TableHead>Schema</TableHead>
                  <TableHead>行数</TableHead>
                  <TableHead>SHA-256</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {evidence.tables.map((table) => (
                  <TableRow key={table.table_id}>
                    <TableCell className="font-mono text-xs">{table.table_id}</TableCell>
                    <TableCell>{value(table.role)}</TableCell>
                    <TableCell className="break-all font-mono text-xs">{value(table.schema_ref)}</TableCell>
                    <TableCell className="tabular-nums">{value(table.row_count)}</TableCell>
                    <TableCell className="break-all font-mono text-xs">{table.sha256 === null ? "未提供" : shortDigest(table.sha256)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {(provisional !== null || b3 !== null) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {provisional !== null && (
              <Card size="sm" className="shadow-none">
                <CardHeader className="pb-2"><CardTitle className="text-sm">ProductAssessment 快照</CardTitle></CardHeader>
                <CardContent className="text-xs">
                  <Badge variant={provisional.product_status === "publishable" ? "secondary" : "outline"}>
                    {provisional.product_status ?? "状态未提供"}
                  </Badge>
                  <p className="mt-2 break-all font-mono">{value(provisional.requirement_id)}</p>
                  {provisional.missing_requirements.length > 0 && (
                    <p className="mt-1 text-muted-foreground">缺少：{provisional.missing_requirements.join("、")}</p>
                  )}
                  {provisional.sha256 !== null && (
                    <p className="mt-1 break-all text-muted-foreground">assessment {shortDigest(provisional.sha256)}</p>
                  )}
                </CardContent>
              </Card>
            )}
            {b3 !== null && (
              <Card size="sm" className="shadow-none">
                <CardHeader className="pb-2"><CardTitle className="text-sm">结构校验快照</CardTitle></CardHeader>
                <CardContent className="grid grid-cols-2 gap-2 text-xs">
                  <div><p className="text-muted-foreground">profile</p><p className="break-all font-mono">{value(b3.profile_ref)}</p></div>
                  <div><p className="text-muted-foreground">checks</p><p className="tabular-nums">{value(b3.checked_count)} / 失败 {value(b3.failed_count)}</p></div>
                  <div className="col-span-2"><p className="text-muted-foreground">checks digest</p><p className="break-all font-mono">{b3.checks_sha256 === null ? "未提供" : shortDigest(b3.checks_sha256)}</p></div>
                </CardContent>
              </Card>
            )}
          </div>
        )}

        <Alert>
          <AlertDescription className="break-all text-xs">
            evidence digest <span className="font-mono">{request.evidence_digest}</span>
          </AlertDescription>
        </Alert>

        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            variant="destructive"
            disabled={disabled}
            onClick={() => void onSubmit({ action: "reject" })}
          >
            {submittingAction === "reject" ? "正在提交…" : <><ProhibitIcon aria-hidden="true" />拒绝候选</>}
          </Button>
          <Button
            disabled={disabled}
            onClick={() => void onSubmit({ action: "accept" })}
          >
            {submittingAction === "accept" ? "正在提交…" : <><CheckCircleIcon aria-hidden="true" />接受并发布候选</>}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
