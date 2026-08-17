import { useState, type FormEvent } from "react";

import { WarningIcon } from "@phosphor-icons/react";

import {
  permissionQuestionnaireItems,
  permissionResolutionFromForm,
  type PermissionGrantAnswer,
  type PermissionPrimaryAnswer,
  type PermissionScopeDurationAnswer,
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
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireError,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import type { PendingPermission } from "@/runtime/types";

interface PermissionQuestionnaireProps {
  taskId: string;
  permission: PendingPermission;
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
  "fs.read": "读取",
  "fs.write": "写入",
  "fs.edit": "修改",
  "process.exec": "执行命令",
};

const SCOPE_LABELS: Record<PendingPermission["scope"], string> = {
  workspace: "工作区",
  task_output: "任务输出",
  framework_internal: "框架内部路径",
  sensitive: "敏感文件",
  project: "项目目录",
  external: "外部目录",
};

function grantDescription(permission: PendingPermission, scope: "run" | "task"): string {
  const lifetime = scope === "run" ? "当前 Run" : "当前 Task";
  return permission.capability === "process.exec"
    ? `${lifetime} 内执行命令时不再询问。`
    : `${lifetime} 内访问当前路径及其子路径时不再询问。`;
}

export function PermissionQuestionnaire({
  taskId,
  permission,
  onResolvePermission,
}: PermissionQuestionnaireProps) {
  const [primary, setPrimary] = useState<PermissionPrimaryAnswer | null>(null);
  const [grant, setGrant] = useState<PermissionGrantAnswer | null>(null);
  const [scopeDuration, setScopeDuration] = useState<PermissionScopeDurationAnswer | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isExec = permission.capability === "process.exec";
  const items = permissionQuestionnaireItems(permission, primary, grant);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const resolution = permissionResolutionFromForm(new FormData(event.currentTarget));
    if (resolution === null) return;

    setSubmitting(true);
    setError(null);
    try {
      await onResolvePermission(
        taskId,
        permission.runId,
        permission.requestId,
        resolution.decision,
        resolution.grantScope,
        resolution.scopeWide,
      );
      // Keep the questionnaire disabled until the durable resolved event
      // removes it. A rejected submission is the only retry path.
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "提交权限决策失败，请重试");
      setSubmitting(false);
    }
  };

  return (
    <Questionnaire
      items={items}
      shortcuts="numbers"
      onSubmit={submit}
      aria-label="Agent 权限请求"
    >
      <Card size="sm" className="w-full">
        <CardHeader>
          <CardTitle className="flex min-w-0 items-center gap-2">
            <WarningIcon data-icon="inline-start" aria-hidden="true" />
            {isExec
              ? "Agent 想执行命令"
              : `Agent 想${CAPABILITY_LABELS[permission.capability]}`}
          </CardTitle>
          <CardDescription>
            {isExec
              ? "确认是否允许这条命令继续执行。"
              : `目标位于${SCOPE_LABELS[permission.scope]}。`}
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
          <div className="flex min-w-0 flex-col gap-3 text-sm">
            {isExec ? (
              <>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs text-muted-foreground">命令</span>
                  <code className="break-all font-mono text-xs">
                    {permission.command ?? permission.summary}
                  </code>
                </div>
                {permission.cwd !== null && (
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-xs text-muted-foreground">工作目录</span>
                    <code className="break-all font-mono text-xs">{permission.cwd}</code>
                  </div>
                )}
                <Alert>
                  <AlertDescription>
                    此命令及其子进程将继承当前系统账户权限。
                  </AlertDescription>
                </Alert>
              </>
            ) : (
              <>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-xs text-muted-foreground">目标</span>
                  <code className="break-all font-mono text-xs">
                    {permission.resource ?? permission.summary}
                  </code>
                </div>
                {permission.canonicalResource !== null &&
                  permission.canonicalResource !== permission.resource && (
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-xs text-muted-foreground">
                        实际目标（符号链接或目录联接解析后）
                      </span>
                      <code className="break-all font-mono text-xs text-destructive">
                        {permission.canonicalResource}
                      </code>
                    </div>
                  )}
                <div className="flex flex-wrap gap-1.5">
                  <Badge variant="outline">{CAPABILITY_LABELS[permission.capability]}</Badge>
                  <Badge variant="secondary">{SCOPE_LABELS[permission.scope]}</Badge>
                </div>
              </>
            )}
          </div>

          <Separator />

          <QuestionnaireItem name="decision" required>
            <QuestionnaireTitle>如何处理？</QuestionnaireTitle>
            <QuestionnaireDescription>
              默认授权只影响当前这一次操作。
            </QuestionnaireDescription>
            <QuestionnaireChoices>
              <QuestionnaireChoice
                value="allow_once"
                checked={primary === "allow_once"}
                onChange={() => {
                  setPrimary("allow_once");
                  setGrant(null);
                  setScopeDuration(null);
                }}
              >
                <span className="font-medium">允许这一次</span>
                <QuestionnaireChoiceDescription>仅继续当前操作。</QuestionnaireChoiceDescription>
              </QuestionnaireChoice>
              <QuestionnaireChoice
                value="deny"
                checked={primary === "deny"}
                onChange={() => {
                  setPrimary("deny");
                  setGrant(null);
                  setScopeDuration(null);
                }}
              >
                <span className="font-medium">拒绝</span>
                <QuestionnaireChoiceDescription>当前操作不会执行。</QuestionnaireChoiceDescription>
              </QuestionnaireChoice>
              <QuestionnaireChoice
                value="other"
                checked={primary === "other"}
                onChange={() => setPrimary("other")}
              >
                <span className="font-medium">其他授权方式</span>
                <QuestionnaireChoiceDescription>
                  为当前 Run、Task 或后续操作授权。
                </QuestionnaireChoiceDescription>
              </QuestionnaireChoice>
            </QuestionnaireChoices>
            <QuestionnaireError>请选择一种处理方式。</QuestionnaireError>
          </QuestionnaireItem>

          <QuestionnaireItem name="grant" required disabled={primary !== "other"}>
            <QuestionnaireTitle>授权范围</QuestionnaireTitle>
            <QuestionnaireDescription>
              选择授权持续时间。长期授权可在设置中撤销。
            </QuestionnaireDescription>
            <QuestionnaireChoices>
              <QuestionnaireChoice
                value="run"
                checked={grant === "run"}
                onChange={() => {
                  setGrant("run");
                  setScopeDuration(null);
                }}
              >
                <span className="font-medium">本次 Run</span>
                <QuestionnaireChoiceDescription>
                  {grantDescription(permission, "run")}
                </QuestionnaireChoiceDescription>
              </QuestionnaireChoice>
              <QuestionnaireChoice
                value="task"
                checked={grant === "task"}
                onChange={() => {
                  setGrant("task");
                  setScopeDuration(null);
                }}
              >
                <span className="font-medium">本 Task</span>
                <QuestionnaireChoiceDescription>
                  {grantDescription(permission, "task")}
                </QuestionnaireChoiceDescription>
              </QuestionnaireChoice>
              <QuestionnaireChoice
                value="persistent"
                checked={grant === "persistent"}
                onChange={() => {
                  setGrant("persistent");
                  setScopeDuration(null);
                }}
              >
                <span className="font-medium">
                  {isExec ? "始终允许命令执行" : "始终允许此路径"}
                </span>
                <QuestionnaireChoiceDescription>
                  {isExec ? "后续命令不再询问。" : "后续访问当前路径时不再询问。"}
                </QuestionnaireChoiceDescription>
              </QuestionnaireChoice>
              {items[1].choices.some((choice) => choice.value === "scope_wide") && (
                <QuestionnaireChoice
                  value="scope_wide"
                  checked={grant === "scope_wide"}
                  onChange={() => setGrant("scope_wide")}
                >
                  <span className="font-medium">
                    高级：允许整个“{SCOPE_LABELS[permission.scope]}”范围
                  </span>
                  <QuestionnaireChoiceDescription>
                    该范围内所有路径都不再询问，风险更高。
                  </QuestionnaireChoiceDescription>
                </QuestionnaireChoice>
              )}
            </QuestionnaireChoices>
            <QuestionnaireError>请选择授权范围。</QuestionnaireError>
          </QuestionnaireItem>

          <QuestionnaireItem
            name="scope_duration"
            required
            disabled={primary !== "other" || grant !== "scope_wide"}
          >
            <QuestionnaireTitle>整个范围授权持续多久？</QuestionnaireTitle>
            <QuestionnaireDescription>
              整个范围授权不会持久保存。
            </QuestionnaireDescription>
            <QuestionnaireChoices>
              <QuestionnaireChoice
                value="run"
                checked={scopeDuration === "run"}
                onChange={() => setScopeDuration("run")}
              >
                <span className="font-medium">仅本次 Run</span>
              </QuestionnaireChoice>
              <QuestionnaireChoice
                value="task"
                checked={scopeDuration === "task"}
                onChange={() => setScopeDuration("task")}
              >
                <span className="font-medium">本 Task</span>
              </QuestionnaireChoice>
            </QuestionnaireChoices>
            <QuestionnaireError>请选择授权持续时间。</QuestionnaireError>
          </QuestionnaireItem>

          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>

        <CardFooter>
          <QuestionnaireActions>
            <QuestionnairePrevious disabled={submitting}>上一步</QuestionnairePrevious>
            <QuestionnaireNext disabled={submitting}>继续</QuestionnaireNext>
            <QuestionnaireSubmit disabled={submitting}>
              {submitting && <Spinner data-icon="inline-start" aria-hidden="true" />}
              确认
            </QuestionnaireSubmit>
          </QuestionnaireActions>
        </CardFooter>
      </Card>
    </Questionnaire>
  );
}
