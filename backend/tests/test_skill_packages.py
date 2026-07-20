"""Persistence and loaders for user-managed skill packages."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from typing import Any

import httpx
import pytest
from agents import RunContextWrapper, function_tool
from app.agent_loop.context import RunContext
from app.config import Settings
from app.skills.catalog import SkillCatalog, SkillDescriptor
from app.skills.packages import (
    DeclarativeSkillManifest,
    PackageValidationError,
    SkillPackageLoader,
)
from app.skills.registry import SkillCategory, SkillDef
from app.skills.store import UserSkillStore


@function_tool
async def builtin_echo(
    ctx: RunContextWrapper[RunContext], value: str,
) -> dict[str, str]:
    """Echo a value from a builtin."""
    return {"task_id": ctx.context.task_id, "value": value}


def _builtin() -> SkillDescriptor:
    return SkillDescriptor.from_skill_def(
        SkillDef(
            name="builtin_echo",
            category=SkillCategory.ACQUISITION,
            description="Immutable builtin.",
            tools=[builtin_echo],
            supported_sources=["builtin"],
            version="1.0.0",
        ),
        display_name="Builtin Echo",
        user_selectable=True,
    )


def _manifest(*, version: str = "1.0.0", name: str = "demo_db") -> dict[str, Any]:
    return {
        "schema_version": "1.0",
        "name": name,
        "display_name": "Demo DB",
        "version": version,
        "category": "acquisition",
        "description": "Fetch a public record.",
        "supported_sources": [name],
        "user_selectable": True,
        "pipeline_supported": False,
        "operations": [
            {
                "name": "fetch_record",
                "description": "Fetch one record.",
                "method": "GET",
                "url": "https://api.example.test/records/{record_id}",
                "query": {"format": "json", "q": "{query}"},
                "headers": {"Accept": "application/json"},
                "timeout_seconds": 3.0,
                "auth": {
                    "source": "env",
                    "reference": "DEMO_TOKEN",
                    "location": "header",
                    "name": "Authorization",
                    "prefix": "Bearer ",
                },
                "extract": "data.items.0",
            }
        ],
    }


def _zip_package(
    manifest: dict[str, Any],
    source: str,
    *,
    extra: dict[str, bytes] | None = None,
) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("manifest.json", json.dumps(manifest))
        archive.writestr("skill.py", source)
        for name, content in (extra or {}).items():
            archive.writestr(name, content)
    return output.getvalue()


def test_settings_derives_external_skill_directory_from_output(tmp_path: Path) -> None:
    configured = Settings(output_dir=str(tmp_path / "runtime" / "output"))
    injected = Settings(
        output_dir=str(tmp_path / "runtime" / "output"),
        skill_data_dir=str(tmp_path / "custom-skills"),
    )

    assert configured.skill_data_path == (tmp_path / "runtime" / "skills").resolve()
    assert injected.skill_data_path == (tmp_path / "custom-skills").resolve()


def test_store_persists_versions_and_rolls_back_with_monotonic_generation(
    tmp_path: Path,
) -> None:
    catalog = SkillCatalog()
    store = UserSkillStore(
        tmp_path / "skills",
        catalog=catalog,
        builtins=(_builtin(),),
        secrets={"DEMO_TOKEN": "secret"},
    )

    first = store.put_manifest(_manifest(version="1.0.0"))
    second = store.put_manifest(_manifest(version="2.0.0"))
    rolled_back = store.rollback("demo_db")

    assert first.generation < second.generation < rolled_back.generation
    assert catalog.snapshot().skills["demo_db"].version == "1.0.0"
    assert store.detail("demo_db").current_version == "1.0.0"
    assert store.detail("demo_db").versions == ("1.0.0", "2.0.0")

    reloaded_catalog = SkillCatalog()
    UserSkillStore(
        tmp_path / "skills",
        catalog=reloaded_catalog,
        builtins=(_builtin(),),
        secrets={"DEMO_TOKEN": "secret"},
    )
    assert reloaded_catalog.snapshot().skills["demo_db"].version == "1.0.0"


def test_failed_update_never_replaces_current_catalog_or_state(tmp_path: Path) -> None:
    catalog = SkillCatalog()
    store = UserSkillStore(
        tmp_path / "skills",
        catalog=catalog,
        builtins=(_builtin(),),
    )
    store.put_manifest(_manifest(version="1.0.0"))
    before = catalog.snapshot()
    state_before = (tmp_path / "skills" / "state.json").read_bytes()

    invalid = _manifest(version="2.0.0")
    invalid["operations"][0]["url"] = "file:///etc/passwd"
    with pytest.raises(PackageValidationError):
        store.put_manifest(invalid)

    assert catalog.snapshot() is before
    assert (tmp_path / "skills" / "state.json").read_bytes() == state_before
    assert store.detail("demo_db").current_version == "1.0.0"


def test_store_enable_disable_delete_and_builtin_immutability(tmp_path: Path) -> None:
    catalog = SkillCatalog()
    store = UserSkillStore(
        tmp_path / "skills",
        catalog=catalog,
        builtins=(_builtin(),),
    )
    store.put_manifest(_manifest())

    disabled = store.set_enabled("demo_db", enabled=False)
    assert disabled.skill.enabled is False
    assert catalog.snapshot().skills["demo_db"].enabled is False
    enabled = store.set_enabled("demo_db", enabled=True)
    assert enabled.skill.enabled is True
    deleted = store.delete("demo_db")
    assert "demo_db" not in catalog.snapshot().skills
    assert deleted.generation == catalog.snapshot().generation

    with pytest.raises(PermissionError, match="builtin"):
        store.delete("builtin_echo")


@pytest.mark.asyncio
async def test_declarative_http_renders_templates_extracts_and_redacts_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"data": {"items": [{"id": "R1"}]}})

    monkeypatch.setattr(
        "app.skills.packages.validate_public_http_url",
        lambda url: url,
    )
    loader = SkillPackageLoader(
        secrets={"DEMO_TOKEN": "top-secret"},
        http_transport=httpx.MockTransport(handler),
    )
    descriptor = loader.load_manifest(_manifest())
    tool = descriptor.resolve_operation("fetch_record")
    assert tool is not None

    result = await tool.on_invoke_tool(
        RunContextWrapper(RunContext(task_id="declarative")),
        json.dumps({"record_id": "R1", "query": "rna seq"}),
    )

    assert result == {"id": "R1"}
    assert requests[0].url.path == "/records/R1"
    assert requests[0].url.params["q"] == "rna seq"
    assert requests[0].headers["Authorization"] == "Bearer top-secret"
    redacted = DeclarativeSkillManifest.model_validate(_manifest()).model_dump()
    assert "top-secret" not in json.dumps(redacted)


def test_zip_loader_rejects_traversal_oversize_bad_entrypoint_and_dependency(
    tmp_path: Path,
) -> None:
    loader = SkillPackageLoader(max_zip_files=3, max_zip_bytes=1024)
    python_manifest = {
        **_manifest(),
        "operations": ["zip_echo"],
        "entrypoint": "skill.py:skill",
        "requirements": [],
    }
    source = "from app.skills.registry import SkillDef, SkillCategory\nskill = SkillDef(name='demo_db', category=SkillCategory.ACQUISITION, description='zip', supported_sources=['demo_db'], version='1.0.0')\n"

    traversal = _zip_package(
        python_manifest,
        source,
        extra={"../escape.py": b"bad"},
    )
    with pytest.raises(PackageValidationError, match="unsafe ZIP path"):
        loader.load_zip(traversal, extraction_root=tmp_path)

    oversized = _zip_package(
        python_manifest,
        source,
        extra={"large.bin": b"x" * 2048},
    )
    with pytest.raises(PackageValidationError, match="size limit"):
        loader.load_zip(oversized, extraction_root=tmp_path)

    bad_entrypoint = dict(python_manifest, entrypoint="other.py:build")
    with pytest.raises(PackageValidationError, match="skill.py:skill"):
        loader.load_zip(
            _zip_package(bad_entrypoint, source),
            extraction_root=tmp_path,
        )

    unavailable = dict(python_manifest, requirements=["definitely-missing-biomed-package>=9"])
    with pytest.raises(PackageValidationError, match="unavailable requirement"):
        loader.load_zip(
            _zip_package(unavailable, source),
            extraction_root=tmp_path,
        )


def test_zip_loader_uses_content_hash_module_name_and_warns_local_code(
    tmp_path: Path,
) -> None:
    manifest = {
        **_manifest(),
        "operations": [],
        "entrypoint": "skill.py:skill",
        "requirements": [],
    }
    source = "from app.skills.registry import SkillDef, SkillCategory\nskill = SkillDef(name='demo_db', category=SkillCategory.ACQUISITION, description='zip', supported_sources=['demo_db'], version='1.0.0')\n"
    loader = SkillPackageLoader()

    first = loader.load_zip(_zip_package(manifest, source), extraction_root=tmp_path)
    second = loader.load_zip(
        _zip_package(manifest, source + "# distinct content\n"),
        extraction_root=tmp_path,
    )

    assert first.descriptor.package_hash != second.descriptor.package_hash
    assert first.module_name != second.module_name
    assert first.module_name.startswith("_biomed_user_skill_")
    assert "executes local Python code" in first.warning
