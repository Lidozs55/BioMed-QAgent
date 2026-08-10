"""Provider-specific model parameter profiles.

Every provider may expose a different parameter surface.  Known presets get
their own profile; anything else falls back to :data:`FALLBACK_PARAM_SPECS`,
which makes every app-supported parameter selectable.  Unknown parameters
are never rejected -- they are stored as free-form extra values.
"""

from __future__ import annotations

from app.model_registry.schemas import ParameterSpec


def _spec(
    key: str,
    label: str,
    type: str,
    *,
    default: object = None,
    description: str = "",
    min: float | None = None,
    max: float | None = None,
    options: list[dict[str, str]] | None = None,
    advanced: bool = False,
) -> ParameterSpec:
    return ParameterSpec(
        key=key,
        label=label,
        type=type,
        default=default,
        description=description,
        min=min,
        max=max,
        options=options or [],
        advanced=advanced,
    )


FALLBACK_PARAM_SPECS: list[ParameterSpec] = [
    _spec("max_tokens", "最大输出 Tokens", "integer", default=8192, min=1, max=262144),
    _spec("temperature", "Temperature", "number", default=0.7, min=0, max=2),
    _spec("top_p", "Top P", "number", default=1.0, min=0, max=1),
    _spec("top_k", "Top K", "integer", min=1, max=100, advanced=True),
    _spec("do_sample", "随机采样", "boolean", default=True, advanced=True),
    _spec(
        "reasoning_effort",
        "思考强度",
        "select",
        default="high",
        options=[
            {"value": "low", "label": "低"},
            {"value": "medium", "label": "中"},
            {"value": "high", "label": "高"},
            {"value": "max", "label": "最大"},
        ],
        advanced=True,
    ),
    _spec("enable_thinking", "思考模式", "boolean", default=False, advanced=True),
    _spec("thinking_budget", "思考预算（Tokens）", "integer", min=0, advanced=True),
    _spec("stop", "停止词（多个用英文逗号分隔）", "string", advanced=True),
    _spec("stream", "流式输出", "boolean", default=True, advanced=True),
    _spec("frequency_penalty", "频率惩罚", "number", default=0, min=-2, max=2),
    _spec("presence_penalty", "存在惩罚", "number", default=0, min=-2, max=2),
    _spec("repetition_penalty", "重复惩罚", "number", default=1.0, min=0, max=2),
    _spec("seed", "随机种子", "integer", min=0, advanced=True),
    _spec("n", "生成结果数", "integer", default=1, min=1, max=8, advanced=True),
    _spec("logit_bias", "Logit Bias（JSON 对象）", "string", advanced=True),
    _spec(
        "tool_choice",
        "工具调用",
        "select",
        default="auto",
        options=[
            {"value": "auto", "label": "自动"},
            {"value": "none", "label": "禁用"},
            {"value": "required", "label": "必须调用"},
        ],
        advanced=True,
    ),
    _spec("enable_search", "联网搜索", "boolean", default=False, advanced=True),
    _spec("thinking_mode", "思维链模式", "boolean", default=False, advanced=True),
]


