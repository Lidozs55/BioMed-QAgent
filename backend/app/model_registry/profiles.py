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
    _spec("frequency_penalty", "频率惩罚", "number", default=0, min=0, max=2),
    _spec("presence_penalty", "存在惩罚", "number", default=0, min=0, max=2),
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
        _spec("presence_penalty", "存在惩罚", "number", default=0, min=0, max=2),
        _spec("frequency_penalty", "频率惩罚", "number", default=0, min=0, max=2),
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
        _spec("presence_penalty", "存在惩罚", "number", default=0, min=0, max=2),
        _spec("frequency_penalty", "频率惩罚", "number", default=0, min=0, max=2),
        _spec("stop", "停止词（多个用英文逗号分隔）", "string", advanced=True),
        _spec("logprobs", "返回对数概率", "boolean", default=False, advanced=True),
        _spec("top_logprobs", "Top Logprobs", "integer", default=0, min=0, max=20, advanced=True),
    ],
    "zhipu": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=4096, min=1, max=262144),
        _spec("temperature", "Temperature", "number", default=0.95, min=0, max=2),
        _spec("top_p", "Top P", "number", default=0.7, min=0, max=1),
        _spec("do_sample", "采样", "boolean", default=True),
        _spec("stop", "停止词（多个用英文逗号分隔）", "string", advanced=True),
        _spec("seed", "随机种子", "integer", min=0, advanced=True),
        _spec(
            "reasoning_effort",
            "思考强度",
            "select",
            default="high",
            options=[
                {"value": "low", "label": "低"},
                {"value": "high", "label": "高"},
                {"value": "max", "label": "最大"},
            ],
            advanced=True,
        ),
        _spec("thinking", "思考模式", "boolean", default=False, advanced=True),
    ],
    "moonshot": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=4096, min=1, max=262144),
        _spec("temperature", "Temperature", "number", default=0.3, min=0, max=2),
        _spec("top_p", "Top P", "number", default=1.0, min=0, max=1),
        _spec("enable_search", "联网搜索", "boolean", default=False, advanced=True),
        _spec("stop", "停止词（多个用英文逗号分隔）", "string", advanced=True),
        _spec("seed", "随机种子", "integer", min=0, advanced=True),
        _spec(
            "reasoning_effort",
            "思考强度",
            "select",
            default="high",
            options=[
                {"value": "low", "label": "低"},
                {"value": "high", "label": "高"},
                {"value": "max", "label": "最大"},
            ],
            advanced=True,
        ),
    ],
    "baichuan": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=4096, min=1, max=262144),
        _spec("temperature", "Temperature", "number", default=0.3, min=0, max=2),
        _spec("top_p", "Top P", "number", default=0.85, min=0, max=1),
        _spec("top_k", "Top K", "integer", default=5, min=1, max=100),
        _spec("stop", "停止词（多个用英文逗号分隔）", "string", advanced=True),
    ],
}


def param_specs_for(provider_id: str) -> list[ParameterSpec]:
    """Return the parameter profile for a provider, falling back to all params."""

    key = provider_id.strip().lower()
    if key in PROFILE_PROVIDER_SPECS:
        return [spec.model_copy(deep=True) for spec in PROFILE_PROVIDER_SPECS[key]]
    return [spec.model_copy(deep=True) for spec in FALLBACK_PARAM_SPECS]


__all__ = ["FALLBACK_PARAM_SPECS", "PROFILE_PROVIDER_SPECS", "param_specs_for"]
