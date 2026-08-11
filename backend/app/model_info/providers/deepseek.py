"""DeepSeek model data provider."""

from __future__ import annotations

from app.model_info.schemas import ModelCapabilities, ModelDetail

MODELS: dict[str, ModelDetail] = {
    "deepseek-v4-flash": ModelDetail(
        id="deepseek-v4-flash",
        name="DeepSeek V4 Flash",
        description="DeepSeek V4 Flash 高速对话模型，1M 上下文，支持思考与非思考模式。",
        vendor_id="deepseek",
        input_context_window=1_000_000,
        max_output_tokens=384_000,
        suggested_max_tokens=32_768,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        pricing_input_per_1m=0.14,
        pricing_output_per_1m=0.28,
        recommended=True,
        model_family="deepseek",
    ),
    "deepseek-v4-pro": ModelDetail(
        id="deepseek-v4-pro",
        name="DeepSeek V4 Pro",
        description="DeepSeek V4 Pro 旗舰模型，1M 上下文，更强推理能力。",
        vendor_id="deepseek",
        input_context_window=1_000_000,
        max_output_tokens=384_000,
        suggested_max_tokens=32_768,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        pricing_input_per_1m=0.435,
        pricing_output_per_1m=0.87,
        model_family="deepseek",
    ),
    "deepseek-chat": ModelDetail(
        id="deepseek-chat",
        name="DeepSeek Chat",
        description="DeepSeek 对话模型别名（已于 2026-07-24 弃用，路由至 V4 Flash）。",
        vendor_id="deepseek",
        input_context_window=128_000,
        max_output_tokens=8_192,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        pricing_input_per_1m=0.14,
        pricing_output_per_1m=0.28,
        model_family="deepseek",
    ),
    "deepseek-reasoner": ModelDetail(
        id="deepseek-reasoner",
        name="DeepSeek Reasoner",
        description="DeepSeek 推理模型别名（已于 2026-07-24 弃用，路由至 V4 Flash 思考模式）。",
        vendor_id="deepseek",
        input_context_window=128_000,
        max_output_tokens=64_000,
        suggested_max_tokens=32_768,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        pricing_input_per_1m=0.14,
        pricing_output_per_1m=0.28,
        model_family="deepseek-r1",
    ),
    "deepseek-v3": ModelDetail(
        id="deepseek-v3",
        name="DeepSeek V3",
        description="DeepSeek V3 开源模型（中转站常用 ID）。",
        vendor_id="deepseek",
        input_context_window=164_000,
        max_output_tokens=16_384,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        pricing_input_per_1m=0.25,
        pricing_output_per_1m=1,
        model_family="deepseek",
    ),
    "deepseek-r1": ModelDetail(
        id="deepseek-r1",
        name="DeepSeek R1",
        description="DeepSeek R1 开源推理模型（中转站常用 ID）。",
        vendor_id="deepseek",
        input_context_window=164_000,
        max_output_tokens=16_384,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        pricing_input_per_1m=0.5,
        pricing_output_per_1m=2.18,
        model_family="deepseek-r1",
    ),
}


def register(target: dict[str, ModelDetail]) -> None:
    """Merge DeepSeek models into the target repository dictionary."""
    target.update(MODELS)
