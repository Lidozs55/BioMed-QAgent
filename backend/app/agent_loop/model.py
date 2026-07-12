"""Lazy DashScope model adapter for the OpenAI Agents SDK."""

from __future__ import annotations

from typing import Any

from agents import OpenAIChatCompletionsModel, set_tracing_disabled
from agents.models.interface import Model
from openai import AsyncOpenAI

from app.config import settings


class ModelConfigurationError(RuntimeError):
    """Stable execution-boundary error for missing model configuration."""

    code = "configuration_error"


def require_model_credentials() -> None:
    """Validate credentials only when execution is about to call the model."""

    if not settings.dashscope_api_key:
        raise ModelConfigurationError(
            "DASHSCOPE_API_KEY is required to run the model"
        )


def _build_delegate() -> OpenAIChatCompletionsModel:
    require_model_credentials()
    client = AsyncOpenAI(
        api_key=settings.dashscope_api_key,
        base_url=settings.dashscope_base_url,
    )
    return OpenAIChatCompletionsModel(
        model=settings.model_name,
        openai_client=client,
    )


class LazyDashScopeModel(Model):
    """Agents SDK model that creates its HTTP client on first model call."""

    def __init__(self) -> None:
        self._delegate: OpenAIChatCompletionsModel | None = None

    def _get_delegate(self) -> OpenAIChatCompletionsModel:
        if self._delegate is None:
            self._delegate = _build_delegate()
        return self._delegate

    async def get_response(self, *args: Any, **kwargs: Any) -> Any:
        return await self._get_delegate().get_response(*args, **kwargs)

    def stream_response(self, *args: Any, **kwargs: Any) -> Any:
        return self._get_delegate().stream_response(*args, **kwargs)

    async def close(self) -> None:
        if self._delegate is not None:
            await self._delegate.close()


def get_model() -> LazyDashScopeModel:
    """Return a model adapter without constructing a credentialed client."""

    set_tracing_disabled(True)
    return LazyDashScopeModel()
