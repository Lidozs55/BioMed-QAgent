"""Baichuan model data provider."""

from __future__ import annotations

from app.model_info.schemas import ModelCapabilities, ModelDetail

MODELS: dict[str, ModelDetail] = {
    "baichuan4": ModelDetail(
        id="baichuan4",
        name="Baichuan4",
        description="百川智能旗舰模型，支持 32K 上下文。",
        vendor_id="baichuan",
        input_context_window=32_768,
        max_output_tokens=4_096,
        suggested_max_tokens=4_096,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        model_family="baichuan",
    ),
    "baichuan4-turbo": ModelDetail(
        id="baichuan4-turbo",
        name="Baichuan4 Turbo",
        description="百川智能 Baichuan4-Turbo 模型，32K 上下文。",
        vendor_id="baichuan",
        input_context_window=32_768,
        max_output_tokens=4_096,
        suggested_max_tokens=4_096,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        model_family="baichuan",
    ),
    "baichuan4-air": ModelDetail(
        id="baichuan4-air",
        name="Baichuan4 Air",
        description="百川智能 Baichuan4-Air 经济型模型，32K 上下文。",
        vendor_id="baichuan",
        input_context_window=32_768,
        max_output_tokens=4_096,
        suggested_max_tokens=4_096,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        model_family="baichuan",
    ),
    "baichuan3-turbo": ModelDetail(
        id="baichuan3-turbo",
        name="Baichuan3 Turbo",
        description="百川智能轻量快速模型，适合日常对话。",
        vendor_id="baichuan",
        input_context_window=32_768,
        max_output_tokens=4_096,
        suggested_max_tokens=4_096,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        model_family="baichuan",
    ),
    "baichuan3-turbo-128k": ModelDetail(
        id="baichuan3-turbo-128k",
        name="Baichuan3 Turbo 128K",
        description="百川智能 Baichuan3-Turbo 长上下文版本，128K。",
        vendor_id="baichuan",
        input_context_window=131_072,
        max_output_tokens=4_096,
        suggested_max_tokens=4_096,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        model_family="baichuan",
    ),
    "baichuan-m3-plus": ModelDetail(
        id="baichuan-m3-plus",
        name="Baichuan M3 Plus",
        description="百川智能当前主力模型，32K 上下文，自动触发医疗搜索。",
        vendor_id="baichuan",
        input_context_window=32_768,
        max_output_tokens=4_096,
        suggested_max_tokens=4_096,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        recommended=True,
        model_family="baichuan",
    ),
    "baichuan-m3": ModelDetail(
        id="baichuan-m3",
        name="Baichuan M3",
        description="百川智能 Baichuan-M3 模型，32K 上下文。",
        vendor_id="baichuan",
        input_context_window=32_768,
        max_output_tokens=4_096,
        suggested_max_tokens=4_096,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        model_family="baichuan",
    ),
}


def register(target: dict[str, ModelDetail]) -> None:
    """Merge Baichuan models into the target repository dictionary."""
    target.update(MODELS)
