"""Recovery contract for incomplete unknown-model settings."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.main import create_app
from app.model_config import RunModelSettings, UserSettings
from app.model_config.context_budget import ContextBudgetConfigurationError
from app.model_settings import ModelConfiguration


@pytest.mark.asyncio
async def test_get_settings_exposes_blocked_budget_for_unknown_model(
    tmp_path: Path,
) -> None:
    # Given
    settings_path = tmp_path / "settings" / "model.json"
    settings_path.parent.mkdir(parents=True)
    settings_path.write_text(
        '{"base_url":"https://provider.example/v1","model_name":"unregistered-current-model"}',
        encoding="utf-8",
    )
    application = create_app(
        Settings(
            output_dir=str(tmp_path / "output"),
            model_name="qwen-plus",
        )
    )

    # When
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        response = await client.get("/api/v1/settings")

    # Then — unknown model remains configurable but cannot run without a window.
    assert response.status_code == 200
    data = response.json()
    assert data["model_name"] == "unregistered-current-model"
    assert data["context_window"] == 0
    assert data["context_window_source"] == "unknown"
    assert data["available_input_tokens"] == 0
    assert data["run_ready"] is False
    assert data["run_block_reason"] == "a positive context window is required"


@pytest.mark.asyncio
async def test_put_recovers_unknown_model_with_positive_context_window(tmp_path: Path) -> None:
    # Given
    settings_path = tmp_path / "settings" / "model.json"
    settings_path.parent.mkdir(parents=True)
    settings_path.write_text(
        '{"base_url":"https://provider.example/v1","model_name":"unregistered-current-model"}',
        encoding="utf-8",
    )
    application = create_app(Settings(output_dir=str(tmp_path / "output")))

    # When
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        response = await client.put("/api/v1/settings", json={"context_window": 65_536})

    # Then
    assert response.status_code == 200
    data = response.json()
    assert data["context_window_source"] == "user"
    assert data["available_input_tokens"] > 0
    assert data["run_ready"] is True
    assert data["run_block_reason"] is None
    assert (
        ModelConfiguration.model_validate_json(settings_path.read_text("utf-8")).context_window
        == 65_536
    )


@pytest.mark.asyncio
async def test_get_settings_marks_known_qwen36_flash_as_run_ready(tmp_path: Path) -> None:
    # Given
    application = create_app(
        Settings(output_dir=str(tmp_path / "output"), model_name="qwen3.6-flash")
    )

    # When
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        response = await client.get("/api/v1/settings")

    # Then
    assert response.status_code == 200
    data = response.json()
    assert data["context_window_source"] == "catalog"
    assert data["run_ready"] is True
    assert data["run_block_reason"] is None


@pytest.mark.asyncio
async def test_put_preserves_unknown_model_as_not_run_ready(tmp_path: Path) -> None:
    # Given
    application = create_app(
        Settings(
            output_dir=str(tmp_path / "output"),
            model_name="unregistered-current-model",
        )
    )

    # When
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        response = await client.put("/api/v1/settings", json={"max_tokens": 4096})

    # Then — persistence succeeds, but execution remains fail-closed.
    assert response.status_code == 200
    data = response.json()
    assert data["context_window"] == 0
    assert data["context_window_source"] == "unknown"
    assert data["run_ready"] is False


def test_run_model_settings_rejects_unknown_model_without_window() -> None:
    settings = UserSettings(model_name="unregistered-current-model")

    with pytest.raises(
        ContextBudgetConfigurationError,
        match="a positive context window is required",
    ):
        RunModelSettings.from_user_settings(settings)
