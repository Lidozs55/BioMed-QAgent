"""Persistent user model configuration stored outside the application bundle."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from threading import RLock
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, HttpUrl

from app.config import Settings, settings


class AdvancedModelSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    temperature: float = Field(default=0.7, ge=0, le=2)
    top_p: float = Field(default=1.0, ge=0, le=1)
    repetition_penalty: float = Field(default=1.0, ge=0)
    enable_search: bool = False
    thinking_mode: bool = False


class ModelConfiguration(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)

    base_url: HttpUrl
    api_key: str = ""
    model_name: str = Field(min_length=1)
    max_tokens: int = Field(default=8192, ge=1)
    advanced: AdvancedModelSettings = AdvancedModelSettings()


def mask_api_key(value: str) -> str:
    if not value:
        return ""
    if len(value) <= 12:
        return f"{value[:4]}****"
    return f"{value[:8]}...{value[-4:]}"


class ModelSettingsStore:
    """Thread-safe settings snapshot with atomic JSON persistence."""

    def __init__(self, path: Path, *, defaults: Settings = settings) -> None:
        self.path = path
        self._lock = RLock()
        self._defaults = ModelConfiguration(
            base_url=defaults.dashscope_base_url,
            api_key=defaults.dashscope_api_key,
            model_name=defaults.model_name,
        )
        self._current = self._load()

    def snapshot(self) -> ModelConfiguration:
        with self._lock:
            return self._current

    def update(self, changes: dict[str, Any]) -> ModelConfiguration:
        with self._lock:
            payload = self._current.model_dump(mode="json")
            api_key = changes.get("api_key")
            if isinstance(api_key, str) and api_key == mask_api_key(self._current.api_key):
                changes = {key: value for key, value in changes.items() if key != "api_key"}
            advanced_updates = {
                key: changes.pop(key)
                for key in tuple(changes)
                if key in AdvancedModelSettings.model_fields
            }
            if "advanced" in changes:
                advanced_updates.update(changes.pop("advanced"))
            payload.update(changes)
            payload["advanced"] = {**payload["advanced"], **advanced_updates}
            updated = ModelConfiguration.model_validate(payload)
            self._write(updated)
            self._current = updated
            return updated

    def _load(self) -> ModelConfiguration:
        if not self.path.is_file():
            return self._defaults
        return ModelConfiguration.model_validate_json(self.path.read_text("utf-8"))

    def _write(self, value: ModelConfiguration) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, raw_path = tempfile.mkstemp(prefix="model-", suffix=".tmp", dir=self.path.parent)
        temp_path = Path(raw_path)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
                json.dump(value.model_dump(mode="json"), output, ensure_ascii=False, indent=2)
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp_path, self.path)
        finally:
            temp_path.unlink(missing_ok=True)


_current_store = ModelSettingsStore(
    Path(settings.output_dir).expanduser().resolve().parent / "settings" / "model.json"
)


def set_current_model_settings_store(store: ModelSettingsStore) -> None:
    global _current_store
    _current_store = store


def get_current_model_configuration() -> ModelConfiguration:
    return _current_store.snapshot()
