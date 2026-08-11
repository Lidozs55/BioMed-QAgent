"""Immutable model-aware context-budget contract tests."""

from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest
from app.model_config import UserSettings
from app.model_config.context_budget import (
    ContextBudgetConfigurationError,
    resolve_context_budget,
)
from app.model_settings import ModelConfiguration
from pydantic import ValidationError


def test_resolve_context_budget_preserves_exact_32768_catalog_window() -> None:
    # Given
    settings = UserSettings(model_name="qwen-max", max_tokens=4096)

    # When
    budget = resolve_context_budget(settings)

    # Then — reserve floor is capped at 20% of window: min(16384, ceil(32768*0.2))=6554
    assert budget.context_window == 32_768
    assert budget.max_output_tokens == 4096
    assert budget.safety_reserve_tokens == 6_554
    assert budget.input_capacity == 22_118
    assert budget.trigger_tokens == 18_801
    assert budget.target_tokens == 13_271


def test_resolve_context_budget_preserves_exact_million_token_catalog_window() -> None:
    # Given
    settings = UserSettings(model_name="qwen-turbo", max_tokens=4096)

    # When
    budget = resolve_context_budget(settings)

    # Then
    assert budget.context_window == 1_000_000
    assert budget.safety_reserve_tokens == 50_000


def test_resolve_context_budget_recognizes_qwen36_flash_catalog_window() -> None:
    # Given
    settings = UserSettings(model_name="qwen3.6-flash", max_tokens=8_192)

    # When
    budget = resolve_context_budget(settings)

    # Then
    assert budget.context_window == 1_000_000
    assert budget.max_output_tokens == 8_192
    assert budget.input_capacity == 941_808


def test_resolve_context_budget_recognizes_qwen38_max_catalog_window() -> None:
    # Given - qwen3.8-max was released 2026-08-03 and must resolve exactly.
    settings = UserSettings(model_name="qwen3.8-max", max_tokens=4096)

    # When
    budget = resolve_context_budget(settings)

    # Then
    assert budget.context_window == 1_000_000
    assert budget.max_output_tokens == 4096


def test_resolve_context_budget_falls_back_to_model_info_warehouse() -> None:
    # Given - these models live only in the model_info warehouse.
    for model_id, expected_window in [("gpt-5.6", 1_050_000), ("glm-5.2", 1_000_000)]:
        settings = UserSettings(model_name=model_id, max_tokens=4096)

        # When
        budget = resolve_context_budget(settings)

        # Then
        assert budget.context_window == expected_window


def test_resolve_context_budget_prefers_positive_user_window_override() -> None:
    # Given
    settings = UserSettings(
        model_name="qwen-max",
        context_window=65_536,
        max_tokens=4096,
    )

    # When
    budget = resolve_context_budget(settings)

    # Then
    assert budget.context_window == 65_536


def test_resolve_context_budget_accepts_pydantic_url_configuration() -> None:
    # Given
    configuration = ModelConfiguration(
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name="qwen-max",
        max_tokens=4096,
    )

    # When
    budget = resolve_context_budget(configuration)

    # Then
    assert budget.provider_origin == "https://dashscope.aliyuncs.com"


@pytest.mark.parametrize(
    ("model_name", "expected_window"),
    [
        ("compatible-unknown", 524_288),
        ("kimi-private-16k", 16_384),
        ("mistral-custom", 524_288),
    ],
)
def test_resolve_context_budget_guesses_window_for_unknown_model(
    model_name: str,
    expected_window: int,
) -> None:
    settings = UserSettings(model_name=model_name, max_tokens=4096)

    budget = resolve_context_budget(settings)

    assert budget.context_window == expected_window
    assert budget.input_capacity > 0


def test_context_budget_is_frozen_after_resolution() -> None:
    # Given
    budget = resolve_context_budget(UserSettings(model_name="qwen-max", max_tokens=4096))

    # When / Then
    with pytest.raises(FrozenInstanceError):
        budget.context_window = 1


def test_user_settings_rejects_safety_reserve_ratio_above_quarter() -> None:
    # Given / When / Then
    with pytest.raises(ValidationError):
        UserSettings(safety_reserve_ratio=0.26)


def test_resolve_context_budget_rejects_invalid_compaction_ratio_order() -> None:
    # Given
    settings = UserSettings(
        model_name="qwen-max",
        compaction_trigger_ratio=0.60,
        compaction_target_ratio=0.60,
    )

    # When / Then
    with pytest.raises(ContextBudgetConfigurationError, match="target"):
        resolve_context_budget(settings)


def test_resolve_context_budget_rejects_non_positive_input_capacity() -> None:
    # Given — max_tokens so large that capacity overflows even with reduced reserve
    settings = UserSettings(model_name="qwen-max", max_tokens=30_000)

    # When / Then
    with pytest.raises(ContextBudgetConfigurationError, match="input capacity"):
        resolve_context_budget(settings)
