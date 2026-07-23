"""Public model catalog regression tests."""

from __future__ import annotations

from importlib.util import find_spec

import app.model_config as model_config


def test_catalog_preserves_stable_model_ids() -> None:
    # Given
    expected_model_ids = {
        "qwen-plus",
        "qwen-max",
        "qwen-turbo",
        "qwen-vl-max",
        "qwen-vl-plus",
        "qwen2.5-vl-72b-instruct",
        "qwen2.5-vl-32b-instruct",
        "qwen-vl-ocr",
        "qwen2-audio",
        "qwen-omni-turbo",
        "qwq-32b",
        "qwq-plus",
        "qwen3-235b-a22b",
        "qwen3.6-35b-a3b",
        "qwen3.6-flash",
        "qwen3.6-flash-2026-04-16",
        "qwen3.6-plus",
        "qwen3.6-plus-2026-04-02",
        "qwen3.7-plus",
        "qwen3.7-plus-2026-05-26",
        "qwen3.5-plus",
        "qwen3.5-plus-2026-04-20",
        "qwen3.5-plus-2026-02-15",
        "qwen3.5-flash",
        "qwen3.5-flash-2026-02-23",
        "qwen3.5-397b-a17b",
        "qwen3.5-122b-a10b",
        "qwen3.5-27b",
        "qwen3.5-35b-a3b",
        "qwen-vl-max-0319",
        "qwen-plus-0419",
        "qwen-turbo-0419",
        "gpt-4o",
        "gpt-4o-mini",
        "gpt-4-turbo",
        "o1",
        "o3-mini",
        "deepseek-chat",
        "deepseek-reasoner",
        "deepseek-v3",
        "deepseek-r1",
        "moonshot-v1-8k",
        "moonshot-v1-32k",
        "moonshot-v1-128k",
        "glm-4-plus",
        "glm-4-flash",
        "glm-4v-plus",
        "baichuan4",
        "baichuan3-turbo",
        "qwen2.5-72b-instruct",
        "qwen2.5-32b-instruct",
        "qwen2.5-14b-instruct",
    }

    # When
    model_ids = set(model_config.QWEN_MODELS_DB)

    # Then
    assert model_ids == expected_model_ids


def test_catalog_lists_recommended_models_first() -> None:
    # Given
    expected_recommended_ids = ("gpt-4o", "qwen-plus", "qwen-plus-0419")

    # When
    known_models = model_config.list_known_models()
    recommended_ids = tuple(model.id for model in known_models if model.recommended)

    # Then
    assert recommended_ids == expected_recommended_ids


def test_catalog_marks_qwen_vl_max_as_image_capable() -> None:
    # Given / When
    capabilities = model_config.QWEN_MODELS_DB["qwen-vl-max"].capabilities

    # Then
    assert capabilities.image


def test_catalog_removes_legacy_models_module() -> None:
    # Given / When / Then
    assert find_spec("app.model_config.models") is None
