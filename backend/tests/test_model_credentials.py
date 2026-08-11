from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import ANY, AsyncMock, Mock

import app.agent_loop.model as model_module
import app.config as config_module
import httpx
import pytest
from app.agent_loop.agent import create_agent
from app.agent_loop.model import (
    LazyDashScopeModel,
    ModelConfigurationError,
    require_model_credentials,
)
from app.model_config import AdvancedParams, RunModelSettings, UserSettings
from app.model_settings import AdvancedModelSettings, ModelConfiguration
from app.tools.network_safety import PublicHttpTarget, UnsafeUrlError


def configure_model(
    monkeypatch: pytest.MonkeyPatch,
    runtime_settings: UserSettings,
) -> Mock:
    frozen_config_settings = SimpleNamespace(
        dashscope_api_key="frozen-api-key",
        dashscope_base_url="https://frozen.example/v1",
        model_name="frozen-model",
    )
    monkeypatch.setattr(
        config_module,
        "settings",
        frozen_config_settings,
    )
    runtime_getter = Mock(return_value=runtime_settings)
    def current_configuration() -> ModelConfiguration:
        current = runtime_getter()
        return ModelConfiguration(
            base_url=current.base_url,
            api_key=current.api_key,
            model_name=current.model_name,
            max_tokens=current.max_tokens,
            context_window=current.context_window,
            safety_reserve_ratio=current.safety_reserve_ratio,
            compaction_trigger_ratio=current.compaction_trigger_ratio,
            compaction_target_ratio=current.compaction_target_ratio,
            advanced=AdvancedModelSettings(**current.advanced.model_dump()),
        )

    monkeypatch.setattr(model_module, "get_current_model_configuration", current_configuration)
    monkeypatch.setattr(
        model_module,
        "resolve_public_http_target",
        lambda url, *, require_https: PublicHttpTarget(
            connect_url=url,
            host_header="provider.example",
            sni_hostname="provider.example",
        ),
    )
    monkeypatch.setattr(model_module.httpx, "AsyncClient", Mock(return_value=object()))
    return runtime_getter


def test_agent_construction_succeeds_without_model_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_model(monkeypatch, UserSettings(api_key=""))

    agent = create_agent()

    assert isinstance(agent.model, LazyDashScopeModel)


def test_agent_receives_dashscope_generation_settings_from_run_snapshot() -> None:
    # Given
    run_settings = RunModelSettings.from_user_settings(
        UserSettings(
            api_key="run-api-key",
            base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
            model_name="qwq-32b",
            max_tokens=2048,
            advanced=AdvancedParams(
                temperature=0.15,
                top_p=0.55,
                repetition_penalty=1.2,
                enable_search=False,
                thinking_mode=True,
            ),
        )
    )

    # When
    agent = create_agent(model_settings=run_settings)

    # Then
    assert agent.model_settings.max_tokens == 2048
    assert agent.model_settings.temperature == 0.15
    assert agent.model_settings.top_p == 0.55
    assert agent.model_settings.extra_body == {
        "repetition_penalty": 1.2,
        "enable_search": False,
        "enable_thinking": True,
    }


def test_agent_omits_dashscope_only_settings_for_other_providers() -> None:
    # Given
    run_settings = RunModelSettings.from_user_settings(
        UserSettings(
            api_key="run-api-key",
            base_url="https://api.openai.com/v1",
            model_name="gpt-4.1-mini",
            context_window=65_536,
            advanced=AdvancedParams(
                repetition_penalty=1.2,
                enable_search=True,
                thinking_mode=True,
            ),
        )
    )

    # When
    agent = create_agent(model_settings=run_settings)

    # Then
    assert agent.model_settings.extra_body is None


def test_agent_omits_dashscope_only_settings_when_qwen_uses_other_provider() -> None:
    # Given
    run_settings = RunModelSettings.from_user_settings(
        UserSettings(
            api_key="run-api-key",
            base_url="https://api.example.com/v1",
            model_name="qwen-plus",
            advanced=AdvancedParams(
                repetition_penalty=1.2,
                enable_search=True,
                thinking_mode=True,
            ),
        )
    )

    # When
    agent = create_agent(model_settings=run_settings)

    # Then
    assert agent.model_settings.extra_body is None


