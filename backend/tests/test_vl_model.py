from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, call

import app.agent_loop.vl_model as vl_model_module
import pytest
from app.agent_loop.vl_model import (
    VL_MODEL_NAME,
    ChartExtractionError,
    call_vl_model,
)
from app.model_config import RunModelSettings, UserSettings
from app.tools.network_safety import UnsafeUrlError
from openai import APIConnectionError


def _make_client_with_close() -> Mock:
    """Return a Mock client whose ``close`` is an ``AsyncMock``."""
    client = Mock()
    client.close = AsyncMock()
    return client


@pytest.mark.asyncio
async def test_call_vl_model_uses_run_credentials_fixed_model_and_closes_client(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Given
    run_settings = RunModelSettings.from_user_settings(
        UserSettings(
            api_key="runtime-api-key",
            base_url="https://runtime.example/v1",
            model_name="user-selected-text-model",
            context_window=65_536,
        )
    )
    completion = AsyncMock(
        return_value=SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="chart response"))]
        )
    )
    client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=completion)),
        close=AsyncMock(),
    )
    client_builder = Mock(return_value=client)
    monkeypatch.setattr(vl_model_module, "build_openai_client", client_builder)
    image_path = tmp_path / "chart.png"
    image_path.write_bytes(b"chart-bytes")

    # When
    result = await call_vl_model(
        image_path,
        "extract the chart",
        model_settings=run_settings,
    )

    # Then
    assert result == "chart response"
    assert VL_MODEL_NAME == "qwen-vl-max"
    assert completion.await_args.kwargs["model"] == "qwen-vl-max"
    assert completion.await_args.kwargs["temperature"] == 0.1
    client_builder.assert_called_once_with(run_settings)
    client.close.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_vl_calls_construct_distinct_clients_for_distinct_run_snapshots(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Given
    first_settings = RunModelSettings.from_user_settings(
        UserSettings(api_key="first-api-key", base_url="https://first.example/v1")
    )
    second_settings = RunModelSettings.from_user_settings(
        UserSettings(api_key="second-api-key", base_url="https://second.example/v1")
    )
    completion = AsyncMock(
        return_value=SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="chart response"))]
        )
    )
    first_client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=completion)),
        close=AsyncMock(),
    )
    second_client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=completion)),
        close=AsyncMock(),
    )
    client_builder = Mock(side_effect=[first_client, second_client])
    monkeypatch.setattr(vl_model_module, "build_openai_client", client_builder)
    image_path = tmp_path / "chart.png"
    image_path.write_bytes(b"chart-bytes")

    # When
    await call_vl_model(image_path, "first", model_settings=first_settings)
    await call_vl_model(image_path, "second", model_settings=second_settings)

    # Then
    assert client_builder.call_args_list == [call(first_settings), call(second_settings)]
    first_client.close.assert_awaited_once_with()
    second_client.close.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_vl_validates_base_url_before_client_construction(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Given
    run_settings = RunModelSettings.from_user_settings(
        UserSettings(api_key="runtime-api-key", base_url="https://invalid.example/v1")
    )
    client_builder = Mock(side_effect=UnsafeUrlError("unsafe URL"))
    monkeypatch.setattr(vl_model_module, "build_openai_client", client_builder)
    image_path = tmp_path / "chart.png"
    image_path.write_bytes(b"chart-bytes")

    # When / Then
    with pytest.raises(UnsafeUrlError, match="unsafe URL"):
        await call_vl_model(image_path, "extract", model_settings=run_settings)
    client_builder.assert_called_once_with(run_settings)


@pytest.mark.asyncio
async def test_vl_requires_https_for_credentials(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Given
    run_settings = RunModelSettings.from_user_settings(
        UserSettings(api_key="runtime-api-key", base_url="http://8.8.8.8/v1")
    )
    client_builder = Mock(side_effect=UnsafeUrlError("credentialed URL must use HTTPS"))
    monkeypatch.setattr(vl_model_module, "build_openai_client", client_builder)
    image_path = tmp_path / "chart.png"
    image_path.write_bytes(b"chart-bytes")

    # When / Then
    with pytest.raises(UnsafeUrlError, match="HTTPS"):
        await call_vl_model(image_path, "extract", model_settings=run_settings)
    client_builder.assert_called_once_with(run_settings)


@pytest.mark.asyncio
async def test_vl_call_closes_client_when_completion_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Given
    run_settings = RunModelSettings.from_user_settings(
        UserSettings(api_key="runtime-api-key", base_url="https://runtime.example/v1")
    )
    completion = AsyncMock(
        side_effect=APIConnectionError(
            message="provider failed",
            request=Mock(),
        )
    )
    client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=completion)),
        close=AsyncMock(),
    )
    monkeypatch.setattr(vl_model_module, "build_openai_client", Mock(return_value=client))
    image_path = tmp_path / "chart.png"
    image_path.write_bytes(b"chart-bytes")

    # When / Then
    with pytest.raises(ChartExtractionError, match="provider failed"):
        await call_vl_model(image_path, "extract", model_settings=run_settings)
    client.close.assert_awaited_once_with()


@pytest.mark.asyncio
async def test_vl_does_not_construct_client_when_image_encoding_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Given
    run_settings = RunModelSettings.from_user_settings(
        UserSettings(api_key="runtime-api-key", base_url="https://runtime.example/v1")
    )
    client_builder = Mock()
    monkeypatch.setattr(vl_model_module, "build_openai_client", client_builder)
    monkeypatch.setattr(
        vl_model_module,
        "_encode_image_b64",
        Mock(side_effect=ChartExtractionError("encoding failed")),
    )
    image_path = tmp_path / "chart.png"
    image_path.write_bytes(b"chart-bytes")

    # When / Then
    with pytest.raises(ChartExtractionError, match="encoding failed"):
        await call_vl_model(image_path, "extract", model_settings=run_settings)
    client_builder.assert_not_called()
