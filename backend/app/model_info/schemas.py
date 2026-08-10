"""Extended model detail schemas for the model information repository.

This module defines the enriched model metadata schema that the ModelInfoRepository
uses to build a comprehensive data warehouse.  The schema extends the basic
``QwenModelEntry`` fields with pricing, knowledge cutoff, vendor association,
and a precise ``max_output_tokens`` (hard limit) distinct from the softer
``suggested_max_tokens``.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Literal

from pydantic import BaseModel, Field


class ModelCapabilities(BaseModel):
    """Binary capability flags for a model."""

    text: bool = True
    image: bool = False
    video: bool = False
    audio: bool = False


ModelFamily = Literal[
    "qwen",
    "qwen2.5",
    "qwen3",
    "qwen3.5",
    "qwen3.6",
    "qwen3.7",
    "qwen-vl",
    "qwen2.5-vl",
    "qwen3-vl",
    "qwen-omni",
    "qwen-coder",
    "qwq",
    "gpt-4",
    "gpt-4o",
    "o1",
    "o3",
    "deepseek",
    "deepseek-r1",
    "moonshot-v1",
    "glm-4",
    "glm-4v",
    "glm-4.5",
    "glm-5",
    "baichuan",
    "llama",
    "grok",
    "mistral",
    "kimi",
    "embedding",
    "fun-asr",
    "fun-music",
    "happyhorse",
    "minimax",
    "mimo",
    "tripo",
    "wan",
]


class ModelDetail(BaseModel):
    """Rich, vendor-aware model metadata for the information warehouse.

    Fields
    ------
    id : str
        Canonical model identifier (e.g. ``"qwen-plus"``).
    name : str
        Human-readable display name.
    description : str
        Short description of the model's strengths and use-cases.
    vendor_id : str
        Provider/vendor identifier matching the ``Vendor.id`` values
        (e.g. ``"dashscope"``, ``"openai"``).
    input_context_window : int
        Maximum number of input tokens the model can accept (this is the
        hard technical limit, not a user-configured override).
    max_output_tokens : int
        Hard upper bound on output token count the model supports.
    suggested_max_tokens : int
        Recommended default for *max_tokens* in the user settings UI.
    capabilities : ModelCapabilities
        Modalities the model supports (text / image / video / audio).
        A model with ``text=True, image=True`` can accept both text and
        image input.
    knowledge_cutoff : str | None
        Knowledge cutoff date (rough training-data boundary) as a short
        human-readable string, e.g. ``"2025-12"`` or ``"2026-03"``.
    pricing_input_per_1m : float | None
        Input token price per 1 million tokens (USD).  ``None`` when
        pricing is not publicly available.
    pricing_output_per_1m : float | None
        Output token price per 1 million tokens (USD).
    recommended : bool
        Whether this model is a default recommendation for its vendor.
    model_family : ModelFamily | None
        Model family / series identifier for logical grouping.
    function_calling : bool
        Whether the model natively supports function/tool calling.
    supports_streaming : bool
        Whether the model supports streaming responses.
    """

    id: str
    name: str
    description: str
    vendor_id: str
    input_context_window: int = Field(ge=1)
    max_output_tokens: int = Field(ge=1)
    suggested_max_tokens: int = Field(ge=1)
    capabilities: ModelCapabilities = Field(default_factory=ModelCapabilities)
    knowledge_cutoff: str | None = None
    pricing_input_per_1m: float | None = None
    pricing_output_per_1m: float | None = None
    recommended: bool = False
    model_family: ModelFamily | None = None
    function_calling: bool = True
    supports_streaming: bool = True


# ---------------------------------------------------------------------------
# Utility helpers
# ---------------------------------------------------------------------------


def format_context_window(tokens: int) -> str:
    """Return a human-readable short string for a token count."""
    if tokens >= 1_000_000:
        return f"{tokens / 1_000_000:.1f}M"
    if tokens >= 1_000:
        return f"{tokens // 1_000}K"
    return str(tokens)


def format_pricing(price: float | None) -> str:
    """Return a human-readable pricing string, or ``"—"`` if unknown."""
    if price is None:
        return "—"
    return f"${price:.2f}"


def capabilities_summary(caps: ModelCapabilities) -> Sequence[str]:
    """Return a sorted list of supported modality labels."""
    labels: list[str] = []
    if caps.text:
        labels.append("text")
    if caps.image:
        labels.append("image")
    if caps.video:
        labels.append("video")
    if caps.audio:
        labels.append("audio")
    return labels

__all__ = [
    "ModelCapabilities",
    "ModelDetail",
    "ModelFamily",
    "capabilities_summary",
    "format_context_window",
    "format_pricing",
]
