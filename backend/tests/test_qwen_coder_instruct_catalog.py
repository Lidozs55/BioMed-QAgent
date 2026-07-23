"""Catalog-lookup tests for Qwen3-Coder instruct models."""

from __future__ import annotations

import pytest
from app.model_config import (
    Capabilities,
    get_known_model,
)


@pytest.mark.parametrize(
    ("model_id", "context_window", "suggested_max_tokens"),
    [
        pytest.param(
            "qwen3-coder-480b-a35b-instruct",
            262_144,
            64_000,
            id="480b-a35b",
        ),
        pytest.param(
            "qwen3-coder-30b-a3b-instruct",
            262_144,
            64_000,
            id="30b-a3b",
        ),
    ],
)
def test_known_qwen_coder_instruct_model(
    model_id: str,
    context_window: int,
    suggested_max_tokens: int,
) -> None:
    # Given / When
    entry = get_known_model(model_id)

    # Then
    assert entry is not None
    assert entry.id == model_id
    assert entry.context_window == context_window
    assert entry.suggested_max_tokens == suggested_max_tokens
    assert entry.capabilities == Capabilities(text=True)
