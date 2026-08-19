"""Bridge protocol tests — JSONL named-operation boundary (Phase 8).

Covers:
  - ping / protocol version / malformed JSON / unknown op
  - cache.* and database.* named operations (no arbitrary SQL)
  - EOF clean shutdown via real subprocess
  - restart persistence via real subprocess
  - path traversal rejection via database.save
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import pytest
from database.bridge import PROTOCOL_VERSION, Bridge

REPO_ROOT = Path(__file__).resolve().parents[2]


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
def bridge(tmp_path: Path) -> Bridge:
    return Bridge(cache_dir=tmp_path / "cache", databases_dir=tmp_path / "databases")


# ── direct dispatch ────────────────────────────────────────────────────


def test_ping(bridge: Bridge) -> None:
    response = bridge.dispatch("ping", {})
    assert response["ok"] is True
    assert response["data"]["service"] == "biomed-db-bridge"
    assert response["data"]["version"] == PROTOCOL_VERSION


def test_unknown_op_rejected(bridge: Bridge) -> None:
    response = bridge.dispatch("sql.exec", {})
    assert response["ok"] is False
    assert response["error"]["code"] == "unknown_op"
    response = bridge.dispatch("db.raw_query", {})
    assert response["ok"] is False
    assert response["error"]["code"] == "unknown_op"


def test_cache_round_trip(bridge: Bridge) -> None:
    commit = bridge.dispatch("cache.commit", {
        "dataset_id": "ds1",
        "source_namespace": "user_import",
        "topic": "TP53 cohort",
        "description": "fixture",
        "csv_rows": [
            {"gene": "TP53", "sample": "S1", "value": "1.5"},
            {"gene": "TP53", "sample": "S2", "value": "2.5"},
        ],
        "created_by_task_id": "task1",
        "keywords": ["TP53"],
    })
    assert commit["ok"] is True
    assert commit["data"]["row_count"] == 2
    assert commit["data"]["column_count"] == 3
    assert commit["data"]["columns"] == ["gene", "sample", "value"]

    search = bridge.dispatch("cache.search", {"query": "TP53", "limit": 5})
    assert search["ok"] is True
    assert search["data"][0]["dataset_id"] == "ds1"

    describe = bridge.dispatch("cache.describe", {
        "source_namespace": "user_import", "dataset_id": "ds1",
    })
    assert describe["data"]["topic"] == "TP53 cohort"

    loaded = bridge.dispatch("cache.get", {
        "source_namespace": "user_import", "dataset_id": "ds1",
    })
    assert len(loaded["data"]["rows"]) == 2
    assert loaded["data"]["rows"][0]["gene"] == "TP53"


def test_cache_commit_with_asset_files(bridge: Bridge, tmp_path: Path) -> None:
    blob = tmp_path / "raw.bin"
    blob.write_bytes(b"raw payload")
    commit = bridge.dispatch("cache.commit", {
        "dataset_id": "geo_raw1",
        "source_namespace": "geo",
        "topic": "raw download",
        "description": "fixture",
        "csv_rows": [{"sha256": "abc"}],
        "created_by_task_id": "task1",
        "asset_files": {"raw.bin": {"path": str(blob), "media_type": "application/octet-stream"}},
    })
    assert commit["ok"] is True
    assert commit["data"]["extra"]["asset_files"][0]["name"] == "raw.bin"
    assert commit["data"]["extra"]["asset_files"][0]["relative_path"] == "assets/raw.bin"

    stored = bridge._cache.root / "records" / "geo" / "geo_raw1" / "assets" / "raw.bin"
    assert stored.is_file()
    assert stored.read_bytes() == b"raw payload"


def test_cache_delete_and_clear(bridge: Bridge) -> None:
    for dataset_id in ("ds1", "ds2"):
        commit = bridge.dispatch("cache.commit", {
            "dataset_id": dataset_id,
            "source_namespace": "user_import",
            "topic": f"topic {dataset_id}",
            "description": "fixture",
            "csv_rows": [{"gene": "TP53", "sample": "S1", "value": "1.5"}],
            "created_by_task_id": "task1",
            "keywords": [dataset_id],
        })
        assert commit["ok"] is True

    deleted = bridge.dispatch("cache.delete", {
        "source_namespace": "user_import", "dataset_id": "ds1",
    })
    assert deleted["ok"] is True
    assert deleted["data"]["deleted"] is True
    assert bridge.dispatch("cache.search", {"query": "ds1", "limit": 5})["data"] == []
    assert len(bridge.dispatch("cache.list", {})["data"]) == 1

    missing = bridge.dispatch("cache.delete", {
        "source_namespace": "user_import", "dataset_id": "nope",
    })
    assert missing["data"]["deleted"] is False

    cleared = bridge.dispatch("cache.clear", {})
    assert cleared["ok"] is True
    assert cleared["data"]["deleted"] == 1
    assert bridge.dispatch("cache.list", {})["data"] == []


def test_database_save_list_disabled_delete(bridge: Bridge) -> None:
    saved = bridge.dispatch("database.save", {"manifest": _manifest()})
    assert saved["ok"] is True
    assert saved["data"]["name"] == "demo"

    listed = bridge.dispatch("database.list", {})
    assert [e["name"] for e in listed["data"]] == ["demo"]
    assert listed["data"][0]["origin"] == "package"

    toggled = bridge.dispatch("database.set_enabled", {"name": "demo", "enabled": False})
    assert toggled["ok"] is True
    disabled = bridge.dispatch("database.disabled", {})
    assert "demo" in disabled["data"]["disabled"]

    deleted = bridge.dispatch("database.delete", {"name": "demo"})
    assert deleted["ok"] is True
    assert bridge.dispatch("database.list", {})["data"] == []


def test_database_save_validation_error(bridge: Bridge) -> None:
    response = bridge.dispatch("database.save", {"manifest": _manifest(name="Bad")})
    assert response["ok"] is False
    assert response["error"]["code"] == "validation"


def test_database_save_path_traversal_rejected(bridge: Bridge) -> None:
    response = bridge.dispatch("database.save", {"manifest": _manifest(name="../evil")})
    assert response["ok"] is False
    assert response["error"]["code"] == "validation"


def test_database_patch_not_found(bridge: Bridge) -> None:
    response = bridge.dispatch("database.patch", {"name": "nope", "patch": {}})
    assert response["ok"] is False
    assert response["error"]["code"] == "not_found"


def test_database_tool_manifests_returns_user_manifests(bridge: Bridge) -> None:
    bridge.dispatch("database.save", {"manifest": _manifest()})
    manifests = bridge.dispatch("database.tool_manifests", {})
    assert manifests["ok"] is True
    assert [m["name"] for m in manifests["data"]] == ["demo"]
    # disabled manifests are excluded
    bridge.dispatch("database.set_enabled", {"name": "demo", "enabled": False})
    manifests = bridge.dispatch("database.tool_manifests", {})
    assert manifests["data"] == []


# ── subprocess protocol ─────────────────────────────────────────────────


def _spawn_bridge(tmp: Path) -> subprocess.Popen:
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.Popen(
        [sys.executable, str(REPO_ROOT / "database" / "bridge.py"),
         "--cache-dir", str(tmp / "cache"),
         "--databases-dir", str(tmp / "databases")],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        cwd=REPO_ROOT,
        env=env,
    )


def _request(proc: subprocess.Popen, op: str, args: dict[str, Any]) -> dict[str, Any]:
    assert proc.stdin is not None and proc.stdout is not None
    proc.stdin.write(json.dumps({
        "version": PROTOCOL_VERSION, "id": f"req_{op}", "op": op, "args": args,
    }) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    assert line, "bridge produced no response"
    return json.loads(line)


def test_subprocess_ping_and_unknown_op() -> None:
    with tempfile.TemporaryDirectory(prefix="bridge-proto-") as tmp:
        proc = _spawn_bridge(Path(tmp))
        try:
            response = _request(proc, "ping", {})
            assert response["ok"] is True
            assert response["id"] == "req_ping"

            response = _request(proc, "sql.exec", {})
            assert response["ok"] is False
            assert response["error"]["code"] == "unknown_op"
        finally:
            proc.stdin.close()
            proc.wait(timeout=10)


def test_subprocess_malformed_json_rejected() -> None:
    with tempfile.TemporaryDirectory(prefix="bridge-proto-") as tmp:
        proc = _spawn_bridge(Path(tmp))
        try:
            assert proc.stdin is not None and proc.stdout is not None
            proc.stdin.write("{not json}\n")
            proc.stdin.flush()
            line = proc.stdout.readline()
            response = json.loads(line)
            assert response["ok"] is False
            assert response["error"]["code"] == "protocol"
        finally:
            proc.stdin.close()
            proc.wait(timeout=10)


def test_subprocess_wrong_version_rejected() -> None:
    with tempfile.TemporaryDirectory(prefix="bridge-proto-") as tmp:
        proc = _spawn_bridge(Path(tmp))
        try:
            assert proc.stdin is not None and proc.stdout is not None
            proc.stdin.write(json.dumps({
                "version": "999", "id": "req_v", "op": "ping", "args": {},
            }) + "\n")
            proc.stdin.flush()
            response = json.loads(proc.stdout.readline())
            assert response["ok"] is False
            assert response["error"]["code"] == "protocol"
        finally:
            proc.stdin.close()
            proc.wait(timeout=10)


def test_subprocess_eof_clean_shutdown() -> None:
    with tempfile.TemporaryDirectory(prefix="bridge-proto-") as tmp:
        proc = _spawn_bridge(Path(tmp))
        proc.stdin.close()
        assert proc.wait(timeout=10) == 0


def test_subprocess_restart_persistence() -> None:
    with tempfile.TemporaryDirectory(prefix="bridge-proto-") as tmp:
        root = Path(tmp)
        proc = _spawn_bridge(root)
        try:
            _request(proc, "database.save", {"manifest": _manifest()})
            _request(proc, "cache.commit", {
                "dataset_id": "ds1",
                "source_namespace": "user_import",
                "topic": "TP53 cohort",
                "description": "d",
                "csv_rows": [{"gene": "TP53"}],
                "created_by_task_id": "task1",
            })
        finally:
            proc.stdin.close()
            proc.wait(timeout=10)

        # restart: same data dir → same facts
        proc = _spawn_bridge(root)
        try:
            listed = _request(proc, "database.list", {})
            assert [e["name"] for e in listed["data"]] == ["demo"]
            found = _request(proc, "cache.search", {"query": "TP53", "limit": 5})
            assert found["data"][0]["dataset_id"] == "ds1"
        finally:
            proc.stdin.close()
            proc.wait(timeout=10)


def test_self_test_entrypoint() -> None:
    result = subprocess.run(
        [sys.executable, str(REPO_ROOT / "database" / "bridge.py"), "--self-test"],
        capture_output=True,
        text=True,
        cwd=REPO_ROOT,
        timeout=60,
    )
    assert result.returncode == 0, result.stderr
    assert "SELF-TEST OK" in result.stdout
