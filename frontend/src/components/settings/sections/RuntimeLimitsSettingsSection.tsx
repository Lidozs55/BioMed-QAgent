import { useState } from "react";
import { ArrowCounterClockwiseIcon, FloppyDiskIcon } from "@phosphor-icons/react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { SettingCard, SettingSection } from "@/components/settings/primitives";
import { RUNTIME_LIMIT_RANGES, type ModelSettings, type RuntimeLimits, type SettingsAPIClient } from "@/api/types";

interface RuntimeLimitsSettingsSectionProps {
  api: SettingsAPIClient;
  settings: ModelSettings | null;
  onUpdated?: (settings: ModelSettings) => void;
}

type LimitKey = keyof RuntimeLimits;

const FIELDS: ReadonlyArray<{
  key: LimitKey;
  label: string;
  description: string;
  unit: string;
  section: "execution" | "model" | "network" | "data";
}> = [
  { key: "command_timeout_seconds", label: "命令执行超时", description: "单个命令允许运行的最长时间。命令复杂或下载构建时可适当提高。", unit: "秒", section: "execution" },
  { key: "command_output_kib", label: "命令输出上限", description: "单次命令返回给 Agent 的 stdout/stderr 总量；超出部分会截断，但进程不会立即停止。", unit: "KiB", section: "execution" },
  { key: "workspace_read_kib", label: "工作区单次读取", description: "Agent 每次读取文件的最大文本量。大文件应使用分页读取。", unit: "KiB", section: "execution" },
  { key: "workspace_write_kib", label: "工作区单次写入", description: "Agent 单次写入文件的最大内容量。", unit: "KiB", section: "execution" },
  { key: "workspace_search_file_mib", label: "搜索单文件扫描上限", description: "搜索工具对单个文件最多扫描的大小，过大的二进制文件会跳过。", unit: "MiB", section: "execution" },
  { key: "workspace_search_max_files", label: "搜索文件数量上限", description: "一次搜索最多扫描的文件数量。", unit: "个", section: "execution" },
  { key: "model_request_timeout_seconds", label: "模型请求超时", description: "视觉抽取、HIL 模型预审、技能迭代与模型发现探测的单次请求最长时间。", unit: "秒", section: "model" },
  { key: "model_provider_max_retries", label: "供应商请求重试次数", description: "Pi 在一次模型调用中遇到可重试供应商错误时的额外重试次数；0 表示不额外重试。", unit: "次", section: "model" },
  { key: "model_recovery_max_attempts", label: "Run 恢复尝试次数", description: "Pi 常规重试耗尽或流中断后，durable Run 可追加的恢复轮数；0 表示禁用恢复轮。", unit: "次", section: "model" },
  { key: "model_retry_base_delay_ms", label: "模型重试基础退避", description: "供应商请求重试和流恢复指数退避的基础等待时间。", unit: "毫秒", section: "model" },
  { key: "model_retry_max_delay_ms", label: "模型重试最长退避", description: "供应商重试与 durable 恢复单次等待的上限。", unit: "毫秒", section: "model" },
  { key: "vlm_max_attempts", label: "视觉请求总尝试次数", description: "每张图片调用视觉模型的总尝试次数，包含首次请求。", unit: "次", section: "model" },
  { key: "vlm_retry_base_delay_ms", label: "视觉重试基础退避", description: "视觉模型可重试传输失败后的指数退避基础时间。", unit: "毫秒", section: "model" },
  { key: "vlm_pdf_max_pages", label: "视觉 PDF 页面上限", description: "每份 PDF 最多渲染并送入视觉模型的候选页面数，超出部分会显式记为跳过。", unit: "页", section: "model" },
  { key: "vlm_pdf_max_images", label: "视觉 PDF 嵌图上限", description: "探索路线每份 PDF 最多抽取并送入视觉模型的内嵌图片数。", unit: "张", section: "model" },
  { key: "vlm_render_dpi", label: "视觉 PDF 渲染分辨率", description: "PDF 完整页面的渲染分辨率；像素内存安全闸仍不可通过设置关闭。", unit: "DPI", section: "model" },
  { key: "http_timeout_seconds", label: "网络请求超时", description: "普通 API 请求的最长等待时间。", unit: "秒", section: "network" },
  { key: "download_timeout_seconds", label: "下载超时", description: "文件下载的最长总时间；慢速连接可提高此值。", unit: "秒", section: "network" },
  { key: "browser_timeout_seconds", label: "浏览器操作超时", description: "页面导航、点击、提取等单次浏览器操作的最长时间。", unit: "秒", section: "network" },
  { key: "request_interval_ms", label: "同来源请求间隔", description: "同一来源请求之间的最短间隔，也作为采集重试的基础退避。部分数据库的官方配额会覆盖此值。", unit: "毫秒", section: "network" },
  { key: "api_response_max_mib", label: "JSON 响应上限", description: "数据库查询工具的单次 JSON 响应预算；各工具自身更小的安全上限仍优先。", unit: "MiB", section: "network" },
  { key: "database_timeout_seconds", label: "声明式数据库超时", description: "用户声明式数据库请求的最长等待时间。", unit: "秒", section: "data" },
  { key: "dataset_operation_timeout_seconds", label: "数据集操作超时", description: "解析、归一化、整合和发布等单个确定性操作的最长时间。", unit: "秒", section: "data" },
  { key: "max_download_mib", label: "单文件下载大小", description: "来源文件允许下载的最大大小。不会改变安全 URL、完整性校验和发布门禁。", unit: "MiB", section: "data" },
  { key: "acquisition_max_attempts", label: "采集最大尝试次数", description: "Core 来源采集在可重试网络故障后的总尝试次数，重试按同来源请求间隔指数退避。", unit: "次", section: "data" },
  { key: "gdc_max_files", label: "GDC 单次下载文件数", description: "一次 GDC 数据获取最多下载的文件数，避免只取极小样本导致无法比较。", unit: "个", section: "data" },
  { key: "chembl_max_compounds", label: "ChEMBL 单请求化合物数", description: "单次 ChEMBL 活性数据请求允许的化合物数量。", unit: "个", section: "data" },
  { key: "chembl_max_records", label: "ChEMBL 单请求记录数", description: "单次 ChEMBL 活性数据请求返回的最大记录数量。", unit: "条", section: "data" },
];

