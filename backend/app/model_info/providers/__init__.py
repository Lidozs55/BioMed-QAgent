"""Provider-specific model data modules.

Each module exports a ``MODELS`` mapping (``dict[str, ModelDetail]``) for
that provider's known model lineup.  The modules are auto-discovered by
``ModelInfoRepository._load_providers()``.
"""

from __future__ import annotations

# ruff: noqa: F401
from .baichuan import register as _register_baichuan
from .deepseek import register as _register_deepseek
from .groq import register as _register_groq
from .kuaishou import register as _register_kuaishou
from .minimax import register as _register_minimax
from .mistral import register as _register_mistral
from .moonshot import register as _register_moonshot
from .openai import register as _register_openai
from .qwen import register as _register_qwen
from .tripo import register as _register_tripo
from .xai import register as _register_xai
from .zhipu import register as _register_zhipu

__all__: list[str] = []
