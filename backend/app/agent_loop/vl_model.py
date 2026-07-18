"""Qwen-VL (DashScope) client for visual chart extraction.

This module provides a dedicated AsyncOpenAI client bound to ``qwen-vl-max``
for image-understanding tasks (chart data extraction, figure OCR). It is
distinct from ``app.agent_loop.model.LazyDashScopeModel`` because:

1. ``LazyDashScopeModel`` implements the Agents SDK ``Model`` interface for
   conversation turns; VLM calls here are one-shot ``chat.completions.create``
   with an image_url content part, not Agent turns.
2. The model name differs (``qwen-vl-max`` vs ``qwen-plus``); a second
   independent client avoids mutating the Agent's model.

The client is created lazily on first use so that missing
``DASHSCOPE_API_KEY`` does not crash import. Configuration errors surface
as ``ModelConfigurationError`` (reused from ``model.py`` for a stable
execution-boundary error code).
"""
from __future__ import annotations

import base64
import logging
from pathlib import Path
from typing import Any

from openai import AsyncOpenAI

from app.agent_loop.model import require_model_credentials
from app.config import settings

logger = logging.getLogger(__name__)

#: Visual model name (DashScope OpenAI-compatible endpoint).
#: ``qwen-vl-max`` is the highest-capacity Qwen vision model as of 2025-Q3.
VL_MODEL_NAME = "qwen-vl-max"

#: Hard cap on image bytes sent to the VLM (DashScope limit is ~10MB for
#: inline base64). Oversize images are downsampled before encoding.
_MAX_VLM_IMAGE_BYTES = 10 * 1024 * 1024

#: Supported image MIME types for the VLM ``image_url`` content part.
_SUPPORTED_IMAGE_MIMES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
}

#: Lazy singleton client — created on first ``get_vl_client()`` call.
_vl_client: AsyncOpenAI | None = None


class ChartExtractionError(RuntimeError):
    """Raised when the full L1→L2→L3 chart extraction chain fails.

    Per project_memory L1 ("LLM 报告生成失败必须抛异常"), silent fallback
    to empty data is forbidden. The Agent loop surfaces this as a tool
    error so the task can either retry with a different source or fail
    visibly rather than silently dropping chart data.
    """

    code = "chart_extraction_failed"


def _infer_mime(path: Path) -> str:
    """Infer image MIME type from extension (defaults to image/png)."""
    ext = path.suffix.lower()
    for mime, suffix in _SUPPORTED_IMAGE_MIMES.items():
        if ext == suffix:
            return mime
    return "image/png"


def _encode_image_b64(path: Path) -> str:
    """Read an image file and return its base64-encoded payload string.

    If the file exceeds ``_MAX_VLM_IMAGE_BYTES``, Pillow is used to
    downsample the longest side to 1920px and re-encode as PNG. This
    keeps VLM calls within DashScope's inline-image size limit while
    preserving chart readability.
    """
    raw = path.read_bytes()
    if len(raw) <= _MAX_VLM_IMAGE_BYTES:
        return base64.b64encode(raw).decode("ascii")

    try:
        from PIL import Image
    except ImportError as exc:
        raise ChartExtractionError(
            f"image {path} is {len(raw)} bytes (> {_MAX_VLM_IMAGE_BYTES}) "
            "and Pillow is not available to downsample"
        ) from exc

    import io

    with Image.open(path) as img:
        img = img.convert("RGB")
        longest = max(img.size)
        if longest > 1920:
            scale = 1920 / longest
            new_size = (int(img.size[0] * scale), int(img.size[1] * scale))
            img = img.resize(new_size, Image.LANCZOS)
        buffer = io.BytesIO()
        img.save(buffer, format="PNG", optimize=True)
        encoded = base64.b64encode(buffer.getvalue()).decode("ascii")
        logger.info(
            "downsampled %s from %d bytes to %d bytes (PNG)",
            path, len(raw), len(encoded),
        )
        return encoded


def get_vl_client() -> AsyncOpenAI:
    """Return the lazy Qwen-VL AsyncOpenAI client.

    Raises ``ModelConfigurationError`` if ``DASHSCOPE_API_KEY`` is missing.
    """
    global _vl_client
    if _vl_client is None:
        require_model_credentials()
        _vl_client = AsyncOpenAI(
            api_key=settings.dashscope_api_key,
            base_url=settings.dashscope_base_url,
        )
    return _vl_client


async def call_vl_model(
    image_path: Path,
    prompt: str,
    *,
    timeout: float = 60.0,
) -> str:
    """Send one image to ``qwen-vl-max`` and return the raw text response.

    Args:
        image_path: Local path to a PNG/JPG/WEBP/GIF image.
        prompt: Text instruction (typically requests strict JSON output).
        timeout: Per-request timeout in seconds.

    Returns:
        The model's text response.

    Raises:
        ModelConfigurationError: API key missing.
        ChartExtractionError: Image too large and cannot be downsampled,
            or the VLM API call fails after retry budget is exhausted.
    """
    client = get_vl_client()
    mime = _infer_mime(image_path)
    b64 = _encode_image_b64(image_path)
    data_url = f"data:{mime};base64,{b64}"

    try:
        response = await client.chat.completions.create(
            model=VL_MODEL_NAME,
            messages=[
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {
                            "type": "image_url",
                            "image_url": {"url": data_url},
                        },
                    ],
                }
            ],
            temperature=0.1,
            timeout=timeout,
        )
    except Exception as exc:
        raise ChartExtractionError(
            f"qwen-vl-max call failed for {image_path}: {exc}"
        ) from exc

    content: str = ""
    choices: list[Any] = getattr(response, "choices", []) or []
    if choices:
        message = getattr(choices[0], "message", None)
        if message is not None:
            content = getattr(message, "content", "") or ""
    if not content:
        raise ChartExtractionError(
            f"qwen-vl-max returned empty content for {image_path}"
        )
    return content


def reset_vl_client_for_tests() -> None:
    """Clear the lazy singleton — test-only hook for isolated VLM tests."""
    global _vl_client
    _vl_client = None
