import { useEffect, useMemo, useRef, useState } from "react";

import { CheckIcon, XCircleIcon } from "@phosphor-icons/react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import type { ResumeRunInput, UserInputDecision } from "@/runtime/contracts";
import type { PendingUserInput, TaskProjection } from "@/runtime/types";

interface UserInputDialogProps {
  task: TaskProjection | undefined;
  onResumeRun: (
    taskId: string,
    runId: string,
    input: ResumeRunInput,
  ) => Promise<void>;
}

interface SubmissionState {
  promptKey: string | null;
  attemptId: number;
  pendingDecision: UserInputDecision | null;
  error: string | null;
}

interface PlanQuerySpec {
  query_id?: unknown;
  database?: unknown;
  query?: unknown;
  generated_by?: unknown;
  purpose?: unknown;
  order?: unknown;
  page_size?: unknown;
  max_results?: unknown;
}

interface PlanDatasetSpec {
  dataset_id?: unknown;
  database?: unknown;
  accession?: unknown;
  reason?: unknown;
}

interface PlanSpec {
  topic: string;
  queries: PlanQuerySpec[];
  datasets: PlanDatasetSpec[];
  requested_outputs: unknown[];
}

function parsePlanSpec(detail: PendingUserInput["detail"]): PlanSpec | null {
  if (
    detail === null
    || typeof detail !== "object"
    || Array.isArray(detail)
  ) {
    return null;
  }
  const raw = detail as Record<string, unknown>;
  const topic = typeof raw.topic === "string" ? raw.topic : null;
  if (topic === null) return null;
  const queries = Array.isArray(raw.queries) ? (raw.queries as PlanQuerySpec[]) : [];
  const datasets = Array.isArray(raw.datasets)
    ? (raw.datasets as PlanDatasetSpec[])
    : [];
  const requestedOutputs = Array.isArray(raw.requested_outputs)
    ? (raw.requested_outputs as unknown[])
    : [];
  return { topic, queries, datasets, requested_outputs: requestedOutputs };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function UserInputDialog({ task, onResumeRun }: UserInputDialogProps) {
  const pending = task?.pendingUserInput ?? null;
  const taskId = task?.summary.task_id ?? null;
  const runId = pending?.runId ?? null;
  const promptKey =
    pending === null || taskId === null
      ? null
      : `${taskId}:${pending.runId}:${pending.requestId}`;
  const nextAttemptId = useRef(0);
  const [submission, setSubmission] = useState<SubmissionState>({
    promptKey: null,
    attemptId: 0,
    pendingDecision: null,
    error: null,
  });
  useEffect(() => {
    nextAttemptId.current += 1;
    setSubmission({
      promptKey,
      attemptId: nextAttemptId.current,
      pendingDecision: null,
      error: null,
    });
  }, [promptKey]);
  const pendingDecision =
    submission.promptKey === promptKey ? submission.pendingDecision : null;
  const error = submission.promptKey === promptKey ? submission.error : null;

  const open = pending !== null && taskId !== null && runId !== null;
  const planSpec = useMemo(
    () =>
      pending?.promptKind === "plan_confirmation" && pending.detail
        ? parsePlanSpec(pending.detail)
        : null,
    [pending],
  );

  const submit = async (decision: UserInputDecision) => {
    if (
      pending === null ||
      taskId === null ||
      runId === null ||
      promptKey === null
    ) {
      return;
    }
    const submittedPromptKey = promptKey;
    nextAttemptId.current += 1;
    const submittedAttemptId = nextAttemptId.current;
    setSubmission({
      promptKey: submittedPromptKey,
      attemptId: submittedAttemptId,
      pendingDecision: decision,
      error: null,
    });
    try {
      await onResumeRun(taskId, runId, {
        request_id: pending.requestId,
        decision,
        detail: {},
      });
    } catch (caught) {
      setSubmission((current) =>
        current.promptKey === submittedPromptKey &&
        current.attemptId === submittedAttemptId
          ? {
              ...current,
              error:
                caught instanceof Error
                  ? caught.message
                  : "提交决策失败，请重试",
            }
          : current,
      );
    } finally {
      setSubmission((current) =>
        current.promptKey === submittedPromptKey &&
        current.attemptId === submittedAttemptId
          ? { ...current, pendingDecision: null }
          : current,
      );
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pendingDecision !== null) return;
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="min-w-0 max-w-[calc(100vw-2rem)] sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle>
            {pending?.promptKind === "plan_confirmation"
              ? "确认研究计划"
              : pending?.promptKind === "max_turns_reached"
                ? "Agent 已达到最大轮次"
                : "请补充信息"}
          </DialogTitle>
          <DialogDescription className="min-w-0 break-words">
            {pending?.summary ?? "Pipeline 已暂停，等待你的决策。"}
          </DialogDescription>
        </DialogHeader>

        {planSpec !== null && (
          <div className="flex max-h-72 min-w-0 flex-col gap-3 overflow-auto rounded-md border border-border/60 bg-muted/30 p-3 text-sm">
            <section className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                研究主题
              </p>
              <p className="break-words">{planSpec.topic}</p>
            </section>

            {planSpec.queries.length > 0 && (
              <section className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  检索查询 ({planSpec.queries.length})
                </p>
                <ol className="space-y-2">
                  {planSpec.queries.map((query, index) => {
                    const order = asNumber(query.order) ?? index + 1;
                    const database = asString(query.database) ?? "unknown";
                    const queryString = asString(query.query) ?? "";
                    const purpose = asString(query.purpose);
                    const queryId = asString(query.query_id);
                    const generatedBy = asString(query.generated_by);
                    const pageSize = asNumber(query.page_size);
                    const maxResults = asNumber(query.max_results);
                    return (
                      <li
                        key={queryId ?? `${database}-${index}`}
                        className="space-y-1 rounded-md border border-border/40 bg-background/60 p-2"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="secondary">#{order}</Badge>
                          <Badge variant="outline">{database}</Badge>
                          {generatedBy !== null && (
                            <Badge variant="ghost">{generatedBy}</Badge>
                          )}
                          {pageSize !== null && (
                            <Badge variant="ghost">page_size={pageSize}</Badge>
                          )}
                          {maxResults !== null && (
                            <Badge variant="ghost">max={maxResults}</Badge>
                          )}
                        </div>
                        <p className="break-words font-mono text-xs">
                          {queryString}
                        </p>
                        {purpose !== null && (
                          <p className="text-xs text-muted-foreground">
                            {purpose}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </section>
            )}

            {planSpec.datasets.length > 0 && (
              <section className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  数据集 ({planSpec.datasets.length})
                </p>
                <ul className="space-y-2">
                  {planSpec.datasets.map((dataset, index) => {
                    const datasetId = asString(dataset.dataset_id);
                    const database = asString(dataset.database) ?? "unknown";
                    const accession = asString(dataset.accession) ?? "";
                    const reason = asString(dataset.reason);
                    return (
                      <li
                        key={datasetId ?? `${database}-${index}`}
                        className="space-y-1 rounded-md border border-border/40 bg-background/60 p-2"
                      >
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline">{database}</Badge>
                          <span className="font-mono text-xs">{accession}</span>
                        </div>
                        {reason !== null && (
                          <p className="text-xs text-muted-foreground">
                            {reason}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {planSpec.requested_outputs.length > 0 && (
              <section className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  请求输出
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {planSpec.requested_outputs.map((output, index) => (
                    <Badge key={index} variant="secondary">
                      {typeof output === "string" ? output : String(output)}
                    </Badge>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {pending?.fixtureExempt && (
          <Alert>
            <AlertDescription>
              当前为固定验收模式，仅供查看计划，确认按钮仅触发流程继续。
            </AlertDescription>
          </Alert>
        )}

        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            disabled={pendingDecision !== null}
            onClick={() => void submit("reject")}
          >
            {pendingDecision === "reject" ? (
              <Spinner data-icon="inline-start" aria-hidden="true" />
            ) : (
              <XCircleIcon data-icon="inline-start" aria-hidden="true" />
            )}
            {pending?.promptKind === "max_turns_reached" ? "停止" : "拒绝"}
          </Button>
          <Button
            disabled={pendingDecision !== null}
            onClick={() => void submit("approve")}
          >
            {pendingDecision === "approve" ? (
              <Spinner data-icon="inline-start" aria-hidden="true" />
            ) : (
              <CheckIcon data-icon="inline-start" aria-hidden="true" />
            )}
            {pending?.promptKind === "max_turns_reached"
              ? "继续工作"
              : "确认执行"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
