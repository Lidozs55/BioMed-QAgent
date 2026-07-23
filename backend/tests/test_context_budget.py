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

    # Then
    assert budget.context_window == 32_768
    assert budget.max_output_tokens == 4096
    assert budget.safety_reserve_tokens == 16_384
    assert budget.input_capacity == 12_288
    assert budget.trigger_tokens == 10_445
    assert budget.target_tokens == 7373


def test_resolve_context_budget_preserves_exact_million_token_catalog_window() -> None:
    # Given
    settings = UserSettings(model_name="qwen-turbo", max_tokens=4096)

    # When
    budget = resolve_context_budget(settings)

    # Then
    assert budget.context_window == 1_000_000
    assert budget.safety_reserve_tokens == 50_000


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


def test_resolve_context_budget_rejects_unknown_model_without_positive_window() -> None:
    # Given
    settings = UserSettings(model_name="compatible-unknown", max_tokens=4096)

    # When / Then
    with pytest.raises(ContextBudgetConfigurationError, match="context window"):
        resolve_context_budget(settings)


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
    # Given
    settings = UserSettings(model_name="qwen-max", max_tokens=16_384)

    # When / Then
    with pytest.raises(ContextBudgetConfigurationError, match="input capacity"):
        resolve_context_budget(settings)
