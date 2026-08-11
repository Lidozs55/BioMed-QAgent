"""MiniMax model data provider."""

from __future__ import annotations

from app.model_info.schemas import ModelCapabilities, ModelDetail

MODELS: dict[str, ModelDetail] = {
    "MiniMax-M3": ModelDetail(
        id="MiniMax-M3",
        name="MiniMax M3",
        description="MiniMax M3 原生多模态模型，1M 上下文，面向 Agent 推理、工具调用与编码。",
        vendor_id="minimax",
        input_context_window=1_000_000,
        max_output_tokens=128_000,
        suggested_max_tokens=32_768,
        capabilities=ModelCapabilities(text=True, image=True, video=True, audio=False),
        pricing_input_per_1m=0.3,
        pricing_output_per_1m=1.2,
        recommended=True,
        model_family="minimax",
    ),
    "MiniMax-M2.7": ModelDetail(
        id="MiniMax-M2.7",
        name="MiniMax M2.7",
        description="MiniMax M2.7 语言模型，205K 上下文。",
        vendor_id="minimax",
        input_context_window=204_800,
        max_output_tokens=131_072,
        suggested_max_tokens=32_768,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=False),
        pricing_input_per_1m=0.3,
        pricing_output_per_1m=1.2,
        model_family="minimax",
    ),
    "MiniMax/speech-2.8-hd": ModelDetail(
        id="MiniMax/speech-2.8-hd",
        name="MiniMax Speech 2.8 HD",
        description="MiniMax 语音合成模型（DashScope 三方直供）。",
        vendor_id="minimax",
        input_context_window=1,
        max_output_tokens=1,
        suggested_max_tokens=1,
        capabilities=ModelCapabilities(text=True, image=False, video=False, audio=True),
        model_family="minimax",
    ),
}


def register(target: dict[str, ModelDetail]) -> None:
    """Merge MiniMax models into the target repository dictionary."""
    target.update(MODELS)
