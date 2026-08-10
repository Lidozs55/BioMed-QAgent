"""Moonshot (Kimi) model data provider."""

from __future__ import annotations

from app.model_info.schemas import ModelCapabilities, ModelDetail

MODELS: dict[str, ModelDetail] = {
    "moonshot-v1-8k": ModelDetail(
        id="moonshot-v1-8k",
        name="Moonshot V1 8K",
        description="月之暗面 Kimi 模型，8K 上下文版本。",
        vendor_id="moonshot",
        input_context_window=8_192,
        max_output_tokens=4_096,
        suggested_max_tokens=4_096,
        capabilities=ModelCapabilities(text=True),
        model_family="moonshot-v1",
    ),
    "moonshot-v1-32k": ModelDetail(
        id="moonshot-v1-32k",
        name="Moonshot V1 32K",
        description="月之暗面 Kimi 模型，32K 上下文版本。",
        vendor_id="moonshot",
        input_context_window=32_768,
        max_output_tokens=8_192,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True),
        model_family="moonshot-v1",
    ),
    "moonshot-v1-128k": ModelDetail(
        id="moonshot-v1-128k",
        name="Moonshot V1 128K",
        description="月之暗面 Kimi 模型，128K 上下文版本，适合长文档分析。",
        vendor_id="moonshot",
        input_context_window=131_072,
        max_output_tokens=8_192,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True),
        model_family="moonshot-v1",
    ),
    # -- Kimi K3 --
    "kimi/kimi-k3": ModelDetail(
        id="kimi/kimi-k3",
        name="Kimi K3",
        description="月之暗面 Kimi K3 新一代模型，支持长上下文。",
        vendor_id="moonshot",
        input_context_window=1_048_576,
        max_output_tokens=131_072,
        suggested_max_tokens=32_768,
        capabilities=ModelCapabilities(text=True),
        knowledge_cutoff="2026-06",
        recommended=True,
        model_family="kimi",
    ),
    # -- Kimi K2.7 Code --
    "kimi-k2.7-code": ModelDetail(
        id="kimi-k2.7-code",
        name="Kimi K2.7 Code",
        description="月之暗面 Kimi K2.7 Code 编程模型，256K 上下文，始终思考。",
        vendor_id="moonshot",
        input_context_window=262_144,
        max_output_tokens=32_768,
        suggested_max_tokens=16_384,
        capabilities=ModelCapabilities(text=True, image=True),
        knowledge_cutoff="2026-05",
        recommended=True,
        model_family="kimi",
    ),
    # -- Kimi K2.6 --
    "kimi-k2.6": ModelDetail(
        id="kimi-k2.6",
        name="Kimi K2.6",
        description="月之暗面 Kimi K2.6 模型，256K 上下文，支持思考与非思考模式。",
        vendor_id="moonshot",
        input_context_window=262_144,
        max_output_tokens=32_768,
        suggested_max_tokens=16_384,
        capabilities=ModelCapabilities(text=True, image=True),
        knowledge_cutoff="2026-03",
        recommended=False,
        model_family="kimi",
    ),
}

def register(target: dict[str, ModelDetail]) -> None:
    """Merge Moonshot models into the target repository dictionary."""
    target.update(MODELS)
