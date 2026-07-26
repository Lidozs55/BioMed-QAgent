"""Model information warehouse — aggregate model metadata from every provider.

This module provides a centralized, modular data warehouse for model
information.  It is separated from ``model_config`` which holds the
bare-minimum catalog data needed for runtime context budget resolution.

Structure::

    model_info/
        __init__.py          # Public exports
        schemas.py           # ``ModelDetail``, ``ModelCapabilities``
        repository.py        # ``ModelInfoRepository``, ``get_repository``
        providers/
            __init__.py      # Auto-imports all provider ``register`` fns
            qwen.py          # DashScope / Qwen family
            openai.py        # OpenAI family
            deepseek.py      # DeepSeek family
            moonshot.py      # Moonshot / Kimi family
            zhipu.py         # ZhipuAI / GLM family
            baichuan.py      # Baichuan family
"""

from __future__ import annotations

from .repository import ModelInfoRepository, get_repository
from .schemas import (
    ModelCapabilities,
    ModelDetail,
    ModelFamily,
    capabilities_summary,
    format_context_window,
    format_pricing,
)

__all__ = [
    "ModelCapabilities",
    "ModelDetail",
    "ModelFamily",
    "ModelInfoRepository",
    "capabilities_summary",
    "format_context_window",
    "format_pricing",
    "get_repository",
]
