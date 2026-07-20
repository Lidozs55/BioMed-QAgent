from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import app.agent_loop.model as model_module
import app.config as config_module
import app.settings_manager as settings_manager
import pytest
from app.agent_loop.agent import create_agent
from app.agent_loop.model import (
    LazyDashScopeModel,
    ModelConfigurationError,
    require_model_credentials,
)
from app.model_config import RunModelSettings, UserSettings


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
    monkeypatch.setattr(settings_manager, "get_settings", runtime_getter)
    return runtime_getter


def test_agent_construction_succeeds_without_model_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_model(monkeypatch, UserSettings(api_key=""))

    agent = create_agent()

    assert isinstance(agent.model, LazyDashScopeModel)


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


@pytest.mark.asyncio
async def test_lazy_model_builds_reuses_and_closes_configured_delegate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime_settings = UserSettings(
        api_key="runtime-api-key",
        base_url="https://runtime.example/v1",
        model_name="runtime-model",
    )
    configure_model(monkeypatch, runtime_settings)
    client = object()
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

    assert model.stream_response("one", option=True) == "stream"
    assert await model.get_response("two") == "response"
    await model.close()

    client_factory.assert_called_once_with(
        api_key="runtime-api-key",
        base_url="https://runtime.example/v1",
    )
    delegate_factory.assert_called_once_with(
        model="runtime-model",
        openai_client=client,
    )
    delegate.stream_response.assert_called_once_with("one", option=True)
    delegate.get_response.assert_awaited_once_with("two")
    delegate.close.assert_awaited_once_with()


def test_lazy_model_uses_explicit_settings_snapshot_after_runtime_change(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    run_settings = UserSettings(
        api_key="run-api-key",
        base_url="https://run.example/v1",
        model_name="run-model",
    )
    updated_settings = UserSettings(
        api_key="updated-api-key",
        base_url="https://updated.example/v1",
        model_name="updated-model",
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
    )
    updated_settings = UserSettings(
        api_key="second-api-key",
        base_url="https://second.example/v1",
        model_name="second-model",
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
    )
    updated_settings = UserSettings(
        api_key="second-api-key",
        base_url="https://second.example/v1",
        model_name="second-model",
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
        ((), {"api_key": "first-api-key", "base_url": "https://first.example/v1"}),
        ((), {"api_key": "second-api-key", "base_url": "https://second.example/v1"}),
    ]
    assert delegate_factory.call_args_list[0].kwargs["model"] == "first-model"
    assert delegate_factory.call_args_list[1].kwargs["model"] == "second-model"
