"""Thin declarative database store — the Phase 2 replacement for UserSkillStore.

Manages the user-selectable database list: builtin databases derived from the
builtin skill table (with per-database enabled toggles) plus user-declared
JSON/HTTP databases. No ZIP packages, no Python code execution, no runtime
skill catalog (docs/migration/phase2-skills-tools-migration.md, decision D4).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from agents import FunctionTool

from app.databases.declarative import (
    DatabaseValidationError,
    DeclarativeDatabaseManifest,
    DeclarativeHttpToolBuilder,
)
from app.skills.builtin import builtin_skill_records

_STATE_VERSION = 1
_DEFAULT_STATE: dict[str, Any] = {"version": _STATE_VERSION, "disabled": []}


@dataclass(frozen=True, slots=True)
class DatabaseEntry:
    """One user-selectable database (builtin or user-declared)."""

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
    """Persist builtin database toggles and user declarative databases."""

    def __init__(self, root: Path) -> None:
        self._root = Path(root)
        self._databases_dir = self._root / "databases"
        self._state_path = self._root / "state.json"
        self._records = builtin_skill_records()
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
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        self._state_path.write_text(
            json.dumps(self._state, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    def _manifest_path(self, name: str) -> Path:
        return self._databases_dir / f"{name}.json"

    def _load_user_manifests(self) -> dict[str, DeclarativeDatabaseManifest]:
        manifests: dict[str, DeclarativeDatabaseManifest] = {}
        if not self._databases_dir.is_dir():
            return manifests
        for path in sorted(self._databases_dir.glob("*.json")):
            try:
                raw = json.loads(path.read_text(encoding="utf-8"))
                manifest = DeclarativeDatabaseManifest.model_validate(raw)
            except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
                continue  # corrupt user manifest: skip, never crash startup
            if manifest.name == path.stem:
                manifests[manifest.name] = manifest
        return manifests

    # ── queries ──────────────────────────────────────────────────────────────

    @property
    def disabled_names(self) -> frozenset[str]:
        return frozenset(self._state["disabled"])

    def disabled_builtin_names(self) -> frozenset[str]:
        return frozenset(
            name for name in self.disabled_names if name in self._records
        )

    def user_manifests(self) -> dict[str, DeclarativeDatabaseManifest]:
        return self._load_user_manifests()

    def list_databases(self) -> list[DatabaseEntry]:
        entries: list[DatabaseEntry] = []
        disabled = self.disabled_names
        for name, record in self._records.items():
            if not record.user_selectable:
                continue
            entries.append(
                DatabaseEntry(
                    id=name,
                    name=name,
                    category=record.category.value,
                    description=record.description,
                    origin="builtin",
                    version=record.version,
                    pipeline_supported=record.pipeline_supported,
                    capability=(
                        "pipeline_supported"
                        if record.pipeline_supported
                        else "research_only"
                    ),
                    enabled=name not in disabled,
                )
            )
        for manifest in self.user_manifests().values():
            entries.append(
                DatabaseEntry(
                    id=manifest.name,
                    name=manifest.name,
                    category=manifest.category.value,
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

    def build_user_http_tools(self) -> list[FunctionTool]:
        """Direct tools for enabled user-declared HTTP databases."""
        builder = DeclarativeHttpToolBuilder()
        disabled = self.disabled_names
        tools: list[FunctionTool] = []
        for manifest in self.user_manifests().values():
            if manifest.name in disabled:
                continue
            for operation in manifest.operations:
                tools.append(builder.build_tool(operation))
        return tools

    # ── mutations ────────────────────────────────────────────────────────────

    def set_enabled(self, name: str, enabled: bool) -> None:
        disabled = list(self._state["disabled"])
        if enabled and name in disabled:
            disabled.remove(name)
        if not enabled and name not in disabled:
            disabled.append(name)
        self._state["disabled"] = sorted(disabled)
        self._save_state()

    def put_database(self, raw: dict[str, Any]) -> DeclarativeDatabaseManifest:
        try:
            manifest = DeclarativeDatabaseManifest.model_validate(raw)
        except ValueError as error:
            raise DatabaseValidationError(str(error)) from error
        self._databases_dir.mkdir(parents=True, exist_ok=True)
        self._manifest_path(manifest.name).write_text(
            json.dumps(manifest.model_dump(mode="json"), ensure_ascii=False, indent=2)
            + "\n",
            encoding="utf-8",
        )
        return manifest

    def patch_database(self, name: str, patch: dict[str, Any]) -> DeclarativeDatabaseManifest:
        current = self._load_user_manifests().get(name)
        if current is None:
            raise KeyError(name)
        if "name" in patch and patch["name"] != name:
            raise ValueError("database name cannot be changed by patch")
        merged = current.model_dump(mode="json") | patch
        return self.put_database(merged)

    def delete_database(self, name: str) -> None:
        if name in self._records:
            raise PermissionError("builtin databases cannot be deleted")
        path = self._manifest_path(name)
        if not path.is_file():
            raise KeyError(name)
        path.unlink()
        self.set_enabled(name, True)

    # ── validation ───────────────────────────────────────────────────────────

    def validate_database(self, raw: dict[str, Any]) -> None:
        try:
            DeclarativeDatabaseManifest.model_validate(raw)
        except ValueError as error:
            raise DatabaseValidationError(str(error)) from error
