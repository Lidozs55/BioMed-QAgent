"""SQLite-backed provider and managed-model registry."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path
from threading import RLock
from typing import Any

from app.domain.contracts.ids import generate_prefixed_uuid
from app.model_registry.profiles import param_specs_for
from app.model_registry.schemas import (
    Capabilities,
    ManagedModelCreate,
    ManagedModelRecord,
    ManagedModelUpdate,
    ParameterSpec,
    ProviderCreate,
    ProviderRecord,
    ProviderUpdate,
    utc_now_iso,
)

_SCHEMA = """
CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',
    preset_id TEXT,
    description TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS managed_models (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    context_window INTEGER,
    max_output_tokens INTEGER,
    suggested_max_tokens INTEGER,
    capabilities TEXT NOT NULL DEFAULT '{}',
    params TEXT NOT NULL DEFAULT '{}',
    param_specs TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL DEFAULT 'manual',
    active INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE,
    UNIQUE (provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS parameter_profiles (
    provider_id TEXT NOT NULL,
    model_pattern TEXT NOT NULL DEFAULT '',
    priority INTEGER NOT NULL DEFAULT 10,
    specs_json TEXT NOT NULL,
    PRIMARY KEY (provider_id, model_pattern)
);
"""


def _json_loads(value: str, fallback: Any) -> Any:
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return fallback


def _parse_param_specs(value: str) -> list[ParameterSpec]:
    raw = _json_loads(value, [])
    if not isinstance(raw, list):
        return []
    specs: list[ParameterSpec] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            specs.append(ParameterSpec.model_validate(item))
        except Exception:
            continue
    return specs


class ProviderModelStore:
    """Thread-safe SQLite registry for providers and managed models."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._initialize()

    # ------------------------------------------------------------------
    # Connection helpers
    # ------------------------------------------------------------------

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def _initialize(self) -> None:
        with self._lock, closing(self._connect()) as connection, connection:
            connection.executescript(_SCHEMA)
            self._seed_profiles(connection)

    def _seed_profiles(self, connection: sqlite3.Connection) -> None:
        count = connection.execute(
            "SELECT COUNT(*) FROM parameter_profiles"
        ).fetchone()[0]
        if count > 0:
            return
        rows = [
            (
                "*",
                "",
                100,
                json.dumps(
                    [spec.model_dump(mode="json") for spec in param_specs_for("*")],
                    ensure_ascii=False,
                ),
            )
        ]
        for provider_id in ("dashscope", "openai", "deepseek", "zhipu", "moonshot", "baichuan"):
            rows.append(
                (
                    provider_id,
                    "",
                    10,
                    json.dumps(
                        [spec.model_dump(mode="json") for spec in param_specs_for(provider_id)],
                        ensure_ascii=False,
                    ),
                )
            )
        connection.executemany(
            "INSERT OR REPLACE INTO parameter_profiles"
            " (provider_id, model_pattern, priority, specs_json) VALUES (?, ?, ?, ?)",
            rows,
        )

    # ------------------------------------------------------------------
    # Providers
    # ------------------------------------------------------------------

    def list_providers(self) -> list[ProviderRecord]:
        with self._lock:
            with closing(self._connect()) as connection:
                rows = connection.execute(
                    "SELECT * FROM providers ORDER BY created_at, name"
                ).fetchall()
            return [self._provider_from_row(row) for row in rows]

    def get_provider(self, provider_id: str) -> ProviderRecord | None:
        with self._lock:
            with closing(self._connect()) as connection:
                row = connection.execute(
                    "SELECT * FROM providers WHERE id = ?", (provider_id,)
                ).fetchone()
            return self._provider_from_row(row) if row is not None else None

    def create_provider(self, data: ProviderCreate) -> ProviderRecord:
        now = utc_now_iso()
        record = ProviderRecord(
            id=generate_prefixed_uuid("provider"),
            name=data.name.strip(),
            base_url=data.base_url.strip(),
            api_key=data.api_key,
            preset_id=data.preset_id,
            description=data.description,
            created_at=now,
            updated_at=now,
        )
        with self._lock, closing(self._connect()) as connection, connection:
            try:
                connection.execute(
                    "INSERT INTO providers"
                    " (id, name, base_url, api_key, preset_id, description,"
                    "  enabled, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        record.id,
                        record.name,
                        record.base_url,
                        record.api_key,
                        record.preset_id,
                        record.description,
                        int(record.enabled),
                        record.created_at,
                        record.updated_at,
                    ),
                )
            except sqlite3.IntegrityError as error:
                raise ValueError("供应商名称已存在") from error
        return record

    def update_provider(self, provider_id: str, data: ProviderUpdate) -> ProviderRecord | None:
        updates = data.model_dump(exclude_unset=True, exclude_none=True)
        api_key = data.api_key
        if api_key is not None:
            updates["api_key"] = api_key
        if not updates:
            return self.get_provider(provider_id)
        fields = ", ".join(f"{key} = ?" for key in updates)
        values = [*updates.values(), utc_now_iso(), provider_id]
        with self._lock, closing(self._connect()) as connection, connection:
            try:
                cursor = connection.execute(
                    f"UPDATE providers SET {fields}, updated_at = ? WHERE id = ?",
                    values,
                )
            except sqlite3.IntegrityError as error:
                raise ValueError("供应商名称已存在") from error
            if cursor.rowcount == 0:
                return None
        return self.get_provider(provider_id)

    def delete_provider(self, provider_id: str) -> bool:
        with self._lock, closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                "DELETE FROM providers WHERE id = ?", (provider_id,)
            )
            return cursor.rowcount > 0

    # ------------------------------------------------------------------
    # Managed models
    # ------------------------------------------------------------------

    def list_models(self) -> list[ManagedModelRecord]:
        with self._lock:
            with closing(self._connect()) as connection:
                rows = connection.execute(
                    "SELECT * FROM managed_models ORDER BY provider_id, model_id"
                ).fetchall()
            return [self._model_from_row(row) for row in rows]

    def list_models_with_provider(
        self,
    ) -> list[tuple[ManagedModelRecord, ProviderRecord]]:
        with self._lock:
            with closing(self._connect()) as connection:
                rows = connection.execute(
                    "SELECT m.*, p.id AS p_id, p.name AS p_name, p.base_url AS p_base_url,"
                    " p.api_key AS p_api_key, p.preset_id AS p_preset_id,"
                    " p.description AS p_description, p.enabled AS p_enabled,"
                    " p.created_at AS p_created_at, p.updated_at AS p_updated_at"
                    " FROM managed_models m JOIN providers p ON p.id = m.provider_id"
                    " ORDER BY p.name, m.model_id"
                ).fetchall()
            return [
                (self._model_from_row(row), self._provider_from_row(row, prefix="p_"))
                for row in rows
            ]

    def get_model(self, model_id: str) -> ManagedModelRecord | None:
        with self._lock:
            with closing(self._connect()) as connection:
                row = connection.execute(
                    "SELECT * FROM managed_models WHERE id = ?", (model_id,)
                ).fetchone()
            return self._model_from_row(row) if row is not None else None

    def create_model(self, data: ManagedModelCreate) -> ManagedModelRecord:
        provider = self.get_provider(data.provider_id)
        if provider is None:
            raise ValueError("供应商不存在")
        provider_key = provider.preset_id or provider.name
        specs = self.get_param_specs(provider_key, data.model_id)
        params = dict(data.model_extra or {})
        params.update(data.params or {})
        now = utc_now_iso()
        record = ManagedModelRecord(
            id=generate_prefixed_uuid("model"),
            provider_id=data.provider_id,
            model_id=data.model_id.strip(),
            name=(data.name or data.model_id.strip()),
            description=data.description or "",
            context_window=data.context_window,
            max_output_tokens=data.max_output_tokens,
            suggested_max_tokens=data.suggested_max_tokens,
            capabilities=data.capabilities or Capabilities(),
            params=params,
            param_specs=specs,
            source=data.source,
            created_at=now,
            updated_at=now,
        )
        with self._lock, closing(self._connect()) as connection, connection:
            try:
                connection.execute(
                    "INSERT INTO managed_models"
                    " (id, provider_id, model_id, name, description, context_window,"
                    "  max_output_tokens, suggested_max_tokens, capabilities, params,"
                    "  param_specs, source, active, created_at, updated_at)"
                    " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (
                        record.id,
                        record.provider_id,
                        record.model_id,
                        record.name,
                        record.description,
                        record.context_window,
                        record.max_output_tokens,
                        record.suggested_max_tokens,
                        record.capabilities.model_dump_json(),
                        json.dumps(record.params, ensure_ascii=False),
                        json.dumps(
                            [spec.model_dump(mode="json") for spec in record.param_specs],
                            ensure_ascii=False,
                        ),
                        record.source,
                        int(record.active),
                        record.created_at,
                        record.updated_at,
                    ),
                )
            except sqlite3.IntegrityError as error:
                if "FOREIGN KEY" in str(error):
                    raise ValueError("供应商不存在") from error
                raise ValueError("该供应商下已存在同名模型") from error
        return record

    def update_model(
        self, model_id: str, data: ManagedModelUpdate
    ) -> ManagedModelRecord | None:
        current = self.get_model(model_id)
        if current is None:
            return None
        updates = data.model_dump(exclude_unset=True, exclude_none=True)
        params = current.params
        if data.params is not None or data.model_extra:
            params = dict(data.model_extra or {})
            params.update(current.params)
            if data.params:
                params.update(data.params)
        if "params" in updates:
            updates.pop("params")
        updates["params"] = json.dumps(params, ensure_ascii=False)
        updates["capabilities"] = updates.get("capabilities", current.capabilities)
        capabilities = updates["capabilities"]
        if isinstance(capabilities, Capabilities):
            updates["capabilities"] = capabilities.model_dump_json()
        elif isinstance(capabilities, dict):
            updates["capabilities"] = json.dumps(capabilities, ensure_ascii=False)
        fields = ", ".join(f"{key} = ?" for key in updates)
        values = [*updates.values(), utc_now_iso(), model_id]
        with self._lock, closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                f"UPDATE managed_models SET {fields}, updated_at = ? WHERE id = ?",
                values,
            )
            if cursor.rowcount == 0:
                return None
        return self.get_model(model_id)

    def delete_model(self, model_id: str) -> bool:
        with self._lock, closing(self._connect()) as connection, connection:
            cursor = connection.execute(
                "DELETE FROM managed_models WHERE id = ?", (model_id,)
            )
            return cursor.rowcount > 0

    def set_active_model(self, model_id: str) -> ManagedModelRecord | None:
        with self._lock, closing(self._connect()) as connection, connection:
            connection.execute("UPDATE managed_models SET active = 0")
            cursor = connection.execute(
                "UPDATE managed_models SET active = 1, updated_at = ? WHERE id = ?",
                (utc_now_iso(), model_id),
            )
            if cursor.rowcount == 0:
                return None
        return self.get_model(model_id)

    # ------------------------------------------------------------------
    # Parameter profiles
    # ------------------------------------------------------------------

    def get_param_specs(self, provider_id: str, model_id: str) -> list[ParameterSpec]:
        provider_key = provider_id.strip().lower()
        with self._lock, closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT provider_id, model_pattern, priority, specs_json"
                " FROM parameter_profiles"
                " WHERE provider_id = ? OR provider_id = '*'"
                " ORDER BY provider_id DESC, priority ASC",
                (provider_key,),
            ).fetchall()
        for row in rows:
            pattern = row["model_pattern"]
            if pattern and not model_id.casefold().startswith(pattern.rstrip("*").casefold()):
                continue
            return _parse_param_specs(row["specs_json"])
        return param_specs_for(provider_key)

    # ------------------------------------------------------------------
    # Row adapters
    # ------------------------------------------------------------------

    def _provider_from_row(self, row: sqlite3.Row, prefix: str = "") -> ProviderRecord:
        return ProviderRecord(
            id=row[f"{prefix}id"],
            name=row[f"{prefix}name"],
            base_url=row[f"{prefix}base_url"],
            api_key=row[f"{prefix}api_key"],
            preset_id=row[f"{prefix}preset_id"],
            description=row[f"{prefix}description"],
            enabled=bool(row[f"{prefix}enabled"]),
            created_at=row[f"{prefix}created_at"],
            updated_at=row[f"{prefix}updated_at"],
        )

    def _model_from_row(self, row: sqlite3.Row) -> ManagedModelRecord:
        return ManagedModelRecord(
            id=row["id"],
            provider_id=row["provider_id"],
            model_id=row["model_id"],
            name=row["name"],
            description=row["description"],
            context_window=row["context_window"],
            max_output_tokens=row["max_output_tokens"],
            suggested_max_tokens=row["suggested_max_tokens"],
            capabilities=Capabilities.model_validate(
                _json_loads(row["capabilities"], {"text": True})
            ),
            params=_json_loads(row["params"], {}),
            param_specs=_parse_param_specs(row["param_specs"]),
            source=row["source"],
            active=bool(row["active"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


__all__ = ["ProviderModelStore"]
