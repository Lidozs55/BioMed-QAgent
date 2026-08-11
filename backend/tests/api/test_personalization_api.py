"""API + Agent prompt-injection tests for personalization settings."""

from __future__ import annotations

from pathlib import Path

import app.personalization as personalization_module
import httpx
import pytest
from app.config import Settings
from app.main import create_app


@pytest.fixture(autouse=True)
def isolated_personalization(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Point personalization persistence at a temp file and reset the cache."""
    monkeypatch.setattr(
        personalization_module,
        "_PERSONALIZATION_PATH",
        tmp_path / "personalization.json",
    )
    personalization_module._runtime_personalization = None
    yield
    personalization_module._runtime_personalization = None


@pytest.mark.asyncio
async def test_personalization_defaults_are_empty(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        response = await client.get("/api/v1/personalization")

    assert response.status_code == 200
    data = response.json()
    assert data["custom_instructions"] == ""
    assert data["personality"] == "pragmatic"
    assert data["personality_label"] == "务实"


@pytest.mark.asyncio
async def test_personalization_save_persists_and_survives_restart(
    tmp_path: Path,
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        saved = await client.put(
            "/api/v1/personalization",
            json={
                "custom_instructions": "优先使用 GEO，其次 Xena。",
                "personality": "rigorous",
            },
        )

    assert saved.status_code == 200
    assert saved.json()["personality"] == "rigorous"
    persisted = (tmp_path / "personalization.json").read_text("utf-8")
    assert "优先使用 GEO，其次 Xena。" in persisted

    # Simulate a server restart: drop the in-memory cache, then re-read.
    personalization_module._runtime_personalization = None
    restarted = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with restarted.router.lifespan_context(restarted), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=restarted),
        base_url="http://localhost",
    ) as client:
        loaded = await client.get("/api/v1/personalization")

    assert loaded.json()["custom_instructions"] == "优先使用 GEO，其次 Xena。"
    assert loaded.json()["personality"] == "rigorous"


@pytest.mark.asyncio
async def test_personalization_partial_update_keeps_other_field(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        await client.put("/api/v1/personalization", json={"personality": "warm"})
        response = await client.get("/api/v1/personalization")

    assert response.status_code == 200
    data = response.json()
    assert data["personality"] == "warm"
    assert data["custom_instructions"] == ""


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "payload",
    [
        {"personality": "chatty"},
        {"custom_instructions": "x" * 20_001},
        {"unknown_field": "boom"},
    ],
)
async def test_personalization_rejects_invalid_updates(
    tmp_path: Path,
    payload: dict[str, object],
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        response = await client.put("/api/v1/personalization", json=payload)

    assert response.status_code == 422


def test_personalization_section_empty_by_default() -> None:
    personalization_module._runtime_personalization = None
    section = personalization_module.personalization_section()

    assert "## 用户自定义指令" not in section
    assert "## 回复语气" in section


def test_personalization_injected_into_agent_instructions() -> None:
    from app.agent_loop import agent as agent_module
    from app.agent_loop.context import RunContext

    personalization_module._runtime_personalization = None
    personalization_module.update_personalization(
        personalization_module.PersonalizationSettings(
            custom_instructions="先查 GEO，再补 Xena。",
            personality="rigorous",
        )
    )

    resolved = agent_module.resolve_agent_instructions(
        "BASE_INSTRUCTIONS",
        RunContext(task_id="task_personalization_inject"),
    )

    assert resolved.startswith("BASE_INSTRUCTIONS")
    assert "## 用户自定义指令" in resolved
    assert "先查 GEO，再补 Xena。" in resolved
    assert "## 回复语气" in resolved
    assert "回复严谨、结构化" in resolved