def test_execution_guard_raises_stable_configuration_error_without_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_model(monkeypatch, UserSettings(api_key=""))

    with pytest.raises(ModelConfigurationError) as caught:
        require_model_credentials()

    assert caught.value.code == "configuration_error"
    assert "DASHSCOPE_API_KEY" in str(caught.value)


def test_lazy_model_first_use_raises_stable_error_without_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_model(monkeypatch, UserSettings(api_key=""))
    model = LazyDashScopeModel()

    with pytest.raises(ModelConfigurationError) as caught:
        model.stream_response("test")

    assert caught.value.code == "configuration_error"
    assert str(caught.value) == "DASHSCOPE_API_KEY is required to run the model"


def test_build_client_rejects_non_public_base_url_before_client_construction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    model_settings = RunModelSettings.from_user_settings(
        UserSettings(
            api_key="runtime-api-key",
            base_url="http://127.0.0.1/v1",
        )
    )
    client_factory = Mock(return_value=object())
    monkeypatch.setattr(model_module, "AsyncOpenAI", client_factory)
    monkeypatch.setattr(
        model_module,
        "OpenAIChatCompletionsModel",
        Mock(),
    )

    # When / Then
    with pytest.raises(UnsafeUrlError):
        model_module._build_client(model_settings)
    client_factory.assert_not_called()


def test_build_client_requires_https_for_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    model_settings = RunModelSettings.from_user_settings(
        UserSettings(
            api_key="runtime-api-key",
            base_url="http://8.8.8.8/v1",
        )
    )
    client_factory = Mock(return_value=object())
    monkeypatch.setattr(model_module, "AsyncOpenAI", client_factory)

    # When / Then
    with pytest.raises(UnsafeUrlError, match="HTTPS"):
        model_module._build_client(model_settings)
    client_factory.assert_not_called()


