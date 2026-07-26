"""Baichuan model data provider."""

from __future__ import annotations

from app.model_info.schemas import ModelCapabilities, ModelDetail

MODELS: dict[str, ModelDetail] = {
    "baichuan4": ModelDetail(
        id="baichuan4",
        name="百川4",
        description="百川智能最新旗舰模型，支持 32K 上下文。",
        vendor_id="baichuan",
        input_context_window=32_768,
        max_output_tokens=4_096,
        suggested_max_tokens=4_096,
        capabilities=ModelCapabilities(text=True),
        recommended=True,
        model_family="baichuan",
    ),
    "baichuan3-turbo": ModelDetail(
        id="baichuan3-turbo",
        name="百川3 Turbo",
        description="百川智能轻量快速模型，适合日常对话。",
        vendor_id="baichuan",
        input_context_window=32_768,
        max_output_tokens=4_096,
        suggested_max_tokens=4_096,
        capabilities=ModelCapabilities(text=True),
        model_family="baichuan",
    ),
}


def register(target: dict[str, ModelDetail]) -> None:
    """Merge Baichuan models into the target repository dictionary."""
    target.update(MODELS)
