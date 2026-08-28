import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ParameterEditor } from "@/components/settings/model/ParameterEditor";
import { paramsValidationError } from "@/components/settings/model/paramValidation";
import type {
  ManagedModelInfo,
  ManagedModelInput,
  ModelCapabilities,
  ParameterSpec,
  SettingsAPIClient,
} from "@/hooks/useAPI";

interface ModelDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: ManagedModelInfo | null;
  api: SettingsAPIClient;
  onSaved: () => void | Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "请求失败";
}

function sourceBadgeLabel(model: ManagedModelInfo): string {
  return model.source === "manual" ? "手动配置" : model.provider_name;
}

function capabilitiesLabel(capabilities: ModelCapabilities): string {
  const labels: string[] = [];
  if (capabilities.text) labels.push("文本");
  if (capabilities.image) labels.push("图像");
  if (capabilities.video) labels.push("视频");
  if (capabilities.audio) labels.push("音频");
  return labels.length > 0 ? labels.join("、") : "—";
}

function allParamsJson(
  specs: ParameterSpec[],
  params: Record<string, unknown>,
): string {
  const merged: Record<string, unknown> = {};
  for (const spec of specs) {
    if (spec.default !== undefined) merged[spec.key] = spec.default;
  }
  for (const [key, value] of Object.entries(params)) merged[key] = value;
  return JSON.stringify(merged, null, 2);
}

/**
 * “最大输出 Tokens”的统一基准：params.max_tokens（运行时优先）优先，
 * 未设置时回退到 max_output_tokens。初始化与保存比对必须使用同一函数，
 * 否则两者不一致时会把未改动的 max_output_tokens 无条件覆盖为输入框值。
 */
function effectiveMaxTokens(model: ManagedModelInfo): number | null {
  const fromParams = model.params.max_tokens;
  return typeof fromParams === "number" ? fromParams : model.max_output_tokens;
}

