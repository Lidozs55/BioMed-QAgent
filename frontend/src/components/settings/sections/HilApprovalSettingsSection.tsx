import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import type {
  HILApprovalMode,
  HILApprovalScope,
  HILApprovalSettings,
} from "@biomed/contracts";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingCard, SettingSection, SegmentedControl } from "@/components/settings/primitives";
import { HIL_HUMAN_MANDATORY_SCOPES, type SettingsAPIClient } from "@/api/types";

interface HilApprovalSettingsSectionProps {
  api: SettingsAPIClient;
}

const MODES: Array<{ value: HILApprovalMode; label: string }> = [
  { value: "human_review", label: "人工审批" },
  { value: "llm_pre_review", label: "大模型初审" },
  { value: "auto_approve", label: "不审批" },
];

const MODE_DESCRIPTIONS: Record<HILApprovalMode, string> = {
  human_review: "每次审核请求都暂停等待人工决定（默认，现状行为）。",
  llm_pre_review:
    "大模型先审一遍：初审通过则自动按“接受/授权”处理并记录理由，只有初审不通过（或模型调用失败）的请求才进入人工审批。",
  auto_approve:
    "不等待任何审批，请求创建后立即按通过处理（reviewer 记为 auto）。",
};

const SCOPES: Array<{ scope: HILApprovalScope; label: string; description: string }> = [
  { scope: "permission", label: "凭据 / 工具授权", description: "Agent 请求使用凭据或敏感工具时的授权确认。" },
  { scope: "field_mapping", label: "字段映射", description: "字符串相似度等提出的字段映射候选。" },
  { scope: "entity_mapping", label: "实体映射", description: "跨来源实体对齐候选。" },
  { scope: "unit_conversion", label: "单位换算", description: "无注册换算规则的未知单位；通过处理需要结构化修正，“不审批”会导致该操作显式失败，建议保持人工审批或大模型初审。" },
  { scope: "vlm_extraction", label: "图表数据抽取", description: "VLM 点级抽取结果；下游 chart 证据门禁要求人工复核。" },
  { scope: "source_conflict", label: "来源冲突", description: "同一指标多个来源取值冲突时的仲裁。" },
  { scope: "measurement_semantics", label: "测量语义", description: "测量表达式语义（如“杀伤率”）的歧义消解。" },
  { scope: "browser_acquisition_formalization", label: "浏览器采集正式化", description: "浏览器页面结构化结果正式化为证据提案前的确认。" },
  { scope: "browser_evidence_acceptance", label: "浏览器证据接受", description: "浏览器证据进入发布的最终接受门；发布边界要求人工审批。" },
  { scope: "publication_acceptance", label: "发布验收", description: "数据集发布前的最终验收门；发布边界要求人工审批。" },
];

function isHumanMandatory(scope: HILApprovalScope): boolean {
  return (HIL_HUMAN_MANDATORY_SCOPES as readonly string[]).includes(scope);
}

export function HilApprovalSettingsSection({ api }: HilApprovalSettingsSectionProps) {
  const [settings, setSettings] = useState<HILApprovalSettings | null>(null);
  const [savingScope, setSavingScope] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.fetchHilApproval()
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch((error: unknown) => {
        toast.error("HIL 审批设置加载失败", {
          description: error instanceof Error ? error.message : "请求失败",
        });
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const apply = useCallback(async (
    patch: Parameters<SettingsAPIClient["saveHilApproval"]>[0],
    key: string,
  ) => {
    setSavingScope(key);
    try {
      const updated = await api.saveHilApproval(patch);
      setSettings(updated);
    } catch (error) {
      toast.error("HIL 审批设置保存失败", {
        description: error instanceof Error ? error.message : "请求失败",
      });
    } finally {
      setSavingScope(null);
    }
  }, [api]);

  if (settings === null) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8" data-anchor="hil-approval-settings">
      <SettingSection
        title="默认审批档位"
        description="未单独分配档位的审核类型按默认档位处理。"
      >
        <SettingCard>
          <div className="flex flex-col gap-3 px-5 py-4">
            <SegmentedControl
              value={settings.default_mode}
              options={MODES}
              ariaLabel="默认 HIL 审批档位"
              disabled={savingScope !== null}
              onChange={(mode) => void apply({ default_mode: mode }, "default_mode")}
            />
            <p className="text-xs text-muted-foreground">
              {MODE_DESCRIPTIONS[settings.default_mode]}
            </p>
          </div>
        </SettingCard>
      </SettingSection>

      <SettingSection
        title="审批权限分配"
        description="为每个审核范围单独分配三档审批权限：人工审批 / 大模型初审 / 不审批。"
      >
        <Alert>
          <AlertTitle>发布边界始终人工把关</AlertTitle>
          <AlertDescription>
            图表数据抽取、浏览器证据接受与发布验收是发布信任边界的最终门禁，下游校验要求
            reviewer 必须是真人，因此这三类固定为人工审批。“大模型初审”的提示词会拦截绕过系统设计的请求（如脚本直改数据、跳过校验门禁），判为不通过即回退人工审批；模型调用异常同样回退人工（fail-safe）。“不审批”档不做任何内容审查，请求一律自动通过。
          </AlertDescription>
        </Alert>
        <SettingCard>
          <div className="flex flex-col">
            {SCOPES.map((entry, index) => {
              const mandatory = isHumanMandatory(entry.scope);
              const effective: HILApprovalMode = mandatory
                ? "human_review"
                : settings.review_modes[entry.scope] ?? settings.default_mode;
              return (
                <div
                  key={entry.scope}
                  data-anchor={`hil-approval-${entry.scope}`}
                  className="px-5 py-4"
                >
                  {index > 0 && <Separator className="mb-4" />}
                  <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{entry.label}</span>
                        <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          {entry.scope}
                        </code>
                        {mandatory && <Badge variant="outline">始终人工审批</Badge>}
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{entry.description}</p>
                    </div>
                    <div className="flex shrink-0 flex-col items-start gap-1 lg:items-end">
                      <SegmentedControl
                        value={effective}
                        options={MODES}
                        ariaLabel={`${entry.label}审批档位`}
                        disabled={mandatory || savingScope !== null}
                        onChange={(mode) =>
                          void apply({ review_modes: { [entry.scope]: mode } }, entry.scope)
                        }
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </SettingCard>
      </SettingSection>
    </div>
  );
}
