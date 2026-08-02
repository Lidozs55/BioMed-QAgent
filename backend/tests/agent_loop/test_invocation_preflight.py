"""Unit tests for InvocationPreflight and calibration recording."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import Mock

import app.agent_loop.invocation as invocation_module
import pytest
from app.agent_loop.context import RunContext
from app.model_config.context_budget import ContextBudgetOverflowError
from app.model_config.token_estimation import (
    ChatCompletionsPromptShape,
    ChatCompletionsStructuralPolicy,
    PromptTokenEstimator,
)
from app.model_settings import ModelSettingsStore, set_current_model_settings_store
from app.runtime.compaction_types import CompactionCancelledError


def _budget(*, calibration_margin_tokens: int = 0) -> Mock:
    return Mock(
        context_window=65536,
        max_output_tokens=4096,
        safety_reserve_tokens=3276,
        trigger_tokens=48000,
        target_tokens=35000,
        provider_origin="https://dashscope.aliyuncs.com",
        model_name="qwen-plus",
        tokenizer_kind="conservative",
        calibration_margin_tokens=calibration_margin_tokens,
        input_capacity=56000,
    )


def _prompt_shape() -> ChatCompletionsPromptShape:
    return ChatCompletionsPromptShape(
        instructions="Test instructions.",
        serialized_tool_schemas=(),
        policy=ChatCompletionsStructuralPolicy(),
    )


class _RecordingCompactor:
    """Compactor that records the request it received."""

    def __init__(self, preparation: object = None) -> None:
        self.last_request = None
        self._preparation = preparation or SimpleNamespace(
            session=object(),
            agent_input="filtered",
            estimate=Mock(total=500),
        )

    async def prepare(self, task_id, *, model_handle, emit, request, session,
                      cancellation_requested, commit):
        self.last_request = request
        return self._preparation


class TestInvocationPreflight:
    """Scenario 1: preflight constructs and passes a CompactionRequest."""

    @pytest.mark.asyncio
    async def test_preflight_passes_compaction_request_to_compactor(self) -> None:
        budget = _budget()
        prompt_shape = _prompt_shape()
        compactor = _RecordingCompactor()
        preflight = invocation_module.InvocationPreflight.from_budget(
            budget, prompt_shape, compactor
        )

        preparation = await preflight.preflight(
            "task_1",
            "query something",
            model_handle=object(),
            emit=Mock(),
            session=object(),
            cancellation_requested=None,
            commit=None,
        )

        assert compactor.last_request is not None
        assert compactor.last_request.agent_input == "query something"
        assert compactor.last_request.prompt_shape is prompt_shape
        assert compactor.last_request.budget is budget
        assert isinstance(compactor.last_request.estimator, PromptTokenEstimator)
        assert preparation.session is compactor._preparation.session
        assert preparation.agent_input == "filtered"

    @pytest.mark.asyncio
    async def test_preflight_resolves_dynamic_instructions_from_context(
        self, tmp_path
    ) -> None:
        budget = _budget()
        prompt_shape = _prompt_shape()
        compactor = _RecordingCompactor()
        preflight = invocation_module.InvocationPreflight.from_budget(
            budget, prompt_shape, compactor
        )
        context = RunContext(task_id="task_dyn", base_dir=tmp_path)

        await preflight.preflight(
            "task_dyn", "query",
            model_handle=object(), emit=Mock(), session=object(),
            cancellation_requested=None, commit=None, context=context,
        )

        request = compactor.last_request
        assert "已完成的检索" in request.resolved_instructions
        assert "暂无检索记录" in request.resolved_instructions


class TestInvalidContextRaises:
    """Regression for I-1: non-RunContext must not be silently suppressed."""

    @pytest.mark.asyncio
    async def test_invalid_context_raises_attribute_error(self) -> None:
        budget = _budget()
        prompt_shape = _prompt_shape()
        compactor = _RecordingCompactor()
        preflight = invocation_module.InvocationPreflight.from_budget(
            budget, prompt_shape, compactor
        )
        # An object that is not None but lacks RunContext fields
        bogus_context = SimpleNamespace(foo="bar")

        with pytest.raises(AttributeError, match="preferred_sources|query_log_summary"):
            await preflight.preflight(
                "task_bogus", "query",
                model_handle=object(), emit=Mock(), session=object(),
                cancellation_requested=None, commit=None,
                context=bogus_context,
            )


class TestOverflowPropagation:
    """Scenario 2: typed overflow produces zero SDK calls."""

    @pytest.mark.asyncio
    async def test_context_budget_overflow_propagates_typed_error(self) -> None:
        budget = _budget()
        prompt_shape = _prompt_shape()

        class OverflowCompactor:
            async def prepare(self, task_id, **kwargs):
                raise ContextBudgetOverflowError(
                    estimated_tokens=99999, limit_tokens=56000
                )

        preflight = invocation_module.InvocationPreflight.from_budget(
            budget, prompt_shape, OverflowCompactor()
        )
        with pytest.raises(ContextBudgetOverflowError) as exc:
            await preflight.preflight(
                "task_of", "too much",
                model_handle=object(), emit=Mock(), session=object(),
                cancellation_requested=None, commit=None,
            )
        assert exc.value.estimated_tokens == 99999

    @pytest.mark.asyncio
    async def test_cancellation_during_preflight_propagates(self) -> None:
        budget = _budget()
        prompt_shape = _prompt_shape()

        class CancellingCompactor:
            async def prepare(self, task_id, **kwargs):
                raise CompactionCancelledError("cancelled during prep")

        preflight = invocation_module.InvocationPreflight.from_budget(
            budget, prompt_shape, CancellingCompactor()
        )
        with pytest.raises(CompactionCancelledError, match="cancelled during prep"):
            await preflight.preflight(
                "task_cancel", "query",
                model_handle=object(), emit=Mock(), session=object(),
                cancellation_requested=None, commit=None,
            )


class TestCalibrationRecording:
    """Scenarios 6–9: usage characterization and calibration persistence."""

    def test_records_positive_residual_from_authoritative_input_tokens(
        self, tmp_path
    ) -> None:
        budget = _budget(calibration_margin_tokens=100)
        store = ModelSettingsStore(
            tmp_path / "settings" / "model.json",
            defaults=Mock(
                dashscope_base_url="https://dashscope.example/v1",
                dashscope_api_key="k",
                model_name="qwen-plus",
            ),
        )
        set_current_model_settings_store(store)
        estimate = Mock(total=600)
        budget.calibration_margin_tokens = 100
        usage = Mock(input_tokens=800, spec=["input_tokens"])
        response = Mock(usage=usage, spec=["usage"])
        result = Mock(raw_responses=[response], spec=["raw_responses"])

        invocation_module.record_calibration_from_result(result, estimate, budget)

        margin = store.calibration_margin_for(budget)
        # residual = 800 - (600 - 100) = 300; margin = min(300, 6553) = 300
        assert margin == 300

    def test_missing_usage_is_no_op(self, tmp_path) -> None:
        budget = _budget()
        store = ModelSettingsStore(
            tmp_path / "settings" / "model_noop.json",
            defaults=Mock(
                dashscope_base_url="https://dashscope.example/v1",
                dashscope_api_key="k",
                model_name="qwen-plus",
            ),
        )
        set_current_model_settings_store(store)
        estimate = Mock(total=500)
        response = SimpleNamespace()  # no .usage
        result = Mock(raw_responses=[response], spec=["raw_responses"])

        invocation_module.record_calibration_from_result(result, estimate, budget)
        assert store.calibration_margin_for(budget) == 0

    def test_missing_raw_responses_is_no_op(self, tmp_path) -> None:
        budget = _budget()
        store = ModelSettingsStore(
            tmp_path / "settings" / "model_noop2.json",
            defaults=Mock(
                dashscope_base_url="https://dashscope.example/v1",
                dashscope_api_key="k",
                model_name="qwen-plus",
            ),
        )
        set_current_model_settings_store(store)
        estimate = Mock(total=500)
        result = SimpleNamespace()  # no .raw_responses

        invocation_module.record_calibration_from_result(result, estimate, budget)
        assert store.calibration_margin_for(budget) == 0

    def test_zero_input_tokens_is_no_op(self, tmp_path) -> None:
        budget = _budget()
        store = ModelSettingsStore(
            tmp_path / "settings" / "model_zero.json",
            defaults=Mock(
                dashscope_base_url="https://dashscope.example/v1",
                dashscope_api_key="k",
                model_name="qwen-plus",
            ),
        )
        set_current_model_settings_store(store)
        estimate = Mock(total=500)
        usage = Mock(input_tokens=0, spec=["input_tokens"])
        response = Mock(usage=usage, spec=["usage"])
        result = Mock(raw_responses=[response], spec=["raw_responses"])

        invocation_module.record_calibration_from_result(result, estimate, budget)
        assert store.calibration_margin_for(budget) == 0

    def test_non_positive_residual_is_no_op(self, tmp_path) -> None:
        """When estimator over-estimates, no residual recorded."""
        budget = _budget(calibration_margin_tokens=0)
        store = ModelSettingsStore(
            tmp_path / "settings" / "model_neg.json",
            defaults=Mock(
                dashscope_base_url="https://dashscope.example/v1",
                dashscope_api_key="k",
                model_name="qwen-plus",
            ),
        )
        set_current_model_settings_store(store)
        estimate = Mock(total=5000)
        budget.calibration_margin_tokens = 0
        usage = Mock(input_tokens=4000, spec=["input_tokens"])
        response = Mock(usage=usage, spec=["usage"])
        result = Mock(raw_responses=[response], spec=["raw_responses"])

        invocation_module.record_calibration_from_result(result, estimate, budget)
        assert store.calibration_margin_for(budget) == 0

    def test_active_budget_is_never_mutated_by_calibration(
        self, tmp_path
    ) -> None:
        """Scenario 9: budget snapshot stays frozen after usage recording."""
        budget = _budget(calibration_margin_tokens=100)
        original_margin = budget.calibration_margin_tokens
        store = ModelSettingsStore(
            tmp_path / "settings" / "model_frozen.json",
            defaults=Mock(
                dashscope_base_url="https://dashscope.example/v1",
                dashscope_api_key="k",
                model_name="qwen-plus",
            ),
        )
        set_current_model_settings_store(store)
        estimate = Mock(total=600)
        budget.calibration_margin_tokens = 100
        usage = Mock(input_tokens=800, spec=["input_tokens"])
        response = Mock(usage=usage, spec=["usage"])
        result = Mock(raw_responses=[response], spec=["raw_responses"])

        invocation_module.record_calibration_from_result(result, estimate, budget)

        assert budget.calibration_margin_tokens == original_margin

    def test_sdk_usage_shape_is_characterized_via_public_interface(self) -> None:
        """Scenario 6: verify the public usage shape contract."""
        from agents.usage import Usage

        usage = Usage(input_tokens=42, output_tokens=7, total_tokens=49)
        assert usage.input_tokens == 42
        assert isinstance(usage.input_tokens, int)

        from agents.items import ModelResponse

        # ModelResponse is a dataclass — verify it exposes usage in its fields.
        assert "usage" in ModelResponse.__dataclass_fields__
