/**
 * Model registry catalog constants (vendors, param specs, budget defaults,
 * verified model facts, and provider/model parameter profiles).
 */
import { DEFAULT_RUNTIME_LIMITS, type ParameterSpec } from "@biomed/contracts";

import {
  catalogCapacity,
  catalogContextWindow,
  lookupModelCatalog,
} from "./model-catalog.js";

export const ADVANCED_DEFAULTS = {
  temperature: 0.7,
  top_p: 1,
  repetition_penalty: 1,
  enable_search: false,
  thinking_mode: false,
};

export const RUNTIME_DEFAULTS = DEFAULT_RUNTIME_LIMITS;

function spec(
  key: string,
  label: string,
  type: ParameterSpec["type"],
  options: {
    defaultValue?: unknown;
    description?: string;
    min?: number | null;
    max?: number | null;
    options?: { value: string; label: string }[];
    required?: boolean;
    advanced?: boolean;
  } = {},
): ParameterSpec {
  const result: ParameterSpec = {
    key,
    label,
    type,
  };
  if (options.defaultValue !== undefined) result.default = options.defaultValue;
  if (options.description !== undefined) result.description = options.description;
  if (options.min !== undefined) result.min = options.min;
  if (options.max !== undefined) result.max = options.max;
  if (options.options !== undefined) result.options = options.options;
  if (options.required !== undefined) result.required = options.required;
  if (options.advanced !== undefined) result.advanced = options.advanced;
  return result;
}

export const FALLBACK_PARAM_SPECS: ParameterSpec[] = [
  spec("max_tokens", "最大输出 Tokens", "integer", { defaultValue: 8192, min: 1 }),
  spec("temperature", "Temperature", "number", { defaultValue: 0.7, min: 0, max: 2 }),
  spec("top_p", "Top P", "number", { defaultValue: 1, min: 0, max: 1 }),
  spec("top_k", "Top K", "integer", { min: 1, max: 100, advanced: true }),
  spec("do_sample", "随机采样", "boolean", { defaultValue: true, advanced: true }),
  spec(
    "reasoning_effort",
    "思考强度",
    "select",
    {
      // 思考开关已并入思考强度：选择“关闭”即关闭思考（运行时不再透传）。
      defaultValue: "off",
      advanced: true,
      options: [
        { value: "off", label: "关闭" },
        { value: "low", label: "低" },
        { value: "medium", label: "中" },
        { value: "high", label: "高" },
        { value: "max", label: "最大" },
      ],
    },
  ),
  spec("thinking_budget", "思考预算（Tokens）", "integer", { min: 0, advanced: true }),
  spec("stop", "停止词（多个用英文逗号分隔）", "string", { advanced: true }),
  spec("stream", "流式输出", "boolean", { defaultValue: true, advanced: true }),
  spec("frequency_penalty", "频率惩罚", "number", { defaultValue: 0, min: -2, max: 2 }),
  spec("presence_penalty", "存在惩罚", "number", { defaultValue: 0, min: -2, max: 2 }),
  spec("repetition_penalty", "重复惩罚", "number", { defaultValue: 1, min: 0, max: 2 }),
  spec("seed", "随机种子", "integer", { min: 0, advanced: true }),
  spec("n", "生成结果数", "integer", { defaultValue: 1, min: 1, max: 8, advanced: true }),
  spec("logit_bias", "Logit Bias（JSON 对象）", "string", { advanced: true }),
  spec(
    "tool_choice",
    "工具调用",
    "select",
    {
      defaultValue: "auto",
      advanced: true,
      options: [
        { value: "auto", label: "自动" },
        { value: "none", label: "禁用" },
        { value: "required", label: "必须调用" },
      ],
    },
  ),
  spec("enable_search", "联网搜索", "boolean", { defaultValue: false, advanced: true }),
];

