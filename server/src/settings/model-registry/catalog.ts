/**
 * Model registry catalog constants (vendors, param specs, budget defaults,
 * context-window heuristics).
 */
import type { JsonObject } from "../../http/validation.js";

export const ADVANCED_DEFAULTS = {
  temperature: 0.7,
  top_p: 1,
  repetition_penalty: 1,
  enable_search: false,
  thinking_mode: false,
};

export const RUNTIME_DEFAULTS: JsonObject = {
  agent_max_turns: 240,
  max_turns_resume_limit: 3,
  child_agent_max_turns: 30,
  subagent_timeout_seconds: 3600,
  no_progress_window_seconds: 300,
  no_progress_repeat_threshold: 3,
  lock_timeout_seconds: 5,
  http_timeout_seconds: 30,
  http_download_timeout_seconds: 60,
  browser_timeout_seconds: 120,
};

export const PARAM_SPECS = [
  { key: "max_tokens", label: "最大输出 Tokens", type: "integer", min: 1 },
  { key: "temperature", label: "Temperature", type: "number", min: 0, max: 2 },
  { key: "top_p", label: "Top P", type: "number", min: 0, max: 1, advanced: true },
  { key: "repetition_penalty", label: "重复惩罚", type: "number", min: 0, advanced: true },
  { key: "enable_search", label: "联网搜索", type: "boolean", advanced: true },
  { key: "thinking_mode", label: "思维链模式", type: "boolean", advanced: true },
] as const;

export const VENDORS = [
  ["dashscope", "DashScope", "https://dashscope.aliyuncs.com/compatible-mode/v1", true],
  ["openai", "OpenAI", "https://api.openai.com/v1", false],
  ["deepseek", "DeepSeek", "https://api.deepseek.com/v1", false],
  ["siliconflow", "SiliconFlow", "https://api.siliconflow.cn/v1", false],
  ["moonshot", "Moonshot", "https://api.moonshot.cn/v1", false],
  ["zhipu", "ZhipuAI", "https://open.bigmodel.cn/api/paas/v4", false],
  ["groq", "Groq", "https://api.groq.com/openai/v1", false],
  ["xai", "xAI", "https://api.x.ai/v1", false],
  ["mistral", "Mistral AI", "https://api.mistral.ai/v1", false],
] as const;

/** Coarse context-window guess for API-discovered models from their id. */
export function guessContextWindow(modelId: string): number {
  const normalized = modelId.toLowerCase();
  if (normalized.includes("2m")) return 2_000_000;
  if (normalized.includes("1m") || normalized.includes("million") ||
      normalized.includes("max")) return 1_000_000;
  if (normalized.includes("262144") || normalized.includes("256k")) return 262_144;
  if (normalized.includes("131072") || normalized.includes("128k")) return 131_072;
  if (normalized.includes("65536") || normalized.includes("64k")) return 65_536;
  if (normalized.includes("32768") || normalized.includes("32k")) return 32_768;
  if (normalized.includes("16384") || normalized.includes("16k")) return 16_384;
  if (normalized.includes("8192") || normalized.includes("8k")) return 8_192;
  if (normalized.includes("omni") || normalized.includes("vl")) return 131_072;
  return 524_288;
}