"""DeepSeek model data provider."""

from __future__ import annotations

from app.model_info.schemas import ModelCapabilities, ModelDetail

MODELS: dict[str, ModelDetail] = {
    "deepseek-chat": ModelDetail(
        id="deepseek-chat",
        name="DeepSeek Chat",
        description="DeepSeek V4 对话模型，支持 1M 上下文窗口。",
        vendor_id="deepseek",
        input_context_window=1_000_000,
        max_output_tokens=8_192,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True),
        knowledge_cutoff="2025-05",
        pricing_input_per_1m=0.27,
        pricing_output_per_1m=1.10,
        recommended=True,
        model_family="deepseek",
    ),
    "deepseek-reasoner": ModelDetail(
        id="deepseek-reasoner",
        name="DeepSeek Reasoner",
        description="DeepSeek R1 推理模型，擅长复杂推理任务。",
        vendor_id="deepseek",
        input_context_window=1_000_000,
        max_output_tokens=8_192,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True),
        knowledge_cutoff="2025-05",
        pricing_input_per_1m=0.55,
        pricing_output_per_1m=2.19,
        model_family="deepseek-r1",
    ),
    "deepseek-v3": ModelDetail(
        id="deepseek-v3",
        name="DeepSeek V3",
        description="DeepSeek V3 对话模型，支持 1M 上下文窗口。",
        vendor_id="deepseek",
        input_context_window=1_000_000,
        max_output_tokens=8_192,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True),
        knowledge_cutoff="2025-05",
        pricing_input_per_1m=0.27,
        pricing_output_per_1m=1.10,
        model_family="deepseek",
    ),
    "deepseek-r1": ModelDetail(
        id="deepseek-r1",
        name="DeepSeek R1",
        description="DeepSeek R1 推理模型，擅长复杂数学、逻辑推理。",
        vendor_id="deepseek",
        input_context_window=1_000_000,
        max_output_tokens=8_192,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True),
        knowledge_cutoff="2025-05",
        pricing_input_per_1m=0.55,
        pricing_output_per_1m=2.19,
        model_family="deepseek-r1",
    ),

    # --- DeepSeek V4 Series (2026) ---
    "deepseek-v4-flash": ModelDetail(
        id="deepseek-v4-flash",
        name="DeepSeek V4 Flash",
        description="DeepSeek V4 high-speed chat model, 1M context window.",
        vendor_id="deepseek",
        input_context_window=1_000_000,
        max_output_tokens=8_192,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True),
        knowledge_cutoff="2026-06",
        pricing_input_per_1m=0.20,
        pricing_output_per_1m=0.80,
        recommended=True,
        model_family="deepseek",
    ),
    "deepseek-v4-pro": ModelDetail(
        id="deepseek-v4-pro",
        name="DeepSeek V4 Pro",
        description="DeepSeek V4 professional edition, stronger reasoning, 1M context.",
        vendor_id="deepseek",
        input_context_window=1_000_000,
        max_output_tokens=8_192,
        suggested_max_tokens=8_192,
        capabilities=ModelCapabilities(text=True),
        knowledge_cutoff="2026-06",
        pricing_input_per_1m=0.50,
        pricing_output_per_1m=2.00,
        model_family="deepseek",
    ),

}


def register(target: dict[str, ModelDetail]) -> None:
    """Merge DeepSeek models into the target repository dictionary."""
    target.update(MODELS)


