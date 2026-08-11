"""Mistral AI model data provider."""

from __future__ import annotations

from app.model_info.schemas import ModelCapabilities, ModelDetail

MODELS: dict[str, ModelDetail] = {
    "mistral-large-latest": ModelDetail(
        id="mistral-large-latest",
        name="Mistral Large",
        description="Mistral Large 3 旗舰模型，262K 上下文，开源多模态。",
        vendor_id="mistral",
        input_context_window=262_144,
        max_output_tokens=262_144,
        suggested_max_tokens=32_768,
        capabilities=ModelCapabilities(text=True, image=True, video=False, audio=False),
        pricing_input_per_1m=0.5,
        pricing_output_per_1m=1.5,
        recommended=True,
        model_family="mistral",
    ),
    "mistral-medium-latest": ModelDetail(
        id="mistral-medium-latest",
        name="Mistral Medium",
        description="Mistral Medium 3.5 前沿多模态模型，262K 上下文。",
        vendor_id="mistral",
        input_context_window=262_144,
        max_output_tokens=262_144,
        suggested_max_tokens=32_768,
        capabilities=ModelCapabilities(text=True, image=True, video=False, audio=False),
        pricing_input_per_1m=1.5,
        pricing_output_per_1m=7.5,
        model_family="mistral",
    ),
    "mistral-small-latest": ModelDetail(
        id="mistral-small-latest",
        name="Mistral Small",
        description="Mistral Small 4 混合模型，256K 上下文，统一指令、推理与编码。",
        vendor_id="mistral",
        input_context_window=256_000,
        max_output_tokens=256_000,
        suggested_max_tokens=32_768,
        capabilities=ModelCapabilities(text=True, image=True, video=False, audio=False),
        pricing_input_per_1m=0.15,
        pricing_output_per_1m=0.6,
        model_family="mistral",
    ),
}


def register(target: dict[str, ModelDetail]) -> None:
    """Merge Mistral AI models into the target repository dictionary."""
    target.update(MODELS)