export const PROFILE_PROVIDER_SPECS: Record<string, ParameterSpec[]> = {
  dashscope: [
    spec("max_tokens", "最大输出 Tokens", "integer", { defaultValue: 8192, min: 1 }),
    spec("temperature", "Temperature", "number", { defaultValue: 0.7, min: 0, max: 2 }),
    spec("top_p", "Top P", "number", { defaultValue: 1, min: 0, max: 1 }),
    spec("top_k", "Top K", "integer", { min: 1, max: 100, advanced: true }),
    spec("repetition_penalty", "重复惩罚", "number", { defaultValue: 1, min: 0, max: 2 }),
    spec("stop", "停止词（多个用英文逗号分隔）", "string", { advanced: true }),
    spec("thinking_budget", "思考预算（Tokens）", "integer", { min: 0, advanced: true }),
    spec(
      "reasoning_effort",
      "思考强度（Qwen3.8）",
      "select",
      {
        // 思考开关已并入思考强度：选择“关闭”即关闭思考（运行时不再透传）。
        defaultValue: "off",
        advanced: true,
        options: [
          { value: "off", label: "关闭" },
          { value: "low", label: "低" },
          { value: "medium", label: "中" },
          { value: "xhigh", label: "超高" },
        ],
      },
    ),
    spec("enable_search", "联网搜索", "boolean", { defaultValue: false, advanced: true }),
  ],
  openai: [
    spec("max_tokens", "最大输出 Tokens", "integer", { defaultValue: 4096, min: 1 }),
    spec("temperature", "Temperature", "number", { defaultValue: 0.7, min: 0, max: 2 }),
    spec("top_p", "Top P", "number", { defaultValue: 1, min: 0, max: 1 }),
    spec("presence_penalty", "存在惩罚", "number", { defaultValue: 0, min: -2, max: 2 }),
    spec("frequency_penalty", "频率惩罚", "number", { defaultValue: 0, min: -2, max: 2 }),
    spec("stop", "停止词（多个用英文逗号分隔）", "string", { advanced: true }),
    spec("seed", "随机种子", "integer", { min: 0, advanced: true }),
    spec("n", "生成结果数", "integer", { defaultValue: 1, min: 1, max: 8, advanced: true }),
    spec(
      "reasoning_effort",
      "思考强度",
      "select",
      {
        defaultValue: "medium",
        advanced: true,
        options: [
          { value: "low", label: "低" },
          { value: "medium", label: "中" },
          { value: "high", label: "高" },
        ],
      },
    ),
    spec(
      "response_format",
      "响应格式",
      "select",
      {
        defaultValue: "text",
        advanced: true,
        options: [
          { value: "text", label: "文本" },
          { value: "json_object", label: "JSON 对象" },
        ],
      },
    ),
    spec("logprobs", "返回对数概率", "boolean", { defaultValue: false, advanced: true }),
    spec("top_logprobs", "Top Logprobs", "integer", { defaultValue: 0, min: 0, max: 20, advanced: true }),
  ],
  deepseek: [
    spec("max_tokens", "最大输出 Tokens", "integer", { defaultValue: 8192, min: 1 }),
    spec("temperature", "Temperature", "number", { defaultValue: 1, min: 0, max: 2 }),
    spec("top_p", "Top P", "number", { defaultValue: 1, min: 0, max: 1 }),
    spec("presence_penalty", "存在惩罚", "number", { defaultValue: 0, min: -2, max: 2 }),
    spec("frequency_penalty", "频率惩罚", "number", { defaultValue: 0, min: -2, max: 2 }),
    spec("stop", "停止词（多个用英文逗号分隔）", "string", { advanced: true }),
    spec("logprobs", "返回对数概率", "boolean", { defaultValue: false, advanced: true }),
    spec("top_logprobs", "Top Logprobs", "integer", { defaultValue: 0, min: 0, max: 20, advanced: true }),
    spec(
      "reasoning_effort",
      "思考强度",
      "select",
      {
        defaultValue: "high",
        advanced: true,
        options: [
          { value: "low", label: "低" },
          { value: "medium", label: "中" },
          { value: "high", label: "高" },
        ],
      },
    ),
    spec("thinking", "思考模式（JSON 对象）", "string", {
      defaultValue: '{"type":"enabled"}',
      description: "DeepSeek 思考参数为 JSON 对象，如 {\"type\":\"enabled\"} 或 {\"type\":\"disabled\"}。",
      advanced: true,
    }),
  ],
  zhipu: [
    spec("max_tokens", "最大输出 Tokens", "integer", { defaultValue: 65536, min: 1 }),
    spec("temperature", "Temperature", "number", { defaultValue: 0.95, min: 0, max: 2 }),
    spec("top_p", "Top P", "number", { defaultValue: 0.7, min: 0, max: 1 }),
    spec("do_sample", "采样", "boolean", { defaultValue: true }),
    spec("stream", "流式输出", "boolean", { defaultValue: false, advanced: true }),
    spec("stop", "停止词（多个用英文逗号分隔）", "string", { advanced: true }),
    spec("seed", "随机种子", "integer", { min: 0, advanced: true }),
    spec(
      "reasoning_effort",
      "思考强度（GLM-5.2 及以上）",
      "select",
      {
        defaultValue: "max",
        advanced: true,
        options: [
          { value: "max", label: "max" },
          { value: "xhigh", label: "xhigh" },
          { value: "high", label: "high" },
          { value: "medium", label: "medium" },
          { value: "low", label: "low" },
          { value: "minimal", label: "minimal" },
          { value: "none", label: "none" },
        ],
      },
    ),
    spec("thinking", "思考模式（JSON 对象）", "string", {
      defaultValue: '{"type":"enabled"}',
      description: "智谱 thinking 为 JSON 对象，如 {\"type\":\"enabled\"} 或 {\"type\":\"disabled\"}。",
      advanced: true,
    }),
  ],
  moonshot: [
    spec("max_tokens", "最大输出 Tokens", "integer", { defaultValue: 32768, min: 1 }),
    spec("temperature", "Temperature", "number", { defaultValue: 1, min: 0, max: 2 }),
    spec("top_p", "Top P", "number", { defaultValue: 0.95, min: 0, max: 1 }),
    spec("stream", "流式输出", "boolean", { defaultValue: true, advanced: true }),
    spec("enable_search", "联网搜索", "boolean", { defaultValue: false, advanced: true }),
    spec("stop", "停止词（多个用英文逗号分隔）", "string", { advanced: true }),
    spec("seed", "随机种子", "integer", { min: 0, advanced: true }),
    spec(
      "reasoning_effort",
      "思考强度（Kimi K3）",
      "select",
      {
        defaultValue: "max",
        advanced: true,
        options: [
          { value: "low", label: "低" },
          { value: "high", label: "高" },
          { value: "max", label: "最大" },
        ],
      },
    ),
    spec("thinking", "思考模式（JSON 对象）", "string", {
      defaultValue: '{"type":"enabled"}',
      description: "Kimi K2.x 的 thinking 为 JSON 对象；K3 使用 reasoning_effort。",
      advanced: true,
    }),
    spec(
      "tool_choice",
      "工具调用",
      "select",
      {
        defaultValue: "auto",
        advanced: true,
        options: [
          { value: "auto", label: "自动" },
          { value: "none", label: "禁用" },
          { value: "required", label: "必须调用" },
        ],
      },
    ),
  ],
  groq: [
    spec("max_tokens", "最大输出 Tokens", "integer", { defaultValue: 8192, min: 1 }),
    spec("temperature", "Temperature", "number", { defaultValue: 0.7, min: 0, max: 2 }),
    spec("top_p", "Top P", "number", { defaultValue: 1, min: 0, max: 1 }),
    spec("presence_penalty", "存在惩罚", "number", { defaultValue: 0, min: -2, max: 2 }),
    spec("frequency_penalty", "频率惩罚", "number", { defaultValue: 0, min: -2, max: 2 }),
    spec("stop", "停止词（多个用英文逗号分隔）", "string", { advanced: true }),
    spec("seed", "随机种子", "integer", { min: 0, advanced: true }),
    spec("n", "生成结果数", "integer", { defaultValue: 1, min: 1, max: 8, advanced: true }),
    spec(
      "response_format",
      "响应格式",
      "select",
      {
        defaultValue: "text",
        advanced: true,
        options: [
          { value: "text", label: "文本" },
          { value: "json_object", label: "JSON 对象" },
        ],
      },
    ),
    spec("logprobs", "返回对数概率", "boolean", { defaultValue: false, advanced: true }),
    spec("top_logprobs", "Top Logprobs", "integer", { defaultValue: 0, min: 0, max: 20, advanced: true }),
  ],
  xai: [
    spec("max_tokens", "最大输出 Tokens", "integer", { defaultValue: 8192, min: 1 }),
    spec("temperature", "Temperature", "number", { defaultValue: 0.7, min: 0, max: 2 }),
    spec("top_p", "Top P", "number", { defaultValue: 1, min: 0, max: 1 }),
    spec(
      "reasoning_effort",
      "思考强度",
      "select",
      {
        defaultValue: "high",
        advanced: true,
        options: [
          { value: "low", label: "低" },
          { value: "medium", label: "中" },
          { value: "high", label: "高" },
        ],
        description: "Grok 4.5 始终推理，仅可调整强度。",
      },
    ),
    spec("presence_penalty", "存在惩罚", "number", { defaultValue: 0, min: -2, max: 2, advanced: true }),
    spec("frequency_penalty", "频率惩罚", "number", { defaultValue: 0, min: -2, max: 2, advanced: true }),
    spec("stop", "停止词（多个用英文逗号分隔）", "string", { advanced: true }),
    spec("seed", "随机种子", "integer", { min: 0, advanced: true }),
    spec(
      "tool_choice",
      "工具调用",
      "select",
      {
        defaultValue: "auto",
        advanced: true,
        options: [
          { value: "auto", label: "自动" },
          { value: "none", label: "禁用" },
          { value: "required", label: "必须调用" },
        ],
      },
    ),
  ],
  mistral: [
    spec("max_tokens", "最大输出 Tokens", "integer", { defaultValue: 16384, min: 1 }),
    spec("temperature", "Temperature", "number", { defaultValue: 0.7, min: 0, max: 2 }),
    spec("top_p", "Top P", "number", { defaultValue: 1, min: 0, max: 1 }),
    spec("top_k", "Top K", "integer", { min: 1, max: 100, advanced: true }),
    spec("stop", "停止词（多个用英文逗号分隔）", "string", { advanced: true }),
    spec("random_seed", "随机种子（Mistral）", "integer", { min: 0, advanced: true }),
    spec("safe_prompt", "安全提示词", "boolean", { defaultValue: false, advanced: true }),
    spec("seed", "随机种子", "integer", { min: 0, advanced: true }),
    spec("n", "生成结果数", "integer", { defaultValue: 1, min: 1, max: 8, advanced: true }),
  ],
  baichuan: [
    spec("max_tokens", "最大输出 Tokens", "integer", { defaultValue: 4096, min: 1 }),
    spec("temperature", "Temperature", "number", { defaultValue: 0.3, min: 0, max: 2 }),
    spec("top_p", "Top P", "number", { defaultValue: 0.85, min: 0, max: 1 }),
    spec("top_k", "Top K", "integer", { defaultValue: 5, min: 1, max: 100 }),
    spec("stop", "停止词（多个用英文逗号分隔）", "string", { advanced: true }),
  ],
};

