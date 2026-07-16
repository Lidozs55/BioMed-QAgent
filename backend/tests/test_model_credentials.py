from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import app.agent_loop.model as model_module
import pytest
from app.agent_loop.agent import create_agent
from app.agent_loop.model import (
    LazyDashScopeModel,
    ModelConfigurationError,
    require_model_credentials,
)


def configure_model(monkeypatch: pytest.MonkeyPatch, api_key: str) -> None:
    monkeypatch.setattr(
        model_module,
        "settings",
        SimpleNamespace(
            dashscope_api_key=api_key,
            dashscope_base_url="https://example.test/v1",
            model_name="test-model",
        ),
    )


def test_agent_construction_succeeds_without_model_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_model(monkeypatch, "")

    agent = create_agent()

    assert isinstance(agent.model, LazyDashScopeModel)


def test_execution_guard_raises_stable_configuration_error_without_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_model(monkeypatch, "")

    with pytest.raises(ModelConfigurationError) as caught:
        require_model_credentials()

    assert caught.value.code == "configuration_error"
    assert "DASHSCOPE_API_KEY" in str(caught.value)


def test_lazy_model_first_use_raises_stable_error_without_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_model(monkeypatch, "")
    model = LazyDashScopeModel()

    with pytest.raises(ModelConfigurationError) as caught:
        model.stream_response("test")

    assert caught.value.code == "configuration_error"
    assert str(caught.value) == "DASHSCOPE_API_KEY is required to run the model"


@pytest.mark.asyncio
async def test_lazy_model_builds_reuses_and_closes_configured_delegate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_model(monkeypatch, "configured")
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
        api_key="configured",
        base_url="https://example.test/v1",
    )
    delegate_factory.assert_called_once_with(
        model="test-model",
        openai_client=client,
    )
    delegate.stream_response.assert_called_once_with("one", option=True)
    delegate.get_response.assert_awaited_once_with("two")
    delegate.close.assert_awaited_once_with()
