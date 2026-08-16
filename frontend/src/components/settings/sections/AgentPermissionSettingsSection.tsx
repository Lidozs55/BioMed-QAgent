import { useEffect, useState } from "react";

import { PlusIcon, TrashIcon } from "@phosphor-icons/react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  AgentPermissionPreset,
  AgentPermissionRuleInput,
  AgentPermissionSettings,
  AgentTempGrant,
  SettingsAPIClient,
} from "@/api/types";

interface AgentPermissionSettingsSectionProps {
  api: SettingsAPIClient;
}

const PRESET_OPTIONS: Array<{
  value: AgentPermissionPreset;
  label: string;
  description: string;
}> = [
  {
    value: "restricted",
    label: "受限",
    description: "Agent 只能在自己的工作区中工作；任务输出只读，项目/外部目录与命令执行均拒绝。",
  },
  {
    value: "ask_when_needed",
    label: "按需询问",
    description: "工作区自由；访问项目或外部文件、执行命令时询问你。",
  },
  {
    value: "full_access",
    label: "完全访问",
    description: "允许访问项目与外部文件并执行命令。命令继承当前系统账户权限，可能读取或修改账户可访问的任何文件。",
  },
];

const CAPABILITY_LABELS: Record<string, string> = {
  "fs.read": "读取",
  "fs.write": "写入",
  "fs.edit": "修改",
  "process.exec": "执行命令",
};

const SCOPE_LABELS: Record<string, string> = {
  workspace: "工作区",
  task_output: "任务输出",
  framework_internal: "框架内部",
  sensitive: "敏感文件",
  project: "项目目录",
  external: "外部目录",
};

/**
 * Agent permission settings (plan §35): preset selection + persistent
 * directory rules.
 */
