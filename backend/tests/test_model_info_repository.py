"""Unit tests for the model information warehouse.

Covers:
- ModelDetail schema validation
- ModelInfoRepository data loading
- Lookup, filtering, search, and vendor listing
- Provider registration completeness
"""

from __future__ import annotations

import pytest
from app.model_info import (
    ModelCapabilities,
    ModelDetail,
    ModelInfoRepository,
    capabilities_summary,
    format_context_window,
    format_pricing,
    get_repository,
)
from pydantic import ValidationError


class TestModelCapabilities:
    """Model capabilities flag tests."""

    def test_defaults(self) -> None:
        caps = ModelCapabilities()
        assert caps.text is True
        assert caps.image is False
        assert caps.video is False
        assert caps.audio is False

    def test_all_true(self) -> None:
        caps = ModelCapabilities(text=True, image=True, video=True, audio=True)
        assert caps.text
        assert caps.image
        assert caps.video
        assert caps.audio

    def test_model_dump(self) -> None:
        caps = ModelCapabilities(text=True, image=True)
        dumped = caps.model_dump()
        assert dumped == {"text": True, "image": True, "video": False, "audio": False}


class TestModelDetail:
    """Model detail schema validation."""

    def test_minimal(self) -> None:
        detail = ModelDetail(
            id="test-model",
            name="Test Model",
            description="A test model entry.",
            vendor_id="test-vendor",
            input_context_window=4096,
            max_output_tokens=1024,
            suggested_max_tokens=512,
        )
        assert detail.id == "test-model"
        assert detail.input_context_window == 4096
        assert detail.max_output_tokens == 1024
        assert detail.suggested_max_tokens == 512
        assert detail.capabilities.text is True  # default
        assert detail.knowledge_cutoff is None
        assert detail.pricing_input_per_1m is None
        assert detail.recommended is False
        assert detail.function_calling is True  # default
        assert detail.supports_streaming is True  # default

    def test_with_all_fields(self) -> None:
        detail = ModelDetail(
            id="qwen-plus",
            name="Qwen Plus",
            description="Full test entry.",
            vendor_id="dashscope",
            input_context_window=1_000_000,
            max_output_tokens=32_000,
            suggested_max_tokens=8_192,
            capabilities=ModelCapabilities(text=True, image=True),
            knowledge_cutoff="2025-12",
            pricing_input_per_1m=0.80,
            pricing_output_per_1m=2.00,
            recommended=True,
            model_family="qwen",
            function_calling=True,
            supports_streaming=True,
        )
        assert detail.knowledge_cutoff == "2025-12"
        assert detail.pricing_input_per_1m == 0.80
        assert detail.recommended is True
        assert detail.model_family == "qwen"

    def test_negative_input_window_raises(self) -> None:
        with pytest.raises(ValidationError) as error:
            ModelDetail(
                id="bad",
                name="Bad",
                description="Negative context",
                vendor_id="test",
                input_context_window=-1,
                max_output_tokens=100,
                suggested_max_tokens=50,
            )
        validation_error = error.value.errors()[0]
        assert validation_error["loc"] == ("input_context_window",)
        assert validation_error["type"] == "greater_than_equal"
        assert validation_error["ctx"] == {"ge": 1}


class TestFormatHelpers:
    """Format utility tests."""

    @pytest.mark.parametrize(
        ("tokens", "expected"),
        [
            (1_000_000, "1.0M"),
            (1_500_000, "1.5M"),
            (128_000, "128K"),
            (4_096, "4K"),
            (500, "500"),
            (0, "0"),
        ],
    )
    def test_format_context_window(self, tokens: int, expected: str) -> None:
        assert format_context_window(tokens) == expected

    @pytest.mark.parametrize(
        ("price_val", "expected"),
        [
            (0.80, "$0.80"),
            (2.50, "$2.50"),
            (None, "—"),
            (0.0, "$0.00"),
        ],
    )
    def test_format_pricing(self, price_val: float | None, expected: str) -> None:
        assert format_pricing(price_val) == expected

    def test_capabilities_summary(self) -> None:
        caps = ModelCapabilities(text=True, image=True)
        labels = capabilities_summary(caps)
        assert "text" in labels
        assert "image" in labels
        assert "video" not in labels
        assert "audio" not in labels


