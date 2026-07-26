"""MiniMax model data provider."""

from __future__ import annotations

from app.model_info.schemas import ModelCapabilities, ModelDetail

MODELS: dict[str, ModelDetail] = {
    "MiniMax-M3": ModelDetail(
        id="MiniMax-M3",
        name="MiniMax M3",
        description="MiniMax M3 文本模型，支持长上下文。",
        vendor_id="minimax",
        input_context_window=128_000,
        max_output_tokens=16_384,
        suggested_max_tokens=16_384,
        capabilities=ModelCapabilities(text=True),
        knowledge_cutoff="2026-06",
        recommended=True,
        model_family="minimax",
    ),
    "MiniMax/speech-2.8-hd": ModelDetail(
        id="MiniMax/speech-2.8-hd",
        name="MiniMax Speech 2.8 HD",
        description="MiniMax 语音合成模型。",
        vendor_id="minimax",
        input_context_window=1,
        max_output_tokens=1,
        suggested_max_tokens=1,
        capabilities=ModelCapabilities(text=True, audio=True),
        knowledge_cutoff="2026-06",
        model_family="minimax",
    ),
}

def register(target: dict[str, ModelDetail]) -> None:
    """Merge MiniMax models into the target repository dictionary."""
    target.update(MODELS)
