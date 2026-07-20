"""User settings CRUD — persistence and runtime configuration."""
from __future__ import annotations

import json
import logging
import os
import tempfile
from contextlib import suppress
from pathlib import Path

from app.model_config import QWEN_MODELS_DB, QwenModelEntry, UserSettings

logger = logging.getLogger(__name__)

_SETTINGS_PATH = Path(__file__).resolve().parent.parent / "data" / "user_settings.json"
_runtime_settings: UserSettings | None = None

# Public API — settings CRUD
# ---------------------------------------------------------------------------


def get_settings() -> UserSettings:
    """Return the current user settings (cached in memory after first load)."""
    global _runtime_settings
    if _runtime_settings is None:
        _runtime_settings = _load_settings()
    return _runtime_settings


def update_settings(settings: UserSettings) -> UserSettings:
    """Persist new settings to disk and update the in-memory singleton."""
    global _runtime_settings
    _save_settings(settings)
    _runtime_settings = settings
    logger.info(
        "User settings updated: base_url=%s model=%s",
        settings.base_url,
        settings.model_name,
    )
    return _runtime_settings


def get_model_entry(model_id: str) -> QwenModelEntry | None:
    """Return the built-in Qwen model entry for *model_id*, or ``None``."""
    return QWEN_MODELS_DB.get(model_id)


def resolve_active_model_entry() -> QwenModelEntry | None:
    """Return the model entry for the currently active model (from settings)."""
    settings = get_settings()
    return get_model_entry(settings.model_name)



# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _load_settings() -> UserSettings:
    """Load settings from the JSON file, falling back to defaults + env vars."""
    if _SETTINGS_PATH.exists():
        try:
            data = json.loads(_SETTINGS_PATH.read_text("utf-8"))
            settings = UserSettings(**data)
            return _apply_env_fallback(
                settings,
                use_environment_api_key="api_key" not in data,
            )
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            logger.warning("Failed to parse user settings file, using defaults: %s", exc)
    return _apply_env_fallback(UserSettings())


def _apply_env_fallback(
    settings: UserSettings,
    *,
    use_environment_api_key: bool = True,
) -> UserSettings:
    """Fill in empty fields from environment variables (DashScope defaults)."""
    kwargs = settings.model_dump()
    if use_environment_api_key and not kwargs.get("api_key"):
        kwargs["api_key"] = os.getenv("DASHSCOPE_API_KEY", "")
    if not kwargs.get("base_url"):
        kwargs["base_url"] = os.getenv(
            "DASHSCOPE_BASE_URL",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        )
    if not kwargs.get("model_name"):
        kwargs["model_name"] = os.getenv("MODEL_NAME", "qwen-plus")
    return UserSettings(**kwargs)


def _save_settings(settings: UserSettings) -> None:
    """Atomically write settings to the JSON file for persistence."""
    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        file_descriptor, temporary_name = tempfile.mkstemp(
            dir=_SETTINGS_PATH.parent,
            prefix=f".{_SETTINGS_PATH.name}.",
            suffix=".tmp",
        )
        temporary_path = Path(temporary_name)
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as settings_file:
            settings_file.write(json.dumps(settings.model_dump(), indent=2, ensure_ascii=False))
            settings_file.flush()
            os.fsync(settings_file.fileno())
        os.replace(temporary_path, _SETTINGS_PATH)
        temporary_path = None
        if os.name != "nt":
            directory_descriptor = os.open(_SETTINGS_PATH.parent, os.O_RDONLY)
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
    except OSError:
        if temporary_path is not None:
            with suppress(OSError):
                temporary_path.unlink(missing_ok=True)
        raise
