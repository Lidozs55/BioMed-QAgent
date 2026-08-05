"""Persistent user model configuration stored outside the application bundle."""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from threading import RLock
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, RootModel, ValidationError

from app.config import Settings, settings
from app.model_config.catalog import get_known_model
from app.model_config.context_budget import (
    ContextBudget,
    ContextBudgetConfigurationError,
    normalize_provider_origin,
    resolve_context_budget,
)
from app.model_config.schemas import RuntimeLimitsSettings


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
    context_window: int | None = Field(default=None, ge=1)
    safety_reserve_ratio: float = Field(default=0.05, ge=0, le=0.25)
    compaction_trigger_ratio: float = Field(default=0.85, gt=0, lt=1)
    compaction_target_ratio: float = Field(default=0.60, gt=0, lt=1)
    runtime_limits: RuntimeLimitsSettings = RuntimeLimitsSettings()
    advanced: AdvancedModelSettings = AdvancedModelSettings()


type PositiveResidual = Annotated[int, Field(gt=0, strict=True)]


class CalibrationFile(RootModel[dict[str, list[PositiveResidual]]]):
    """Persisted calibration mapping containing only positive numeric residuals."""

    model_config = ConfigDict(frozen=True)


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

    @property
    def calibration_path(self) -> Path:
        """Return the residual calibration file stored beside the model settings file."""

        return self.path.with_name("calibration.json")

    def snapshot(self) -> ModelConfiguration:
        with self._lock:
            return self._current

    def update(
        self, changes: dict[str, Any], *, clears: set[str] | None = None
    ) -> ModelConfiguration:
        clears = clears or set()
        with self._lock:
            changes = dict(changes)
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
            # ── explicit-null clear semantics ─────────────────────────
            # Fields the caller sent as JSON null are stripped from
            # the merged payload so ModelConfiguration receives its
            # default (None for context_window, which triggers catalog
            # resolution).  Unknown models + cleared window still fail
            # in resolve_context_budget below.
            for field in clears:
                payload.pop(field, None)
            updated = ModelConfiguration.model_validate(payload)
            try:
                resolve_context_budget(updated)
            except ContextBudgetConfigurationError as error:
                if (
                    error.reason == "a positive context window is required"
                    and updated.context_window is None
                    and get_known_model(updated.model_name) is None
                ):
                    pass
                else:
                    raise ValueError(str(error)) from error
            self._write(updated)
            self._current = updated
            return updated

    def calibration_margin_for(self, budget: ContextBudget) -> int:
        """Return the maximum residual stored for this provider and model."""

        with self._lock:
            return min(
                max(self._load_calibrations().get(_calibration_key(budget), ()), default=0),
                budget.context_window // 10,
            )

    def record_calibration_residual(
        self,
        budget: ContextBudget,
        residual_tokens: int,
    ) -> None:
        """Persist one positive residual without modifying an already-captured Run."""

        if residual_tokens <= 0:
            return
        with self._lock:
            calibrations = self._load_calibrations()
            key = _calibration_key(budget)
            calibrations[key] = [*calibrations.get(key, ()), residual_tokens][-20:]
            self._write_calibrations(calibrations)

    def _load(self) -> ModelConfiguration:
        if not self.path.is_file():
            return self._defaults
        try:
            candidate = ModelConfiguration.model_validate_json(
                self.path.read_text("utf-8")
            )
        except (ValidationError, UnicodeDecodeError, json.JSONDecodeError):
            return self._defaults
        try:
            resolve_context_budget(candidate)
        except ContextBudgetConfigurationError as error:
            if (
                error.reason == "a positive context window is required"
                and candidate.context_window is None
                and get_known_model(candidate.model_name) is None
            ):
                return candidate
            return self._defaults
        return candidate

    def _write(self, value: ModelConfiguration) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, raw_path = tempfile.mkstemp(prefix="model-", suffix=".tmp", dir=self.path.parent)
        temp_path = Path(raw_path)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
                json.dump(
                    value.model_dump(mode="json", exclude_none=True),
                    output,
                    ensure_ascii=False,
                    indent=2,
                )
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp_path, self.path)
        finally:
            temp_path.unlink(missing_ok=True)

    def _load_calibrations(self) -> dict[str, list[PositiveResidual]]:
        if not self.calibration_path.is_file():
            return {}
        try:
            return CalibrationFile.model_validate_json(
                self.calibration_path.read_text("utf-8")
            ).root
        except (ValidationError, UnicodeDecodeError):
            return {}

    def _write_calibrations(self, calibrations: dict[str, list[PositiveResidual]]) -> None:
        self.calibration_path.parent.mkdir(parents=True, exist_ok=True)
        fd, raw_path = tempfile.mkstemp(
            prefix="calibration-",
            suffix=".tmp",
            dir=self.calibration_path.parent,
        )
        temp_path = Path(raw_path)
        try:
            with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as output:
                output.write(CalibrationFile.model_validate(calibrations).model_dump_json())
                output.write("\n")
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp_path, self.calibration_path)
        finally:
            temp_path.unlink(missing_ok=True)


def _calibration_key(budget: ContextBudget) -> str:
    """Return the normalized provider/model residual key."""

    return f"{normalize_provider_origin(budget.provider_origin)}|{budget.model_name}"


_current_store = ModelSettingsStore(
    Path(settings.output_dir).expanduser().resolve().parent / "settings" / "model.json"
)


def set_current_model_settings_store(store: ModelSettingsStore) -> None:
    global _current_store
    _current_store = store


def get_current_model_configuration() -> ModelConfiguration:
    return _current_store.snapshot()


def get_runtime_limits() -> RuntimeLimitsSettings:
    """Return the persisted runtime limits from the active store.

    REVIEW 2026-08-05 §5.5 (B5): replaces the former ``RuntimeLimitsSettings()``
    module-level defaults so every consumer reads the real persisted value
    instead of a fake standalone default.
    """

    return _current_store.snapshot().runtime_limits


def calibration_margin_for(budget: ContextBudget) -> int:
    """Read active-store calibration without changing its model configuration."""

    return _current_store.calibration_margin_for(budget)
