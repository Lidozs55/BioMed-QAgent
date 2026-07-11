"""模型适配 — DashScope (Qwen) 通过 OpenAI 兼容接口接入 openai-agents-python。

DashScope 提供 OpenAI 兼容的 Chat Completions 端点，因此使用
OpenAIChatCompletionsModel + AsyncOpenAI 客户端，无需第三方适配器。
"""
from __future__ import annotations

from openai import AsyncOpenAI
from agents import OpenAIChatCompletionsModel, set_tracing_disabled

from app.config import settings


def _build_client() -> AsyncOpenAI:
    return AsyncOpenAI(
        api_key=settings.dashscope_api_key,
        base_url=settings.dashscope_base_url,
    )


def get_model() -> OpenAIChatCompletionsModel:
    """构造 DashScope 兼容的 Model 实例。

    关闭内置 tracing（需 OpenAI 平台 key），后续可接入自定义 tracing processor。
    """
    if not settings.dashscope_api_key:
        # 允许无 key 启动（便于前端骨架联调），实际 Agent 运行时会报错
        pass
    set_tracing_disabled(True)
    client = _build_client()
    return OpenAIChatCompletionsModel(
        model=settings.model_name,
        openai_client=client,
    )
