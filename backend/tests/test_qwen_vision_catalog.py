"""Catalog-lookup and context-budget tests for Qwen vision-chat models."""

from __future__ import annotations

import pytest
from app.model_config import (
    Capabilities,
    get_known_model,
)
from app.model_config.context_budget import resolve_context_budget

_VISION_CHAT = Capabilities(text=True, image=True, video=True)

_ALL_VISION_MODELS = [
    # existing
    pytest.param("qwen3.7-plus", 1_000_000, 64_000, _VISION_CHAT, id="qwen3.7-plus"),
    pytest.param("qwen3.6-plus", 1_000_000, 64_000, _VISION_CHAT, id="qwen3.6-plus"),
    pytest.param("qwen3.6-flash", 1_000_000, 64_000, _VISION_CHAT, id="qwen3.6-flash"),
    pytest.param("qwen3.6-35b-a3b", 262_144, 64_000, _VISION_CHAT, id="qwen3.6-35b-a3b"),
    # qwen3.7 vision snapshot batch (2026-07-15 Model Studio)
    pytest.param("qwen3.7-plus-2026-05-26", 1_000_000, 64_000, _VISION_CHAT, id="qwen3.7-plus-2026-05-26"),
    # qwen3.6 vision snapshot batch
    pytest.param("qwen3.6-plus-2026-04-02", 1_000_000, 64_000, _VISION_CHAT, id="qwen3.6-plus-2026-04-02"),
    pytest.param("qwen3.6-flash-2026-04-16", 1_000_000, 64_000, _VISION_CHAT, id="qwen3.6-flash-2026-04-16"),
    # qwen3.5 vision batch (2026-07-15 Model Studio)
    pytest.param("qwen3.5-plus", 1_000_000, 64_000, _VISION_CHAT, id="qwen3.5-plus"),
    pytest.param("qwen3.5-plus-2026-02-15", 1_000_000, 64_000, _VISION_CHAT, id="qwen3.5-plus-2026-02-15"),
    pytest.param("qwen3.5-flash", 1_000_000, 64_000, _VISION_CHAT, id="qwen3.5-flash"),
    pytest.param("qwen3.5-flash-2026-02-23", 1_000_000, 64_000, _VISION_CHAT, id="qwen3.5-flash-2026-02-23"),
    pytest.param("qwen3.5-397b-a17b", 32_768, 8_192, _VISION_CHAT, id="qwen3.5-397b-a17b"),
    pytest.param("qwen3.5-122b-a10b", 32_768, 8_192, _VISION_CHAT, id="qwen3.5-122b-a10b"),
    pytest.param("qwen3.5-27b", 32_768, 8_192, _VISION_CHAT, id="qwen3.5-27b"),
    pytest.param("qwen3.5-35b-a3b", 32_768, 8_192, _VISION_CHAT, id="qwen3.5-35b-a3b"),
]


@pytest.mark.parametrize(
    ("model_id", "context_window", "suggested_max_tokens", "capabilities"),
    _ALL_VISION_MODELS,
)
def test_known_vision_model(
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


def test_qwen36_plus_context_budget_with_caller_max_tokens_distinct_from_suggested() -> None:
    """Caller supplies max_tokens=32000; budget must NOT use suggested_max_tokens=64000."""
    from app.model_config import UserSettings

    # Given
    settings = UserSettings(
        model_name="qwen3.6-plus",
        max_tokens=32_000,
    )

    # When
    budget = resolve_context_budget(settings)

    # Then
    assert budget.context_window == 1_000_000
    assert budget.max_output_tokens == 32_000
    assert budget.model_name == "qwen3.6-plus"
    # safety_reserve_tokens = max(16384, ceil(1_000_000 * 0.05))
    assert budget.safety_reserve_tokens == 50_000
    # input_capacity = 1_000_000 - 32_000 - 50_000 = 918_000
    assert budget.input_capacity == 918_000
