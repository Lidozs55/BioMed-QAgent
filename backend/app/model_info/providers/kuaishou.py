"""Kuaishou/HappyHorse video model data provider."""

from __future__ import annotations

from app.model_info.schemas import ModelCapabilities, ModelDetail

MODELS: dict[str, ModelDetail] = {
    "happyhorse-1.0-video-edit": ModelDetail(
        id="happyhorse-1.0-video-edit",
        name="HappyHorse 1.0 Video Edit",
        description="快手可灵 AI 视频编辑模型。",
        vendor_id="kuaishou",
        input_context_window=1,
        max_output_tokens=1,
        suggested_max_tokens=1,
        capabilities=ModelCapabilities(text=True, image=False, video=True, audio=False),
        model_family="happyhorse",
    ),
    "happyhorse-1.1-i2v": ModelDetail(
        id="happyhorse-1.1-i2v",
        name="HappyHorse 1.1 I2V",
        description="快手可灵 1.1 图生视频模型。",
        vendor_id="kuaishou",
        input_context_window=1,
        max_output_tokens=1,
        suggested_max_tokens=1,
        capabilities=ModelCapabilities(text=True, image=True, video=True, audio=False),
        model_family="happyhorse",
    ),
    "happyhorse-1.1-r2v": ModelDetail(
        id="happyhorse-1.1-r2v",
        name="HappyHorse 1.1 R2V",
        description="快手可灵 1.1 参考视频生成模型。",
        vendor_id="kuaishou",
        input_context_window=1,
        max_output_tokens=1,
        suggested_max_tokens=1,
        capabilities=ModelCapabilities(text=True, image=False, video=True, audio=False),
        model_family="happyhorse",
    ),
    "happyhorse-1.1-t2v": ModelDetail(
        id="happyhorse-1.1-t2v",
        name="HappyHorse 1.1 T2V",
        description="快手可灵 1.1 文生视频模型。",
        vendor_id="kuaishou",
        input_context_window=1,
        max_output_tokens=1,
        suggested_max_tokens=1,
        capabilities=ModelCapabilities(text=True, image=False, video=True, audio=False),
        model_family="happyhorse",
    ),
    "mimo-v2.5-pro": ModelDetail(
        id="mimo-v2.5-pro",
        name="Xiaomi MiMo 2.5 Pro",
        description="小米 MiMo 2.5 Pro 视频生成模型（DashScope 三方直供）。",
        vendor_id="kuaishou",
        input_context_window=1,
        max_output_tokens=1,
        suggested_max_tokens=1,
        capabilities=ModelCapabilities(text=True, image=False, video=True, audio=False),
        model_family="mimo",
    ),
}


def register(target: dict[str, ModelDetail]) -> None:
    """Merge Kuaishou/HappyHorse video models into the target repository dictionary."""
    target.update(MODELS)