PROFILE_PROVIDER_SPECS: dict[str, list[ParameterSpec]] = {
    "dashscope": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=8192, min=1, max=262144),
        _spec("temperature", "Temperature", "number", default=0.7, min=0, max=2),
        _spec("top_p", "Top P", "number", default=1.0, min=0, max=1),
        _spec("top_k", "Top K", "integer", min=1, max=100, advanced=True),
        _spec("repetition_penalty", "重复惩罚", "number", default=1.0, min=0, max=2),
        _spec("stop", "停止词（多个用英文逗号分隔）", "string", advanced=True),
        _spec("enable_thinking", "思考模式", "boolean", default=False, advanced=True),
        _spec("thinking_budget", "思考预算（Tokens）", "integer", min=0, advanced=True),
        _spec("enable_search", "联网搜索", "boolean", default=False, advanced=True),
        _spec("thinking_mode", "思维链模式", "boolean", default=False, advanced=True),
    ],
    "openai": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=4096, min=1, max=262144),
        _spec("temperature", "Temperature", "number", default=0.7, min=0, max=2),
        _spec("top_p", "Top P", "number", default=1.0, min=0, max=1),
        _spec("presence_penalty", "存在惩罚", "number", default=0, min=-2, max=2),
        _spec("frequency_penalty", "频率惩罚", "number", default=0, min=-2, max=2),
        _spec("stop", "停止词（多个用英文逗号分隔）", "string", advanced=True),
        _spec("seed", "随机种子", "integer", min=0, advanced=True),
        _spec("n", "生成结果数", "integer", default=1, min=1, max=8, advanced=True),
        _spec(
            "reasoning_effort",
            "思考强度",
            "select",
            default="medium",
            options=[
                {"value": "low", "label": "低"},
                {"value": "medium", "label": "中"},
                {"value": "high", "label": "高"},
            ],
            advanced=True,
        ),
        _spec(
            "response_format",
            "响应格式",
            "select",
            default="text",
            options=[
                {"value": "text", "label": "文本"},
                {"value": "json_object", "label": "JSON 对象"},
            ],
            advanced=True,
        ),
        _spec("logprobs", "返回对数概率", "boolean", default=False, advanced=True),
        _spec("top_logprobs", "Top Logprobs", "integer", default=0, min=0, max=20, advanced=True),
    ],
    "deepseek": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=8192, min=1, max=262144),
        _spec("temperature", "Temperature", "number", default=1.0, min=0, max=2),
        _spec("top_p", "Top P", "number", default=1.0, min=0, max=1),
        _spec("presence_penalty", "存在惩罚", "number", default=0, min=-2, max=2),
        _spec("frequency_penalty", "频率惩罚", "number", default=0, min=-2, max=2),
        _spec("stop", "停止词（多个用英文逗号分隔）", "string", advanced=True),
        _spec("logprobs", "返回对数概率", "boolean", default=False, advanced=True),
        _spec("top_logprobs", "Top Logprobs", "integer", default=0, min=0, max=20, advanced=True),
    ],
    "zhipu": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=65536, min=1, max=131072),
        _spec("temperature", "Temperature", "number", default=0.95, min=0, max=2),
        _spec("top_p", "Top P", "number", default=0.7, min=0, max=1),
        _spec("do_sample", "采样", "boolean", default=True),
        _spec("stream", "流式输出", "boolean", default=False, advanced=True),
        _spec("stop", "停止词（多个用英文逗号分隔）", "string", advanced=True),
        _spec("seed", "随机种子", "integer", min=0, advanced=True),
        _spec(
            "reasoning_effort",
            "思考强度（GLM-5.2 及以上）",
            "select",
            default="max",
            options=[
                {"value": "max", "label": "max"},
                {"value": "xhigh", "label": "xhigh"},
                {"value": "high", "label": "high"},
                {"value": "medium", "label": "medium"},
                {"value": "low", "label": "low"},
                {"value": "minimal", "label": "minimal"},
                {"value": "none", "label": "none"},
            ],
            description=(
                "GLM-5.2+ 推理强度；low/medium 映射为 high，xhigh 映射为 max，"
                "none/minimal 会放弃思考。"
            ),
            advanced=True,
        ),
        _spec(
            "thinking",
            "思考模式（JSON 对象）",
            "string",
            default='{"type":"enabled"}',
            description=(
                "智谱 thinking 为 JSON 对象，如 {\"type\":\"enabled\"} 或 "
                "{\"type\":\"disabled\"}；仅 GLM-4.5 及以上支持。"
            ),
            advanced=True,
        ),
    ],
    "moonshot": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=32768, min=1, max=131072),
        _spec("temperature", "Temperature", "number", default=1.0, min=0, max=2),
        _spec("top_p", "Top P", "number", default=0.95, min=0, max=1),
        _spec("stream", "流式输出", "boolean", default=True, advanced=True),
        _spec("enable_search", "联网搜索", "boolean", default=False, advanced=True),
        _spec("stop", "停止词（多个用英文逗号分隔）", "string", advanced=True),
        _spec("seed", "随机种子", "integer", min=0, advanced=True),
        _spec(
            "reasoning_effort",
            "思考强度（Kimi K3）",
            "select",
            default="max",
            options=[
                {"value": "low", "label": "低"},
                {"value": "high", "label": "高"},
                {"value": "max", "label": "最大"},
            ],
            description="Kimi K3 始终推理，通过 reasoning_effort 控制强度；K2.x 不支持该参数。",
            advanced=True,
        ),
        _spec(
            "thinking",
            "思考模式（JSON 对象）",
            "string",
            default='{"type":"enabled"}',
            description=(
                "Kimi K2.x 的 thinking 为 JSON 对象，如 {\"type\":\"enabled\"}、"
                "{\"type\":\"disabled\"} 或 {\"type\":\"enabled\",\"keep\":\"all\"}；"
                "K3 不支持该参数。"
            ),
            advanced=True,
        ),
        _spec(
            "tool_choice",
            "工具调用",
            "select",
            default="auto",
            options=[
                {"value": "auto", "label": "自动"},
                {"value": "none", "label": "禁用"},
                {"value": "required", "label": "必须调用"},
            ],
            description="required 仅 Kimi K3 支持；K2.6 / K2.7-code 传入会报错。",
            advanced=True,
        ),
    ],
    "groq": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=8192, min=1, max=131072),
        _spec("temperature", "Temperature", "number", default=0.7, min=0, max=2),
        _spec("top_p", "Top P", "number", default=1.0, min=0, max=1),
        _spec("presence_penalty", "存在惩罚", "number", default=0, min=-2, max=2),
        _spec("frequency_penalty", "频率惩罚", "number", default=0, min=-2, max=2),
        _spec("stop", "停止词（多个用英文逗号分隔）", "string", advanced=True),
        _spec("seed", "随机种子", "integer", min=0, advanced=True),
        _spec("n", "生成结果数", "integer", default=1, min=1, max=8, advanced=True),
        _spec(
            "response_format",
            "响应格式",
            "select",
            default="text",
            options=[
                {"value": "text", "label": "文本"},
                {"value": "json_object", "label": "JSON 对象"},
            ],
            advanced=True,
        ),
        _spec("logprobs", "返回对数概率", "boolean", default=False, advanced=True),
        _spec("top_logprobs", "Top Logprobs", "integer", default=0, min=0, max=20, advanced=True),
    ],
    "xai": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=8192, min=1, max=131072),
        _spec("temperature", "Temperature", "number", default=0.7, min=0, max=2),
        _spec("top_p", "Top P", "number", default=1.0, min=0, max=1),
        _spec(
            "reasoning_effort",
            "思考强度",
            "select",
            default="high",
            options=[
                {"value": "low", "label": "低"},
                {"value": "medium", "label": "中"},
                {"value": "high", "label": "高"},
            ],
            description="Grok 4.5 始终推理，不可关闭；仅可调整强度。",
            advanced=True,
        ),
        _spec("presence_penalty", "存在惩罚", "number", default=0, min=-2, max=2, advanced=True),
        _spec("frequency_penalty", "频率惩罚", "number", default=0, min=-2, max=2, advanced=True),
        _spec("stop", "停止词（多个用英文逗号分隔）", "string", advanced=True),
        _spec("seed", "随机种子", "integer", min=0, advanced=True),
        _spec(
            "tool_choice",
            "工具调用",
            "select",
            default="auto",
            options=[
                {"value": "auto", "label": "自动"},
                {"value": "none", "label": "禁用"},
                {"value": "required", "label": "必须调用"},
            ],
            advanced=True,
        ),
    ],
    "mistral": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=16384, min=1, max=262144),
        _spec("temperature", "Temperature", "number", default=0.7, min=0, max=2),
        _spec("top_p", "Top P", "number", default=1.0, min=0, max=1),
        _spec("top_k", "Top K", "integer", min=1, max=100, advanced=True),
        _spec("stop", "停止词（多个用英文逗号分隔）", "string", advanced=True),
        _spec("random_seed", "随机种子（Mistral）", "integer", min=0, advanced=True),
        _spec("safe_prompt", "安全提示词", "boolean", default=False, advanced=True),
        _spec("seed", "随机种子", "integer", min=0, advanced=True),
        _spec("n", "生成结果数", "integer", default=1, min=1, max=8, advanced=True),
    ],
    "baichuan": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=4096, min=1, max=262144),
        _spec("temperature", "Temperature", "number", default=0.3, min=0, max=2),
        _spec("top_p", "Top P", "number", default=0.85, min=0, max=1),
        _spec("top_k", "Top K", "integer", default=5, min=1, max=100),
        _spec("stop", "停止词（多个用英文逗号分隔）", "string", advanced=True),
    ],
}