@pytest.mark.asyncio
async def test_build_client_pins_resolved_ip_and_preserves_host_and_sni(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    settings = RunModelSettings.from_user_settings(
        UserSettings(
            api_key="runtime-api-key",
            base_url="https://provider.example:8443/v1",
            context_window=65_536,
        )
    )
    target = PublicHttpTarget(
        connect_url="https://203.0.113.10:8443/v1",
        host_header="provider.example:8443",
        sni_hostname="provider.example",
    )
    resolver = Mock(return_value=target)
    monkeypatch.setattr(model_module, "resolve_public_http_target", resolver)
    observed: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        observed["url"] = str(request.url)
        observed["host"] = request.headers["host"]
        observed["sni"] = request.extensions.get("sni_hostname")
        return httpx.Response(200, json={"object": "list", "data": []})

    client = model_module.build_openai_client(settings)
    http_client = client._client  # noqa: SLF001 - verify owned transport policy
    await http_client._transport.aclose()  # noqa: SLF001
    http_client._transport = httpx.MockTransport(handler)  # noqa: SLF001
    try:
        await client.models.list()
    finally:
        await client.close()

    resolver.assert_called_once_with(
        "https://provider.example:8443/v1",
        require_https=True,
    )
    assert observed["url"] == "https://203.0.113.10:8443/v1/models"
    assert observed["host"] == "provider.example:8443"
    assert observed["sni"] == "provider.example"
    assert http_client.follow_redirects is False
    assert http_client.trust_env is False


@pytest.mark.asyncio
async def test_lazy_model_closes_owned_client_when_delegate_close_is_noop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    runtime_settings = UserSettings(
        api_key="runtime-api-key",
        base_url="https://runtime.example/v1",
        model_name="runtime-model",
        context_window=65_536,
    )
    configure_model(monkeypatch, runtime_settings)
    client = SimpleNamespace(close=AsyncMock())
    delegate = SimpleNamespace(
        get_response=AsyncMock(return_value="response"),
        stream_response=Mock(return_value="stream"),
        close=AsyncMock(),
    )
    client_factory = Mock(return_value=client)
    delegate_factory = Mock(return_value=delegate)
    monkeypatch.setattr(model_module, "AsyncOpenAI", client_factory)
    monkeypatch.setattr(
        model_module,
        "OpenAIChatCompletionsModel",
        delegate_factory,
    )
    model = LazyDashScopeModel()

    # When
    assert model.stream_response("one", option=True) == "stream"
    assert await model.get_response("two") == "response"
    await model.close()
    await model.close()

    # Then
    client_factory.assert_called_once_with(
        api_key="runtime-api-key",
        base_url="https://runtime.example/v1",
        http_client=ANY,
    )
    delegate_factory.assert_called_once_with(
        model="runtime-model",
        openai_client=client,
    )
    delegate.stream_response.assert_called_once_with("one", option=True)
    delegate.get_response.assert_awaited_once_with("two")
    client.close.assert_awaited_once_with()
    delegate.close.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_lazy_model_closes_owned_client_after_delegate_construction_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    runtime_settings = UserSettings(
        api_key="runtime-api-key",
        base_url="https://runtime.example/v1",
        model_name="runtime-model",
        context_window=65_536,
    )
    configure_model(monkeypatch, runtime_settings)
    client = SimpleNamespace(close=AsyncMock())
    monkeypatch.setattr(model_module, "AsyncOpenAI", Mock(return_value=client))
    monkeypatch.setattr(
        model_module,
        "OpenAIChatCompletionsModel",
        Mock(side_effect=RuntimeError("delegate construction failed")),
    )
    model = LazyDashScopeModel()

    # When
    with pytest.raises(RuntimeError, match="delegate construction failed"):
        model.stream_response("one")
    await model.close()

    # Then
    client.close.assert_awaited_once_with()


def test_lazy_model_uses_explicit_settings_snapshot_after_runtime_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    run_settings = UserSettings(
        api_key="run-api-key",
        base_url="https://run.example/v1",
        model_name="run-model",
        context_window=65_536,
    )
    updated_settings = UserSettings(
        api_key="updated-api-key",
        base_url="https://updated.example/v1",
        model_name="updated-model",
        context_window=65_536,
    )
    runtime_getter = configure_model(monkeypatch, updated_settings)
    client = object()
    client_factory = Mock(return_value=client)
    delegate_factory = Mock(return_value=Mock(stream_response=Mock(return_value="stream")))
    monkeypatch.setattr(model_module, "AsyncOpenAI", client_factory)
    monkeypatch.setattr(model_module, "OpenAIChatCompletionsModel", delegate_factory)
    model = LazyDashScopeModel(RunModelSettings.from_user_settings(run_settings))

    # When
    assert model.stream_response("first model call") == "stream"

    # Then
    runtime_getter.assert_not_called()
    client_factory.assert_called_once_with(
        api_key="run-api-key",
        base_url="https://run.example/v1",
        http_client=ANY,
    )
    delegate_factory.assert_called_once_with(
        model="run-model",
        openai_client=client,
    )


def test_lazy_model_keeps_its_first_runtime_settings_for_the_run(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initial_settings = UserSettings(
        api_key="first-api-key",
        base_url="https://first.example/v1",
        model_name="first-model",
        context_window=65_536,
    )
    updated_settings = UserSettings(
        api_key="second-api-key",
        base_url="https://second.example/v1",
        model_name="second-model",
        context_window=65_536,
    )
    runtime_getter = configure_model(monkeypatch, initial_settings)
    client_factory = Mock(return_value=object())
    delegate_factory = Mock(return_value=Mock(stream_response=Mock(return_value="stream")))
    monkeypatch.setattr(model_module, "AsyncOpenAI", client_factory)
    monkeypatch.setattr(model_module, "OpenAIChatCompletionsModel", delegate_factory)
    model = LazyDashScopeModel()

    assert model.stream_response("first") == "stream"
    runtime_getter.return_value = updated_settings

    assert model.stream_response("second") == "stream"

    client_factory.assert_called_once_with(
        api_key="first-api-key",
        base_url="https://first.example/v1",
        http_client=ANY,
    )
    delegate_factory.assert_called_once()
    runtime_getter.assert_called_once_with()


def test_fresh_lazy_model_uses_runtime_settings_persisted_between_runs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initial_settings = UserSettings(
        api_key="first-api-key",
        base_url="https://first.example/v1",
        model_name="first-model",
        context_window=65_536,
    )
    updated_settings = UserSettings(
        api_key="second-api-key",
        base_url="https://second.example/v1",
        model_name="second-model",
        context_window=65_536,
    )
    runtime_getter = configure_model(monkeypatch, initial_settings)
    client_factory = Mock(side_effect=[object(), object()])
    delegate_factory = Mock(
        side_effect=[
            Mock(stream_response=Mock(return_value="first-stream")),
            Mock(stream_response=Mock(return_value="second-stream")),
        ]
    )
    monkeypatch.setattr(model_module, "AsyncOpenAI", client_factory)
    monkeypatch.setattr(model_module, "OpenAIChatCompletionsModel", delegate_factory)

    assert LazyDashScopeModel().stream_response("first") == "first-stream"
    runtime_getter.return_value = updated_settings

    assert LazyDashScopeModel().stream_response("second") == "second-stream"

    assert client_factory.call_args_list == [
        (
            (),
            {
                "api_key": "first-api-key",
                "base_url": "https://first.example/v1",
                "http_client": ANY,
            },
        ),
        (
            (),
            {
                "api_key": "second-api-key",
                "base_url": "https://second.example/v1",
                "http_client": ANY,
            },
        ),
    ]
    assert delegate_factory.call_args_list[0].kwargs["model"] == "first-model"
    assert delegate_factory.call_args_list[1].kwargs["model"] == "second-model"


@pytest.mark.asyncio
async def test_model_error_response_body_is_logged_and_sdk_still_reads_it(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A 4xx model call must print the upstream error body (truncated).

    Regression for the 2026-08-05 incident: the DashScope-compatible
    endpoint answered ``HTTP/1.1 400 Bad Request`` on every task start,
    but the backend console only showed the httpx status line, hiding the
    real error detail (model id / parameter validation). The response hook
    must log the body's first characters, and must not break the OpenAI
    SDK, which still needs to read the same bytes for its error object.
    """
    import logging

    import openai

    settings = RunModelSettings.from_user_settings(
        UserSettings(
            api_key="runtime-api-key",
            base_url="https://provider.example/v1",
            model_name="qwen3.7-max-preview",
            context_window=65_536,
        )
    )
    target = PublicHttpTarget(
        connect_url="https://203.0.113.10/v1",
        host_header="provider.example",
        sni_hostname="provider.example",
    )
    monkeypatch.setattr(model_module, "resolve_public_http_target", Mock(return_value=target))
    error_body = {
        "error": {
            "message": "The model `qwen3.7-max-preview` does not exist or you do "
            "not have access to it.",
            "type": "invalid_request_error",
            "code": "model_not_found",
        }
    }

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, json=error_body, request=request)

    client = model_module.build_openai_client(settings)
    http_client = client._client  # noqa: SLF001 - inject the mocked transport
    await http_client._transport.aclose()  # noqa: SLF001
    http_client._transport = httpx.MockTransport(handler)  # noqa: SLF001
    try:
        with (
            caplog.at_level(logging.ERROR, logger="app.agent_loop.model"),
            pytest.raises(openai.BadRequestError, match="does not exist"),
        ):
            await client.chat.completions.create(
                model="qwen3.7-max-preview",
                messages=[{"role": "user", "content": "hi"}],
            )
    finally:
        await client.close()

    assert any(
        "model request failed: HTTP 400" in record.message
        and "model_not_found" in record.message
        for record in caplog.records
    )
