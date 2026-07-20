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
        base_url="http://test",
    ) as client:
        response = await client.get("/api/v1/databases")

    assert response.status_code == 200
    identifiers = {item["id"] for item in response.json()["databases"]}
    assert identifiers == {"pubmed", "geo", "gdc", "pdb", "xena", "pubchem", "reactome"}
    assert identifiers.isdisjoint(
        {
            "analysis",
            "browser_fallback",
            "self_evolution",
            "literature_understanding",
            "pdf_extraction",
        }
    )
    projected = {item["id"]: item for item in response.json()["databases"]}
    assert all(item["available"] is True for item in projected.values())
    assert projected["pubmed"]["pipeline_supported"] is True
    assert projected["geo"]["pipeline_supported"] is True
    assert projected["gdc"]["pipeline_supported"] is False
