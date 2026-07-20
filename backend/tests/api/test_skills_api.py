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
    assert projected["available"] is True
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


@pytest.mark.asyncio
async def test_declarative_database_convenience_crud(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://test"
    ) as client:
        created = await client.post("/api/v1/databases", json=_manifest())
        updated = await client.put(
            "/api/v1/databases/demo_db", json={"description": "Updated database."}
        )
        deleted = await client.delete("/api/v1/databases/demo_db")

    assert created.status_code == 200 and created.json()["generation"] > 0
    assert updated.status_code == 200 and updated.json()["skill"]["version"] == "1.0.0"
    assert deleted.status_code == 200 and deleted.json()["generation"] > updated.json()["generation"]


@pytest.mark.asyncio
async def test_database_detail_round_trips_declarative_operation(tmp_path: Path) -> None:
    manifest = _manifest()
    manifest["operations"][0].update(
        {
            "method": "POST",
            "url": "https://example.com/search/{record_id}",
            "query": {"q": "{query}"},
            "headers": {"X-Mode": "catalog"},
            "body": {"term": "{query}"},
        }
    )
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://test"
    ) as client:
        await client.post("/api/v1/databases", json=manifest)
        detail = await client.get("/api/v1/skills/demo_db")

    operation = detail.json()["declarative_manifest"]["operations"][0]
    assert operation["method"] == "POST"
    assert operation["url"] == "https://example.com/search/{record_id}"
    assert operation["query"] == {"q": "{query}"}
    assert operation["body"] == {"term": "{query}"}


@pytest.mark.asyncio
async def test_database_patch_preserves_secrets_and_unedited_operations(
    tmp_path: Path,
) -> None:
    manifest = _manifest()
    manifest["description"] = "Before edit"
    manifest["operations"] = [
        {
            "name": "fetch_demo",
            "description": "Fetch demo.",
            "method": "GET",
            "url": "https://example.com/records/{record_id}",
            "headers": {"Authorization": "Bearer persisted-secret", "X-Mode": "full"},
            "auth": {
                "source": "env",
                "reference": "DEMO_API_KEY",
                "location": "header",
                "name": "X-Api-Key",
                "prefix": "Bearer ",
            },
        },
        {
            "name": "describe_demo",
            "description": "Describe demo.",
            "method": "GET",
            "url": "https://example.com/descriptions/{record_id}",
        },
    ]
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://test"
    ) as client:
        await client.post("/api/v1/databases", json=manifest)
        detail_before = await client.get("/api/v1/skills/demo_db")
        updated = await client.put(
            "/api/v1/databases/demo_db",
            json={
                "description": "After edit",
                "operation": {
                    "name": "fetch_demo",
                    "url": "https://api.example.com/records/{record_id}",
                    "headers": {"Authorization": "[redacted]"},
                },
            },
        )
        detail_after = await client.get("/api/v1/skills/demo_db")

    assert detail_before.json()["declarative_manifest"]["operations"][0][
        "headers"
    ]["Authorization"] == "[redacted]"
    assert updated.status_code == 200
    stored = detail_after.json()["declarative_manifest"]
    assert stored["description"] == "After edit"
    assert [operation["name"] for operation in stored["operations"]] == [
        "fetch_demo",
        "describe_demo",
    ]
    assert stored["operations"][0]["url"] == (
        "https://api.example.com/records/{record_id}"
    )
    assert stored["operations"][0]["auth"]["reference"] == "DEMO_API_KEY"
    assert stored["operations"][1]["url"] == (
        "https://example.com/descriptions/{record_id}"
    )
    state = json.loads((tmp_path / "skills" / "state.json").read_text("utf-8"))
    current = state["packages"]["demo_db"]["current"]
    package_file = next(
        (tmp_path / "skills" / "packages" / "demo_db").glob(f"{current}.*")
    )
    raw = json.loads(package_file.read_text("utf-8"))
    assert raw["operations"][0]["headers"]["Authorization"] == (
        "Bearer persisted-secret"
    )


@pytest.mark.asyncio
async def test_skill_list_includes_unavailable_persistent_package(tmp_path: Path) -> None:
    configured = Settings(output_dir=str(tmp_path / "output"))
    first = create_app(configured)
    async with first.router.lifespan_context(first), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=first), base_url="http://test"
    ) as client:
        await client.post("/api/v1/databases", json=_manifest())

    state = json.loads((tmp_path / "skills" / "state.json").read_text("utf-8"))
    current = state["packages"]["demo_db"]["current"]
    package_file = next((tmp_path / "skills" / "packages" / "demo_db").glob(f"{current}.*"))
    package_file.write_text("not json", encoding="utf-8")

    second = create_app(configured)
    async with second.router.lifespan_context(second), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=second), base_url="http://test"
    ) as client:
        listed = await client.get("/api/v1/skills")
        detail = await client.get("/api/v1/skills/demo_db")

    item = next(skill for skill in listed.json()["skills"] if skill["name"] == "demo_db")
    assert item["available"] is False
    assert item["load_error"]
    assert detail.json()["available"] is False


@pytest.mark.asyncio
async def test_multipart_upload_is_rejected_at_compressed_byte_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.api.skills.MAX_SKILL_UPLOAD_BYTES", 8)
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://test"
    ) as client:
        response = await client.post(
            "/api/v1/skills/validate",
            files={"file": ("manifest.json", b"{" + b"x" * 100, "application/json")},
        )

    assert response.status_code == 413
