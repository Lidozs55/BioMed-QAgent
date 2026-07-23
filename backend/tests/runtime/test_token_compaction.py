"""Token-targeted compaction scenarios for Task 3."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from app.domain.contracts import RunStatus
from app.model_config.context_budget import ContextBudget
from app.model_config.token_estimation import (
    ChatCompletionsPromptShape,
    ChatCompletionsStructuralPolicy,
    ConservativeUtf8TokenCounter,
    PromptTokenEstimator,
)
from app.runtime.compaction import (
    CompactionRequest,
    ContextBudgetOverflowError,
    ConversationCompactor,
)


def _request() -> CompactionRequest:
    return CompactionRequest(
        agent_input="next question",
        prompt_shape=ChatCompletionsPromptShape(
            instructions="resolved instructions",
            serialized_tool_schemas=(),
            policy=ChatCompletionsStructuralPolicy(),
        ),
        resolved_instructions="resolved instructions",
        budget=ContextBudget(
            context_window=1_000,
            max_output_tokens=100,
            safety_reserve_tokens=100,
            trigger_tokens=500,
            target_tokens=300,
            provider_origin="https://provider.example",
            model_name="model-a",
            tokenizer_kind="conservative",
            calibration_margin_tokens=0,
        ),
        estimator=PromptTokenEstimator(ConservativeUtf8TokenCounter()),
    )


@pytest.mark.asyncio
async def test_prepare_preserves_effective_input_when_estimate_is_below_trigger() -> None:
    # Given
    class Session:
        async def get_items(self) -> list[dict[str, str]]:
            return [{"role": "user", "content": "earlier question"}]

    class Repository:
        session = Session()

        def task_session(self, task_id: str) -> Session:
            return self.session

        async def get_snapshot(self, task_id: str) -> SimpleNamespace:
            return SimpleNamespace(runs=[])

        async def load_conversation_summary(self, task_id: str) -> dict[str, str]:
            return {}

    async def summarize(**kwargs: object) -> str:
        raise AssertionError("a below-trigger prompt must not summarize")

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    repository = Repository()

    # When
    preparation = await ConversationCompactor(repository, summarize=summarize).prepare(
        "task_below_trigger",
        model_handle=object(),
        emit=emit,
        request=_request(),
    )

    # Then
    assert preparation.session is repository.session
    assert preparation.agent_input == "next question"
    assert preparation.estimate.total < _request().budget.trigger_tokens
    assert preparation.compacted is False
    assert preparation.degraded_alignment is False
    assert emitted == []


class _ZeroCounter:
    def count(self, text: str) -> int:
        return 0


@pytest.mark.asyncio
async def test_prepare_compacts_when_estimate_equals_trigger() -> None:
    # Given
    items = [
        {"role": "user", "content": "question zero"},
        {"role": "assistant", "content": "answer zero"},
        {"role": "user", "content": "question one"},
        {"role": "assistant", "content": "answer one"},
    ]

    class Session:
        async def get_items(self) -> list[dict[str, str]]:
            return list(items)

        async def add_items(self, new_items: list[dict[str, str]]) -> None:
            items.extend(new_items)

        async def pop_item(self) -> None:
            return None

        async def clear_session(self) -> None:
            items.clear()

    class Repository:
        session = Session()
        saved_summary: dict[str, object] | None = None

        def task_session(self, task_id: str) -> Session:
            return self.session

        async def get_snapshot(self, task_id: str) -> SimpleNamespace:
            return SimpleNamespace(
                runs=[
                    SimpleNamespace(
                        run_id=f"run_{index}",
                        input=f"question {'zero' if index == 0 else 'one'}",
                        status=RunStatus.COMPLETED,
                    )
                    for index in range(2)
                ]
            )

        async def load_conversation_summary(self, task_id: str) -> dict[str, str]:
            return {}

        async def save_conversation_summary(
            self,
            task_id: str,
            summary: dict[str, object],
        ) -> None:
            self.saved_summary = summary

    request = CompactionRequest(
        agent_input="next question",
        prompt_shape=ChatCompletionsPromptShape(
            instructions="ignored",
            serialized_tool_schemas=(),
            policy=ChatCompletionsStructuralPolicy(),
        ),
        resolved_instructions="ignored",
        budget=ContextBudget(
            context_window=1_000,
            max_output_tokens=100,
            safety_reserve_tokens=100,
            trigger_tokens=26,
            target_tokens=14,
            provider_origin="https://provider.example",
            model_name="model-a",
            tokenizer_kind="conservative",
            calibration_margin_tokens=0,
        ),
        estimator=PromptTokenEstimator(_ZeroCounter()),
    )

    async def summarize(**kwargs: object) -> str:
        return "summary"

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    # When
    preparation = await ConversationCompactor(
        Repository(),
        summarize=summarize,
    ).prepare(
        "task_equal_trigger",
        model_handle=object(),
        emit=emit,
        request=request,
    )

    # Then
    assert preparation.estimate.total == request.budget.target_tokens
    assert preparation.compacted is True
    assert len(emitted) == 1


@pytest.mark.asyncio
async def test_prepare_rejects_fixed_prompt_overflow_before_summary_or_repository_reads() -> None:
    # Given
    calls: list[str] = []

    class Session:
        async def get_items(self) -> list[dict[str, str]]:
            calls.append("session")
            return []

    class Repository:
        session = Session()

        def task_session(self, task_id: str) -> Session:
            return self.session

        async def get_snapshot(self, task_id: str) -> None:
            calls.append("snapshot")
            return None

        async def load_conversation_summary(self, task_id: str) -> dict[str, str]:
            calls.append("summary")
            return {}

    request = CompactionRequest(
        agent_input="input",
        prompt_shape=ChatCompletionsPromptShape(
            instructions="fixed prompt cannot fit",
            serialized_tool_schemas=(),
            policy=ChatCompletionsStructuralPolicy(
                message_wrapper_tokens=0,
                assistant_priming_tokens=0,
                tool_envelope_tokens=0,
            ),
        ),
        resolved_instructions="fixed prompt cannot fit",
        budget=ContextBudget(
            context_window=20,
            max_output_tokens=5,
            safety_reserve_tokens=5,
            trigger_tokens=8,
            target_tokens=6,
            provider_origin="https://provider.example",
            model_name="model-a",
            tokenizer_kind="conservative",
            calibration_margin_tokens=0,
        ),
        estimator=PromptTokenEstimator(ConservativeUtf8TokenCounter()),
    )

    async def summarize(**kwargs: object) -> str:
        calls.append("summarize")
        return "unreachable"

    async def emit(payload: object) -> None:
        calls.append("emit")

    # When / Then
    with pytest.raises(ContextBudgetOverflowError, match="fixed prompt"):
        await ConversationCompactor(Repository(), summarize=summarize).prepare(
            "task_fixed_overflow",
            model_handle=object(),
            emit=emit,
            request=request,
        )

    assert calls == []
