import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { SettingCard, SettingRow, SettingSection } from "@/components/settings/primitives";
import { Button } from "@/components/ui/button";
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
  PersonalizationSettings,
  Personality,
  SettingsAPIClient,
} from "@/hooks/useAPI";

const PERSONALITY_OPTIONS: { value: Personality; label: string; description: string }[] = [
  { value: "pragmatic", label: "务实", description: "简洁、专注、直接" },
  { value: "warm", label: "亲和", description: "温暖、协作、贴心" },
  { value: "rigorous", label: "严谨", description: "结构化、明确区分事实与推断" },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

export function PersonalizationSettingsSection({ api }: { api: SettingsAPIClient }) {
  const [settings, setSettings] = useState<PersonalizationSettings | null>(null);
  const [draft, setDraft] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .fetchPersonalization()
      .then((value) => {
        if (cancelled) return;
        setSettings(value);
        setDraft(value.custom_instructions);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(true);
          toast.error("个性化设置加载失败", { description: errorText(error) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const saveInstructions = useCallback(async () => {
    if (settings === null) return;
    setSaving(true);
    try {
      const updated = await api.savePersonalization({ custom_instructions: draft });
      setSettings(updated);
      setDraft(updated.custom_instructions);
      toast.success("自定义指令已保存", {
        description: "后续新任务将自动应用，当前运行中的任务不受影响。",
      });
    } catch (error) {
      toast.error("自定义指令保存失败", { description: errorText(error) });
    } finally {
      setSaving(false);
    }
  }, [api, draft, settings]);

  const changePersonality = useCallback(
    async (value: string) => {
      const personality = value as Personality;
      try {
        const updated = await api.savePersonalization({ personality });
        setSettings(updated);
        toast.success(`回复语气已切换为“${updated.personality_label}”`);
      } catch (error) {
        toast.error("个性设置保存失败", { description: errorText(error) });
      }
    },
    [api],
  );

  return (
    <div className="flex flex-col gap-8">
      <SettingSection
        title="自定义指令"
        description="向 Agent 提供适用于所有任务的额外说明与上下文，保存后注入系统提示词。默认留空。"
      >
        <SettingCard>
          <div className="flex flex-col gap-3 p-5">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="settings-custom-instructions">
                  自定义指令
                </FieldLabel>
                <Textarea
                  id="settings-custom-instructions"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="例如：优先使用 GEO 数据源；汇报时附 PMID 与 GSE 编号；明确标注无法溯源的内容为待核验。"
                  rows={8}
                  aria-label="自定义指令"
                  className="font-mono text-xs leading-relaxed"
                />
                <FieldDescription>
                  支持 Markdown。指令为空时不会额外占用上下文。
                </FieldDescription>
              </Field>
            </FieldGroup>
            <div className="flex justify-end">
              <Button
                type="button"
                onClick={() => void saveInstructions()}
                disabled={saving || settings === null}
              >
                {saving && <Spinner data-icon="inline-start" />}
                {saving ? "保存中" : "保存"}
              </Button>
            </div>
          </div>
        </SettingCard>
        {loadError && (
          <p className="text-xs text-destructive">
            无法读取当前个性化设置，保存将覆盖服务端内容。
          </p>
        )}
      </SettingSection>

      <SettingSection
        title="个性"
        description="选择 Agent 回复的默认语气，随自定义指令一起注入系统提示词。"
      >
        <SettingCard>
          <SettingRow
            id="settings-personality"
            title="回复语气"
            description="切换后立即生效并持久化。"
            control={
              <Select
                value={settings?.personality ?? "pragmatic"}
                onValueChange={(value) => {
                  if (value) void changePersonality(value);
                }}
                disabled={settings === null}
              >
                <SelectTrigger className="w-56" aria-label="回复语气">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {PERSONALITY_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                        <span className="ml-2 text-xs text-muted-foreground">
                          {option.description}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            }
          />
        </SettingCard>
      </SettingSection>
    </div>
  );
}
