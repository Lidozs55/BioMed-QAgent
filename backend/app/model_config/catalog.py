"""Model catalog composition, lookup, and capability inference."""

from __future__ import annotations

from .catalog_compatible import COMPATIBLE_MODELS
from .catalog_qwen import QWEN_MODELS
from .schemas import AdvancedParams, Capabilities, QwenModelEntry

QWEN_MODELS_DB: dict[str, QwenModelEntry] = {**QWEN_MODELS, **COMPATIBLE_MODELS}


def get_known_model(model_id: str) -> QwenModelEntry | None:
    """Return a catalog entry for a known model identifier."""
    return QWEN_MODELS_DB.get(model_id)


def infer_capabilities(model_id: str) -> Capabilities:
    """Infer capabilities for an API-discovered model identifier."""
    normalized_id = model_id.lower()
    if "omni" in normalized_id:
        return Capabilities(text=True, image=True, video=True, audio=True)
    if "vl" in normalized_id:
        return Capabilities(
            text=True,
            image=True,
            video="2.5" in normalized_id or "3" in normalized_id,
        )
    if "audio" in normalized_id:
        return Capabilities(text=True, audio=True)
    return Capabilities(text=True)


def augment_capabilities(
    model_id: str,
    known: QwenModelEntry | None = None,
) -> Capabilities:
    """Use known capabilities when available, otherwise infer them from the identifier."""
    if known is not None:
        return known.capabilities
    return infer_capabilities(model_id)


def get_advanced_defaults() -> dict[str, bool | float]:
    """Return serialized default advanced generation settings."""
    defaults = AdvancedParams()
    return {
        "temperature": defaults.temperature,
        "top_p": defaults.top_p,
        "repetition_penalty": defaults.repetition_penalty,
        "enable_search": defaults.enable_search,
        "thinking_mode": defaults.thinking_mode,
    }


def list_known_models() -> list[QwenModelEntry]:
    """Return all built-in models with recommended entries first."""
    models = list(QWEN_MODELS_DB.values())
    models.sort(key=lambda model: (not model.recommended, model.id))
    return models
