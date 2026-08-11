"""Groq model data provider."""

from __future__ import annotations

from app.model_info.schemas import ModelCapabilities, ModelDetail

MODELS: dict[str, ModelDetail] = {
    "meta-llama/llama-4-scout-17b-16e-instruct": ModelDetail(
        id="meta-llama/llama-4-scout-17b-16e-instruct",
        name="Llama 4 Scout",
        description="Groq 托管的 Meta Llama 4 Scout 17B 模型，128K 上下文，支持视觉与工具调用。",
        vendor_id="groq",
        input_context_window=131_072,
        max_output_tokens=8_192,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True, image=True, video=False, audio=False),
        knowledge_cutoff="2024-08",
        pricing_input_per_1m=0.11,
        pricing_output_per_1m=0.34,
        model_family="llama",
    ),
    "llama-3.3-70b-versatile": ModelDetail(
        id="llama-3.3-70b-versatile",
        name="Llama 3.3 70B",
        description="Groq 托管的 Meta Llama 3.3 70B 模型，131K 上下文。",
        vendor_id="groq",
        input_context_window=131_072,
        max_output_tokens=32_768,
        suggested_max_tokens=32_768,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        pricing_input_per_1m=0.59,
        pricing_output_per_1m=0.79,
        recommended=True,
        model_family="llama",
    ),
    "llama-3.1-8b-instant": ModelDetail(
        id="llama-3.1-8b-instant",
        name="Llama 3.1 8B",
        description="Groq 托管的 Meta Llama 3.1 8B 模型，131K 上下文。",
        vendor_id="groq",
        input_context_window=131_072,
        max_output_tokens=131_072,
        suggested_max_tokens=32_768,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        pricing_input_per_1m=0.05,
        pricing_output_per_1m=0.08,
        model_family="llama",
    ),
    "openai/gpt-oss-120b": ModelDetail(
        id="openai/gpt-oss-120b",
        name="GPT OSS 120B",
        description="OpenAI 开源 GPT-OSS 120B 模型，支持推理与工具调用。",
        vendor_id="groq",
        input_context_window=131_072,
        max_output_tokens=65_536,
        suggested_max_tokens=32_768,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        pricing_input_per_1m=0.15,
        pricing_output_per_1m=0.6,
        model_family="llama",
    ),
    "openai/gpt-oss-20b": ModelDetail(
        id="openai/gpt-oss-20b",
        name="GPT OSS 20B",
        description="OpenAI 开源 GPT-OSS 20B 模型。",
        vendor_id="groq",
        input_context_window=131_072,
        max_output_tokens=65_536,
        suggested_max_tokens=32_768,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        pricing_input_per_1m=0.075,
        pricing_output_per_1m=0.3,
        model_family="llama",
    ),
    "qwen/qwen3.6-27b": ModelDetail(
        id="qwen/qwen3.6-27b",
        name="Qwen3.6 27B",
        description="Groq 托管的 Qwen3.6-27B 模型，131K 上下文。",
        vendor_id="groq",
        input_context_window=131_072,
        max_output_tokens=16_384,
        suggested_max_tokens=16_384,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        pricing_input_per_1m=0.6,
        pricing_output_per_1m=3,
        model_family="qwen3.6",
    ),
}


def register(target: dict[str, ModelDetail]) -> None:
    """Merge Groq models into the target repository dictionary."""
    target.update(MODELS)
