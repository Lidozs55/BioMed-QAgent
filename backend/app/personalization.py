"""User personalization settings - custom instructions and default tone.

Personalization is intentionally separate from model settings:

- ``custom_instructions``: extra instructions the user wants applied to every
  Agent task on this host (mirrors Code X's "自定义指令").
- ``personality``: the default reply tone injected into the Agent system
  prompt (mirrors Code X's "个性").

Both fields are persisted to ``data/personalization.json`` (atomic replace)
and injected at instruction-resolution time so main agents, child agents, and
prompt-shape estimation all share the same source of truth.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

logger = logging.getLogger(__name__)

Personality = Literal["pragmatic", "warm", "rigorous"]

#: 个性选项 -> UI 标签（前端保持同步，见 settingsContracts.ts）。
PERSONALITY_LABELS: dict[Personality, str] = {
    "pragmatic": "务实",
    "warm": "亲和",
    "rigorous": "严谨",
}

#: 个性选项 -> 注入系统提示词的语气指导。
PERSONALITY_GUIDANCE: dict[Personality, str] = {
    "pragmatic": "回复简洁、专注、直接，优先给出可执行的结论。",
    "warm": "回复温暖、协作、贴心，适当说明思路并给出引导。",
    "rigorous": "回复严谨、结构化，明确区分事实与推断，并附可溯源证据。",
}

_PERSONALIZATION_PATH = (
    Path(__file__).resolve().parent.parent / "data" / "personalization.json"
)
_runtime_personalization: PersonalizationSettings | None = None


class PersonalizationSettings(BaseModel):
    """Persisted personalization preferences (defaults are empty/neutral)."""

    model_config = ConfigDict(extra="forbid")

    custom_instructions: str = Field(default="", max_length=20_000)
    personality: Personality = "pragmatic"


def get_personalization() -> PersonalizationSettings:
    """Return the current personalization settings (cached after first load)."""
    global _runtime_personalization
    if _runtime_personalization is None:
        _runtime_personalization = _load_personalization()
    return _runtime_personalization


def update_personalization(
    settings: PersonalizationSettings,
) -> PersonalizationSettings:
    """Persist new personalization settings and update the in-memory singleton."""
    global _runtime_personalization
    _save_personalization(settings)
    _runtime_personalization = settings
    logger.info(
        "Personalization updated: custom_instructions=%s chars personality=%s",
        len(settings.custom_instructions),
        settings.personality,
    )
    return _runtime_personalization


def personalization_section(
    settings: PersonalizationSettings | None = None,
) -> str:
    """Render the personalization block appended to Agent instructions.

    Custom instructions are only injected when the user actually wrote some
    (default is empty); the tone line is always present so the personality
    setting has an effect even with no custom instructions.
    """

    prefs = settings or get_personalization()
    parts: list[str] = []
    instructions = prefs.custom_instructions.strip()
    if instructions:
        parts.append(f"## 用户自定义指令\n\n{instructions}")
    parts.append(f"## 回复语气\n\n{PERSONALITY_GUIDANCE[prefs.personality]}")
    return "\n\n---\n\n".join(parts)


# ---------------------------------------------------------------------------
# Internal helpers (file persistence)
# ---------------------------------------------------------------------------


def _load_personalization() -> PersonalizationSettings:
    """Load personalization from the JSON file, falling back to defaults."""
    if _PERSONALIZATION_PATH.exists():
        try:
            data = json.loads(_PERSONALIZATION_PATH.read_text("utf-8"))
            return PersonalizationSettings(**data)
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            logger.warning(
                "Failed to parse personalization file, using defaults: %s",
                exc,
            )
    return PersonalizationSettings()


def _save_personalization(settings: PersonalizationSettings) -> None:
    """Atomically write personalization to the JSON file for persistence."""
    _PERSONALIZATION_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        file_descriptor, temporary_name = tempfile.mkstemp(
            dir=_PERSONALIZATION_PATH.parent,
            prefix=f".{_PERSONALIZATION_PATH.name}.",
            suffix=".tmp",
        )
        temporary_path = Path(temporary_name)
        with os.fdopen(file_descriptor, "w", encoding="utf-8") as settings_file:
            settings_file.write(
                json.dumps(
                    settings.model_dump(),
                    indent=2,
                    ensure_ascii=False,
                )
            )
            settings_file.flush()
            os.fsync(settings_file.fileno())
        os.replace(temporary_path, _PERSONALIZATION_PATH)
        temporary_path = None
        if os.name != "nt":
            directory_descriptor = os.open(
                _PERSONALIZATION_PATH.parent,
                os.O_RDONLY,
            )
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
    except OSError:
        if temporary_path is not None:
            with suppress(OSError):
                temporary_path.unlink(missing_ok=True)
        raise
