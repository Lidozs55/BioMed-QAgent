from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import app.agent_loop.vl_model as vl_model_module
import app.config as config_module
import app.settings_manager as settings_manager
import pytest
from app.agent_loop.vl_model import (
    VL_MODEL_NAME,
    call_vl_model,
    get_vl_client,
    reset_vl_client_for_tests,
)
from app.model_config import UserSettings


@pytest.fixture(autouse=True)
def reset_vl_client() -> Iterator[None]:
    reset_vl_client_for_tests()
    yield
    reset_vl_client_for_tests()


def configure_vl_client(
    monkeypatch: pytest.MonkeyPatch,
    runtime_settings: UserSettings,
) -> Mock:
    frozen_config_settings = SimpleNamespace(
        dashscope_api_key="frozen-api-key",
        dashscope_base_url="https://frozen.example/v1",
    )
    monkeypatch.setattr(
        config_module,
        "settings",
        frozen_config_settings,
    )
    runtime_getter = Mock(return_value=runtime_settings)
    monkeypatch.setattr(settings_manager, "get_settings", runtime_getter)
    return runtime_getter


def _make_client_with_close() -> Mock:
    """Return a Mock client whose ``close`` is an ``AsyncMock``."""
    client = Mock()
    client.close = AsyncMock()
    return client


@pytest.mark.asyncio
async def test_vl_client_reuses_singleton_when_runtime_credentials_are_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runtime_settings = UserSettings(
        api_key="runtime-api-key",
        base_url="https://runtime.example/v1",
    )
    configure_vl_client(monkeypatch, runtime_settings)
    client = _make_client_with_close()
    client_factory = Mock(return_value=client)
    monkeypatch.setattr(vl_model_module, "AsyncOpenAI", client_factory)

    assert await get_vl_client() is client
    assert await get_vl_client() is client

    client_factory.assert_called_once_with(
        api_key="runtime-api-key",
        base_url="https://runtime.example/v1",
    )


@pytest.mark.asyncio
async def test_vl_client_rebuilds_when_runtime_api_key_changes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initial_settings = UserSettings(
        api_key="first-api-key",
        base_url="https://runtime.example/v1",
    )
    updated_settings = initial_settings.model_copy(update={"api_key": "second-api-key"})
    runtime_getter = configure_vl_client(monkeypatch, initial_settings)
    first_client = _make_client_with_close()
    second_client = _make_client_with_close()
    first_client.close.side_effect = lambda: (
        vl_model_module._vl_client is first_client
    ) or pytest.fail("replacement was published before old client closed")
    client_factory = Mock(side_effect=[first_client, second_client])
    monkeypatch.setattr(vl_model_module, "AsyncOpenAI", client_factory)

    assert await get_vl_client() is first_client
    runtime_getter.return_value = updated_settings

    assert await get_vl_client() is second_client

    assert client_factory.call_args_list == [
        ((), {"api_key": "first-api-key", "base_url": "https://runtime.example/v1"}),
        ((), {"api_key": "second-api-key", "base_url": "https://runtime.example/v1"}),
    ]

    first_client.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_vl_client_rebuilds_when_runtime_base_url_changes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initial_settings = UserSettings(
        api_key="runtime-api-key",
        base_url="https://first.example/v1",
    )
    updated_settings = initial_settings.model_copy(
        update={"base_url": "https://second.example/v1"}
    )
    runtime_getter = configure_vl_client(monkeypatch, initial_settings)
    first_client = _make_client_with_close()
    second_client = _make_client_with_close()
    client_factory = Mock(side_effect=[first_client, second_client])
    monkeypatch.setattr(vl_model_module, "AsyncOpenAI", client_factory)

    assert await get_vl_client() is first_client
    runtime_getter.return_value = updated_settings

    assert await get_vl_client() is second_client

    assert client_factory.call_args_list == [
        ((), {"api_key": "runtime-api-key", "base_url": "https://first.example/v1"}),
        ((), {"api_key": "runtime-api-key", "base_url": "https://second.example/v1"}),
    ]

    first_client.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_vl_client_does_not_close_on_unchanged_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Verify that re-fetching with identical credentials does not call close."""
    runtime_settings = UserSettings(
        api_key="stable-key",
        base_url="https://stable.example/v1",
    )
    configure_vl_client(monkeypatch, runtime_settings)
    client = _make_client_with_close()
    monkeypatch.setattr(vl_model_module, "AsyncOpenAI", Mock(return_value=client))

    await get_vl_client()
    await get_vl_client()
    await get_vl_client()

    client.close.assert_not_awaited()
    client.close.assert_not_called()


@pytest.mark.asyncio
async def test_call_vl_model_uses_fixed_qwen_vl_max(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure_vl_client(
        monkeypatch,
        UserSettings(
            api_key="runtime-api-key",
            base_url="https://runtime.example/v1",
            model_name="user-selected-text-model",
        ),
    )
    completion = AsyncMock(
        return_value=SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="chart response"))]
        )
    )
    client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=completion))
    )
    monkeypatch.setattr(vl_model_module, "AsyncOpenAI", Mock(return_value=client))
    image_path = tmp_path / "chart.png"
    image_path.write_bytes(b"chart-bytes")

    assert await call_vl_model(image_path, "extract the chart") == "chart response"

    assert VL_MODEL_NAME == "qwen-vl-max"
    assert completion.await_args.kwargs["model"] == "qwen-vl-max"