_GPT_5_6_REASONING_EFFORT = _spec(
    "reasoning_effort",
    "思考强度",
    "select",
    default="medium",
    options=[
        {"value": "none", "label": "none"},
        {"value": "low", "label": "低"},
        {"value": "medium", "label": "中"},
        {"value": "high", "label": "高"},
        {"value": "xhigh", "label": "xhigh"},
        {"value": "max", "label": "最大"},
    ],
    advanced=True,
)

_O_SERIES_REASONING_EFFORT = _spec(
    "reasoning_effort",
    "思考强度",
    "select",
    default="medium",
    options=[
        {"value": "low", "label": "低"},
        {"value": "medium", "label": "中"},
        {"value": "high", "label": "高"},
    ],
    advanced=True,
)

_KIMI_K2_TOOL_CHOICE = _spec(
    "tool_choice",
    "工具调用",
    "select",
    default="auto",
    options=[
        {"value": "auto", "label": "自动"},
        {"value": "none", "label": "禁用"},
    ],
    description="Kimi K2.6 / K2.7-code 不支持 required。",
    advanced=True,
)

_KIMI_K2_7_THINKING = _spec(
    "thinking",
    "思考模式（JSON 对象）",
    "string",
    default='{"type":"enabled","keep":"all"}',
    description=(
        "Kimi K2.7-code 思考默认开启且不可关闭，仅接受 "
        '{"type":"enabled","keep":"all"}。'
    ),
    advanced=True,
)


