"""Declarative database 持久化存储 — Phase 8 独立边界。

从 ``backend/app/databases/store.py`` 迁入。Phase 8 拆分了原 DatabaseStore
混合的三类职责：

    TS 侧（server/src/product/builtin-databases.ts + declarative-db.ts）
    ├─ builtin database catalogue（内置数据库元数据）
    ├─ declarative manifest 业务校验
    ├─ HTTP Tool construction
    └─ secret/auth handling

    Python database/database_store.py（本模块，只存事实）
    ├─ state.json（enabled/disabled 状态）
    ├─ 用户 manifest JSON 持久化（<root>/databases/<name>.json）
    └─ 原子写 / 路径安全校验

本模块不 import Agent / Skill / FastAPI / Dataset Core。内置数据库的
enabled 开关仍持久化在这里（``set_enabled`` 接受任意名称，包括内置名）。

Persistence safety:
- user manifests live under ``<root>/databases/<name>.json`` where ``<name>``
  is validated against ``^[a-z][a-z0-9_]*$`` before touching the filesystem;
- writes are atomic (tempfile + os.replace), so a crash never truncates
  ``state.json`` or a manifest.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    # package context (pytest / installed package): database/ is a package
    from database.declarative import (
        DatabaseValidationError,
        DeclarativeDatabaseManifest,
        redact_sensitive_manifest,
    )
except ImportError:
    # script context (``python database/bridge.py``): flat sibling import
    from declarative import (  # type: ignore[no-redef]
        DatabaseValidationError,
        DeclarativeDatabaseManifest,
        redact_sensitive_manifest,
    )

_STATE_VERSION = 1
_DEFAULT_STATE: dict[str, Any] = {"version": _STATE_VERSION, "disabled": []}
_MANIFEST_NAME = re.compile(r"^[a-z][a-z0-9_]*$")


def _atomic_write_text(path: Path, content: str) -> None:
    """Write text atomically so a crash never leaves a truncated file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except BaseException:
        with suppress(OSError):
            os.unlink(temp_name)
        raise


@dataclass(frozen=True, slots=True)
class DatabaseEntry:
    """One user-selectable database (user-declared manifests only).

    Phase 8: builtin database entries are served by the TS builtin catalogue
    (``server/src/product/builtin-databases.ts``); this persistence layer only
    projects user manifests.
    """

    id: str
    name: str
    category: str
    description: str
    origin: str
    version: str
    pipeline_supported: bool
    capability: str
    available: bool = True
    enabled: bool = True
    declarative_manifest: DeclarativeDatabaseManifest | None = None


