"""Run-scoped OpenAI-compatible model adapter for the Agents SDK."""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import replace
from typing import Any
from urllib.parse import urlsplit

import httpx
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
from app.tools.network_safety import resolve_public_http_target

logger = logging.getLogger(__name__)

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
        runtime_limits=configuration.runtime_limits,
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

    extra_body = None
    if _uses_dashscope_compatible_qwen(model_settings):
        extra_body = {
            "repetition_penalty": model_settings.repetition_penalty,
            "enable_search": model_settings.enable_search,
        }
        if model_settings.thinking_mode:
            # DashScope restricts enable_thinking to True and rejects
            # enable_thinking=False with HTTP 400 InvalidParameter. When
            # thinking is off, omit the field so the endpoint's default
            # (thinking disabled) applies.
            extra_body["enable_thinking"] = True
    return ModelSettings(
        max_tokens=model_settings.max_tokens,
        temperature=model_settings.temperature,
        top_p=model_settings.top_p,
        include_usage=True,
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


_MODEL_ERROR_BODY_SNIPPET = 500


async def _log_model_error_response(response: httpx.Response) -> None:
    """Surface the upstream error body (truncated) for failed model calls.

    The OpenAI SDK collapses non-2xx responses into a generic
    ``APIError``; the DashScope-compatible endpoint usually returns a
    JSON error detail (invalid model id, unsupported parameter, quota,
    ...) that would otherwise never reach the backend console. This
    hook logs the first ``_MODEL_ERROR_BODY_SNIPPET`` characters of the
    body so the root cause is visible without extra tooling. ``aread``
    caches the bytes, so the SDK can still read them afterwards.
    """
    if response.status_code < 400:
        return
    try:
        body = await response.aread()
    except Exception:  # noqa: BLE001 — a logging hook must never break the call
        body = b""
    snippet = body[:_MODEL_ERROR_BODY_SNIPPET].decode("utf-8", errors="replace")
    logger.error(
        "model request failed: HTTP %s %s body=%s",
        response.status_code,
        response.url,
        snippet or "<empty body>",
    )


def build_openai_client(
    model_settings: RunModelSettings,
    *,
    max_retries: int | None = None,
) -> AsyncOpenAI:
    """Build a credentialed client pinned to one validated public IP."""

    require_model_credentials(model_settings)
    target = resolve_public_http_target(
        model_settings.base_url,
        require_https=True,
    )

    async def pin_original_authority(request: httpx.Request) -> None:
        request.headers["Host"] = target.host_header
        request.extensions["sni_hostname"] = target.sni_hostname

    http_client = httpx.AsyncClient(
        follow_redirects=False,
        trust_env=False,
        event_hooks={
            "request": [pin_original_authority],
            "response": [_log_model_error_response],
        },
    )
    options: dict[str, Any] = {
        "api_key": model_settings.api_key,
        "base_url": target.connect_url,
        "http_client": http_client,
    }
    if max_retries is not None:
        options["max_retries"] = max_retries
    return AsyncOpenAI(**options)


def _build_client(model_settings: RunModelSettings) -> AsyncOpenAI:
    """Create one credentialed client for an already-resolved Run snapshot."""

    return build_openai_client(
        model_settings,
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
