"""User model settings manager — persistence and Qwen model database.

Provides:
- ``UserSettings`` Pydantic model for base_url / api_key / model_name / max_tokens
- ``get_settings()`` / ``update_settings()`` backed by ``data/user_settings.json``
- Built-in Qwen model capability database with cross-reference helpers
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from pydantic import BaseModel

logger = logging.getLogger(__name__)

#: Path to the user-settings JSON file (relative to backend root).
_SETTINGS_PATH = Path(__file__).resolve().parent.parent / "data" / "user_settings.json"
_runtime_settings: UserSettings | None = None

# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------


class Capabilities(BaseModel):
    text: bool = True
    image: bool = False
    video: bool = False
    audio: bool = False


class QwenModelEntry(BaseModel):
    id: str
    name: str
    description: str
    context_window: int
    suggested_max_tokens: int
    capabilities: Capabilities
    recommended: bool = False


class UserSettings(BaseModel):
    base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    api_key: str = ""
    model_name: str = "qwen-plus"
    max_tokens: int = 8192


# ---------------------------------------------------------------------------
# Built-in Qwen model database
# ---------------------------------------------------------------------------

QWEN_MODELS_DB: dict[str, QwenModelEntry] = {
    # ── Flagship text models ──────────────────────────────────────────────
    "qwen-plus": QwenModelEntry(
        id="qwen-plus",
        name="Qwen Plus",
        description="Qwen 主力文本模型，平衡性能与成本，适合日常研究对话。",
        context_window=131_072,
        suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True),
        recommended=True,
    ),
    "qwen-max": QwenModelEntry(
        id="qwen-max",
        name="Qwen Max",
        description="Qwen 最强文本模型，适合复杂推理、深度分析和长文档理解。",
        context_window=32_768,
        suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True),
    ),
    "qwen-turbo": QwenModelEntry(
        id="qwen-turbo",
        name="Qwen Turbo",
        description="轻量快速模型，适合简单问答、摘要、分类等低延迟场景。",
        context_window=1_000_000,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True),
    ),
    # ── Vision-Language models ────────────────────────────────────────────
    "qwen-vl-max": QwenModelEntry(
        id="qwen-vl-max",
        name="Qwen VL Max",
        description="最强视觉语言模型，支持图像理解、图表提取、OCR。",
        context_window=32_768,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True, image=True),
    ),
    "qwen-vl-plus": QwenModelEntry(
        id="qwen-vl-plus",
        name="Qwen VL Plus",
        description="视觉语言模型，支持图文理解，性价比高。",
        context_window=32_768,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True, image=True),
    ),
    "qwen2.5-vl-72b-instruct": QwenModelEntry(
        id="qwen2.5-vl-72b-instruct",
        name="Qwen2.5 VL 72B",
        description="Qwen2.5 系列 72B 视觉语言模型，支持图像与视频理解。",
        context_window=32_768,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True, image=True, video=True),
    ),
    "qwen2.5-vl-32b-instruct": QwenModelEntry(
        id="qwen2.5-vl-32b-instruct",
        name="Qwen2.5 VL 32B",
        description="Qwen2.5 系列 32B 视觉语言模型，支持图像与视频理解。",
        context_window=32_768,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True, image=True, video=True),
    ),
    "qwen-vl-ocr": QwenModelEntry(
        id="qwen-vl-ocr",
        name="Qwen VL OCR",
        description="专注于 OCR 识别和文档数字化的视觉模型。",
        context_window=32_768,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True, image=True),
    ),
    # ── Audio models ──────────────────────────────────────────────────────
    "qwen2-audio": QwenModelEntry(
        id="qwen2-audio",
        name="Qwen2 Audio",
        description="语音理解模型，支持语音识别、语音对话与音频分析。",
        context_window=32_768,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True, audio=True),
    ),
    # ── Omni (all modalities) ─────────────────────────────────────────────
    "qwen-omni-turbo": QwenModelEntry(
        id="qwen-omni-turbo",
        name="Qwen Omni Turbo",
        description="全模态模型（文本+图像+视频+音频），适合多模态交互场景。",
        context_window=32_768,
        suggested_max_tokens=4_096,
        capabilities=Capabilities(text=True, image=True, video=True, audio=True),
    ),
    # ── Reasoning models ──────────────────────────────────────────────────
    "qwq-32b": QwenModelEntry(
        id="qwq-32b",
        name="QWQ 32B",
        description="推理增强模型（类 o1），擅长数学、逻辑和多步推理。",
        context_window=32_768,
        suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True),
    ),
    "qwq-plus": QwenModelEntry(
        id="qwq-plus",
        name="QWQ Plus",
        description="新一代推理模型，更强的思维链与复杂推理能力。",
        context_window=131_072,
        suggested_max_tokens=16_384,
        capabilities=Capabilities(text=True),
    ),
    # ── Legacy models ─────────────────────────────────────────────────────
    "qwen2.5-72b-instruct": QwenModelEntry(
        id="qwen2.5-72b-instruct",
        name="Qwen2.5 72B Instruct",
        description="Qwen2.5 系列 72B 文本模型，适合大规模文本生成。",
        context_window=128_000,
        suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True),
    ),
    "qwen2.5-32b-instruct": QwenModelEntry(
        id="qwen2.5-32b-instruct",
        name="Qwen2.5 32B Instruct",
        description="Qwen2.5 系列 32B 文本模型，三十二亿参数均衡之选。",
        context_window=128_000,
        suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True),
    ),
    "qwen2.5-14b-instruct": QwenModelEntry(
        id="qwen2.5-14b-instruct",
        name="Qwen2.5 14B Instruct",
        description="Qwen2.5 系列 14B 文本模型，轻量部署首选。",
        context_window=128_000,
        suggested_max_tokens=8_192,
        capabilities=Capabilities(text=True),
    ),
}


# ---------------------------------------------------------------------------
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
    _runtime_settings = settings
    _save_settings(settings)
    logger.info("User settings updated: base_url=%s model=%s", settings.base_url, settings.model_name)
    return _runtime_settings


def get_model_entry(model_id: str) -> QwenModelEntry | None:
    """Return the built-in Qwen model entry for *model_id*, or ``None``."""
    return QWEN_MODELS_DB.get(model_id)


def resolve_active_model_entry() -> QwenModelEntry | None:
    """Return the model entry for the currently active model (from settings)."""
    settings = get_settings()
    return get_model_entry(settings.model_name)


def list_known_models() -> list[QwenModelEntry]:
    """Return all models in the built-in Qwen database, with recommended first."""
    models = list(QWEN_MODELS_DB.values())
    models.sort(key=lambda m: (not m.recommended, m.id))
    return models


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _load_settings() -> UserSettings:
    """Load settings from the JSON file, falling back to defaults + env vars."""
    if _SETTINGS_PATH.exists():
        try:
            data = json.loads(_SETTINGS_PATH.read_text("utf-8"))
            return _apply_env_fallback(UserSettings(**data))
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            logger.warning("Failed to parse user settings file, using defaults: %s", exc)
    return _apply_env_fallback(UserSettings())


def _apply_env_fallback(settings: UserSettings) -> UserSettings:
    """Fill in empty fields from environment variables (DashScope defaults)."""
    kwargs = settings.model_dump()
    if not kwargs.get("api_key"):
        kwargs["api_key"] = os.getenv("DASHSCOPE_API_KEY", "")
    if not kwargs.get("base_url"):
        kwargs["base_url"] = os.getenv(
            "DASHSCOPE_BASE_URL",
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
        )
    if kwargs.get("model_name") in ("qwen-plus", ""):
        kwargs["model_name"] = os.getenv("MODEL_NAME", "qwen-plus")
    return UserSettings(**kwargs)


def _save_settings(settings: UserSettings) -> None:
    """Write settings to the JSON file for persistence."""
    _SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    data = settings.model_dump()
    _SETTINGS_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