class TestModelInfoRepository:
    """Repository data warehouse tests."""

    def test_repository_contains_known_models(self) -> None:
        repo = ModelInfoRepository()
        # At minimum we expect key models from each provider.
        assert repo.count >= 10
        assert repo.get_model("qwen-plus") is not None
        assert repo.get_model("gpt-4o") is not None
        assert repo.get_model("deepseek-chat") is not None

    def test_qwen38_max_registered_in_warehouse(self) -> None:
        """The 2026-08-03 Qwen3.8-Max release must be present with exact specs."""
        repo = ModelInfoRepository()
        model = repo.get_model("qwen3.8-max")
        assert model is not None
        assert model.vendor_id == "dashscope"
        assert model.input_context_window == 1_000_000
        assert model.max_output_tokens == 64_000
        assert model.capabilities.image is True
        assert model.capabilities.video is True

    def test_get_model_missing(self) -> None:
        repo = ModelInfoRepository()
        assert repo.get_model("nonexistent-model-v42") is None

    def test_get_model_or_raise(self) -> None:
        repo = ModelInfoRepository()
        detail = repo.get_model_or_raise("qwen-plus")
        assert detail.vendor_id == "dashscope"
        with pytest.raises(KeyError):
            repo.get_model_or_raise("does-not-exist")

    def test_list_models_no_filter(self) -> None:
        repo = ModelInfoRepository()
        all_models = repo.list_models()
        assert len(all_models) == repo.count
        # First model should be recommended (sorted by not recommended first).
        assert all_models[0].recommended is True

    def test_list_models_by_vendor(self) -> None:
        repo = ModelInfoRepository()
        dashscope_models = repo.list_models(vendor="dashscope")
        assert all(m.vendor_id == "dashscope" for m in dashscope_models)
        assert len(dashscope_models) > 0

        openai_models = repo.list_models(vendor="openai")
        assert all(m.vendor_id == "openai" for m in openai_models)
        assert "gpt-4o" in [m.id for m in openai_models]

    def test_list_models_by_capability(self) -> None:
        repo = ModelInfoRepository()
        image_models = repo.list_models(capability="image")
        assert len(image_models) > 0
        for model in image_models:
            assert model.capabilities.image is True

    def test_list_models_by_capability_audio(self) -> None:
        repo = ModelInfoRepository()
        audio_models = repo.list_models(capability="audio")
        assert len(audio_models) > 0
        for model in audio_models:
            assert model.capabilities.audio is True

    def test_recommended_only(self) -> None:
        repo = ModelInfoRepository()
        recommended = repo.list_models(recommended_only=True)
        assert len(recommended) > 0
        assert all(m.recommended for m in recommended)

    def test_list_vendors(self) -> None:
        repo = ModelInfoRepository()
        vendors = repo.list_vendors()
        assert "dashscope" in vendors
        assert "openai" in vendors
        assert "deepseek" in vendors
        assert "moonshot" in vendors
        assert "zhipu" in vendors
        assert "baichuan" in vendors

    def test_new_providers_registered(self) -> None:
        repo = ModelInfoRepository()
        vendors = repo.list_vendors()
        assert "groq" in vendors
        assert "xai" in vendors
        assert "mistral" in vendors
        assert repo.get_model("grok-4.5") is not None
        assert repo.get_model("meta-llama/llama-4-scout-17b-16e-instruct") is not None
        assert repo.get_model("mistral-large-latest") is not None
        assert repo.get_model("kimi/kimi-k3") is not None
        assert repo.get_model("kimi-k2.6") is not None
        assert repo.get_model("kimi-k2.7-code") is not None

    def test_kimi_k3_context_window_corrected(self) -> None:
        repo = ModelInfoRepository()
        model = repo.get_model("kimi/kimi-k3")
        assert model is not None
        assert model.input_context_window == 1_048_576
        assert model.max_output_tokens == 131_072

    def test_zhipu_new_models_present(self) -> None:
        repo = ModelInfoRepository()
        for model_id in ("glm-5-turbo", "glm-4.5", "glm-4.5-air", "glm-4.6v-flash"):
            assert repo.get_model(model_id) is not None

    def test_search(self) -> None:
        repo = ModelInfoRepository()
        results = repo.search("qwen-plus")
        assert len(results) >= 1
        assert any(m.id == "qwen-plus" for m in results)

        results = repo.search("gpt")
        assert len(results) >= 1
        assert any("gpt" in m.id for m in results)

    def test_search_by_vendor_name(self) -> None:
        repo = ModelInfoRepository()
        results = repo.search("deepseek")
        assert len(results) >= 1
        assert any(m.vendor_id == "deepseek" for m in results)

    def test_list_by_family(self) -> None:
        repo = ModelInfoRepository()
        qwen_models = repo.list_by_family("qwen")
        assert len(qwen_models) >= 1
        assert all(m.model_family == "qwen" for m in qwen_models)

    def test_to_flat_dicts(self) -> None:
        repo = ModelInfoRepository()
        dicts = repo.to_flat_dicts()
        assert len(dicts) == repo.count
        assert all(isinstance(d, dict) for d in dicts)
        # Spot check a known model
        qwen_plus = next((d for d in dicts if d["id"] == "qwen-plus"), None)
        assert qwen_plus is not None
        assert qwen_plus["vendor_id"] == "dashscope"
        assert qwen_plus["input_context_window"] == 1_000_000

    def test_model_has_required_fields(self) -> None:
        repo = ModelInfoRepository()
        for model in repo.list_models():
            assert model.id, f"Model missing id: {model}"
            assert model.name, f"Model missing name: {model.id}"
            assert model.vendor_id, f"Model missing vendor_id: {model.id}"
            assert model.input_context_window > 0
            assert model.max_output_tokens > 0
            assert model.suggested_max_tokens > 0


class TestSingletonRepository:
    """Singleton get_repository() tests."""

    def test_singleton_returns_same_instance(self) -> None:
        repo1 = get_repository()
        repo2 = get_repository()
        assert repo1 is repo2

    def test_singleton_is_populated(self) -> None:
        repo = get_repository()
        assert repo.count >= 10
