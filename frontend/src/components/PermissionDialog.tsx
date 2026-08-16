import { useState } from "react";

import {
  CheckIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";

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
import type { PendingPermission, TaskProjection } from "@/runtime/types";

interface PermissionDialogProps {
  task: TaskProjection | undefined;
  onResolvePermission: (
    taskId: string,
    runId: string,
    requestId: string,
    decision: "allow" | "deny",
    grantScope?: "once" | "run" | "task" | "persistent",
    scopeWide?: boolean,
  ) => Promise<void>;
}

const CAPABILITY_LABELS: Record<PendingPermission["capability"], string> = {
  "fs.read": "读取文件",
  "fs.write": "写入文件",
  "fs.edit": "修改文件",
  "process.exec": "执行命令",
};

const SCOPE_LABELS: Record<PendingPermission["scope"], string> = {
  workspace: "工作区",
  task_output: "任务输出",
  framework_internal: "框架内部路径",
  sensitive: "敏感文件（.env/密钥）",
  project: "项目目录",
  external: "外部目录",
};

/**
 * Permission approval card (plan §34). Rendered in the run timeline instead
 * of a transient system modal so a page refresh still shows the context;
 * the pending state itself is restored from the durable event stream.
 *
 * Round-3 audit: when the requested path differs from its canonical target
 * (symlink/junction), both are shown; "本 Run / 本 Task" grants bind to the
 * canonical path + subtree, with an explicit opt-in for the whole scope.
 */
export function PermissionDialog({ task, onResolvePermission }: PermissionDialogProps) {
  const pending = task?.pendingPermission ?? null;
  const taskId = task?.summary.task_id ?? null;
  const runId = pending?.runId ?? null;
  const [submitting, setSubmitting] = useState<"deny" | "once" | "run" | "task" | "persistent" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scopeWide, setScopeWide] = useState(false);
  const open = pending !== null && taskId !== null && runId !== null;
  const isExec = pending?.capability === "process.exec";
  // Round-3 audit: the whole-scope opt-in only makes sense for fs requests
  // where a path-rooted run/task grant would otherwise be the safer default.
  const canScopeWide =
    pending !== null &&
    !isExec &&
    (pending.scope === "project" || pending.scope === "external" || pending.scope === "sensitive");

  const submit = async (
    decision: "allow" | "deny",
    grantScope?: "once" | "run" | "task" | "persistent",
  ) => {
    if (pending === null || taskId === null || runId === null) return;
    const key = decision === "deny" ? "deny" : (grantScope ?? "once");
    setSubmitting(key);
    setError(null);
    try {
      if (scopeWide && (grantScope === "run" || grantScope === "task")) {
        await onResolvePermission(taskId, runId, pending.requestId, decision, grantScope, true);
      } else {
        await onResolvePermission(taskId, runId, pending.requestId, decision, grantScope);
      }
      // The durable permission_resolved event clears the card; release the
      // in-flight state so the UI never sticks on a disabled button.
      setSubmitting(null);
      setScopeWide(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提交权限决策失败，请重试");
      setSubmitting(null);
    }
  };


  return (
    <Dialog
      open={open}
      onOpenChange={() => undefined}
    >
      <DialogContent
        showCloseButton={false}
        className="min-w-0 max-w-[calc(100vw-2rem)] sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WarningIcon data-icon="inline-start" aria-hidden="true" />
            {isExec ? "Agent 请求执行命令" : `Agent 请求${CAPABILITY_LABELS[pending?.capability ?? "fs.read"]}`}
          </DialogTitle>
          <DialogDescription className="min-w-0 break-words">
            {pending === null
              ? "Agent 正在等待权限决策。"
              : isExec
                ? "命令将继承 BioMed-QAgent 当前系统账户权限，可能访问工作区外文件、网络或其他当前账户有权限访问的资源。"
                : `目标位于${SCOPE_LABELS[pending.scope]}，${pending.scope === "workspace"
                    ? "工作区内操作默认允许。"
                    : "需要你的批准。"}`}
          </DialogDescription>
        </DialogHeader>

        {pending !== null && (
          <div className="flex min-w-0 flex-col gap-3 rounded-md border border-border/60 bg-muted/30 p-3 text-sm">
            {isExec ? (
              <>
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    命令
                  </p>
                  <code className="break-all font-mono text-xs">{pending.command ?? pending.summary}</code>
                </div>
                {pending.cwd !== null && (
                  <div className="flex flex-col gap-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      工作目录
                    </p>
                    <code className="break-all font-mono text-xs">{pending.cwd}</code>
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col gap-1">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  目标
                </p>
                <code className="break-all font-mono text-xs">{pending.resource ?? pending.summary}</code>
                {pending.canonicalResource !== null &&
                  pending.canonicalResource !== pending.resource && (
                    <div className="flex flex-col gap-0.5">
                      <p className="text-xs text-muted-foreground">
                        实际路径（符号链接/联接解析后）
                      </p>
                      <code className="break-all font-mono text-xs text-amber-600">
                        {pending.canonicalResource}
                      </code>
                    </div>
                  )}
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge variant="outline">{CAPABILITY_LABELS[pending.capability]}</Badge>
                  <Badge variant="secondary">{SCOPE_LABELS[pending.scope]}</Badge>
                </div>
              </div>
            )}
          </div>
        )}

        {isExec && pending !== null && (
          <Alert>
            <AlertDescription>
              允许执行后，该命令或其子进程可能访问 Workspace 外文件、网络或其他当前账户有权限访问的资源。
            </AlertDescription>
          </Alert>
        )}

        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!isExec && pending !== null && (
          <div className="flex flex-col gap-1.5">
            <p className="text-xs text-muted-foreground">
              提示：“本 Run / 本 Task 允许”针对当前目标路径及其子路径（“
              {CAPABILITY_LABELS[pending.capability]}”× 该路径），不会自动覆盖同一范围的其他路径。
              持久授权只针对当前这条具体路径。
            </p>
            {canScopeWide && (
              <label className="flex cursor-pointer items-start gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={scopeWide}
                  onChange={(event) => setScopeWide(event.target.checked)}
                />
                <span>
                  高级：改为授权整个“{SCOPE_LABELS[pending.scope]}”范围（该范围内所有路径都不再询问，
                  风险更高，仅在你确定需要时勾选）。
                </span>
              </label>
            )}
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={submitting !== null}
            onClick={() => void submit("deny")}
          >
            {submitting === "deny" ? (
              <Spinner data-icon="inline-start" aria-hidden="true" />
            ) : (
              <XCircleIcon data-icon="inline-start" aria-hidden="true" />
            )}
            拒绝
          </Button>
          {isExec ? (
            <>
              <Button
                disabled={submitting !== null}
                onClick={() => void submit("allow", "once")}
              >
                {submitting === "once" ? (
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                ) : (
                  <CheckIcon data-icon="inline-start" aria-hidden="true" />
                )}
                允许一次
              </Button>
              <Button
                variant="secondary"
                disabled={submitting !== null}
                onClick={() => void submit("allow", "run")}
              >
                {submitting === "run" ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
                本次 Run 允许
              </Button>
              <Button
                variant="secondary"
                disabled={submitting !== null}
                onClick={() => void submit("allow", "task")}
              >
                {submitting === "task" ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
                本 Task 允许
              </Button>
              <Button
                variant="secondary"
                disabled={submitting !== null}
                onClick={() => void submit("allow", "persistent")}
              >
                {submitting === "persistent" ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
                始终允许命令执行
              </Button>
            </>
          ) : (
            <>
              <Button
                disabled={submitting !== null}
                onClick={() => void submit("allow", "once")}
              >
                {submitting === "once" ? (
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                ) : (
                  <CheckIcon data-icon="inline-start" aria-hidden="true" />
                )}
                允许一次
              </Button>
              <Button
                variant="secondary"
                disabled={submitting !== null}
                onClick={() => void submit("allow", "run")}
              >
                {submitting === "run" ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
                本 Run 允许
              </Button>
              <Button
                variant="secondary"
                disabled={submitting !== null}
                onClick={() => void submit("allow", "task")}
              >
                {submitting === "task" ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
                本 Task 允许
              </Button>
              <Button
                variant="secondary"
                disabled={submitting !== null}
                onClick={() => void submit("allow", "persistent")}
              >
                {submitting === "persistent" ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
                始终允许此路径
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
