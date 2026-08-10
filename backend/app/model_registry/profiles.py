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
    _spec("repetition_penalty", "重复惩罚", "number", default=1.0, min=0, max=2),
    _spec("enable_search", "联网搜索", "boolean", default=False, advanced=True),
    _spec("thinking_mode", "思维链模式", "boolean", default=False, advanced=True),
]


PROFILE_PROVIDER_SPECS: dict[str, list[ParameterSpec]] = {
    "dashscope": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=8192, min=1, max=262144),
        _spec("temperature", "Temperature", "number", default=0.7, min=0, max=2),
        _spec("top_p", "Top P", "number", default=1.0, min=0, max=1),
        _spec("repetition_penalty", "重复惩罚", "number", default=1.0, min=0, max=2),
        _spec("enable_search", "联网搜索", "boolean", default=False, advanced=True),
        _spec("thinking_mode", "思维链模式", "boolean", default=False, advanced=True),
    ],
    "openai": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=4096, min=1, max=262144),
        _spec("temperature", "Temperature", "number", default=0.7, min=0, max=2),
        _spec("top_p", "Top P", "number", default=1.0, min=0, max=1),
        _spec("presence_penalty", "存在惩罚", "number", default=0, min=0, max=2),
        _spec("frequency_penalty", "频率惩罚", "number", default=0, min=0, max=2),
    ],
    "deepseek": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=8192, min=1, max=262144),
        _spec("temperature", "Temperature", "number", default=1.0, min=0, max=2),
        _spec("top_p", "Top P", "number", default=1.0, min=0, max=1),
        _spec("presence_penalty", "存在惩罚", "number", default=0, min=0, max=2),
        _spec("frequency_penalty", "频率惩罚", "number", default=0, min=0, max=2),
    ],
    "zhipu": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=4096, min=1, max=262144),
        _spec("temperature", "Temperature", "number", default=0.95, min=0, max=2),
        _spec("top_p", "Top P", "number", default=0.7, min=0, max=1),
        _spec("do_sample", "采样", "boolean", default=True),
    ],
    "moonshot": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=4096, min=1, max=262144),
        _spec("temperature", "Temperature", "number", default=0.3, min=0, max=2),
        _spec("top_p", "Top P", "number", default=1.0, min=0, max=1),
        _spec("enable_search", "联网搜索", "boolean", default=False, advanced=True),
    ],
    "baichuan": [
        _spec("max_tokens", "最大输出 Tokens", "integer", default=4096, min=1, max=262144),
        _spec("temperature", "Temperature", "number", default=0.3, min=0, max=2),
        _spec("top_p", "Top P", "number", default=0.85, min=0, max=1),
        _spec("top_k", "Top K", "integer", default=5, min=1, max=100),
    ],
}


def param_specs_for(provider_id: str) -> list[ParameterSpec]:
    """Return the parameter profile for a provider, falling back to all params."""

    key = provider_id.strip().lower()
    if key in PROFILE_PROVIDER_SPECS:
        return [spec.model_copy(deep=True) for spec in PROFILE_PROVIDER_SPECS[key]]
    return [spec.model_copy(deep=True) for spec in FALLBACK_PARAM_SPECS]


__all__ = ["FALLBACK_PARAM_SPECS", "PROFILE_PROVIDER_SPECS", "param_specs_for"]
