"""Lazy DashScope model adapter for the OpenAI Agents SDK."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlsplit

from agents import ModelSettings, OpenAIChatCompletionsModel, set_tracing_disabled
from agents.models.interface import Model
from openai import AsyncOpenAI

from app.config import settings
from app.model_settings import ModelConfiguration, get_current_model_configuration


class ModelConfigurationError(RuntimeError):
    """Stable execution-boundary error for missing model configuration."""

    code = "configuration_error"


def _environment_configuration() -> ModelConfiguration:
    return ModelConfiguration(
        base_url=settings.dashscope_base_url,
        api_key=settings.dashscope_api_key,
        model_name=settings.model_name,
    )


def require_model_credentials(
    configuration: ModelConfiguration | None = None,
) -> None:
    """Validate credentials only when execution is about to call the model."""

    if not (configuration or _environment_configuration()).api_key:
        raise ModelConfigurationError(
            "DASHSCOPE_API_KEY is required to run the model"
        )


def _build_delegate(configuration: ModelConfiguration) -> OpenAIChatCompletionsModel:
    require_model_credentials(configuration)
    client = AsyncOpenAI(
        api_key=configuration.api_key,
        base_url=str(configuration.base_url),
    )
    return OpenAIChatCompletionsModel(
        model=configuration.model_name,
        openai_client=client,
    )


class LazyDashScopeModel(Model):
    """Agents SDK model that creates its HTTP client on first model call."""

    def __init__(self, configuration: ModelConfiguration | None = None) -> None:
        self.configuration = configuration or _environment_configuration()
        advanced = self.configuration.advanced
        extra_body: dict[str, Any] | None = None
        hostname = urlsplit(str(self.configuration.base_url)).hostname or ""
        model_name = self.configuration.model_name.casefold()
        explicit_standard_hosts = {
            "api.openai.com",
            "api.deepseek.com",
            "api.moonshot.cn",
        }
        if (
            hostname == "dashscope.aliyuncs.com"
            or hostname.endswith(".dashscope.aliyuncs.com")
            or (
                model_name.startswith(("qwen", "qwq"))
                and hostname not in explicit_standard_hosts
            )
        ):
            extra_body = {
                "repetition_penalty": advanced.repetition_penalty,
                "enable_search": advanced.enable_search,
                "enable_thinking": advanced.thinking_mode,
            }
        self.model_settings = ModelSettings(
            max_tokens=self.configuration.max_tokens,
            temperature=advanced.temperature,
            top_p=advanced.top_p,
            extra_body=extra_body,
        )
        self._delegate: OpenAIChatCompletionsModel | None = None

    def _get_delegate(self) -> OpenAIChatCompletionsModel:
        if self._delegate is None:
            self._delegate = _build_delegate(self.configuration)
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
    return LazyDashScopeModel(get_current_model_configuration())
