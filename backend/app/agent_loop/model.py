"""Lazy DashScope model adapter for the OpenAI Agents SDK."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

from agents import ModelSettings, OpenAIChatCompletionsModel, set_tracing_disabled
from agents.models.interface import Model
from openai import AsyncOpenAI

from app import settings_manager
from app.model_config import RunModelSettings, UserSettings
from app.tools.network_safety import validate_credentialed_public_url

_run_model_settings: ContextVar[RunModelSettings | None] = ContextVar(
    "run_model_settings",
    default=None,
)


class ModelConfigurationError(RuntimeError):
    """Stable execution-boundary error for missing model configuration."""

    code = "configuration_error"


def _resolve_model_settings(
    model_settings: RunModelSettings | UserSettings | None,
) -> RunModelSettings:
    """Return an explicit snapshot or resolve standalone runtime settings."""

    match model_settings:
        case RunModelSettings():
            return model_settings
        case UserSettings():
            return RunModelSettings.from_user_settings(model_settings)
        case None:
            return RunModelSettings.from_user_settings(settings_manager.get_settings())


def get_active_model_settings() -> RunModelSettings:
    """Return the scoped Run snapshot or one standalone runtime snapshot."""

    return _run_model_settings.get() or _resolve_model_settings(None)


def build_sdk_model_settings(model_settings: RunModelSettings) -> ModelSettings:
    """Translate one Run snapshot into Agents SDK request settings."""

    extra_body = (
        {
            "repetition_penalty": model_settings.repetition_penalty,
            "enable_search": model_settings.enable_search,
            "enable_thinking": model_settings.thinking_mode,
        }
        if _uses_dashscope_compatible_qwen(model_settings)
        else None
    )
    return ModelSettings(
        max_tokens=model_settings.max_tokens,
        temperature=model_settings.temperature,
        top_p=model_settings.top_p,
        extra_body=extra_body,
    )


def _uses_dashscope_compatible_qwen(model_settings: RunModelSettings) -> bool:
    """Return whether DashScope-only request fields are valid for this Run."""

    from urllib.parse import urlsplit

    model_name = model_settings.model_name.lower()
    parsed_url = urlsplit(model_settings.base_url)
    return (
        model_name.startswith(("qwen", "qwq"))
        and parsed_url.hostname == "dashscope.aliyuncs.com"
        and parsed_url.path.rstrip("/") == "/compatible-mode/v1"
    )


def require_model_credentials(
    model_settings: RunModelSettings | UserSettings | None = None,
) -> None:
    """Validate credentials only when execution is about to call the model."""

    active_settings = _resolve_model_settings(model_settings)
    if not active_settings.api_key:
        raise ModelConfigurationError(
            "DASHSCOPE_API_KEY is required to run the model"
        )


def _build_delegate(
    model_settings: RunModelSettings | UserSettings | None,
) -> OpenAIChatCompletionsModel:
    runtime_settings = _resolve_model_settings(model_settings)
    require_model_credentials(runtime_settings)
    base_url = validate_credentialed_public_url(runtime_settings.base_url)
    client = AsyncOpenAI(
        api_key=runtime_settings.api_key,
        base_url=base_url,
    )
    return OpenAIChatCompletionsModel(
        model=runtime_settings.model_name,
        openai_client=client,
    )


class LazyDashScopeModel(Model):
    """Agents SDK model that creates its HTTP client on first model call."""

    def __init__(self, model_settings: RunModelSettings | None = None) -> None:
        self._model_settings = model_settings
        self._delegate: OpenAIChatCompletionsModel | None = None

    def _get_delegate(self) -> OpenAIChatCompletionsModel:
        if self._delegate is None:
            self._delegate = _build_delegate(self._model_settings)
        return self._delegate

    async def get_response(self, *args: Any, **kwargs: Any) -> Any:
        return await self._get_delegate().get_response(*args, **kwargs)

    def stream_response(self, *args: Any, **kwargs: Any) -> Any:
        return self._get_delegate().stream_response(*args, **kwargs)

    async def close(self) -> None:
        if self._delegate is not None:
            await self._delegate.close()


@contextmanager
def run_model_settings_scope(model_settings: RunModelSettings) -> Iterator[None]:
    """Scope a Run snapshot to Agent construction without global mutation."""

    token = _run_model_settings.set(model_settings)
    try:
        yield
    finally:
        _run_model_settings.reset(token)


def get_model(
    model_settings: RunModelSettings | None = None,
) -> LazyDashScopeModel:
    """Return a model adapter without constructing a credentialed client."""

    set_tracing_disabled(True)
    active_settings = (
        model_settings if model_settings is not None else _run_model_settings.get()
    )
    return LazyDashScopeModel(active_settings)
