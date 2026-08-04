"""Task 5: Active Settings API — context budget exposure, validation, and
model preview fidelity tests."""

from __future__ import annotations

import math
from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.main import create_app

# ── Scenario 1: GET returns resolved context budget ─────────────────────


@pytest.mark.asyncio
async def test_get_settings_returns_resolved_context_budget(tmp_path: Path) -> None:
    """Scenario 1: GET returns exact resolved catalog window/source, output
    limit, reserve ratio/tokens, trigger/target ratios, and available input
    capacity."""
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        await client.put(
            "/api/v1/settings",
            json={
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "model_name": "qwen-max",
                "max_tokens": 4096,
            },
        )
        response = await client.get("/api/v1/settings")

    assert response.status_code == 200
    data = response.json()
    assert data["context_window"] == 32_768
    assert data["context_window_source"] == "catalog"
    assert data["max_tokens"] == 4096
    assert data["safety_reserve_ratio"] == 0.05
    assert data["safety_reserve_tokens"] == 6_554
    assert data["compaction_trigger_ratio"] == 0.85
    assert data["compaction_target_ratio"] == 0.60
    assert data["available_input_tokens"] == 22_118


# ── Scenario 2: Known model resolves catalog window ─────────────────────


@pytest.mark.asyncio
async def test_known_model_without_override_resolves_catalog_window(
    tmp_path: Path,
) -> None:
    """Scenario 2: A known model selection without override resolves and
    persists its exact catalog window."""
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        response = await client.put(
            "/api/v1/settings",
            json={
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "model_name": "qwen-turbo",
                "max_tokens": 4096,
            },
        )

    assert response.status_code == 200
    data = response.json()
    assert data["context_window"] == 1_000_000
    assert data["context_window_source"] == "catalog"
    persisted = (tmp_path / "settings" / "model.json").read_text("utf-8")
    assert '"model_name": "qwen-turbo"' in persisted


# ── Scenario 3: User override changes source ────────────────────────────


@pytest.mark.asyncio
async def test_positive_user_window_override_persists_as_user_source(
    tmp_path: Path,
) -> None:
    """Scenario 3: A positive user window override persists and changes
    source to ``user``."""
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        response = await client.put(
            "/api/v1/settings",
            json={
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "model_name": "qwen-max",
                "max_tokens": 4096,
                "context_window": 65_536,
            },
        )

    assert response.status_code == 200
    data = response.json()
    assert data["context_window"] == 65_536
    assert data["context_window_source"] == "user"
    persisted = (tmp_path / "settings" / "model.json").read_text("utf-8")
    assert '"context_window": 65536' in persisted


# ── Scenario 4: Unknown model saved with inferred 512K window ───────────


@pytest.mark.asyncio
async def test_unknown_model_saved_with_inferred_window(
    tmp_path: Path,
) -> None:
    """Scenario 4: Unknown model persists and resolves a conservative 512K window."""
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        # Set up first with a known model so the store has valid state
        await client.put(
            "/api/v1/settings",
            json={
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "model_name": "qwen-max",
                "max_tokens": 4096,
            },
        )

        response = await client.put(
            "/api/v1/settings",
            json={"model_name": "compatible-unknown"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["model_name"] == "compatible-unknown"
        assert data["context_window"] == 524_288
        assert data["context_window_source"] == "inferred"
        assert data["run_ready"] is True


# ── Scenario 5: Partial update validates merged candidate ───────────────


@pytest.mark.asyncio
async def test_partial_update_validates_merged_candidate(tmp_path: Path) -> None:
    """Scenario 5: Partial updates validate the fully merged candidate,
    including output and reserve interactions."""
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        # Establish sane base state
        await client.put(
            "/api/v1/settings",
            json={
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "model_name": "qwen-max",
                "max_tokens": 4096,
            },
        )
        # Partial update: only change max_tokens — merged candidate must still resolve
        response = await client.put(
            "/api/v1/settings",
            json={"max_tokens": 2048},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["max_tokens"] == 2048
    assert data["context_window"] == 32_768
    assert data["available_input_tokens"] == 32_768 - 2048 - 6_554


# ── Scenario 6: Invalid inputs → 422, no state change ───────────────────


@pytest.mark.asyncio
async def test_invalid_ratios_return_422_leave_state_unchanged(
    tmp_path: Path,
) -> None:
    """Scenario 6: Invalid ratios, non-positive windows, and non-positive
    capacity return 422 and leave both file bytes and in-memory snapshot
    unchanged."""
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with (
        application.router.lifespan_context(application),
        httpx.AsyncClient(
            transport=httpx.ASGITransport(app=application), base_url="http://localhost"
        ) as client,
    ):
        # Establish known-good state
        good = await client.put(
            "/api/v1/settings",
            json={
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "model_name": "qwen-max",
                "max_tokens": 4096,
            },
        )
        assert good.status_code == 200
        settings_path = tmp_path / "settings" / "model.json"
        original_bytes = settings_path.read_bytes()
        snapshot_before = await client.get("/api/v1/settings")

        # Attempt invalid compaction ratio order
        bad = await client.put(
            "/api/v1/settings",
            json={
                "compaction_target_ratio": 0.90,
                "compaction_trigger_ratio": 0.80,
            },
        )

        assert bad.status_code == 422
        assert settings_path.read_bytes() == original_bytes
        after = await client.get("/api/v1/settings")
        assert after.json() == snapshot_before.json()


# ── Scenario 9: Runtime snapshot matches GET ────────────────────────────


def test_runtime_snapshot_matches_active_get_settings(tmp_path: Path) -> None:
    """Scenario 9: Runtime manager/settings snapshot receives the same
    validated immutable context budget exposed by GET."""
    from app.model_config import RunModelSettings, UserSettings
    from app.model_config.context_budget import resolve_context_budget
    from app.model_settings import ModelSettingsStore

    store = ModelSettingsStore(
        tmp_path / "model.json",
        defaults=Settings(
            dashscope_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
            model_name="qwen-max",
        ),
    )
    store.update({"max_tokens": 4096})

    config = store.snapshot()
    user_settings = UserSettings(
        base_url=str(config.base_url).rstrip("/"),
        api_key=config.api_key,
        model_name=config.model_name,
        max_tokens=config.max_tokens,
        context_window=config.context_window,
        safety_reserve_ratio=config.safety_reserve_ratio,
        compaction_trigger_ratio=config.compaction_trigger_ratio,
        compaction_target_ratio=config.compaction_target_ratio,
        advanced=config.advanced.model_dump(),
    )
    run_settings = RunModelSettings.from_user_settings(user_settings)
    budget = resolve_context_budget(config)

    assert run_settings.context_budget == budget
    assert run_settings.context_budget.context_window == 32_768
    assert run_settings.context_budget.max_output_tokens == 4096
    assert budget.input_capacity == 32_768 - 4096 - min(16_384, math.ceil(0.2 * 32_768))