export function AgentPermissionSettingsSection({ api }: AgentPermissionSettingsSectionProps) {
  const [settings, setSettings] = useState<AgentPermissionSettings | null>(null);
  const [tempGrants, setTempGrants] = useState<AgentTempGrant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rulePath, setRulePath] = useState("");
  const [ruleCapability, setRuleCapability] = useState<"fs.read" | "fs.write" | "fs.edit">("fs.read");
  const [rulePolicy, setRulePolicy] = useState<"allow" | "ask" | "deny">("allow");
  // Round-4 audit: a persistent rule binds to ONE resource scope. Defaulting
  // to ``project`` keeps the rule from accidentally covering sensitive files
  // or external paths the user did not mean to authorize.
  const [ruleScope, setRuleScope] = useState<AgentPermissionRuleInput["resource_scope"]>("project");
  const [ruleSubmitting, setRuleSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const [value, grants] = await Promise.all([
          api.fetchAgentPermissions(),
          api.fetchAgentTempGrants(),
        ]);
        if (cancelled) return;
        setSettings(value);
        setTempGrants(grants);
        setLoading(false);
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "加载权限设置失败");
        setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const apply = async (action: () => Promise<AgentPermissionSettings>): Promise<void> => {
    setError(null);
    try {
      setSettings(await action());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存权限设置失败");
    }
  };

  const refreshGrants = async (): Promise<void> => {
    setError(null);
    try {
      setTempGrants(await api.fetchAgentTempGrants());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "加载运行中授权失败");
    }
  };

  const revokeGrant = async (grantId: string): Promise<void> => {
    setError(null);
    try {
      await api.revokeAgentTempGrant(grantId);
      await refreshGrants();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "撤销授权失败");
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const current = settings ?? {
    schema_version: 1 as const,
    preset: "ask_when_needed" as AgentPermissionPreset,
    rules: [],
    persistent_exec_allow: false,
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>权限模式</CardTitle>
          <CardDescription>
            控制 Agent 对工作区外资源的访问方式。工作区（data/workspaces/&lt;taskId&gt;）始终允许读写。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2">
            <Label>权限模式</Label>
            <Select
              value={current.preset}
              onValueChange={(value) => {
                void apply(() => api.setAgentPermissionsPreset(value as AgentPermissionPreset));
              }}
            >
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESET_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {PRESET_OPTIONS.find((option) => option.value === current.preset)?.description}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>已授权目录</CardTitle>
          <CardDescription>
            持久路径规则（通过“始终允许此路径”批准后自动添加，也可手动创建或删除）。
            规则路径必须为绝对路径；递归规则覆盖该路径下的所有子路径。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid gap-2 rounded-md border border-border/60 p-3 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
            <div className="flex min-w-0 flex-col gap-1">
              <Label htmlFor="rule-path">路径（绝对路径，自动规范化）</Label>
              <Input
                id="rule-path"
                placeholder="D:\\datasets\\TCGA"
                value={rulePath}
                onChange={(event) => setRulePath(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label>能力</Label>
              <Select
                value={ruleCapability}
                onValueChange={(value) => setRuleCapability(value as "fs.read" | "fs.write" | "fs.edit")}
              >                <SelectTrigger className="w-full sm:w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fs.read">读取</SelectItem>
                  <SelectItem value="fs.write">写入</SelectItem>
                  <SelectItem value="fs.edit">修改</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>策略</Label>
              <Select
                value={rulePolicy}
                onValueChange={(value) => setRulePolicy(value as "allow" | "ask" | "deny")}
              >                <SelectTrigger className="w-full sm:w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="allow">允许</SelectItem>
                  <SelectItem value="ask">询问</SelectItem>
                  <SelectItem value="deny">拒绝</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1">
              <Label>作用域</Label>
              <Select
                value={ruleScope}
                onValueChange={(value) => setRuleScope(value as AgentPermissionRuleInput["resource_scope"])}
              >                <SelectTrigger className="w-full sm:w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="project">项目目录</SelectItem>
                  <SelectItem value="external">外部目录</SelectItem>
                  <SelectItem value="sensitive">敏感文件</SelectItem>
                  <SelectItem value="workspace">工作区</SelectItem>
                  <SelectItem value="task_output">任务输出</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button
              size="sm"
              disabled={rulePath.trim() === "" || ruleSubmitting}
              onClick={() => {
                setRuleSubmitting(true);
                void apply(async () => {
                  const next = await api.addAgentPermissionRule({
                    capability: ruleCapability,
                    resource_scope: ruleScope,
                    path: rulePath.trim(),
                    recursive: true,
                    policy: rulePolicy,
                  });
                  setRulePath("");
                  return next;
                }).finally(() => setRuleSubmitting(false));
              }}
            >
              <PlusIcon data-icon="inline-start" aria-hidden="true" />
              添加规则
            </Button>
          </div>
          {current.rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              暂无持久规则。Agent 尝试访问工作区外路径时，你可以在批准卡片中选择“始终允许此路径”。
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {current.rules.map((rule) => (
                <li
                  key={rule.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <code className="truncate font-mono text-xs">{rule.path}</code>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="outline">{CAPABILITY_LABELS[rule.capability] ?? rule.capability}</Badge>
                      <Badge variant="outline">{SCOPE_LABELS[rule.resource_scope] ?? rule.resource_scope}</Badge>
                      {rule.recursive && <Badge variant="secondary">递归</Badge>}
                      <Badge
                        variant={rule.policy === "deny" ? "destructive" : rule.policy === "ask" ? "outline" : "default"}
                      >
                        {rule.policy === "allow" ? "允许" : rule.policy === "deny" ? "拒绝" : "询问"}
                      </Badge>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`删除规则 ${rule.path}`}
                    onClick={() => void apply(() => api.removeAgentPermissionRule(rule.id))}
                  >
                    <TrashIcon aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>运行中授权</CardTitle>
          <CardDescription>
            本进程内尚未过期的 Run / Task 临时授权（批准卡片上的“本 Run 允许 / 本 Task 允许”）。
            可随时在此撤销；重启进程后这些授权自动失效。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tempGrants.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              暂无运行中授权。Agent 请求工作区外访问时，可在批准卡片中选择“本 Run / 本 Task 允许”。
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {tempGrants.map((grant) => (
                <li
                  key={grant.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-3 py-2"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <code className="truncate font-mono text-xs">
                      {grant.root ?? `整个${SCOPE_LABELS[grant.scope] ?? grant.scope}范围`}
                    </code>
                    <div className="flex flex-wrap gap-1.5">
                      <Badge variant="outline">{CAPABILITY_LABELS[grant.capability] ?? grant.capability}</Badge>
                      <Badge variant="secondary">
                        {grant.boundTo === "run" ? "本 Run" : "本 Task"}
                      </Badge>
                      <Badge variant="outline">{grant.taskId}</Badge>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="撤销此授权"
                    onClick={() => void revokeGrant(grant.id)}
                  >
                    <TrashIcon aria-hidden="true" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>命令执行</CardTitle>
          <CardDescription>
            控制 Agent 执行命令的持久授权。命令继承 BioMed-QAgent 当前系统账户权限。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Label htmlFor="persistent-exec-switch">始终允许命令执行</Label>
              <p className="text-xs text-muted-foreground">
                {current.preset === "restricted"
                  ? "受限模式下命令执行始终拒绝，此开关不可用。"
                  : current.persistent_exec_allow
                    ? "已启用：不再逐条询问命令执行。"
                    : "关闭后需要逐条批准命令执行；可随时在此撤销授权。"}
              </p>
            </div>
            <Switch
              id="persistent-exec-switch"
              checked={current.persistent_exec_allow}
              disabled={current.preset === "restricted"}
              onCheckedChange={(checked) => {
                void apply(() => api.setAgentPermissionsPersistentExec(checked));
              }}
            />
          </div>
          {current.persistent_exec_allow && current.preset !== "restricted" && (
            <Alert className="mt-3">
              <AlertDescription>
                已启用“始终允许命令执行”：命令继承 BioMed-QAgent 当前系统账户权限，
                可读取或修改账户可访问的任何文件。切换到“受限”模式会立即撤销此授权。
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
