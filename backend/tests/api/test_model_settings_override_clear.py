"""Override-clear contract: omitted-vs-null ``context_window`` semantics
for the active PUT /api/v1/settings path.

Scenarios 7–8, 10–13 from the Task 5 override-clear extension.
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.main import create_app

# ── Scenario 7: Omit context_window → leave override unchanged ─────────


@pytest.mark.asyncio
async def test_omit_context_window_leaves_override_unchanged(
    tmp_path: Path,
) -> None:
    """Scenario 7: Omitting context_window in a partial update leaves a
    pre-existing user override intact (both in-memory and on-disk)."""
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        # Establish user override
        await client.put(
            "/api/v1/settings",
            json={
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "model_name": "qwen-max",
                "max_tokens": 4096,
                "context_window": 65_536,
            },
        )
        # Partial update without context_window — must leave override intact
        response = await client.put(
            "/api/v1/settings",
            json={"max_tokens": 2048},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["context_window"] == 65_536
    assert data["context_window_source"] == "user"
    assert data["max_tokens"] == 2048
    persisted = (tmp_path / "settings" / "model.json").read_text("utf-8")
    assert '"context_window": 65536' in persisted


# ── Scenario 8: Explicit null → clear to catalog source/window ─────────


@pytest.mark.asyncio
async def test_explicit_null_context_window_clears_to_catalog_source(
    tmp_path: Path,
) -> None:
    """Scenario 8: Explicit JSON ``context_window: null`` clears the user
    override, resolving the exact catalog window and persisting
    ``context_window_source: "catalog"``."""
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        # Establish user override first
        await client.put(
            "/api/v1/settings",
            json={
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "model_name": "qwen-max",
                "max_tokens": 4096,
                "context_window": 65_536,
            },
        )
        # Explicit null → clear the override
        response = await client.put(
            "/api/v1/settings",
            json={"context_window": None},
        )

    assert response.status_code == 200
    data = response.json()
    assert data["context_window"] == 32_768
    assert data["context_window_source"] == "catalog"
    # On-disk: context_window must be absent (None excluded by store)
    persisted = (tmp_path / "settings" / "model.json").read_text("utf-8")
    assert '"context_window"' not in persisted


# ── Scenario 10: Explicit null for unknown model → rejected ────────────


@pytest.mark.asyncio
async def test_explicit_null_context_window_for_unknown_model_rejected(
    tmp_path: Path,
) -> None:
    """Scenario 10: Clearing context_window for an unknown model is
    rejected (no catalog to fall back to) — disk and memory unchanged."""
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        # Establish known-good baseline
        await client.put(
            "/api/v1/settings",
            json={
                "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
                "model_name": "qwen-max",
                "max_tokens": 4096,
            },
        )
        settings_path = tmp_path / "settings" / "model.json"
        original_bytes = settings_path.read_bytes()
        snapshot_before = await client.get("/api/v1/settings")

        # Switch to unknown model AND attempt to clear context_window
        response = await client.put(
            "/api/v1/settings",
            json={"model_name": "compatible-unknown", "context_window": None},
        )

        assert response.status_code == 422
        assert settings_path.read_bytes() == original_bytes
        after = await client.get("/api/v1/settings")
        assert after.json() == snapshot_before.json()


# ── Scenario 11: Cleared override survives reload ──────────────────────


def test_cleared_context_window_survives_store_reload(tmp_path: Path) -> None:
    """Scenario 11: After clearing via store.update() with clears,
    a reloaded store resolves catalog source and window."""
    from app.model_settings import ModelSettingsStore

    settings_path = tmp_path / "settings" / "model.json"
    defaults = Settings(
        dashscope_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name="qwen-max",
    )
    store = ModelSettingsStore(settings_path, defaults=defaults)
    store.update({"context_window": 65_536, "max_tokens": 4096})
    assert store.snapshot().context_window == 65_536

    store.update({"max_tokens": 2048}, clears={"context_window"})
    snapshot = store.snapshot()
    assert snapshot.context_window is None
    assert snapshot.max_tokens == 2048

    reloaded = ModelSettingsStore(settings_path, defaults=defaults)
    assert reloaded.snapshot().context_window is None


# ── Scenario 12: clears parameter is idempotent ────────────────────────


def test_clears_idempotent_on_already_cleared_field(tmp_path: Path) -> None:
    """Scenario 12: Calling clears on an already-cleared (catalog-source)
    field produces the same result as the first clear."""
    from app.model_settings import ModelSettingsStore

    settings_path = tmp_path / "settings" / "model.json"
    defaults = Settings(
        dashscope_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name="qwen-max",
    )
    store = ModelSettingsStore(settings_path, defaults=defaults)
    store.update({"max_tokens": 4096})
    assert store.snapshot().context_window is None

    store.update({"max_tokens": 2048}, clears={"context_window"})
    assert store.snapshot().context_window is None
    assert store.snapshot().max_tokens == 2048


# ── Scenario 13: Unknown model with clears-rejected preserves disk ─────


def test_clears_for_unknown_model_preserves_disk(tmp_path: Path) -> None:
    """Scenario 13: When clears + unknown model is rejected by budget
    validation, the store file remains byte-identical."""
    from app.model_settings import ModelSettingsStore

    settings_path = tmp_path / "settings" / "model.json"
    defaults = Settings(
        dashscope_base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name="qwen-max",
    )
    store = ModelSettingsStore(settings_path, defaults=defaults)
    store.update({"max_tokens": 4096})
    original_bytes = settings_path.read_bytes()

    with pytest.raises(ValueError, match="a positive context window is required"):
        store.update({"model_name": "compatible-unknown"}, clears={"context_window"})

    assert settings_path.read_bytes() == original_bytes
    assert store.snapshot().model_name == "qwen-max"
