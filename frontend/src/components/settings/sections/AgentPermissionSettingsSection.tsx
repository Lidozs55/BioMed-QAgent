import { useEffect, useState } from "react";

import { TrashIcon } from "@phosphor-icons/react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
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
  AgentPermissionSettings,
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
};

/**
 * Agent permission settings (plan §35): preset selection + persistent
 * directory rules.
 */
export function AgentPermissionSettingsSection({ api }: AgentPermissionSettingsSectionProps) {
  const [settings, setSettings] = useState<AgentPermissionSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.fetchAgentPermissions()
      .then((value) => {
        if (cancelled) return;
        setSettings(value);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "加载权限设置失败");
        setLoading(false);
      });
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
            持久路径规则（通过“始终允许此目录”批准后自动添加，也可手动删除）。
          </CardDescription>
        </CardHeader>
        <CardContent>
          {current.rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              暂无持久规则。Agent 尝试访问工作区外路径时，你可以在批准卡片中选择“始终允许此目录”。
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
          {current.persistent_exec_allow && (
            <Alert className="mt-3">
              <AlertDescription>
                已启用“始终允许命令执行”：命令继承 BioMed-QAgent 当前系统账户权限。
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
