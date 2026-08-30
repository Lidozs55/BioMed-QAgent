import { useCallback, useState } from "react";
import { toast } from "sonner";

import type { VisionModelSelectorProps } from "@/components/settings/types";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** Sentinel option value for "no explicit visual role". */
const NONE_VALUE = "none";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

/**
 * Explicit visual-extraction model role selector.
 *
 * Lists only image-capable models of enabled providers, shows each
 * candidate's credential readiness, and saves the role as a managed-model
 * record id (`vision_model_id`) without touching the active main model.
 */
export function VisionModelSelector({
  api,
  settings,
  managedModels,
  providers,
  onSaved,
}: VisionModelSelectorProps) {
  const [saving, setSaving] = useState(false);
  const enabledProviderIds = new Set(
    providers.filter((provider) => provider.enabled).map((provider) => provider.id),
  );
  const candidates = managedModels.filter(
    (model) =>
      model.capabilities.image === true && enabledProviderIds.has(model.provider_id),
  );

  const saveRole = useCallback(
    async (value: string) => {
      setSaving(true);
      try {
        const updated = await api.saveSettings({
          vision_model_id: value === NONE_VALUE ? null : value,
        });
        onSaved(updated);
        toast.success("视觉抽取模型已保存");
      } catch (error) {
        toast.error("视觉抽取模型保存失败", { description: errorText(error) });
      } finally {
        setSaving(false);
      }
    },
    [api, onSaved],
  );

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <Select
        value={settings.vision_model_id ?? NONE_VALUE}
        onValueChange={(value) => void saveRole(value ?? NONE_VALUE)}
      >
        <SelectTrigger className="w-full max-w-md" aria-label="视觉抽取模型" disabled={saving}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectItem value={NONE_VALUE}>未选择</SelectItem>
            {candidates.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.name}
                （{model.provider_name} ·{" "}
                {model.provider_api_key_configured ? "密钥已配置" : "未配置密钥"}）
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      <p className="max-w-[42rem] text-xs leading-relaxed text-muted-foreground">
        上传的图片由视觉抽取工具处理，不会直接发送给主对话模型。未选择时，仅当激活的模型具备图像能力才能进行图片抽取。
      </p>
      {Boolean(settings.vision_block_reason) && (
        <p className="max-w-[42rem] text-xs leading-relaxed text-destructive">
          {settings.vision_block_reason}
        </p>
      )}
      {settings.vision_model_ready === true && settings.vision_model_name !== null && (
        <p className="max-w-[42rem] text-xs leading-relaxed text-muted-foreground">
          视觉抽取就绪：{settings.vision_provider_name} · {settings.vision_model_name}
        </p>
      )}
    </div>
  );
}
