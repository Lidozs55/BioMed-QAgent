"""Exact catalog contracts for Qwen3.5 Omni HTTP models."""

from __future__ import annotations

import pytest
from app.model_config import Capabilities, get_known_model

_OMNI = Capabilities(text=True, image=True, video=True, audio=True)


@pytest.mark.parametrize(
    ("model_id", "context_window", "suggested_max_tokens"),
    (
        pytest.param("qwen3.5-omni-plus", 262_144, 64_000, id="plus"),
        pytest.param(
            "qwen3.5-omni-plus-2026-03-15",
            262_144,
            64_000,
            id="plus-snapshot",
        ),
        pytest.param("qwen3.5-omni-flash", 262_144, 64_000, id="flash"),
        pytest.param(
            "qwen3.5-omni-flash-2026-03-15",
            262_144,
            64_000,
            id="flash-snapshot",
        ),
    ),
)
def test_known_omni_model(
    model_id: str,
    context_window: int,
    suggested_max_tokens: int,
) -> None:
    entry = get_known_model(model_id)
    assert entry is not None, f"{model_id} not in catalog"
    assert entry.context_window == context_window
    assert entry.suggested_max_tokens == suggested_max_tokens
    assert entry.capabilities == _OMNI


def test_omni_model_ids_present_in_catalog_dict() -> None:
    from app import model_config

    assert "qwen3.5-omni-plus" in model_config.QWEN_MODELS_DB
    assert "qwen3.5-omni-plus-2026-03-15" in model_config.QWEN_MODELS_DB
    assert "qwen3.5-omni-flash" in model_config.QWEN_MODELS_DB
    assert "qwen3.5-omni-flash-2026-03-15" in model_config.QWEN_MODELS_DB
