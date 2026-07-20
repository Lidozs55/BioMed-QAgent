"""Management API coverage for dynamic user skills and database projection."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any

import httpx
import pytest
from app.config import Settings
from app.main import create_app


def _manifest(*, version: str = "1.0.0") -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "name": "demo_db",
        "display_name": "Demo DB",
        "version": version,
        "category": "acquisition",
        "description": "Demo database.",
        "supported_sources": ["demo_db"],
        "user_selectable": True,
        "pipeline_supported": False,
        "operations": [
            {
                "name": "fetch_demo",
                "description": "Fetch demo.",
                "method": "GET",
                "url": "https://example.com/{record_id}",
            }
        ],
    }


def _zip() -> bytes:
    manifest = {
        **_manifest(),
        "operations": [],
        "origin": "package",
        "entrypoint": "skill.py:skill",
        "requirements": [],
    }
    source = (
        "from app.skills.registry import SkillDef, SkillCategory\n"
        "skill = SkillDef(name='demo_db', category=SkillCategory.ACQUISITION, "
        "description='Demo database.', supported_sources=['demo_db'], "
        "version='1.0.0')\n"
    )
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr("skill.py", source)
    return output.getvalue()


@pytest.mark.asyncio
async def test_skills_crud_versions_and_database_projection(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://test"
    ) as client:
        created = await client.put("/api/v1/skills/demo_db/manifest", json=_manifest())
        listed = await client.get("/api/v1/skills")
        detail = await client.get("/api/v1/skills/demo_db")
        databases = await client.get("/api/v1/databases")
        disabled = await client.post("/api/v1/skills/demo_db/disable")
        updated = await client.put(
            "/api/v1/skills/demo_db/manifest", json=_manifest(version="2.0.0")
        )
        rolled_back = await client.post("/api/v1/skills/demo_db/rollback")
        enabled = await client.post("/api/v1/skills/demo_db/enable")
        deleted = await client.delete("/api/v1/skills/demo_db")

    assert created.status_code == 200 and created.json()["generation"] > 0
    assert any(item["name"] == "demo_db" for item in listed.json()["skills"])
    assert detail.json()["current_version"] == "1.0.0"
    projected = next(item for item in databases.json()["databases"] if item["id"] == "demo_db")
    assert projected["origin"] == "package"
    assert projected["version"] == "1.0.0"
    assert projected["pipeline_supported"] is False
    assert disabled.json()["skill"]["enabled"] is False
    assert updated.json()["skill"]["version"] == "2.0.0"
    assert rolled_back.json()["skill"]["version"] == "1.0.0"
    assert enabled.json()["skill"]["enabled"] is True
    assert deleted.json()["generation"] > enabled.json()["generation"]


@pytest.mark.asyncio
async def test_validate_and_upload_python_package_warn_about_local_code(
    tmp_path: Path,
) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    package = _zip()
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://test"
    ) as client:
        validated = await client.post(
            "/api/v1/skills/validate",
            files={"file": ("demo.zip", package, "application/zip")},
        )
        uploaded = await client.post(
            "/api/v1/skills/upload",
            files={"file": ("demo.zip", package, "application/zip")},
        )

    assert validated.status_code == 200
    assert "executes local Python code" in validated.json()["warning"]
    assert uploaded.status_code == 200
    assert uploaded.json()["skill"]["name"] == "demo_db"
