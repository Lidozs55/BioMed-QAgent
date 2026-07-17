import { useMemo, useState } from "react";

import { CheckIcon, XCircleIcon } from "@phosphor-icons/react";

import { Alert, AlertDescription } from "@/components/ui/alert";
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

function tryStringifyPlan(detail: PendingUserInput["detail"]): string | null {
  try {
    const text = JSON.stringify(detail, null, 2);
    return text === "{}" ? null : text;
  } catch {
    return null;
  }
}

export function UserInputDialog({ task, onResumeRun }: UserInputDialogProps) {
  const pending = task?.pendingUserInput ?? null;
  const taskId = task?.summary.task_id ?? null;
  const runId = task?.summary.active_run_id ?? null;
  const [pendingDecision, setPendingDecision] =
    useState<UserInputDecision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = pending !== null && taskId !== null && runId !== null;
  const planText = useMemo(
    () => (pending ? tryStringifyPlan(pending.detail) : null),
    [pending],
  );

  const submit = async (decision: UserInputDecision) => {
    if (pending === null || taskId === null || runId === null) return;
    setPendingDecision(decision);
    setError(null);
    try {
      await onResumeRun(taskId, runId, {
        request_id: pending.requestId,
        decision,
        detail: {},
      });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "提交决策失败，请重试",
      );
    } finally {
      setPendingDecision(null);
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
              : "请补充信息"}
          </DialogTitle>
          <DialogDescription className="min-w-0 break-words">
            {pending?.summary ?? "Pipeline 已暂停，等待你的决策。"}
          </DialogDescription>
        </DialogHeader>

        {planText !== null && (
          <pre className="max-h-64 min-w-0 overflow-auto rounded-md bg-muted/40 p-3 text-xs">
            {planText}
          </pre>
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
            拒绝
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
            确认执行
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
