"""Recovery contract for incomplete unknown-model settings."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.main import create_app
from app.model_config import RunModelSettings, UserSettings
from app.model_config.context_budget import ContextBudgetConfigurationError


@pytest.mark.asyncio
async def test_get_settings_exposes_incomplete_unknown_model_budget_for_recovery(
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

    # Then
    assert response.status_code == 200
    data = response.json()
    assert data["model_name"] == "unregistered-current-model"
    assert data["context_window"] == 0
    assert data["context_window_source"] == "unknown"
    assert data["safety_reserve_tokens"] == 0
    assert data["available_input_tokens"] == 0


@pytest.mark.asyncio
async def test_put_rejects_unknown_model_without_positive_context_window(tmp_path: Path) -> None:
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

    # Then
    assert response.status_code == 422
    assert not (tmp_path / "settings" / "model.json").exists()


def test_run_model_settings_rejects_unknown_model_without_positive_context_window() -> None:
    # Given
    settings = UserSettings(model_name="unregistered-current-model")

    # When / Then
    with pytest.raises(ContextBudgetConfigurationError, match="context window"):
        RunModelSettings.from_user_settings(settings)