class DatabaseStore:
    """Persist enabled/disabled state and user declarative databases."""

    def __init__(self, root: Path) -> None:
        self._root = Path(root)
        self._databases_dir = self._root / "databases"
        self._state_path = self._root / "state.json"
        self._state: dict[str, Any] = self._load_state()

    # ── persistence ─────────────────────────────────────────────────────────

    def _load_state(self) -> dict[str, Any]:
        try:
            raw = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError, UnicodeDecodeError):
            return dict(_DEFAULT_STATE)
        if not isinstance(raw, dict):
            return dict(_DEFAULT_STATE)
        disabled = raw.get("disabled")
        if not isinstance(disabled, list) or any(
            not isinstance(name, str) for name in disabled
        ):
            disabled = []
        return {"version": raw.get("version", _STATE_VERSION), "disabled": disabled}

    def _save_state(self) -> None:
        _atomic_write_text(
            self._state_path,
            json.dumps(self._state, ensure_ascii=False, indent=2) + "\n",
        )

    def _manifest_path(self, name: str) -> Path:
        if _MANIFEST_NAME.fullmatch(name) is None:
            raise DatabaseValidationError(
                f"database name must match {_MANIFEST_NAME.pattern}"
            )
        return self._databases_dir / f"{name}.json"

    def _load_user_manifests(self) -> dict[str, DeclarativeDatabaseManifest]:
        manifests: dict[str, DeclarativeDatabaseManifest] = {}
        if not self._databases_dir.is_dir():
            return manifests
        for path in sorted(self._databases_dir.glob("*.json")):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                manifest = DeclarativeDatabaseManifest.parse(raw)
            except (DatabaseValidationError, ValueError, json.JSONDecodeError, UnicodeDecodeError):
                continue  # corrupt user manifest: skip, never crash startup
            if manifest.name == path.stem:
                manifests[manifest.name] = manifest
        return manifests

    # ── queries ──────────────────────────────────────────────────────────────

    @property
    def disabled_names(self) -> frozenset[str]:
        return frozenset(self._state["disabled"])

    def user_manifests(self) -> dict[str, DeclarativeDatabaseManifest]:
        return self._load_user_manifests()

    def list_databases(self) -> list[DatabaseEntry]:
        """User-declared databases only (builtin catalogue lives in TS)."""
        entries: list[DatabaseEntry] = []
        disabled = self.disabled_names
        for manifest in self.user_manifests().values():
            entries.append(
                DatabaseEntry(
                    id=manifest.name,
                    name=manifest.name,
                    category=manifest.category,
                    description=manifest.description,
                    origin="package",
                    version=manifest.version,
                    pipeline_supported=False,
                    capability="research_only",
                    enabled=manifest.name not in disabled,
                    declarative_manifest=manifest,
                )
            )
        return entries

    def get_database(self, name: str) -> DatabaseEntry | None:
        for entry in self.list_databases():
            if entry.name == name:
                return entry
        return None

    def redacted_manifest_dump(self, manifest: DeclarativeDatabaseManifest) -> dict[str, Any]:
        """Serialize a manifest for API responses with sensitive keys redacted."""
        return redact_sensitive_manifest(manifest.to_dict())  # type: ignore[return-value]

    # ── mutations ────────────────────────────────────────────────────────────

    def set_enabled(self, name: str, enabled: bool) -> None:
        """Toggle any database (builtin or user) enabled state.

        Phase 8: the TS side decides whether ``name`` is a builtin; this
        persistence layer only records the fact.
        """
        disabled = list(self._state["disabled"])
        if enabled and name in disabled:
            disabled.remove(name)
        if not enabled and name not in disabled:
            disabled.append(name)
        self._state["disabled"] = sorted(disabled)
        self._save_state()

    def put_database(self, raw: dict[str, Any]) -> DeclarativeDatabaseManifest:
        try:
            manifest = DeclarativeDatabaseManifest.parse(raw)
        except DatabaseValidationError:
            raise
        except ValueError as error:
            raise DatabaseValidationError(str(error)) from error
        if manifest.name in self.user_manifests():
            raise DatabaseValidationError(
                f"database already exists; use PUT to update: {manifest.name}"
            )
        return self._write_manifest(manifest)

    def _write_manifest(
        self, manifest: DeclarativeDatabaseManifest
    ) -> DeclarativeDatabaseManifest:
        self._databases_dir.mkdir(parents=True, exist_ok=True)
        _atomic_write_text(
            self._manifest_path(manifest.name),
            json.dumps(manifest.to_dict(), ensure_ascii=False, indent=2) + "\n",
        )
        return manifest

    def patch_database(self, name: str, patch: dict[str, Any]) -> DeclarativeDatabaseManifest:
        current = self._load_user_manifests().get(name)
        if current is None:
            raise KeyError(name)
        if "name" in patch and patch["name"] != name:
            raise ValueError("database name cannot be changed by patch")
        merged = current.to_dict() | patch
        try:
            manifest = DeclarativeDatabaseManifest.parse(merged)
        except DatabaseValidationError:
            raise
        except ValueError as error:
            raise DatabaseValidationError(str(error)) from error
        return self._write_manifest(manifest)

    def delete_database(self, name: str) -> None:
        # Resolve only through the validated user-manifest registry so the raw
        # URL path parameter can never escape the databases directory.
        if name not in self._load_user_manifests():
            raise KeyError(name)
        self._manifest_path(name).unlink()
        self.set_enabled(name, True)