const SECTION_META = {
  execution: { title: "Agent 执行", description: "控制命令与工作区工具的资源预算。" },
  model: { title: "模型调用", description: "统一控制主模型恢复、视觉模型重试与模型请求超时。" },
  network: { title: "网络与浏览器", description: "控制外部请求、下载和网页操作的等待时间。" },
  data: { title: "数据获取与构建", description: "控制数据集操作和来源获取规模。" },
} as const;

function formatValue(value: number): string {
  return String(value);
}

export function RuntimeLimitsSettingsSection({ api, settings, onUpdated }: RuntimeLimitsSettingsSectionProps) {
  const [draft, setDraft] = useState<RuntimeLimits | null>(settings?.runtime_limits ?? null);
  const [errors, setErrors] = useState<Partial<Record<LimitKey, string>>>({});
  const [saving, setSaving] = useState(false);

  if (draft === null) {
    return <p className="text-sm text-muted-foreground">正在加载运行限制...</p>;
  }

  const update = (key: LimitKey, raw: string): void => {
    const value = Number(raw);
    setDraft({ ...draft, [key]: Number.isFinite(value) ? value : 0 });
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const validate = (): boolean => {
    const next: Partial<Record<LimitKey, string>> = {};
    for (const field of FIELDS) {
      const value = draft[field.key];
      const range = RUNTIME_LIMIT_RANGES[field.key];
      if (!Number.isSafeInteger(value) || value < range.min || value > range.max) {
        next[field.key] = `请输入 ${range.min} 到 ${range.max} 之间的整数`;
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const save = async (): Promise<void> => {
    if (!validate()) return;
    setSaving(true);
    try {
      const updated = await api.saveSettings({ runtime_limits: draft });
      setDraft(updated.runtime_limits);
      onUpdated?.(updated);
      toast.success("运行限制已保存", { description: "新设置将在新任务或新 Run 中生效。" });
    } catch (error) {
      toast.error("运行限制保存失败", { description: error instanceof Error ? error.message : "请求失败" });
    } finally {
      setSaving(false);
    }
  };

  const reset = async (): Promise<void> => {
    setSaving(true);
    try {
      const updated = await api.saveSettings({ runtime_limits: null });
      setDraft(updated.runtime_limits);
      onUpdated?.(updated);
      setErrors({});
      toast.success("已恢复推荐默认值");
    } catch (error) {
      toast.error("恢复默认值失败", { description: error instanceof Error ? error.message : "请求失败" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      <Alert>
        <AlertTitle>这些是运行预算，不是安全边界</AlertTitle>
        <AlertDescription>
          提高限制可以减少 Agent 因超时或截断而重复试错，但会增加 CPU、内存、磁盘和 API 成本。SSRF 校验、权限策略、来源完整性和发布门禁不会被这些设置关闭。
        </AlertDescription>
      </Alert>
      {(Object.keys(SECTION_META) as Array<keyof typeof SECTION_META>).map((section) => (
        <SettingSection key={section} title={SECTION_META[section].title} description={SECTION_META[section].description}>
          <SettingCard>
            <FieldGroup className="gap-0">
              {FIELDS.filter((field) => field.section === section).map((field, index) => {
                const range = RUNTIME_LIMIT_RANGES[field.key];
                const error = errors[field.key];
                return (
                  <div
                    key={field.key}
                    data-anchor={`runtime-limit-${field.key}`}
                    className="px-5 py-4"
                  >
                    {index > 0 && <Separator className="mb-4" />}
                    <Field data-invalid={error ? true : undefined}>
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
                        <div className="min-w-0 flex-1">
                          <FieldLabel htmlFor={`runtime-limit-${field.key}`}>{field.label}</FieldLabel>
                          <FieldDescription>{field.description} 范围 {range.min}–{range.max} {field.unit}。</FieldDescription>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Input
                            id={`runtime-limit-${field.key}`}
                            type="number"
                            min={range.min}
                            max={range.max}
                            step={1}
                            value={formatValue(draft[field.key])}
                            onChange={(event) => update(field.key, event.target.value)}
                            aria-invalid={error ? true : undefined}
                            className="no-spinner h-9 w-32 font-mono text-right tabular-nums"
                          />
                          <span className="w-12 text-xs text-muted-foreground">{field.unit}</span>
                        </div>
                      </div>
                      {error && <FieldError>{error}</FieldError>}
                    </Field>
                  </div>
                );
              })}
            </FieldGroup>
          </SettingCard>
        </SettingSection>
      ))}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" onClick={() => void reset()} disabled={saving}>
          <ArrowCounterClockwiseIcon data-icon="inline-start" />
          恢复推荐默认
        </Button>
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? <Spinner data-icon="inline-start" /> : <FloppyDiskIcon data-icon="inline-start" />}
          {saving ? "保存中..." : "保存运行限制"}
        </Button>
      </div>
    </div>
  );
}

