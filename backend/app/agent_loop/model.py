"""Run-scoped OpenAI-compatible model adapter for the Agents SDK."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import replace
from typing import Any
from urllib.parse import urlsplit

from agents import ModelSettings, OpenAIChatCompletionsModel, set_tracing_disabled
from agents.models.interface import Model
from openai import AsyncOpenAI

from app.model_config import RunModelSettings
from app.model_config.context_budget import resolve_context_budget
from app.model_settings import (
    ModelConfiguration,
    calibration_margin_for,
    get_current_model_configuration,
)
from app.tools.network_safety import validate_credentialed_public_url

_run_model_settings: ContextVar[RunModelSettings | None] = ContextVar(
    "run_model_settings",
    default=None,
)


class ModelConfigurationError(RuntimeError):
    """Stable execution-boundary error for missing model configuration."""

    code = "configuration_error"


def to_run_model_settings(configuration: ModelConfiguration) -> RunModelSettings:
    """Convert the mutable-store snapshot into one immutable Run snapshot."""

    budget = resolve_context_budget(configuration)
    return RunModelSettings(
        base_url=str(configuration.base_url),
        api_key=configuration.api_key,
        model_name=configuration.model_name,
        max_tokens=configuration.max_tokens,
        temperature=configuration.advanced.temperature,
        top_p=configuration.advanced.top_p,
        repetition_penalty=configuration.advanced.repetition_penalty,
        enable_search=configuration.advanced.enable_search,
        thinking_mode=configuration.advanced.thinking_mode,
        context_budget=replace(
            budget,
            calibration_margin_tokens=calibration_margin_for(budget),
        ),
    )


def _resolve_model_settings(
    model_settings: RunModelSettings | ModelConfiguration | None,
) -> RunModelSettings:
    """Return an explicit Run snapshot or capture the current store once."""

    match model_settings:
        case RunModelSettings():
            return model_settings
        case ModelConfiguration():
            return to_run_model_settings(model_settings)
        case None:
            return to_run_model_settings(get_current_model_configuration())


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

    parsed_url = urlsplit(model_settings.base_url)
    return (
        model_settings.model_name.casefold().startswith(("qwen", "qwq"))
        and parsed_url.hostname == "dashscope.aliyuncs.com"
        and parsed_url.path.rstrip("/") == "/compatible-mode/v1"
    )


def require_model_credentials(
    model_settings: RunModelSettings | ModelConfiguration | None = None,
) -> None:
    """Validate credentials only when execution is about to call the model."""

    if not _resolve_model_settings(model_settings).api_key:
        raise ModelConfigurationError("DASHSCOPE_API_KEY is required to run the model")


def _build_client(model_settings: RunModelSettings) -> AsyncOpenAI:
    """Create one credentialed client for an already-resolved Run snapshot."""

    require_model_credentials(model_settings)
    return AsyncOpenAI(
        api_key=model_settings.api_key,
        base_url=validate_credentialed_public_url(model_settings.base_url),
    )


def _build_delegate(
    model_settings: RunModelSettings,
    client: AsyncOpenAI,
) -> OpenAIChatCompletionsModel:
    """Wrap the explicitly owned client in the Agents SDK model adapter."""

    return OpenAIChatCompletionsModel(
        model=model_settings.model_name,
        openai_client=client,
    )


class LazyDashScopeModel(Model):
    """Agents SDK model with an explicitly owned, lazily created client."""

    def __init__(self, model_settings: RunModelSettings | None = None) -> None:
        resolved_settings = _resolve_model_settings(model_settings)
        self._model_settings = resolved_settings
        self.model_settings = build_sdk_model_settings(resolved_settings)
        self._delegate: OpenAIChatCompletionsModel | None = None
        self._client_resources: tuple[RunModelSettings, AsyncOpenAI] | None = None

    def _get_delegate(self) -> OpenAIChatCompletionsModel:
        if self._delegate is None:
            client_resources = self._client_resources
            if client_resources is None:
                runtime_settings = _resolve_model_settings(self._model_settings)
                client_resources = (runtime_settings, _build_client(runtime_settings))
                self._client_resources = client_resources
            runtime_settings, client = client_resources
            self._delegate = _build_delegate(runtime_settings, client)
        return self._delegate

    async def get_response(self, *args: Any, **kwargs: Any) -> Any:
        return await self._get_delegate().get_response(*args, **kwargs)

    def stream_response(self, *args: Any, **kwargs: Any) -> Any:
        return self._get_delegate().stream_response(*args, **kwargs)

    async def close(self) -> None:
        """Release every owned resource exactly once."""

        delegate = self._delegate
        client_resources = self._client_resources
        self._delegate = None
        self._client_resources = None
        try:
            if delegate is not None:
                await delegate.close()
        finally:
            if client_resources is not None:
                _, client = client_resources
                await client.close()


@contextmanager
def run_model_settings_scope(model_settings: RunModelSettings) -> Iterator[None]:
    """Scope a Run snapshot to Agent construction without global mutation."""

    token = _run_model_settings.set(model_settings)
    try:
        yield
    finally:
        _run_model_settings.reset(token)


def get_model(
    model_settings: RunModelSettings | ModelConfiguration | None = None,
) -> LazyDashScopeModel:
    """Return a model adapter without constructing a credentialed client."""

    set_tracing_disabled(True)
    active_settings = model_settings or _run_model_settings.get()
    return LazyDashScopeModel(_resolve_model_settings(active_settings))
