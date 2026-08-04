"""Model catalog composition, lookup, and capability inference."""

from __future__ import annotations

from app.model_info import get_repository

from .catalog_compatible import COMPATIBLE_MODELS
from .catalog_qwen import QWEN_MODELS
from .schemas import AdvancedParams, Capabilities, QwenModelEntry

QWEN_MODELS_DB: dict[str, QwenModelEntry] = {**QWEN_MODELS, **COMPATIBLE_MODELS}

#: Fallback context window (512K) used when a model id matches no catalog
#: entry and cannot be guessed from naming conventions.
DEFAULT_GUESS_CONTEXT_WINDOW = 524_288


def get_known_model(model_id: str) -> QwenModelEntry | None:
    """Return a catalog entry for a known model identifier.

    The legacy QWEN_MODELS_DB overlay is checked first, then the richer
    model_info warehouse is consulted so every model registered there is
    treated as known (exact context window, capabilities, and suggested
    output) without duplicating metadata across the two catalogs.
    """
    entry = QWEN_MODELS_DB.get(model_id)
    if entry is not None:
        return entry
    detail = get_repository().get_model(model_id)
    if detail is None:
        return None
    return QwenModelEntry(
        id=detail.id,
        name=detail.name,
        description=detail.description,
        context_window=detail.input_context_window,
        suggested_max_tokens=detail.suggested_max_tokens,
        capabilities=Capabilities(
            text=detail.capabilities.text,
            image=detail.capabilities.image,
            video=detail.capabilities.video,
            audio=detail.capabilities.audio,
        ),
        recommended=detail.recommended,
    )


def guess_context_window(model_id: str) -> int:
    """Infer a conservative context window for an unregistered model id.

    Naming-convention heuristics run first (e.g. 1m/max flagship markers,
    explicit 128k suffixes, VL/omni multimodal models); when no pattern
    matches, DEFAULT_GUESS_CONTEXT_WINDOW (512K) is returned so an
    unregistered model never blocks a task solely for lacking a configured
    context window.
    """
    mid = model_id.casefold()
    if "2m" in mid:
        return 2_000_000
    if "1m" in mid or "million" in mid or "max" in mid:
        return 1_000_000
    if "262144" in mid or "256k" in mid:
        return 262_144
    if "131072" in mid or "128k" in mid:
        return 131_072
    if "65536" in mid or "64k" in mid:
        return 65_536
    if "32768" in mid or "32k" in mid:
        return 32_768
    if "16384" in mid or "16k" in mid:
        return 16_384
    if "8192" in mid or "8k" in mid:
        return 8_192
    if "omni" in mid or "vl" in mid:
        return 131_072
    return DEFAULT_GUESS_CONTEXT_WINDOW


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
