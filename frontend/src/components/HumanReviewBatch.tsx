import { useState } from "react";

import {
  CheckCircleIcon,
  PencilSimpleIcon,
  ProhibitIcon,
  SkipForwardIcon,
} from "@phosphor-icons/react";
import type { HILDecision, HILRequest, JsonValue } from "@biomed/contracts";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

type ReviewAction = "accept" | "correct" | "reject" | "skip";
type PermissionAction = "approve" | "reject";

interface HumanReviewBatchProps {
  request: HILRequest;
  disabled: boolean;
  submittingAction: string | null;
  onSubmit: (decision: HILDecision) => Promise<void>;
}

const ACTION_LABEL: Record<ReviewAction | PermissionAction, string> = {
  approve: "授权本次调用",
  accept: "接受整个审核批次",
  correct: "修正整个审核批次",
  reject: "拒绝整个审核批次",
  skip: "跳过整个审核批次",
};

function evidenceText(value: JsonValue): string {
  if (value === null) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function HumanReviewBatch({
  request,
  disabled,
  submittingAction,
  onSubmit,
}: HumanReviewBatchProps) {
  const permissionRequest = request.kind === "permission";
  const [action, setAction] = useState<ReviewAction | PermissionAction>(
    permissionRequest ? "approve" : "accept",
  );
  const [correction, setCorrection] = useState("{}");
  const [localError, setLocalError] = useState<string | null>(null);

  const submit = async () => {
    setLocalError(null);
    if (action !== "correct") {
      await onSubmit({ action });
      return;
    }
    let parsed: JsonValue;
    try {
      parsed = JSON.parse(correction) as JsonValue;
    } catch {
      setLocalError("修正内容必须是有效 JSON。请按当前审核类型提交结构化值。");
      return;
    }
    await onSubmit({ action: "correct", correction: parsed });
  };

  return (
    <Card className="min-w-0 border-border/70 shadow-none">
      <CardHeader className="gap-2 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">批量审核</CardTitle>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant="secondary">{request.kind}</Badge>
            {request.review_type !== null && (
              <Badge variant="outline">{request.review_type}</Badge>
            )}
            <Badge variant={request.blocking ? "destructive" : "outline"}>
              {request.blocking ? "阻塞发布" : "建议审核"}
            </Badge>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">{request.summary}</p>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <ScrollArea className="max-h-64 rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>项目</TableHead>
                <TableHead>机器候选</TableHead>
                <TableHead>可信度</TableHead>
                <TableHead>证据</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {request.review_items.map((item) => (
                <TableRow key={item.item_id}>
                  <TableCell className="max-w-52 whitespace-normal font-medium">
                    {item.summary}
                  </TableCell>
                  <TableCell className="max-w-48 whitespace-normal font-mono text-xs">
                    {evidenceText(item.proposed_value)}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={item.confidence_level === "low" ? "destructive" : "outline"}
                    >
                      {item.confidence_level ?? "n/a"}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-72 whitespace-normal text-xs text-muted-foreground">
                    {evidenceText(item.evidence)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </ScrollArea>

        <div className="flex flex-col gap-2">
          <Label>{permissionRequest ? "授权决定" : "处理方式"}</Label>
          <ToggleGroup
            value={[action]}
            onValueChange={(values) => {
              const next = values[values.length - 1];
              if (permissionRequest) {
                if (next === "approve" || next === "reject") setAction(next);
                return;
              }
              if (next === "accept" || next === "correct" || next === "reject" || next === "skip") {
                setAction(next);
              }
            }}
            variant="outline"
            spacing={1}
            className="flex w-full flex-wrap justify-start"
          >
            {permissionRequest ? (
              <ToggleGroupItem value="approve" aria-label="授权">
                <CheckCircleIcon aria-hidden="true" /> 授权
              </ToggleGroupItem>
            ) : (
              <>
                <ToggleGroupItem value="accept" aria-label="接受">
                  <CheckCircleIcon aria-hidden="true" /> 接受
                </ToggleGroupItem>
                <ToggleGroupItem value="correct" aria-label="修正">
                  <PencilSimpleIcon aria-hidden="true" /> 修正
                </ToggleGroupItem>
              </>
            )}
            <ToggleGroupItem value="reject" aria-label="拒绝">
              <ProhibitIcon aria-hidden="true" /> 拒绝
            </ToggleGroupItem>
            {!permissionRequest && (
              <ToggleGroupItem value="skip" aria-label="跳过">
                <SkipForwardIcon aria-hidden="true" /> 跳过
              </ToggleGroupItem>
            )}
          </ToggleGroup>
        </div>

        {action === "correct" && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="hil-correction-json">结构化修正（JSON）</Label>
            <Textarea
              id="hil-correction-json"
              value={correction}
              onChange={(event) => setCorrection(event.target.value)}
              className="min-h-28 font-mono text-xs"
              disabled={disabled}
              aria-describedby="hil-correction-help"
            />
            <p id="hil-correction-help" className="text-xs text-muted-foreground">
              字段映射使用 mappings，单位换算使用 unit_conversion，VLM 点修正使用 points。
            </p>
          </div>
        )}

        <Alert>
          <AlertDescription className="break-all font-mono text-xs">
            evidence {request.evidence_digest.slice(0, 12)}… · policy {request.policy_ref}
          </AlertDescription>
        </Alert>
        {localError !== null && (
          <Alert variant="destructive">
            <AlertDescription>{localError}</AlertDescription>
          </Alert>
        )}
        <Button
          variant={action === "reject" ? "destructive" : "default"}
          disabled={disabled}
          onClick={() => void submit()}
        >
          {submittingAction === action ? "正在提交…" : ACTION_LABEL[action]}
        </Button>
      </CardContent>
    </Card>
  );
}
