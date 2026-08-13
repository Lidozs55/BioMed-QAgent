#!/usr/bin/env python3
"""Biomed DB bridge — JSONL named-operation protocol (migration plan §15).

Phase 5 (P5-10/P5-11) boundary: the only Python the TS product path may call
is this bridge. It exposes **named operations only** — never arbitrary SQL and
never business tool modules:

    cache.*        local dataset cache (search/describe/get/commit/list)
    database.*     user declarative database manifests (list/get/save/patch/
                   delete/set_enabled)

Protocol (stdin/stdout JSONL, one object per line):

    → {"version":"1","id":"req_1","op":"cache.search","args":{"query":"TP53"}}
    ← {"version":"1","id":"req_1","ok":true,"data":[...]}
    ← {"version":"1","id":"req_1","ok":false,"error":{"code":"not_found","message":"..."}}

stderr carries human-readable logs only. The process is managed by the TS
DatabaseClient (server/src/persistence/db-client.ts); it exits cleanly on EOF.

Phase 5 reuses the existing Python stores behind the facade
(app/tools/cache_store.py, app/databases/store.py — rollback-only modules);
Phase 8 may move them under database/ without changing the protocol.

Usage:
    python database/bridge.py --cache-dir <dir> --databases-dir <dir>
    python database/bridge.py --self-test
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import traceback
from pathlib import Path
from typing import Any

PROTOCOL_VERSION = "1"


def _error(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}


class Bridge:
    """Named-operation facade over the cache + database stores."""

    def __init__(self, backend_root: Path, cache_dir: Path | None, databases_dir: Path | None) -> None:
        sys.path.insert(0, str(backend_root))
        from app.tools.cache_store import init_cache_store
        from app.databases.store import DatabaseStore

        self._cache = init_cache_store(cache_dir) if cache_dir else init_cache_store()
        self._databases = DatabaseStore(databases_dir or Path("data/databases"))

    # ── cache ops ────────────────────────────────────────────────────────────

    def _cache_manifest(self, manifest: Any) -> dict[str, Any]:
        return {
            "dataset_id": manifest.dataset_id,
            "source_namespace": manifest.source_namespace,
            "topic": manifest.topic,
            "description": manifest.description,
            "row_count": manifest.row_count,
            "column_count": manifest.column_count,
            "created_at": manifest.created_at,
            "created_by_task_id": manifest.created_by_task_id,
            "source_files": manifest.source_files,
            "extra": manifest.extra,
            "keywords": manifest.keywords or [],
        }

    def cache_commit(self, args: dict[str, Any]) -> dict[str, Any]:
        manifest = self._cache.commit_dataset(
            dataset_id=str(args["dataset_id"]),
            source_namespace=str(args["source_namespace"]),
            topic=str(args["topic"]),
            description=str(args["description"]),
            csv_rows=[
                {str(key): str(value) for key, value in row.items()}
                for row in args["csv_rows"]
            ],
            created_by_task_id=str(args.get("created_by_task_id", "")),
            source_files=[str(name) for name in args.get("source_files", [])],
            extra=dict(args.get("extra", {})),
            keywords=[str(k) for k in args.get("keywords", [])] or None,
        )
        return self._cache_manifest(manifest)

    def cache_search(self, args: dict[str, Any]) -> list[dict[str, Any]]:
        manifests = self._cache.search_datasets(
            str(args["query"]), limit=int(args.get("limit", 20))
        )
        return [self._cache_manifest(m) for m in manifests]

    def cache_list(self, args: dict[str, Any]) -> list[dict[str, Any]]:
        namespace = args.get("source_namespace")
        manifests = self._cache.list_datasets(
            source_namespace=str(namespace) if namespace else None,
            limit=int(args.get("limit", 50)),
        )
        return [self._cache_manifest(m) for m in manifests]

    def cache_describe(self, args: dict[str, Any]) -> dict[str, Any] | None:
        manifest = self._cache.describe_dataset(
            str(args["source_namespace"]), str(args["dataset_id"])
        )
        return self._cache_manifest(manifest) if manifest else None

    def cache_get(self, args: dict[str, Any]) -> dict[str, Any] | None:
        result = self._cache.get_dataset(
            str(args["source_namespace"]), str(args["dataset_id"])
        )
        if result is None:
            return None
        manifest, rows = result
        return {"manifest": self._cache_manifest(manifest), "rows": rows}

    # ── database ops ─────────────────────────────────────────────────────────

    def _database_entry(self, entry: Any) -> dict[str, Any]:
        manifest = entry.declarative_manifest
        return {
            "id": entry.id,
            "name": entry.name,
            "category": entry.category,
            "description": entry.description,
            "origin": entry.origin,
            "version": entry.version,
            "pipeline_supported": entry.pipeline_supported,
            "capability": entry.capability,
            "available": entry.available,
            "enabled": entry.enabled,
            "declarative_manifest": (
                self._databases.redacted_manifest_dump(manifest) if manifest else None
            ),
        }

    def database_list(self, args: dict[str, Any]) -> list[dict[str, Any]]:
        return [self._database_entry(entry) for entry in self._databases.list_databases()]

    def database_get(self, args: dict[str, Any]) -> dict[str, Any] | None:
        entry = self._databases.get_database(str(args["name"]))
        return self._database_entry(entry) if entry else None

    def database_tool_manifests(self, args: dict[str, Any]) -> list[dict[str, Any]]:
        """Raw enabled user manifests for TS tool registration.

        Deliberately NOT redacted (unlike database.list): the TS host needs
        header names / auth references to build executable tools. The bridge
        is local IPC; secret VALUES never appear in manifests — only env
        references — so this leaks nothing to the model.
        """
        disabled = self._databases.disabled_names
        return [
            manifest.model_dump(mode="json")
            for manifest in self._databases.user_manifests().values()
            if manifest.name not in disabled
        ]

    def database_save(self, args: dict[str, Any]) -> dict[str, Any]:
        from app.databases.declarative import DatabaseValidationError

        try:
            manifest = self._databases.put_database(dict(args["manifest"]))
        except DatabaseValidationError as exc:
            return _error("validation", str(exc))
        return {"ok": True, "data": self._databases.redacted_manifest_dump(manifest)}

    def database_patch(self, args: dict[str, Any]) -> dict[str, Any]:
        from app.databases.declarative import DatabaseValidationError

        try:
            manifest = self._databases.patch_database(str(args["name"]), dict(args["patch"]))
        except DatabaseValidationError as exc:
            return _error("validation", str(exc))
        except KeyError as exc:
            return _error("not_found", str(exc))
        except PermissionError as exc:
            return _error("forbidden", str(exc))
        return {"ok": True, "data": self._databases.redacted_manifest_dump(manifest)}

    def database_delete(self, args: dict[str, Any]) -> dict[str, Any]:
        try:
            self._databases.delete_database(str(args["name"]))
        except KeyError as exc:
            return _error("not_found", str(exc))
        except PermissionError as exc:
            return _error("forbidden", str(exc))
        return {"ok": True, "data": {"deleted": str(args["name"])}}

    def database_set_enabled(self, args: dict[str, Any]) -> dict[str, Any]:
        name = str(args["name"])
        enabled = bool(args["enabled"])
        self._databases.set_enabled(name, enabled)
        return {"ok": True, "data": {"name": name, "enabled": enabled}}

    # ── dispatch ─────────────────────────────────────────────────────────────

    def dispatch(self, op: str, args: dict[str, Any]) -> dict[str, Any]:
        handlers = {
            "ping": lambda _a: {"ok": True, "data": {"service": "biomed-db-bridge", "version": PROTOCOL_VERSION}},
            "cache.commit": self.cache_commit,
            "cache.search": self.cache_search,
            "cache.list": self.cache_list,
            "cache.describe": self.cache_describe,
            "cache.get": self.cache_get,
            "database.list": self.database_list,
            "database.get": self.database_get,
            "database.tool_manifests": self.database_tool_manifests,
            "database.save": self.database_save,
            "database.patch": self.database_patch,
            "database.delete": self.database_delete,
            "database.set_enabled": self.database_set_enabled,
        }
        handler = handlers.get(op)
        if handler is None:
            return _error("unknown_op", f"unknown operation: {op}")
        try:
            result = handler(args)
        except (KeyError, TypeError, ValueError) as exc:
            return _error("validation", str(exc))
        except Exception as exc:  # noqa: BLE001 — bridge must never die on one op
            traceback.print_exc(file=sys.stderr)
            return _error("internal", f"{type(exc).__name__}: {exc}")
        if isinstance(result, dict) and "ok" in result:
            return result
        return {"ok": True, "data": result}


def _serve(bridge: Bridge) -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            sys.stdout.write(json.dumps(
                {"version": PROTOCOL_VERSION, "id": None, "ok": False,
                 "error": {"code": "protocol", "message": f"invalid JSON: {exc}"}}
            ) + "\n")
            sys.stdout.flush()
            continue
        request_id = request.get("id")
        version = request.get("version")
        if version != PROTOCOL_VERSION:
            sys.stdout.write(json.dumps(
                {"version": PROTOCOL_VERSION, "id": request_id, "ok": False,
                 "error": {"code": "protocol", "message": f"unsupported protocol version: {version}"}}
            ) + "\n")
            sys.stdout.flush()
            continue
        op = request.get("op")
        args = request.get("args")
        if not isinstance(op, str) or not isinstance(args, dict):
            sys.stdout.write(json.dumps(
                {"version": PROTOCOL_VERSION, "id": request_id, "ok": False,
                 "error": {"code": "protocol", "message": "request requires string op and object args"}}
            ) + "\n")
            sys.stdout.flush()
            continue
        response = bridge.dispatch(op, args)
        if "ok" not in response:
            response = {"ok": True, "data": response}
        sys.stdout.write(json.dumps(
            {"version": PROTOCOL_VERSION, "id": request_id, **response},
            ensure_ascii=False,
        ) + "\n")
        sys.stdout.flush()
    return 0


def _self_test() -> int:
    with tempfile.TemporaryDirectory(prefix="biomed-bridge-") as tmp:
        bridge = Bridge(
            backend_root=Path(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend")),
            cache_dir=Path(tmp) / "cache",
            databases_dir=Path(tmp) / "databases",
        )
        assert bridge.dispatch("ping", {})["ok"] is True
        manifest = bridge.dispatch("cache.commit", {
            "dataset_id": "ds_self_test",
            "source_namespace": "user_import",
            "topic": "self test",
            "description": "bridge self-test dataset",
            "csv_rows": [{"record_id": "r1", "dataset_id": "ds_self_test", "source_id": "src", "asset_id": "asset", "gene_id": "TP53"}],
            "created_by_task_id": "self_test",
        })
        assert manifest["ok"] is True and manifest["data"]["row_count"] == 1
        found = bridge.dispatch("cache.search", {"query": "self test", "limit": 5})
        assert found["ok"] is True and found["data"][0]["dataset_id"] == "ds_self_test"
        loaded = bridge.dispatch("cache.get", {"source_namespace": "user_import", "dataset_id": "ds_self_test"})
        assert loaded["ok"] is True and len(loaded["data"]["rows"]) == 1
        saved = bridge.dispatch("database.save", {"manifest": {
            "schema_version": "1.0",
            "name": "demo",
            "display_name": "Demo",
            "version": "1.0.0",
            "category": "discovery",
            "description": "self-test declarative database",
            "supported_sources": [],
            "operations": [],
            "enabled": True,
            "user_selectable": True,
            "pipeline_supported": False,
            "requirements": [],
        }})
        assert saved["ok"] is True, saved
        listed = bridge.dispatch("database.list", {})
        assert any(e["name"] == "demo" for e in listed["data"])
        deleted = bridge.dispatch("database.delete", {"name": "demo"})
        assert deleted["ok"] is True
        unknown = bridge.dispatch("sql.exec", {})
        assert unknown["ok"] is False and unknown["error"]["code"] == "unknown_op"
    print("SELF-TEST OK")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Biomed DB bridge (named-op JSONL)")
    parser.add_argument("--backend-root", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
    parser.add_argument("--cache-dir", default=None)
    parser.add_argument("--databases-dir", default=None)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        return _self_test()
    bridge = Bridge(
        backend_root=Path(args.backend_root),
        cache_dir=Path(args.cache_dir) if args.cache_dir else None,
        databases_dir=Path(args.databases_dir) if args.databases_dir else None,
    )
    return _serve(bridge)


if __name__ == "__main__":
    sys.exit(main())