/** Backward-compatible alias for callers that only need the generic surface. */
export const PARAM_SPECS = FALLBACK_PARAM_SPECS;

const MODEL_PARAM_OVERRIDES: Record<string, ParameterSpec[]> = {
  "kimi-k3": [
    spec("max_tokens", "最大输出 Tokens", "integer", { defaultValue: 32768, min: 1 }),
    spec("stream", "流式输出", "boolean", { defaultValue: true, advanced: true }),
    spec("enable_search", "联网搜索", "boolean", { defaultValue: false, advanced: true }),
    spec(
      "reasoning_effort",
      "思考强度（Kimi K3）",
      "select",
      {
        defaultValue: "max",
        advanced: true,
        options: [
          { value: "low", label: "低" },
          { value: "high", label: "高" },
          { value: "max", label: "最大" },
        ],
        description: "Kimi K3 始终推理，通过 reasoning_effort 控制强度。",
      },
    ),
    spec(
      "tool_choice",
      "工具调用",
      "select",
      {
        defaultValue: "auto",
        advanced: true,
        options: [
          { value: "auto", label: "自动" },
          { value: "none", label: "禁用" },
          { value: "required", label: "必须调用" },
        ],
      },
    ),
  ],
  "kimi/kimi-k3": [
    spec("max_tokens", "最大输出 Tokens", "integer", { defaultValue: 32768, min: 1 }),
    spec("stream", "流式输出", "boolean", { defaultValue: true, advanced: true }),
    spec("enable_search", "联网搜索", "boolean", { defaultValue: false, advanced: true }),
    spec(
      "reasoning_effort",
      "思考强度（Kimi K3）",
      "select",
      {
        defaultValue: "max",
        advanced: true,
        options: [
          { value: "low", label: "低" },
          { value: "high", label: "高" },
          { value: "max", label: "最大" },
        ],
        description: "Kimi K3 始终推理，通过 reasoning_effort 控制强度。",
      },
    ),
    spec(
      "tool_choice",
      "工具调用",
      "select",
      {
        defaultValue: "auto",
        advanced: true,
        options: [
          { value: "auto", label: "自动" },
          { value: "none", label: "禁用" },
          { value: "required", label: "必须调用" },
        ],
      },
    ),
  ],
  "zhipu/glm-5.3": PROFILE_PROVIDER_SPECS.zhipu!,
  "glm-5.3": PROFILE_PROVIDER_SPECS.zhipu!,
};

/**
 * Return the parameter profile for a provider/model.
 *
 * Model-level verified facts win over provider defaults for known models;
 * unknown models receive the generic full surface so JSON editing still works.
 */
export function paramSpecsFor(
  providerId: string,
  modelId?: string,
): ParameterSpec[] {
  const providerKey = providerId.trim().toLowerCase();
  if (modelId !== undefined) {
    const modelKey = modelId.trim().toLowerCase();
    const modelOverrides = MODEL_PARAM_OVERRIDES[modelKey] ??
      MODEL_PARAM_OVERRIDES[modelKey.split("/").pop() ?? modelKey];
    if (modelOverrides !== undefined) return structuredClone(modelOverrides);
  }
  const providerSpecs = PROFILE_PROVIDER_SPECS[providerKey];
  if (providerSpecs !== undefined) return structuredClone(providerSpecs);
  return structuredClone(FALLBACK_PARAM_SPECS);
}

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

export { catalogCapacity, catalogContextWindow, lookupModelCatalog };