def _model_specs(
    provider_id: str,
    *,
    drop: set[str] | None = None,
    replace: dict[str, ParameterSpec] | None = None,
) -> list[ParameterSpec]:
    """Derive a model-specific profile from its provider profile.

    ``drop`` removes parameters the model does not support, and ``replace``
    swaps individual definitions (options/ranges/defaults).  Entries are
    deep-copied so callers can never mutate the shared catalog.
    """

    dropped = drop or set()
    base = [
        spec.model_copy(deep=True)
        for spec in PROFILE_PROVIDER_SPECS.get(provider_id, FALLBACK_PARAM_SPECS)
        if spec.key not in dropped
    ]
    if replace:
        base = [replace.get(spec.key, spec) for spec in base]
    return base


MODEL_PARAM_SPECS: dict[str, dict[str, list[ParameterSpec]]] = {
    "openai": {
        "gpt-5.6": _model_specs("openai", replace={"reasoning_effort": _GPT_5_6_REASONING_EFFORT}),
        "gpt-5.6-luna": _model_specs(
            "openai", replace={"reasoning_effort": _GPT_5_6_REASONING_EFFORT}
        ),
        "gpt-5.6-terra": _model_specs(
            "openai", replace={"reasoning_effort": _GPT_5_6_REASONING_EFFORT}
        ),
        "gpt-5.6-sol": _model_specs(
            "openai", replace={"reasoning_effort": _GPT_5_6_REASONING_EFFORT}
        ),
        "gpt-4o": _model_specs("openai", drop={"reasoning_effort"}),
        "gpt-4o-mini": _model_specs("openai", drop={"reasoning_effort"}),
        "gpt-4-turbo": _model_specs("openai", drop={"reasoning_effort"}),
        "gpt-4": _model_specs("openai", drop={"reasoning_effort"}),
        "o1": _model_specs(
            "openai",
            drop={
                "temperature",
                "top_p",
                "presence_penalty",
                "frequency_penalty",
                "logprobs",
                "top_logprobs",
                "n",
                "response_format",
            },
            replace={"reasoning_effort": _O_SERIES_REASONING_EFFORT},
        ),
        "o3-mini": _model_specs(
            "openai",
            drop={
                "temperature",
                "top_p",
                "presence_penalty",
                "frequency_penalty",
                "logprobs",
                "top_logprobs",
                "n",
                "response_format",
            },
            replace={"reasoning_effort": _O_SERIES_REASONING_EFFORT},
        ),
    },
    "deepseek": {
        "deepseek-reasoner": _model_specs(
            "deepseek",
            drop={
                "temperature",
                "top_p",
                "presence_penalty",
                "frequency_penalty",
                "logprobs",
                "top_logprobs",
            },
        ),
    },
    "zhipu": {
        "glm-5.1": _model_specs("zhipu", drop={"reasoning_effort"}),
        "glm-5": _model_specs("zhipu", drop={"reasoning_effort"}),
        "glm-5-turbo": _model_specs("zhipu", drop={"reasoning_effort"}),
        "glm-5v-turbo": _model_specs("zhipu", drop={"reasoning_effort"}),
        "glm-4.7": _model_specs("zhipu", drop={"reasoning_effort"}),
        "glm-4.6": _model_specs("zhipu", drop={"reasoning_effort"}),
        "glm-4.6v": _model_specs("zhipu", drop={"reasoning_effort"}),
        "glm-4.6v-flash": _model_specs("zhipu", drop={"reasoning_effort"}),
        "glm-4.6v-flashx": _model_specs("zhipu", drop={"reasoning_effort"}),
        "glm-4.5": _model_specs("zhipu", drop={"reasoning_effort"}),
        "glm-4.5-air": _model_specs("zhipu", drop={"reasoning_effort"}),
        "glm-4.5-flash": _model_specs("zhipu", drop={"reasoning_effort"}),
        "glm-4v-flash": _model_specs("zhipu", drop={"reasoning_effort", "thinking"}),
        "glm-4-flash-250414": _model_specs(
            "zhipu", drop={"reasoning_effort", "thinking"}
        ),
        "glm-4-plus": _model_specs("zhipu", drop={"reasoning_effort", "thinking"}),
        "glm-4-flash": _model_specs("zhipu", drop={"reasoning_effort", "thinking"}),
        "glm-4-long": _model_specs("zhipu", drop={"reasoning_effort", "thinking"}),
        "glm-4v-plus": _model_specs("zhipu", drop={"reasoning_effort", "thinking"}),
    },
    "moonshot": {
        "kimi/kimi-k3": _model_specs(
            "moonshot",
            drop={"temperature", "top_p", "seed", "stop", "thinking"},
        ),
        "kimi-k2.6": _model_specs(
            "moonshot",
            drop={"temperature", "top_p", "seed", "stop", "reasoning_effort"},
            replace={"tool_choice": _KIMI_K2_TOOL_CHOICE},
        ),
        "kimi-k2.7-code": _model_specs(
            "moonshot",
            drop={"temperature", "top_p", "seed", "stop", "reasoning_effort"},
            replace={
                "tool_choice": _KIMI_K2_TOOL_CHOICE,
                "thinking": _KIMI_K2_7_THINKING,
            },
        ),
        "moonshot-v1-8k": _model_specs(
            "moonshot", drop={"reasoning_effort", "thinking", "tool_choice"}
        ),
        "moonshot-v1-32k": _model_specs(
            "moonshot", drop={"reasoning_effort", "thinking", "tool_choice"}
        ),
        "moonshot-v1-128k": _model_specs(
            "moonshot", drop={"reasoning_effort", "thinking", "tool_choice"}
        ),
    },
    "xai": {
        "grok-4.5": _model_specs(
            "xai",
            drop={"presence_penalty", "frequency_penalty", "stop", "seed"},
        ),
    },
}


def param_specs_for(provider_id: str, model_id: str | None = None) -> list[ParameterSpec]:
    """Return the parameter profile for a provider, falling back to all params.

    When ``model_id`` is given and the model has a catalog entry, the
    model-specific profile (official API support) wins over the provider
    profile.
    """

    key = provider_id.strip().lower()
    if model_id:
        model_key = model_id.strip().lower()
        model_specs = MODEL_PARAM_SPECS.get(key, {}).get(model_key)
        if model_specs is not None:
            return [spec.model_copy(deep=True) for spec in model_specs]
    if key in PROFILE_PROVIDER_SPECS:
        return [spec.model_copy(deep=True) for spec in PROFILE_PROVIDER_SPECS[key]]
    return [spec.model_copy(deep=True) for spec in FALLBACK_PARAM_SPECS]


__all__ = [
    "FALLBACK_PARAM_SPECS",
    "MODEL_PARAM_SPECS",
    "PROFILE_PROVIDER_SPECS",
    "param_specs_for",
]
