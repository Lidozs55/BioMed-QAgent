/**
 * Product model-config → upstream payload translation: sampling-override
 * restrictions per provider, DashScope-Qwen-specific parameter semantics, and
 * request token clamping.
 */

import type { BioMedModelConfig } from "../contracts.js";

export function resolveRequestMaxTokens(
  configuredMaxTokens: number | undefined,
  requestMaxTokens: number | undefined,
): number | undefined {
  if (configuredMaxTokens === undefined) return requestMaxTokens;
  if (requestMaxTokens === undefined) return configuredMaxTokens;
  return Math.min(configuredMaxTokens, requestMaxTokens);
}

/**
 * Kimi models on DashScope reject sampling overrides entirely (even
 * `top_p: 1`); any temperature/top_p value yields a 400 invalid_parameter.
 * They must run with provider-default sampling only.
 */
function rejectsSamplingOverrides(selected: BioMedModelConfig): boolean {
  return selected.modelId.toLowerCase().startsWith("kimi");
}

export function usesDashScopeQwen(selected: BioMedModelConfig): boolean {
  if (selected.baseUrl === undefined) return false;
  try {
    const target = new URL(selected.baseUrl);
    const modelId = selected.modelId.toLowerCase();
    // 百炼国内（dashscope）与国际（dashscope-intl）站点的 OpenAI 兼容端点
    // 共享同一套 Qwen 专属参数语义（enable_search / enable_thinking 等）。
    return (modelId.startsWith("qwen") || modelId.startsWith("qwq")) &&
      (target.hostname === "dashscope.aliyuncs.com" ||
        target.hostname === "dashscope-intl.aliyuncs.com") &&
      target.pathname.replace(/\/$/, "") === "/compatible-mode/v1";
  } catch {
    return false;
  }
}

export function applyModelProfileToPayload(
  payload: unknown,
  selected: BioMedModelConfig,
): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  const next: Record<string, unknown> = { ...payload };
  const dashScopeQwen = usesDashScopeQwen(selected);
  if (rejectsSamplingOverrides(selected)) {
    delete next.temperature;
    delete next.top_p;
  }
  for (const [key, value] of Object.entries(selected.params ?? {})) {
    if (value === undefined) continue;
    if (key === "top_logprobs" && selected.params?.logprobs !== true) continue;
    if (key === "max_tokens" || key === "temperature" || key === "top_p") continue;
    if (key === "reasoning_effort" && (value === "off" || value === "none")) continue; // 思考强度=关闭：不向上游透传无效值
    if (key === "context_window" || key === "max_output_tokens" ||
        key === "suggested_max_tokens" || key === "capabilities") continue;
    if (dashScopeQwen &&
        (key === "repetition_penalty" || key === "enable_search" ||
         key === "thinking_mode" || key === "enable_thinking")) continue;
    next[key] = key === "thinking" && typeof value === "string"
      ? (() => {
          try {
            const parsed = JSON.parse(value) as unknown;
            return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
              ? parsed
              : value;
          } catch {
            return value;
          }
        })()
      : value;
  }
  if (selected.topP !== undefined && !rejectsSamplingOverrides(selected)) next.top_p = selected.topP;
  if (dashScopeQwen) {
    if (selected.repetitionPenalty !== undefined) {
      next.repetition_penalty = selected.repetitionPenalty;
    }
    if (selected.enableSearch !== undefined) next.enable_search = selected.enableSearch;
    // 思考强度是思考开关的唯一入口（DashScope 语义：enable_thinking 与
    // reasoning_effort 必须一致，"xhigh + enable_thinking:false" 这类组合会被
    // 400 invalid_parameter 拒绝）。effort 为非关闭值时强制开启思考——存量设置
    // 里 thinking_mode:false + effort:xhigh 的脏组合在这里被纠正；effort 显式
    // 关闭（off/none）时强制关闭；未配置 effort 时回退旧思维链开关。
    // 与 settings/model-registry/model-resolution.ts 的 resolveThinkingMode 同一规则。
    const effort = selected.params?.reasoning_effort;
    if (effort === "off" || effort === "none") {
      next.enable_thinking = false;
    } else if (effort !== undefined) {
      next.enable_thinking = true;
    } else if (selected.thinkingMode !== undefined) {
      next.enable_thinking = selected.thinkingMode;
    }
  }
  return next;
}
