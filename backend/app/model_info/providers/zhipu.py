"""ZhipuAI (GLM) model data provider."""

from __future__ import annotations

from app.model_info.schemas import ModelCapabilities, ModelDetail

MODELS: dict[str, ModelDetail] = {
    "glm-4-plus": ModelDetail(
        id="glm-4-plus",
        name="GLM-4 Plus",
        description="智谱 AI GLM-4 旗舰模型，支持 128K 上下文。",
        vendor_id="zhipu",
        input_context_window=128_000,
        max_output_tokens=8_192,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True),
        recommended=True,
        model_family="glm-4",
    ),
    "glm-4-flash": ModelDetail(
        id="glm-4-flash",
        name="GLM-4 Flash",
        description="智谱 AI GLM-4 轻量快速模型，响应速度快。",
        vendor_id="zhipu",
        input_context_window=128_000,
        max_output_tokens=4_096,
        suggested_max_tokens=4_096,
        capabilities=ModelCapabilities(text=True),
        model_family="glm-4",
    ),
    "glm-4v-plus": ModelDetail(
        id="glm-4v-plus",
        name="GLM-4V Plus",
        description="智谱 AI GLM-4V 多模态模型，支持图片理解。",
        vendor_id="zhipu",
        input_context_window=128_000,
        max_output_tokens=4_096,
        suggested_max_tokens=4_096,
        capabilities=ModelCapabilities(text=True, image=True),
        model_family="glm-4v",
    ),
    # -- GLM-5.2 --
    "glm-5.2": ModelDetail(
        id="glm-5.2",
        name="GLM-5.2",
        description="智谱 AI GLM-5.2 旗舰模型，支持 128K 上下文与图像理解。",
        vendor_id="zhipu",
        input_context_window=128_000,
        max_output_tokens=8_192,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True, image=True),
        knowledge_cutoff="2026-06",
        recommended=True,
        model_family="glm-4",
    ),
}

def register(target: dict[str, ModelDetail]) -> None:
    """Merge ZhipuAI models into the target repository dictionary."""
    target.update(MODELS)
