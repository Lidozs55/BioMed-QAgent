from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.main import create_app


@pytest.mark.asyncio
async def test_database_api_lists_only_user_selectable_data_sources(
    tmp_path: Path,
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        response = await client.get("/api/v1/databases")

    assert response.status_code == 200
    identifiers = {item["id"] for item in response.json()["databases"]}
    assert identifiers == {"pubmed", "geo", "gdc", "pdb", "xena", "pubchem", "reactome"}
    assert identifiers.isdisjoint(
        {
            "analysis",
            "browser_fallback",
            "create_skill",
            "self_evolution",
            "literature_understanding",
            "pdf_extraction",
        }
    )
    projected = {item["id"]: item for item in response.json()["databases"]}
    assert all(item["available"] is True for item in projected.values())
    assert projected["pubmed"]["pipeline_supported"] is True
    assert projected["geo"]["pipeline_supported"] is True
    assert projected["gdc"]["pipeline_supported"] is True
    # TODO §1.4: each source carries its declared capability so the frontend
    # can distinguish pipeline_supported from research_only / pending.
    assert projected["pubmed"]["capability"] == "pipeline_supported"
    assert projected["xena"]["capability"] == "pipeline_supported"
    assert projected["pdb"]["capability"] == "research_only"
    assert projected["pubchem"]["capability"] == "research_only"


@pytest.mark.asyncio
async def test_create_task_with_specification_persists_on_run(
    tmp_path: Path,
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        response = await client.post(
            "/api/v1/tasks",
            json={
                "request_id": "req_spec_1",
                "input": "开始",
                "mode": "agent",
                "specification": {"topic": "TP53 表达差异"},
            },
        )

    assert response.status_code == 202
    task_id = response.json()["task_id"]
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        events = (await client.get(f"/api/v1/tasks/{task_id}/events")).json()["events"]
        snapshot = (await client.get(f"/api/v1/tasks/{task_id}")).json()

    queued = next(e for e in events if e["payload"]["type"] == "run_queued")
    assert queued["payload"]["specification"]["topic"] == "TP53 表达差异"
    assert snapshot["runs"][0]["specification"]["schema_version"] == "1.0"
