"""xAI (Grok) model data provider."""

from __future__ import annotations

from app.model_info.schemas import ModelCapabilities, ModelDetail

MODELS: dict[str, ModelDetail] = {
    "grok-4.5": ModelDetail(
        id="grok-4.5",
        name="Grok 4.5",
        description="xAI Grok 4.5 旗舰模型，500K 上下文，始终推理（可调强度），支持图像输入。",
        vendor_id="xai",
        input_context_window=500_000,
        max_output_tokens=131_072,
        suggested_max_tokens=32_768,
        capabilities=ModelCapabilities(text=True, image=True),
        knowledge_cutoff="2026-06",
        pricing_input_per_1m=2.00,
        pricing_output_per_1m=6.00,
        recommended=True,
        model_family="grok",
        function_calling=True,
        supports_streaming=True,
    ),
}


def register(target: dict[str, ModelDetail]) -> None:
    """Merge xAI models into the target repository dictionary."""
    target.update(MODELS)
