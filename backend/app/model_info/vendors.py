"""OpenAI-compatible vendor quick-select data and helpers.

Single source of truth for the vendor list served by ``GET /api/v1/vendors``.
Relocated from ``app.model_config.vendors`` (which was dead code) so the vendor
catalog lives alongside the rest of the model-info warehouse.
"""

from __future__ import annotations

from pydantic import BaseModel


class Vendor(BaseModel):
    id: str
    name: str
    base_url: str
    description: str
    recommended: bool = False


VENDORS: list[Vendor] = [
    Vendor(
        id="dashscope",
        name="DashScope",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        description="阿里云 Qwen 官方 API",
        recommended=True,
    ),
    Vendor(
        id="openai",
        name="OpenAI",
        base_url="https://api.openai.com/v1",
        description="OpenAI 官方 API",
    ),
    Vendor(
        id="deepseek",
        name="DeepSeek",
        base_url="https://api.deepseek.com/v1",
        description="DeepSeek 系列模型 API",
    ),
    Vendor(
        id="siliconflow",
        name="SiliconFlow",
        base_url="https://api.siliconflow.cn/v1",
        description="硅基流动，聚合多种模型",
    ),
    Vendor(
        id="moonshot",
        name="Moonshot",
        base_url="https://api.moonshot.cn/v1",
        description="月之暗面 Kimi API",
    ),
    Vendor(
        id="zhipu",
        name="ZhipuAI",
        base_url="https://open.bigmodel.cn/api/paas/v4",
        description="智谱 AI GLM 系列 API",
    ),
    Vendor(
        id="baichuan",
        name="Baichuan",
        base_url="https://api.baichuan-ai.com/v1",
        description="百川智能 API",
    ),
    Vendor(
        id="groq",
        name="Groq",
        base_url="https://api.groq.com/openai/v1",
        description="Groq 高速推理 API，提供 Llama 等开源模型",
    ),
    Vendor(
        id="xai",
        name="xAI",
        base_url="https://api.x.ai/v1",
        description="xAI Grok 系列模型 API",
    ),
    Vendor(
        id="mistral",
        name="Mistral AI",
        base_url="https://api.mistral.ai/v1",
        description="Mistral 官方 API",
    ),
]


def list_vendors() -> list[dict[str, str | bool]]:
    """Return built-in vendors as API-ready mappings."""
    return [
        {
            "id": vendor.id,
            "name": vendor.name,
            "base_url": vendor.base_url,
            "description": vendor.description,
            "recommended": vendor.recommended,
        }
        for vendor in VENDORS
    ]
