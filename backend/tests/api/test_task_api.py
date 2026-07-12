from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

import app.api.routes as routes_module
from app.main import app


@pytest.mark.asyncio
async def test_create_fixture_task_runs_pipeline_and_returns_typed_status(
    tmp_path: Path, monkeypatch
) -> None:
    output_dir = tmp_path / "output"
    monkeypatch.setattr(
        routes_module, "settings", SimpleNamespace(output_dir=str(output_dir))
    )

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        created = await client.post(
            "/api/v1/tasks",
            json={
                "topic": "user supplied acceptance topic",
                "databases": ["pubmed", "geo"],
                "mode": "fixture",
            },
        )
        assert created.status_code == 201
        payload = created.json()
        assert payload["task_id"].startswith("task_")
        assert payload["status"] == "completed"

        status = await client.get(f"/api/v1/tasks/{payload['task_id']}")
        assert status.status_code == 200
        assert status.json() == {
            "task_id": payload["task_id"],
            "status": "completed",
            "current_stage": "validation",
            "validation_status": "valid",
            "artifact_count": 14,
        }

        manifest = await client.get(
            f"/api/v1/tasks/{payload['task_id']}/artifacts/run_manifest"
        )
        assert manifest.status_code == 200
        assert manifest.json()["request"]["topic"] == ("user supplied acceptance topic")


@pytest.mark.asyncio
async def test_fixture_task_requires_pubmed_and_geo(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(
        routes_module, "settings", SimpleNamespace(output_dir=str(tmp_path / "output"))
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/v1/tasks",
            json={
                "topic": "test",
                "databases": ["geo"],
                "mode": "fixture",
            },
        )

    assert response.status_code == 422

    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        unsupported = await client.post(
            "/api/v1/tasks",
            json={
                "topic": "test",
                "databases": ["pubmed", "geo", "gdc"],
                "mode": "fixture",
            },
        )
    assert unsupported.status_code == 422


@pytest.mark.asyncio
async def test_fixture_task_rejects_blank_topic_without_side_effects(
    tmp_path: Path, monkeypatch
) -> None:
    output_dir = tmp_path / "output"
    monkeypatch.setattr(
        routes_module, "settings", SimpleNamespace(output_dir=str(output_dir))
    )
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/v1/tasks",
            json={
                "topic": "   ",
                "databases": ["pubmed", "geo"],
                "mode": "fixture",
            },
        )

    assert response.status_code == 422
    assert not (output_dir / "tasks").exists()


@pytest.mark.asyncio
async def test_database_api_lists_only_user_selectable_data_sources() -> None:
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as client:
        response = await client.get("/api/v1/databases")

    assert response.status_code == 200
    identifiers = {item["id"] for item in response.json()["databases"]}
    assert identifiers == {"pubmed", "geo"}
    assert identifiers.isdisjoint(
        {
            "analysis",
            "browser_fallback",
            "self_evolution",
            "literature_understanding",
            "pdf_extraction",
        }
    )
