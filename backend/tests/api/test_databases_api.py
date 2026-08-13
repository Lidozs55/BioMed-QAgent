"""Phase 2: thin declarative database store + /api/v1/databases surface.

Replaces the retired UserSkillStore/skills API (docs/migration/
phase2-skills-tools-migration.md, decision D4).
"""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.databases.declarative import DatabaseValidationError
from app.databases.store import DatabaseStore
from app.main import create_app

_DECLARATIVE = {
    "schema_version": "1.0",
    "name": "demo_source",
    "display_name": "Demo Source",
    "version": "0.1.0",
    "category": "acquisition",
    "description": "Declarative HTTP demo database.",
    "supported_sources": ["demo_source"],
    "operations": [
        {
            "name": "query_demo",
            "description": "Query the demo source.",
            "method": "GET",
            "url": "https://example.com/api/{query}",
        }
    ],
    "enabled": True,
    "user_selectable": True,
    "pipeline_supported": False,
    "requirements": [],
}


# ── store unit behavior ──────────────────────────────────────────────────────


def test_store_lists_nine_builtin_databases_with_capabilities(tmp_path: Path) -> None:
    store = DatabaseStore(tmp_path / "skills")

    entries = {entry.id: entry for entry in store.list_databases()}

    assert set(entries) == {
        "pubmed", "geo", "gdc", "pdb", "xena", "pubchem", "reactome",
        "uniprot", "chembl",
    }
    assert entries["uniprot"].capability == "research_only"
    assert entries["gdc"].capability == "pipeline_supported"
    assert all(entry.enabled for entry in entries.values())
    assert all(entry.origin == "builtin" for entry in entries.values())


def test_store_persists_enable_disable_toggles(tmp_path: Path) -> None:
    root = tmp_path / "skills"
    store = DatabaseStore(root)
    store.set_enabled("geo", False)

    reloaded = DatabaseStore(root)

    entries = {entry.id: entry for entry in reloaded.list_databases()}
    assert entries["geo"].enabled is False
    assert entries["gdc"].enabled is True
    assert reloaded.disabled_builtin_names() == frozenset({"geo"})


def test_store_creates_and_patches_user_declarative_databases(tmp_path: Path) -> None:
    root = tmp_path / "skills"
    store = DatabaseStore(root)
    manifest = store.put_database(_DECLARATIVE)

    entries = {entry.id: entry for entry in store.list_databases()}
    assert "demo_source" in entries
    assert entries["demo_source"].origin == "package"
    assert entries["demo_source"].declarative_manifest is not None
    assert [op.name for op in manifest.operations] == ["query_demo"]

    patched = store.patch_database(
        "demo_source",
        {"display_name": "Demo Renamed", "description": "New description."},
    )
    assert patched.display_name == "Demo Renamed"
    assert patched.operations[0].name == "query_demo"


def test_store_rejects_invalid_manifest_without_persisting(tmp_path: Path) -> None:
    store = DatabaseStore(tmp_path / "skills")

    with pytest.raises(DatabaseValidationError):
        store.put_database(
            {
                "name": "bad",
                "display_name": "Bad",
                "version": "1",
                "category": "acquisition",
                "description": "x",
                "operations": [
                    {
                        "name": "op",
                        "description": "d",
                        "method": "GET",
                        "url": "localhost/private",
                    }
                ],
            }
        )

    assert store.get_database("bad") is None


def test_store_cannot_delete_builtin_databases(tmp_path: Path) -> None:
    store = DatabaseStore(tmp_path / "skills")

    with pytest.raises(PermissionError):
        store.delete_database("geo")


def test_store_builds_direct_http_tools_for_user_databases(tmp_path: Path) -> None:
    store = DatabaseStore(tmp_path / "skills")
    store.put_database(_DECLARATIVE)

    tools = store.build_user_http_tools()

    assert [tool.name for tool in tools] == ["query_demo"]
    # Disabling the database removes its tools.
    store.set_enabled("demo_source", False)
    assert store.build_user_http_tools() == []


# ── API surface ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_databases_api_lists_all_with_enabled_flags(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        response = await client.get("/api/v1/databases")

    assert response.status_code == 200
    items = {item["id"]: item for item in response.json()["databases"]}
    assert "geo" in items
    assert items["geo"]["enabled"] is True
    assert items["geo"]["origin"] == "builtin"
    assert items["geo"]["declarative_manifest" if False else "name"] == "GEO"


@pytest.mark.asyncio
async def test_databases_api_crud_and_toggles(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        created = await client.post("/api/v1/databases", json=_DECLARATIVE)
        assert created.status_code == 201
        assert created.json()["name"] == "Demo Source"
        assert created.json()["declarative_manifest"]["operations"][0]["name"] == "query_demo"

        detail = await client.get("/api/v1/databases/demo_source")
        assert detail.status_code == 200
        assert detail.json()["declarative_manifest"]["display_name"] == "Demo Source"

        patched = await client.put(
            "/api/v1/databases/demo_source",
            json={"display_name": "Demo Renamed"},
        )
        assert patched.status_code == 200
        assert patched.json()["declarative_manifest"]["display_name"] == "Demo Renamed"

        disabled = await client.post("/api/v1/databases/demo_source/disable")
        assert disabled.status_code == 200
        assert disabled.json()["enabled"] is False

        enabled = await client.post("/api/v1/databases/demo_source/enable")
        assert enabled.status_code == 200
        assert enabled.json()["enabled"] is True

        deleted = await client.delete("/api/v1/databases/demo_source")
        assert deleted.status_code == 204
        missing = await client.get("/api/v1/databases/demo_source")
        assert missing.status_code == 404


@pytest.mark.asyncio
async def test_databases_api_rejects_invalid_and_builtin_deletion(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        invalid = await client.post(
            "/api/v1/databases",
            json={
                **_DECLARATIVE,
                "operations": [
                    {
                        "name": "bad_op",
                        "description": "d",
                        "method": "GET",
                        "url": "ftp://example.com/x",
                    }
                ],
            },
        )
        assert invalid.status_code == 422

        deleted = await client.delete("/api/v1/databases/geo")
        assert deleted.status_code == 409

        unknown = await client.delete("/api/v1/databases/never_existed")
        assert unknown.status_code == 404


@pytest.mark.asyncio
async def test_skills_api_is_retired(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        response = await client.get("/api/v1/skills")

    assert response.status_code == 404
