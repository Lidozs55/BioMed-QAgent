"""Mistral AI model data provider (OpenAI-compatible)."""

from __future__ import annotations

from app.model_info.schemas import ModelCapabilities, ModelDetail

MODELS: dict[str, ModelDetail] = {
    "mistral-large-latest": ModelDetail(
        id="mistral-large-latest",
        name="Mistral Large",
        description="Mistral 旗舰模型，256K 上下文，支持图像输入与工具调用。",
        vendor_id="mistral",
        input_context_window=262_144,
        max_output_tokens=16_384,
        suggested_max_tokens=16_384,
        capabilities=ModelCapabilities(text=True, image=True),
        pricing_input_per_1m=0.50,
        pricing_output_per_1m=1.50,
        recommended=True,
        model_family="mistral",
        function_calling=True,
        supports_streaming=True,
    ),
    "mistral-medium-latest": ModelDetail(
        id="mistral-medium-latest",
        name="Mistral Medium",
        description="Mistral 中端模型，256K 上下文，兼顾性能与成本。",
        vendor_id="mistral",
        input_context_window=262_144,
        max_output_tokens=8_192,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True, image=True),
        recommended=False,
        model_family="mistral",
        function_calling=True,
        supports_streaming=True,
    ),
}


def register(target: dict[str, ModelDetail]) -> None:
    """Merge Mistral models into the target repository dictionary."""
    target.update(MODELS)
