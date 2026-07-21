from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

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
        )
    )
    validated_url = "https://validated.example/v1"
    url_validator = Mock(return_value=validated_url)
    monkeypatch.setattr(vl_model_module, "validate_credentialed_public_url", url_validator)
    completion = AsyncMock(
        return_value=SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content="chart response"))]
        )
    )
    client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=completion)),
        close=AsyncMock(),
    )
    client_factory = Mock(return_value=client)
    monkeypatch.setattr(vl_model_module, "AsyncOpenAI", client_factory)
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
    url_validator.assert_called_once_with("https://runtime.example/v1")
    client_factory.assert_called_once_with(
        api_key="runtime-api-key",
        base_url=validated_url,
    )
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
    monkeypatch.setattr(vl_model_module, "validate_credentialed_public_url", lambda url: url)
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
    client_factory = Mock(side_effect=[first_client, second_client])
    monkeypatch.setattr(vl_model_module, "AsyncOpenAI", client_factory)
    image_path = tmp_path / "chart.png"
    image_path.write_bytes(b"chart-bytes")

    # When
    await call_vl_model(image_path, "first", model_settings=first_settings)
    await call_vl_model(image_path, "second", model_settings=second_settings)

    # Then
    assert client_factory.call_args_list == [
        ((), {"api_key": "first-api-key", "base_url": "https://first.example/v1"}),
        ((), {"api_key": "second-api-key", "base_url": "https://second.example/v1"}),
    ]
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
    monkeypatch.setattr(
        vl_model_module,
        "validate_credentialed_public_url",
        Mock(side_effect=UnsafeUrlError("unsafe URL")),
    )
    client_factory = Mock()
    monkeypatch.setattr(vl_model_module, "AsyncOpenAI", client_factory)
    image_path = tmp_path / "chart.png"
    image_path.write_bytes(b"chart-bytes")

    # When / Then
    with pytest.raises(UnsafeUrlError, match="unsafe URL"):
        await call_vl_model(image_path, "extract", model_settings=run_settings)
    client_factory.assert_not_called()


@pytest.mark.asyncio
async def test_vl_requires_https_for_credentials(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Given
    run_settings = RunModelSettings.from_user_settings(
        UserSettings(api_key="runtime-api-key", base_url="http://8.8.8.8/v1")
    )
    client = SimpleNamespace(
        chat=SimpleNamespace(
            completions=SimpleNamespace(
                create=AsyncMock(
                    return_value=SimpleNamespace(
                        choices=[
                            SimpleNamespace(
                                message=SimpleNamespace(content="unexpected")
                            )
                        ]
                    )
                )
            )
        ),
        close=AsyncMock(),
    )
    client_factory = Mock(return_value=client)
    monkeypatch.setattr(vl_model_module, "AsyncOpenAI", client_factory)
    image_path = tmp_path / "chart.png"
    image_path.write_bytes(b"chart-bytes")

    # When / Then
    with pytest.raises(UnsafeUrlError, match="HTTPS"):
        await call_vl_model(image_path, "extract", model_settings=run_settings)
    client_factory.assert_not_called()


@pytest.mark.asyncio
async def test_vl_call_closes_client_when_completion_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Given
    run_settings = RunModelSettings.from_user_settings(
        UserSettings(api_key="runtime-api-key", base_url="https://runtime.example/v1")
    )
    monkeypatch.setattr(vl_model_module, "validate_credentialed_public_url", lambda url: url)
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
    monkeypatch.setattr(vl_model_module, "AsyncOpenAI", Mock(return_value=client))
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
    client_factory = Mock()
    monkeypatch.setattr(vl_model_module, "AsyncOpenAI", client_factory)
    monkeypatch.setattr(vl_model_module, "validate_credentialed_public_url", lambda url: url)
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
    client_factory.assert_not_called()
