"""Catalog-lookup tests for Qwen pure-text (non-vision) models."""

from __future__ import annotations

import pytest
from app.model_config import (
    Capabilities,
    get_known_model,
)

_TEXT_ONLY = Capabilities(text=True)

_ALL_TEXT_MODELS = [
    # qwen3.6 text family — Model Studio/QwenCloud exact limits
    pytest.param(
        "qwen3.6-max-preview",
        262_144,
        64_000,
        _TEXT_ONLY,
        id="qwen3.6-max-preview",
    ),
    pytest.param(
        "qwen3.6-27b",
        262_144,
        64_000,
        _TEXT_ONLY,
        id="qwen3.6-27b",
    ),
    # qwen2.5 open-source text family — OpenAI-compatible models
    pytest.param(
        "qwen2.5-72b-instruct",
        32_768,
        8_000,
        _TEXT_ONLY,
        id="qwen2.5-72b-instruct",
    ),
    pytest.param(
        "qwen2.5-32b-instruct",
        32_768,
        8_000,
        _TEXT_ONLY,
        id="qwen2.5-32b-instruct",
    ),
    pytest.param(
        "qwen2.5-14b-instruct",
        32_768,
        8_000,
        _TEXT_ONLY,
        id="qwen2.5-14b-instruct",
    ),
    pytest.param(
        "qwen2.5-14b-instruct-1m",
        1_000_000,
        8_000,
        _TEXT_ONLY,
        id="qwen2.5-14b-instruct-1m",
    ),
    pytest.param(
        "qwen2.5-7b-instruct",
        32_768,
        8_000,
        _TEXT_ONLY,
        id="qwen2.5-7b-instruct",
    ),
    pytest.param(
        "qwen2.5-7b-instruct-1m",
        1_000_000,
        8_000,
        _TEXT_ONLY,
        id="qwen2.5-7b-instruct-1m",
    ),
    # qwen3 legacy family — OpenAI-compatible commercial and open-source models
    pytest.param(
        "qwen3-235b-a22b",
        131_072,
        16_000,
        _TEXT_ONLY,
        id="qwen3-235b-a22b",
    ),
    pytest.param(
        "qwen3-235b-a22b-thinking-2507",
        131_072,
        32_000,
        _TEXT_ONLY,
        id="qwen3-235b-a22b-thinking-2507",
    ),
    pytest.param(
        "qwen3-235b-a22b-instruct-2507",
        131_072,
        32_000,
        _TEXT_ONLY,
        id="qwen3-235b-a22b-instruct-2507",
    ),
    pytest.param(
        "qwen3-next-80b-a3b-thinking",
        131_072,
        32_000,
        _TEXT_ONLY,
        id="qwen3-next-80b-a3b-thinking",
    ),
    pytest.param(
        "qwen3-next-80b-a3b-instruct",
        131_072,
        32_000,
        _TEXT_ONLY,
        id="qwen3-next-80b-a3b-instruct",
    ),
    pytest.param("qwen3-32b", 131_072, 16_000, _TEXT_ONLY, id="qwen3-32b"),
    pytest.param(
        "qwen3-30b-a3b", 131_072, 16_000, _TEXT_ONLY, id="qwen3-30b-a3b"
    ),
    pytest.param(
        "qwen3-30b-a3b-thinking-2507",
        131_072,
        32_000,
        _TEXT_ONLY,
        id="qwen3-30b-a3b-thinking-2507",
    ),
    pytest.param(
        "qwen3-30b-a3b-instruct-2507",
        131_072,
        32_000,
        _TEXT_ONLY,
        id="qwen3-30b-a3b-instruct-2507",
    ),
    pytest.param("qwen3-14b", 131_072, 8_000, _TEXT_ONLY, id="qwen3-14b"),
    pytest.param("qwen3-8b", 131_072, 8_000, _TEXT_ONLY, id="qwen3-8b"),
    pytest.param("qwen3-4b", 131_072, 8_000, _TEXT_ONLY, id="qwen3-4b"),
    pytest.param("qwen3-1.7b", 32_768, 8_000, _TEXT_ONLY, id="qwen3-1.7b"),
    pytest.param("qwen3-0.6b", 32_768, 8_000, _TEXT_ONLY, id="qwen3-0.6b"),
    # Current legacy text models — OpenAI-compatible Responses models
    pytest.param("qwen-plus", 1_000_000, 32_000, _TEXT_ONLY, id="qwen-plus"),
    pytest.param("qwen-flash", 1_000_000, 32_000, _TEXT_ONLY, id="qwen-flash"),
    # qwen3-max family — text-only OpenAI-compatible models
    pytest.param("qwen3-max", 262_144, 64_000, _TEXT_ONLY, id="qwen3-max"),
    pytest.param(
        "qwen3-max-2026-01-23",
        262_144,
        64_000,
        _TEXT_ONLY,
        id="qwen3-max-2026-01-23",
    ),
    pytest.param(
        "qwen3-max-preview",
        262_144,
        64_000,
        _TEXT_ONLY,
        id="qwen3-max-preview",
    ),
    pytest.param(
        "qwen3-max-2025-09-23",
        262_144,
        64_000,
        _TEXT_ONLY,
        id="qwen3-max-2025-09-23",
    ),
    # qwen3-coder family — text-only OpenAI-compatible coding models
    pytest.param(
        "qwen3-coder-plus",
        1_000_000,
        64_000,
        _TEXT_ONLY,
        id="qwen3-coder-plus",
    ),
    pytest.param(
        "qwen3-coder-plus-2025-09-23",
        1_000_000,
        64_000,
        _TEXT_ONLY,
        id="qwen3-coder-plus-2025-09-23",
    ),
    pytest.param(
        "qwen3-coder-plus-2025-07-22",
        1_000_000,
        64_000,
        _TEXT_ONLY,
        id="qwen3-coder-plus-2025-07-22",
    ),
    pytest.param(
        "qwen3-coder-flash",
        1_000_000,
        64_000,
        _TEXT_ONLY,
        id="qwen3-coder-flash",
    ),
    pytest.param(
        "qwen3-coder-flash-2025-07-28",
        1_000_000,
        64_000,
        _TEXT_ONLY,
        id="qwen3-coder-flash-2025-07-28",
    ),
    pytest.param(
        "qwen3-coder-next",
        262_144,
        64_000,
        _TEXT_ONLY,
        id="qwen3-coder-next",
    ),
    # qwen3.7-max family — text-only, 1M context
    pytest.param("qwen3.7-max", 1_000_000, 64_000, _TEXT_ONLY, id="qwen3.7-max"),
    pytest.param(
        "qwen3.7-max-2026-06-08",
        1_000_000,
        64_000,
        _TEXT_ONLY,
        id="qwen3.7-max-2026-06-08",
    ),
    pytest.param(
        "qwen3.7-max-2026-05-20",
        1_000_000,
        64_000,
        _TEXT_ONLY,
        id="qwen3.7-max-2026-05-20",
    ),
    pytest.param(
        "qwen3.7-max-preview",
        1_000_000,
        64_000,
        _TEXT_ONLY,
        id="qwen3.7-max-preview",
    ),
    pytest.param(
        "qwen3.7-max-2026-05-17",
        1_000_000,
        64_000,
        _TEXT_ONLY,
        id="qwen3.7-max-2026-05-17",
    ),
]


@pytest.mark.parametrize(
    ("model_id", "context_window", "suggested_max_tokens", "capabilities"),
    _ALL_TEXT_MODELS,
)
def test_known_text_model(
    model_id: str,
    context_window: int,
    suggested_max_tokens: int,
    capabilities: Capabilities,
) -> None:
    # Given / When
    entry = get_known_model(model_id)

    # Then
    assert entry is not None
    assert entry.id == model_id
    assert entry.context_window == context_window
    assert entry.suggested_max_tokens == suggested_max_tokens
    assert entry.capabilities == capabilities
