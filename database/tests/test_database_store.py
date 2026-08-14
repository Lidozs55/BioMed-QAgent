"""Unit tests for ``database.database_store.DatabaseStore`` (Phase 8 boundary).

Covers persistence-only responsibilities:
  - user manifest JSON persistence + atomic writes
  - enabled/disabled state persistence (builtin names included)
  - path-traversal guard on names
  - corrupt state / corrupt manifest never crash startup
  - builtin catalogue is NOT known to Python anymore (user-only projection)
  - no Agent/Skill/FastAPI imports anywhere in ``database/``
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from database.database_store import DatabaseStore


def _manifest(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "schema_version": "1.0",
        "name": "demo",
        "display_name": "Demo DB",
        "version": "1.0.0",
        "category": "discovery",
        "description": "demo database",
        "supported_sources": ["demo"],
        "operations": [],
        "enabled": True,
        "user_selectable": True,
        "pipeline_supported": False,
        "requirements": [],
    }
    base.update(overrides)
    return base


@pytest.fixture
def store(tmp_path: Path) -> DatabaseStore:
    return DatabaseStore(tmp_path)


def test_put_get_list_round_trip(store: DatabaseStore) -> None:
    manifest = store.put_database(_manifest())
    assert manifest.name == "demo"

    entries = store.list_databases()
    assert len(entries) == 1
    entry = entries[0]
    assert entry.name == "demo"
    assert entry.origin == "package"
    assert entry.category == "discovery"
    assert entry.enabled is True
    assert entry.declarative_manifest is not None

    assert store.get_database("demo") is not None
    assert store.get_database("nope") is None


def test_manifest_persisted_to_disk(store: DatabaseStore, tmp_path: Path) -> None:
    store.put_database(_manifest())
    manifest_file = tmp_path / "databases" / "demo.json"
    assert manifest_file.is_file()
    raw = json.loads(manifest_file.read_text(encoding="utf-8"))
    assert raw["name"] == "demo"

    # A fresh store instance (restart) reads the same manifest
    restarted = DatabaseStore(tmp_path)
    assert restarted.get_database("demo") is not None


def test_duplicate_put_rejected(store: DatabaseStore) -> None:
    store.put_database(_manifest())
    with pytest.raises(Exception, match="already exists"):
        store.put_database(_manifest())


def test_patch_database(store: DatabaseStore) -> None:
    store.put_database(_manifest())
    patched = store.patch_database("demo", {"description": "updated"})
    assert patched.description == "updated"
    assert store.get_database("demo") is not None
    assert store.get_database("demo").description == "updated"


def test_patch_missing_database_raises_key_error(store: DatabaseStore) -> None:
    with pytest.raises(KeyError):
        store.patch_database("missing", {"description": "x"})


def test_patch_rename_rejected(store: DatabaseStore) -> None:
    store.put_database(_manifest())
    with pytest.raises(ValueError, match="cannot be changed"):
        store.patch_database("demo", {"name": "other"})


def test_delete_database(store: DatabaseStore) -> None:
    store.put_database(_manifest())
    store.delete_database("demo")
    assert store.get_database("demo") is None
    with pytest.raises(KeyError):
        store.delete_database("demo")


def test_set_enabled_persists_any_name(store: DatabaseStore, tmp_path: Path) -> None:
    """Enabled state persists for user AND builtin names (facts only)."""
    store.set_enabled("demo", False)
    store.set_enabled("geo", False)  # builtin name — Python records the fact

    assert "demo" in store.disabled_names
    assert "geo" in store.disabled_names

    restarted = DatabaseStore(tmp_path)
    assert "demo" in restarted.disabled_names
    assert "geo" in restarted.disabled_names

    store.set_enabled("geo", True)
    assert "geo" not in store.disabled_names


def test_name_path_traversal_guard(store: DatabaseStore) -> None:
    with pytest.raises(Exception, match="name must match"):
        store.put_database(_manifest(name="../evil"))
    with pytest.raises(Exception, match="name must match"):
        store.put_database(_manifest(name="a/b"))


def test_corrupt_state_file_never_crashes(tmp_path: Path) -> None:
    state_path = tmp_path / "state.json"
    state_path.write_text("{not json", encoding="utf-8")
    store = DatabaseStore(tmp_path)
    assert store.disabled_names == frozenset()
    # and it can still save afterwards
    store.set_enabled("demo", False)
    assert "demo" in store.disabled_names


def test_corrupt_manifest_skipped_not_crashed(tmp_path: Path) -> None:
    databases_dir = tmp_path / "databases"
    databases_dir.mkdir()
    (databases_dir / "broken.json").write_text("{not json", encoding="utf-8")
    (databases_dir / "bad_schema.json").write_text(
        json.dumps({"schema_version": "9.9", "name": "bad_schema"}),
        encoding="utf-8",
    )
    store = DatabaseStore(tmp_path)
    assert store.list_databases() == []


def test_manifest_name_must_match_filename(store: DatabaseStore) -> None:
    """A manifest whose name differs from its filename is ignored (safety)."""
    store.put_database(_manifest())
    # rename on disk behind the store's back
    (store._databases_dir / "demo.json").rename(
        store._databases_dir / "renamed.json"
    )
    assert store.get_database("demo") is None
    assert store.get_database("renamed") is None


def test_user_only_projection(store: DatabaseStore) -> None:
    """Phase 8: Python no longer knows builtin databases — list is user-only."""
    store.set_enabled("geo", False)  # builtin toggle still persists
    entries = store.list_databases()
    assert all(entry.origin == "package" for entry in entries)
    assert store.get_database("geo") is None


def test_no_forbidden_imports_in_database_package() -> None:
    """Architecture guard: database/ modules must not import backend/app,
    agents, fastapi, uvicorn or any scientific stack. Only import lines are
    scanned — historical docstrings may mention the retired runtime."""
    import inspect
    import pathlib

    import database

    package_dir = pathlib.Path(inspect.getfile(database)).parent
    forbidden = ("backend", "app.", "agents", "fastapi", "uvicorn",
                 "playwright", "pdfplumber", "scipy", "matplotlib", "seaborn")
    for source in package_dir.glob("*.py"):
        for line in source.read_text(encoding="utf-8").splitlines():
            stripped = line.lstrip()
            if not (stripped.startswith("import ") or stripped.startswith("from ")):
                continue
            for token in forbidden:
                assert token not in line, (
                    f"{source.name} must not import {token!r}: {line.strip()}"
                )
