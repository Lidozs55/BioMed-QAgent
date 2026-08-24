import { useCallback, useEffect, useMemo, useState } from "react";
import { CopyIcon, ShieldCheckIcon, SparkleIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { SettingCard, SettingSection } from "@/components/settings/primitives";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type {
  SettingsAPIClient,
  SkillIterationCandidate,
  SkillIterationContext,
} from "@/hooks/useAPI";

const TASK_LIMIT_OPTIONS = [
  { value: "3", label: "最近 3 个任务" },
  { value: "5", label: "最近 5 个任务" },
  { value: "10", label: "最近 10 个任务" },
  { value: "12", label: "最近 12 个任务" },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

export function SkillIterationSettingsSection({ api }: { api: SettingsAPIClient }) {
  const [context, setContext] = useState<SkillIterationContext | null>(null);
  const [targetSkill, setTargetSkill] = useState("");
  const [taskLimit, setTaskLimit] = useState("5");
  const [userFocus, setUserFocus] = useState("");
  const [candidate, setCandidate] = useState<SkillIterationCandidate | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.fetchSkillIterationContext()
      .then((value) => {
        if (cancelled) return;
        setContext(value);
        setTargetSkill(
          value.targets.find((target) => target.name === "dataset-construction")?.name
            ?? value.targets[0]?.name
            ?? "",
        );
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          toast.error("Skill 迭代上下文加载失败", { description: errorText(error) });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const selectedTasks = useMemo(
    () => context?.history_tasks.slice(0, Number(taskLimit)) ?? [],
    [context, taskLimit],
  );
  const targetOptions = useMemo(
    () => context?.targets.map((target) => ({
      value: target.name,
      label: target.name,
    })) ?? [],
    [context],
  );

  const generate = useCallback(async () => {
    if (targetSkill === "" || selectedTasks.length === 0) return;
    setGenerating(true);
    try {
      const value = await api.startSkillIteration({
        schema_version: "1.0",
        target_skill: targetSkill,
        task_ids: selectedTasks.map((task) => task.task_id),
        user_focus: userFocus,
      });
      setCandidate(value);
      toast.success("个性化 Skill 候选已生成", {
        description: "候选已记录，但尚未激活；请先审查内容与证据。",
      });
    } catch (error) {
      toast.error("Skill 迭代失败", { description: errorText(error) });
    } finally {
      setGenerating(false);
    }
  }, [api, selectedTasks, targetSkill, userFocus]);

  const copyCandidate = useCallback(async () => {
    if (candidate === null) return;
    try {
      await navigator.clipboard.writeText(candidate.proposed_skill_markdown);
      toast.success("候选 SKILL.md 已复制");
    } catch (error) {
      toast.error("复制失败", { description: errorText(error) });
    }
  }, [candidate]);

  return (
    <div className="flex flex-col gap-8">
      <SettingSection
        title="个性化 Skill 迭代"
        description="使用当前已配置模型，从既往交互中提炼稳定偏好，并为一个现有 curated Skill 生成可审查候选。"
      >
        <Alert>
          <ShieldCheckIcon />
          <AlertTitle>历史使用与激活边界</AlertTitle>
          <AlertDescription>
            {context?.privacy_notice
              ?? "只读取已结束任务的用户与助手消息，并在发送模型前进行脱敏和长度限制。"}
            候选不会自动覆盖 .pi/skills，也不会改变正在运行的任务。
          </AlertDescription>
        </Alert>

        <SettingCard>
          <div className="flex flex-col gap-5 p-5" data-anchor="settings-skill-iteration">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="skill-iteration-target">目标主 Skill</FieldLabel>
                <Select
                  items={targetOptions}
                  value={targetSkill}
                  onValueChange={(value) => {
                    if (typeof value === "string") {
                      setTargetSkill(value);
                      setCandidate(null);
                    }
                  }}
                  disabled={loading || targetOptions.length === 0}
                >
                  <SelectTrigger id="skill-iteration-target" aria-label="目标主 Skill">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {context?.targets.map((target) => (
                        <SelectItem key={target.name} value={target.name}>
                          <span>{target.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {target.description}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  默认选择负责可信数据构建的 dataset-construction；也可以逐个迭代其他任务 Skill。
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="skill-iteration-history">历史范围</FieldLabel>
                <Select
                  items={TASK_LIMIT_OPTIONS}
                  value={taskLimit}
                  onValueChange={(value) => {
                    if (typeof value === "string") setTaskLimit(value);
                  }}
                  disabled={loading}
                >
                  <SelectTrigger id="skill-iteration-history" aria-label="历史任务范围">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {TASK_LIMIT_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  当前可用 {context?.history_tasks.length ?? 0} 个已结束任务；本次将使用
                  {" "}{selectedTasks.length} 个任务、最多
                  {" "}{context?.defaults.max_messages_per_task ?? 20} 条消息/任务。
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="skill-iteration-focus">本次迭代重点</FieldLabel>
                <Textarea
                  id="skill-iteration-focus"
                  value={userFocus}
                  onChange={(event) => setUserFocus(event.target.value)}
                  maxLength={4000}
                  rows={5}
                  placeholder="例如：强调来源追溯、原始值保留、时间顺序验证和失败时的诚实说明。"
                />
                <FieldDescription>
                  当前明确要求优先于历史推断；留空时仅根据重复且有证据的历史模式提炼。
                </FieldDescription>
              </Field>
            </FieldGroup>

            {selectedTasks.length > 0 && (
              <div className="flex flex-wrap gap-2" aria-label="将用于迭代的历史任务">
                {selectedTasks.map((task) => (
                  <Badge key={task.task_id} variant="secondary">
                    {task.title} · {task.message_count} 条
                  </Badge>
                ))}
              </div>
            )}

            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => void generate()}
                disabled={loading || generating || targetSkill === "" || selectedTasks.length === 0}
              >
                {generating ? <Spinner data-icon="inline-start" /> : <SparkleIcon data-icon="inline-start" />}
                {generating ? "正在分析与迭代" : "调用模型生成候选"}
              </Button>
            </div>
          </div>
        </SettingCard>
      </SettingSection>

      {candidate !== null && (
        <SettingSection
          title="本次候选"
          description="以下内容已作为审计候选持久化；正式提升前仍需人工比较、测试和回滚准备。"
        >
          <Card>
            <CardHeader>
              <CardTitle>{candidate.target_skill}</CardTitle>
              <CardDescription>{candidate.summary}</CardDescription>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">{candidate.model_id}</Badge>
                <Badge variant="secondary">{candidate.history_task_ids.length} 个任务</Badge>
                <Badge variant="secondary">{candidate.history_message_count} 条消息</Badge>
                <Badge variant="outline">candidate</Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">个性化需求与证据</h3>
                {candidate.signals.map((signal, index) => (
                  <div key={signal.category + String(index)} className="flex flex-col gap-1 rounded-lg border p-3">
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline">{signal.category}</Badge>
                      <Badge variant="secondary">{signal.confidence}</Badge>
                    </div>
                    <p className="text-sm font-medium">{signal.requirement}</p>
                    <p className="text-xs text-muted-foreground">{signal.action}</p>
                    <p className="text-xs text-muted-foreground">
                      证据：{signal.evidence_refs.join("、") || "仅作待确认推断"}
                    </p>
                  </div>
                ))}
              </div>

              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">数据处理偏好</h3>
                {candidate.data_processing_preferences.map((preference, index) => (
                  <div key={preference.stage + String(index)} className="flex flex-col gap-1 rounded-lg border p-3">
                    <Badge variant="outline">{preference.stage}</Badge>
                    <p className="text-sm font-medium">{preference.method}</p>
                    <p className="text-xs text-muted-foreground">
                      适用条件：{preference.applies_when}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      验证方式：{preference.verification}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      证据：{preference.evidence_refs.join("、")}
                    </p>
                  </div>
                ))}
              </div>

              <Field>
                <FieldLabel htmlFor="skill-iteration-candidate">候选 SKILL.md</FieldLabel>
                <Textarea
                  id="skill-iteration-candidate"
                  value={candidate.proposed_skill_markdown}
                  readOnly
                  rows={18}
                  className="font-mono text-xs leading-relaxed"
                />
              </Field>

              {candidate.warnings.length > 0 && (
                <Alert>
                  <AlertTitle>审查提示</AlertTitle>
                  <AlertDescription>{candidate.warnings.join("；")}</AlertDescription>
                </Alert>
              )}
            </CardContent>
            <CardFooter className="justify-end">
              <Button type="button" variant="outline" onClick={() => void copyCandidate()}>
                <CopyIcon data-icon="inline-start" />
                复制候选
              </Button>
            </CardFooter>
          </Card>
        </SettingSection>
      )}
    </div>
  );
}
