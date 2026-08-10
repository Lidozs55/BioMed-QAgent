"""Groq model data provider (OpenAI-compatible)."""

from __future__ import annotations

from app.model_info.schemas import ModelCapabilities, ModelDetail

MODELS: dict[str, ModelDetail] = {
    "meta-llama/llama-4-scout-17b-16e-instruct": ModelDetail(
        id="meta-llama/llama-4-scout-17b-16e-instruct",
        name="Llama 4 Scout",
        description="Groq 托管的 Meta Llama 4 Scout 17B 模型，131K 上下文，支持视觉与工具调用。",
        vendor_id="groq",
        input_context_window=131_072,
        max_output_tokens=8_192,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True, image=True),
        pricing_input_per_1m=0.11,
        pricing_output_per_1m=0.34,
        recommended=True,
        model_family="llama",
        function_calling=True,
        supports_streaming=True,
    ),
    "meta-llama/llama-3.3-70b-versatile": ModelDetail(
        id="meta-llama/llama-3.3-70b-versatile",
        name="Llama 3.3 70B",
        description="Groq 托管的 Meta Llama 3.3 70B 模型，131K 上下文，擅长通用对话与推理。",
        vendor_id="groq",
        input_context_window=131_072,
        max_output_tokens=32_768,
        suggested_max_tokens=32_768,
        capabilities=ModelCapabilities(text=True),
        pricing_input_per_1m=0.59,
        pricing_output_per_1m=0.79,
        recommended=False,
        model_family="llama",
        function_calling=True,
        supports_streaming=True,
    ),
}


def register(target: dict[str, ModelDetail]) -> None:
    """Merge Groq models into the target repository dictionary."""
    target.update(MODELS)
