import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";

import { WarningIcon } from "@phosphor-icons/react";

import {
  userInputQuestionnaireItems,
  userInputResolutionFromForm,
} from "@/components/intervention/questionnaireAdapters";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireItem,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { HumanReviewBatch } from "@/components/HumanReviewBatch";
import type {
  HILDecision,
  ResumeRunInput,
  UserInputDecision,
} from "@/runtime/contracts";
import type { PendingUserInput, TaskProjection } from "@/runtime/types";

interface UserInputQuestionnaireProps {
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
  pendingDecision: HILDecision["action"] | UserInputDecision | null;
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

function renderDetailValue(value: unknown): ReactNode {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (Array.isArray(value)) {
    return (
      <ul className="list-disc pl-4 flex flex-col gap-1">
        {value.map((item, index) => (
          <li key={index}>{renderDetailValue(item)}</li>
        ))}
      </ul>
    );
  }
  if (value !== null && typeof value === "object") {
    return (
      <code className="break-all font-mono text-xs text-muted-foreground">
        {JSON.stringify(value)}
      </code>
    );
  }
  return null;
}

export function UserInputQuestionnaire({
  task,
  onResumeRun,
}: UserInputQuestionnaireProps) {
  const pending = task?.pendingUserInput ?? null;
  const taskId = task?.summary.task_id ?? null;
  const runId = pending?.runId ?? null;
  const promptKey =
    pending === null || taskId === null
      ? null
      : `${taskId}:${pending.runId}:${pending.requestId}:${pending.promptKind}`;
  const nextAttemptId = useRef(0);
  const [correctionText, setCorrectionText] = useState("");
  const [selectedDecision, setSelectedDecision] = useState<"approve" | "reject" | null>(null);
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
    setCorrectionText("");
    setSelectedDecision(null);
  }, [promptKey]);
  const pendingDecision =
    submission.promptKey === promptKey ? submission.pendingDecision : null;
  const error = submission.promptKey === promptKey ? submission.error : null;

  // A prompt is only actionable while its run is still awaiting user input.
  // After a cancel/failure transition the durable event clears the prompt;
  // this guard covers the transient window where the prompt is still present
  // but the run is no longer awaiting a decision.
  const pendingRun =
    pending === null || task === undefined
      ? null
      : (task.runsById[pending.runId] ?? null);
  const awaitingInput = pendingRun?.status === "awaiting_user_input";
  // A past or unparseable deadline is no longer actionable: render an
  // expired state and disable submission instead of claiming the deadline
  // is still open. The durable resume/synthetic event closes the prompt.
  const deadline =
    pending === null || pending.expiresAt === null
      ? null
      : new Date(pending.expiresAt).getTime();
  const expired =
    deadline !== null && (Number.isNaN(deadline) || deadline <= Date.now());
  const actionable = awaitingInput && !expired;
  // F3 (final review): a mounted card that crosses its deadline must flip
  // to the expired state (and disable its actions) without waiting for a
  // re-render from elsewhere. While a deadline is pending, re-render on a
  // one-second interval; the interval is torn down when the prompt clears
  // or the component unmounts.
  const [, setExpiryTick] = useState(0);
  useEffect(() => {
    if (pending === null || pending.expiresAt === null) return;
    const timer = window.setInterval(
      () => setExpiryTick((tick) => tick + 1),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [pending]);
  const planSpec = useMemo(
    () =>
      pending?.promptKind === "plan_confirmation" && pending.detail
        ? parsePlanSpec(pending.detail)
        : null,
    [pending],
  );
  const hilRequest = pending?.hilRequest ?? null;

  const submit = async (
    decision: HILDecision | UserInputDecision,
    detail: NonNullable<ResumeRunInput["detail"]> = {},
  ): Promise<void> => {
    if (
      pending === null ||
      taskId === null ||
      runId === null ||
      promptKey === null ||
      !awaitingInput ||
      expired
    ) {
      return;
    }
    const submittedPromptKey = promptKey;
    const submittedAction = typeof decision === "string" ? decision : decision.action;
    nextAttemptId.current += 1;
    const submittedAttemptId = nextAttemptId.current;
    setSubmission({
      promptKey: submittedPromptKey,
      attemptId: submittedAttemptId,
      pendingDecision: submittedAction,
      error: null,
    });
    try {
      const input: ResumeRunInput = hilRequest === null
        ? {
            request_id: pending.requestId,
            decision,
            detail,
          }
        : {
            request_id: hilRequest.request_id,
            evidence_digest: hilRequest.evidence_digest,
            decision,
            reason: null,
          };
      await onResumeRun(taskId, runId, input);
      // FIX 3 (final review): on SUCCESS the in-flight decision is retained
      // while the same prompt stays pending — the manager may have returned
      // its snapshot as-is (still awaiting_user_input) until the durable
      // user_input_resumed event lands, and a briefly re-enabled button
      // invites a second click the backend submitter would reject. The
      // promptKey reset effect clears the submission state once the prompt
      // is removed (or replaced), so nothing is retained beyond the prompt
      // lifecycle.
    } catch (caught) {
      // A confirmed rejection is the only path that restores the retry
      // state: clear the in-flight decision and surface the error.
      setSubmission((current) =>
        current.promptKey === submittedPromptKey &&
        current.attemptId === submittedAttemptId
          ? {
              ...current,
              pendingDecision: null,
              error:
                caught instanceof Error
                  ? caught.message
                  : "提交决策失败，请重试",
            }
          : current,
      );
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending === null) return;
    const resolution = userInputResolutionFromForm(new FormData(event.currentTarget));
    if (resolution === null) return;
    if (
      pending.promptKind === "data_correction" &&
      resolution.decision === "approve" &&
      correctionText.trim() === ""
    ) {
      setSubmission((current) => ({ ...current, error: "请输入修正内容。" }));
      return;
    }
    const detail: NonNullable<ResumeRunInput["detail"]> =
      pending.promptKind === "data_correction"
        ? { correction: resolution.decision === "approve" ? correctionText : "" }
        : {};
    await submit(resolution.decision, detail);
  };

  if (pending === null || taskId === null || runId === null) {
    return null;
  }

  const maxTurnsOrNoProgress =
    pending.promptKind === "max_turns_reached" || pending.promptKind === "no_progress";
  const title =
    pending.promptKind === "plan_confirmation"
      ? "确认研究计划"
      : pending.promptKind === "max_turns_reached"
        ? "Agent 已达到最大轮次"
        : pending.promptKind === "no_progress"
          ? "检测到无进展"
          : pending.promptKind === "api_key_or_credential"
            ? "需要凭据授权"
            : "需要人工修正";
  const description =
    pending.promptKind === "data_correction"
      ? "Agent 在研究中请求人工修正，请在下方输入你的修正并提交。"
      : (pending.summary ?? "Pipeline 已暂停，等待你的决策。");
  const approveLabel = maxTurnsOrNoProgress ? "继续工作" : "确认执行";
  const rejectLabel = maxTurnsOrNoProgress ? "停止" : "拒绝";
  const actionsDisabled = !actionable || pendingDecision !== null;
  const submitDisabled =
    actionsDisabled ||
    (pending.promptKind === "data_correction" &&
      selectedDecision === "approve" &&
      correctionText.trim() === "");

  if (hilRequest !== null) {
    return (
      <div className="flex min-w-0 flex-col gap-4">
        <p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
          {pending.summary}
        </p>
        <HumanReviewBatch
          key={hilRequest.request_id}
          request={hilRequest}
          disabled={actionsDisabled}
          submittingAction={pendingDecision}
          onSubmit={(decision) => submit(decision)}
        />
        {pending.fixtureExempt && (
          <Alert>
            <AlertDescription>
              {pending.promptKind === "data_correction"
                ? "当前为固定验收模式，仅供查看修正请求，提交修正仅触发流程继续。"
                : "当前为固定验收模式，仅供查看计划，确认按钮仅触发流程继续。"}
            </AlertDescription>
          </Alert>
        )}
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    );
  }

  return (
    <Questionnaire
      items={userInputQuestionnaireItems()}
      shortcuts="numbers"
      onSubmit={handleSubmit}
      aria-label="Agent 用户输入请求"
    >
      <Card size="sm" className="w-full">
        <CardHeader>
          <CardTitle className="flex min-w-0 items-center gap-2">
            <WarningIcon data-icon="inline-start" aria-hidden="true" />
            {title}
          </CardTitle>
          <CardDescription className="min-w-0 break-words">
            {description}
          </CardDescription>
          <CardAction>
            <QuestionnaireProgress
              render={(props, state) => (
                <span {...props}>第 {state.current} / {state.total} 步</span>
              )}
            />
          </CardAction>
        </CardHeader>

        <CardContent className="flex min-w-0 flex-col gap-4">
          {planSpec !== null && (
            <div className="flex max-h-72 min-w-0 flex-col gap-3 overflow-auto rounded-md border border-border/60 bg-muted/30 p-3 text-sm">
              <section className="flex flex-col gap-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  研究主题
                </p>
                <p className="break-words">{planSpec.topic}</p>
              </section>

              {planSpec.queries.length > 0 && (
                <section className="flex flex-col gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    检索查询 ({planSpec.queries.length})
                  </p>
                  <ol className="flex flex-col gap-2">
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
                          className="flex flex-col gap-1 rounded-md border border-border/40 bg-background/60 p-2"
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
                <section className="flex flex-col gap-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    数据集 ({planSpec.datasets.length})
                  </p>
                  <ul className="flex flex-col gap-2">
                    {planSpec.datasets.map((dataset, index) => {
                      const datasetId = asString(dataset.dataset_id);
                      const database = asString(dataset.database) ?? "unknown";
                      const accession = asString(dataset.accession) ?? "";
                      const reason = asString(dataset.reason);
                      return (
                        <li
                          key={datasetId ?? `${database}-${index}`}
                          className="flex flex-col gap-1 rounded-md border border-border/40 bg-background/60 p-2"
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
                <section className="flex flex-col gap-1">
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

          {pending.promptKind === "data_correction" && (
            <div className="flex min-w-0 flex-col gap-3 rounded-md border border-border/60 bg-muted/30 p-3 text-sm">
              <p className="whitespace-pre-wrap break-words text-sm font-medium leading-relaxed">
                {pending.summary}
              </p>

              {Object.keys(pending.detail).length > 0 && (
                <dl className="flex flex-col gap-2">
                  {Object.entries(pending.detail).map(([key, value]) => (
                    <div key={key} className="flex flex-col gap-1">
                      <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {key}
                      </dt>
                      <dd className="break-words">{renderDetailValue(value)}</dd>
                    </div>
                  ))}
                </dl>
              )}

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="data-correction-input">修正内容</Label>
                <Textarea
                  id="data-correction-input"
                  value={correctionText}
                  onChange={(event) => setCorrectionText(event.target.value)}
                  placeholder="输入你的修正或答复…"
                  disabled={pendingDecision !== null}
                />
              </div>

              {pending.expiresAt !== null &&
                (expired ? (
                  <p className="text-xs text-muted-foreground">
                    该请求已超时，将记录到 corrections_todo.csv 并继续
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    需在{" "}
                    {new Date(pending.expiresAt).toLocaleString("zh-CN", {
                      hour12: false,
                    })}{" "}
                    前答复，超时后将记录到 corrections_todo.csv 并继续
                  </p>
                ))}
            </div>
          )}

          <Separator />

          <QuestionnaireItem name="decision" required>
            <QuestionnaireTitle>如何处理？</QuestionnaireTitle>
            <QuestionnaireDescription>
              选择下方一种方式，然后确认提交。
            </QuestionnaireDescription>
            <QuestionnaireChoices>
              <QuestionnaireChoice
                value="approve"
                checked={selectedDecision === "approve"}
                onChange={() => setSelectedDecision("approve")}
                disabled={actionsDisabled}
              >
                <span className="font-medium">
                  {pending.promptKind === "data_correction" ? "提交修正" : approveLabel}
                </span>
                <QuestionnaireChoiceDescription>
                  {pending.promptKind === "data_correction"
                    ? "按下方修正内容提交并继续。"
                    : maxTurnsOrNoProgress
                      ? "允许 Agent 继续工作。"
                      : pending.promptKind === "plan_confirmation"
                        ? "确认研究计划，继续执行。"
                        : "授权使用当前凭据继续。"}
                </QuestionnaireChoiceDescription>
              </QuestionnaireChoice>
              <QuestionnaireChoice
                value="reject"
                checked={selectedDecision === "reject"}
                onChange={() => setSelectedDecision("reject")}
                disabled={actionsDisabled}
              >
                <span className="font-medium">
                  {pending.promptKind === "data_correction" ? "跳过并继续" : rejectLabel}
                </span>
                <QuestionnaireChoiceDescription>
                  {pending.promptKind === "data_correction"
                    ? "不提交修正，流程继续。"
                    : "拒绝后停止当前请求。"}
                </QuestionnaireChoiceDescription>
              </QuestionnaireChoice>
            </QuestionnaireChoices>
            <QuestionnaireError>请选择一种处理方式。</QuestionnaireError>
          </QuestionnaireItem>

          {pending.fixtureExempt && (
            <Alert>
              <AlertDescription>
                {pending.promptKind === "data_correction"
                  ? "当前为固定验收模式，仅供查看修正请求，提交修正仅触发流程继续。"
                  : "当前为固定验收模式，仅供查看计划，确认按钮仅触发流程继续。"}
              </AlertDescription>
            </Alert>
          )}

          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>

        <CardFooter>
          <QuestionnaireActions>
            <QuestionnaireSubmit disabled={submitDisabled}>
              {pendingDecision !== null && <Spinner data-icon="inline-start" aria-hidden="true" />}
              确认
            </QuestionnaireSubmit>
          </QuestionnaireActions>
        </CardFooter>
      </Card>
    </Questionnaire>
  );
}