export function ModelDetailDialog({
  open,
  onOpenChange,
  model,
  api,
  onSaved,
}: ModelDetailDialogProps) {
  const [params, setParams] = useState<Record<string, unknown>>(() =>
    model ? { ...model.params } : {},
  );
  const [contextWindow, setContextWindow] = useState(() =>
    model?.context_window == null ? "" : String(model.context_window),
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState(() => {
    if (model == null) return "";
    const effective = effectiveMaxTokens(model);
    return effective == null ? "" : String(effective);
  });
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState(() =>
    model ? allParamsJson(model.param_specs, model.params) : "",
  );
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!model) return null;

  const isOfficial = model.source === "api" || model.source === "catalog";

  const toggleJson = () => {
    if (jsonOpen) {
      setJsonOpen(false);
      return;
    }
    setJsonText(allParamsJson(model.param_specs, params));
    setJsonError(null);
    setJsonOpen(true);
  };

  const formatJson = () => {
    try {
      const parsed: unknown = JSON.parse(jsonText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("配置必须是 JSON 对象");
      }
      setJsonText(JSON.stringify(parsed, null, 2));
      setJsonError(null);
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "JSON 格式错误");
    }
  };

  const restoreJson = () => {
    setJsonText(allParamsJson(model.param_specs, {}));
    setJsonError(null);
    toast.success("已恢复为默认参数");
  };

  const applyJson = () => {
    try {
      const parsed: unknown = JSON.parse(jsonText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("配置必须是 JSON 对象");
      }
      setParams(parsed as Record<string, unknown>);
      setJsonOpen(false);
      setJsonError(null);
      toast.success("JSON 配置已应用，记得保存参数");
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "JSON 格式错误");
    }
  };

  const save = async () => {
    const rawContext = contextWindow.trim();
    const parsedContext = rawContext === "" ? null : Number(rawContext);
    if (parsedContext !== null && (!Number.isFinite(parsedContext) || parsedContext <= 0)) {
      toast.error("上下文窗口必须为正整数（Tokens）");
      return;
    }

    const rawMax = maxOutputTokens.trim();
    const parsedMax = rawMax === "" ? null : Number(rawMax);
    if (parsedMax !== null && (!Number.isFinite(parsedMax) || parsedMax <= 0)) {
      toast.error("最大输出 Tokens 必须为正整数");
      return;
    }

    // “最大输出 Tokens”以顶部输入框为唯一入口：同步写入 params.max_tokens
    //（运行时优先字段），避免与图形编辑器中的同名列重复调整。
    const nextParams = { ...params };
    if (parsedMax === null) {
      delete nextParams.max_tokens;
    } else {
      nextParams.max_tokens = parsedMax;
    }
    // 提交前按 param spec 做 JS 强制校验（min/max 不只是 HTML 属性）；
    // JSON 编辑器通道应用的 params 汇入同一 state，此处一并拦截。
    const paramError = paramsValidationError(model.param_specs, nextParams);
    if (paramError) {
      toast.error(paramError);
      return;
    }

    const patch: Partial<ManagedModelInput> = {};
    if (parsedContext !== model.context_window) {
      patch.context_window = parsedContext;
    }
    patch.params = nextParams;
    // 与初始化同一基准比较：用户未实际改动时不重复提交 max_output_tokens。
    if (parsedMax !== effectiveMaxTokens(model)) {
      patch.max_output_tokens = parsedMax;
    }

    setSaving(true);
    try {
      const updated = await api.updateManagedModel(model.id, patch);
      toast.success(`已保存 ${updated.name} 的参数`);
      await onSaved();
      onOpenChange(false);
    } catch (error) {
      toast.error("保存失败", { description: errorText(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>模型详情</DialogTitle>
          <DialogDescription>{model.name}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5 md:grid-cols-2">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
            <dt className="text-muted-foreground">供应商</dt>
            <dd className="truncate">{model.provider_name}</dd>
            <dt className="text-muted-foreground">模型 ID</dt>
            <dd className="truncate">{model.model_id}</dd>
            <dt className="text-muted-foreground">能力</dt>
            <dd>{capabilitiesLabel(model.capabilities)}</dd>
            <dt className="text-muted-foreground">来源</dt>
            <dd>{sourceBadgeLabel(model)}</dd>
          </dl>

          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="detail-context-window"
                className="text-sm text-foreground"
                title="上下文窗口（Tokens），清空表示未知"
              >
                上下文窗口
              </label>
              <Input
                id="detail-context-window"
                type="number"
                min={1}
                value={contextWindow}
                onChange={(event) => setContextWindow(event.target.value)}
                className="h-8 w-40"
                placeholder="未知"
                aria-label="上下文窗口"
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <label
                htmlFor="detail-max-output"
                className="text-sm text-foreground"
                title="最大输出 Tokens，清空表示未知"
              >
                最大输出 Tokens
              </label>
              <Input
                id="detail-max-output"
                type="number"
                min={1}
                value={maxOutputTokens}
                onChange={(event) => setMaxOutputTokens(event.target.value)}
                className="h-8 w-40"
                placeholder="未知"
                aria-label="最大输出 Tokens"
              />
            </div>
          </div>
        </div>

        <div className="border-t pt-3">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-medium">模型参数</p>
            <Button variant="outline" size="sm" onClick={toggleJson}>
              {jsonOpen ? "返回图形编辑" : "配置 JSON"}
            </Button>
          </div>

          {jsonOpen ? (
            <div className="flex flex-col gap-2">
              <Textarea
                value={jsonText}
                onChange={(event) => {
                  setJsonText(event.target.value);
                  setJsonError(null);
                }}
                className="h-56 w-full resize-none font-mono text-xs"
                spellCheck={false}
                aria-label="配置 JSON"
              />
              {jsonError && (
                <p className="text-xs text-destructive" role="alert">
                  {jsonError}
                </p>
              )}
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={restoreJson}>
                  恢复默认
                </Button>
                <Button variant="outline" size="sm" onClick={formatJson}>
                  格式化
                </Button>
                <Button size="sm" onClick={applyJson}>
                  应用
                </Button>
              </div>
            </div>
          ) : (
            <ParameterEditor
              specs={model.param_specs}
              params={params}
              onChange={setParams}
              hiddenKeys={["max_tokens", "enable_thinking"]}
            />
          )}
        </div>

        {isOfficial && (
          <p className="text-xs text-warning">官方提供的参数，请谨慎修改</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving && <Spinner data-icon="inline-start" />}
            保存参数
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
