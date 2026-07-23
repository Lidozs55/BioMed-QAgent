"""Catalog-lookup and context-budget tests for Qwen vision-chat models."""

from __future__ import annotations

from app.model_config import (
    Capabilities,
    get_known_model,
)
from app.model_config.context_budget import resolve_context_budget


def test_find_qwen37_plus() -> None:
    # Given / When
    entry = get_known_model("qwen3.7-plus")

    # Then
    assert entry is not None
    assert entry.id == "qwen3.7-plus"
    assert entry.context_window == 1_000_000
    assert entry.suggested_max_tokens == 64_000
    assert entry.capabilities == Capabilities(text=True, image=True, video=True)


def test_find_qwen36_plus() -> None:
    # Given / When
    entry = get_known_model("qwen3.6-plus")

    # Then
    assert entry is not None
    assert entry.id == "qwen3.6-plus"
    assert entry.context_window == 1_000_000
    assert entry.suggested_max_tokens == 64_000
    assert entry.capabilities == Capabilities(text=True, image=True, video=True)


def test_find_qwen36_35b_a3b() -> None:
    # Given / When
    entry = get_known_model("qwen3.6-35b-a3b")

    # Then
    assert entry is not None
    assert entry.id == "qwen3.6-35b-a3b"
    assert entry.context_window == 262_144
    assert entry.suggested_max_tokens == 64_000
    assert entry.capabilities == Capabilities(text=True, image=True, video=True)


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
