"""Regression coverage for corrupt-history compaction fallback bounds."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from app.model_config.context_budget import ContextBudget, ContextBudgetOverflowError
from app.model_config.token_estimation import (
    ChatCompletionsPromptShape,
    ChatCompletionsStructuralPolicy,
    ConservativeUtf8TokenCounter,
    PromptTokenEstimator,
)
from app.runtime.compaction import CompactionRequest, ConversationCompactor
from app.runtime.compaction_planning import estimate


def _request(*, agent_input: str = "next", target_tokens: int = 850) -> CompactionRequest:
    return CompactionRequest(
        agent_input=agent_input,
        prompt_shape=ChatCompletionsPromptShape(
            instructions="bounded fallback",
            serialized_tool_schemas=(),
            policy=ChatCompletionsStructuralPolicy(),
        ),
        resolved_instructions="bounded fallback",
        budget=ContextBudget(
            context_window=2_000,
            max_output_tokens=100,
            safety_reserve_tokens=100,
            trigger_tokens=500,
            target_tokens=target_tokens,
            provider_origin="https://provider.example",
            model_name="model-a",
            tokenizer_kind="conservative",
            calibration_margin_tokens=0,
        ),
        estimator=PromptTokenEstimator(ConservativeUtf8TokenCounter()),
    )


class _Session:
    def __init__(self, items: list[dict[str, str]]) -> None:
        self._items = items

    async def get_items(self) -> list[dict[str, str]]:
        return list(self._items)


class _UnalignableRepository:
    def __init__(self, session: _Session) -> None:
        self._session = session

    def task_session(self, task_id: str) -> _Session:
        return self._session

    async def get_snapshot(self, task_id: str) -> None:
        return None

    async def load_conversation_summary(self, task_id: str) -> dict[str, str]:
        return {}


def _complete_groups(count: int, content_size: int) -> list[dict[str, str]]:
    return [
        item
        for index in range(count)
        for item in (
            {"role": "user", "content": f"question {index} " + "u" * content_size},
            {"role": "assistant", "content": f"answer {index} " + "a" * content_size},
        )
    ]


@pytest.mark.asyncio
async def test_corrupt_fallback_keeps_newest_complete_groups_within_every_limit() -> None:
    # Given
    request = _request()
    items = _complete_groups(4, 250)
    session = _Session(items)
    emitted: list[object] = []

    async def summarize(**kwargs: object) -> str:
        raise AssertionError("corrupt fallback must not call the summarizer")

    async def emit(payload: object) -> None:
        emitted.append(payload)

    assert estimate(request, items).total > request.budget.input_capacity

    # When
    preparation = await ConversationCompactor(
        _UnalignableRepository(session),
        summarize=summarize,
    ).prepare(
        "task_corrupt_history",
        model_handle=SimpleNamespace(),
        emit=emit,
        request=request,
    )
    effective = await preparation.session.get_items()

    # Then
    assert preparation.fallback is True
    assert preparation.estimate.total <= request.budget.target_tokens
    assert preparation.estimate.total <= request.budget.input_capacity
    assert effective == items[-2:]
    assert len(emitted) == 1


@pytest.mark.asyncio
async def test_corrupt_fallback_raises_when_fixed_prompt_exceeds_target() -> None:
    # Given
    request = _request(agent_input="x" * 1_000, target_tokens=400)
    items = _complete_groups(1, 250)

    async def summarize(**kwargs: object) -> str:
        raise AssertionError("overflow fallback must not call the summarizer")

    async def emit(payload: object) -> None:
        return None

    assert estimate(request, []).total > request.budget.target_tokens
    assert estimate(request, []).total <= request.budget.input_capacity

    # When
    preparation = await ConversationCompactor(
        _UnalignableRepository(_Session(items)),
        summarize=summarize,
    ).prepare(
        "task_corrupt_fixed_overflow",
        model_handle=SimpleNamespace(),
        emit=emit,
        request=request,
    )

    # Then: 固定 prompt 超 target 但未超硬容量 → 保底保留最新完整组，
    # 永不产生空输入（空输入会让续跑以 "Prepared model input is empty" 失败）。
    effective = await preparation.session.get_items()
    assert preparation.fallback is True
    assert effective
    assert preparation.estimate.total <= request.budget.input_capacity


@pytest.mark.asyncio
async def test_fixed_prompt_over_hard_capacity_raises_before_fallback() -> None:
    # Given
    request = _request(agent_input="x" * 300_000, target_tokens=400)
    items = _complete_groups(1, 250)

    async def summarize(**kwargs: object) -> str:
        raise AssertionError("capacity overflow must not call the summarizer")

    async def emit(payload: object) -> None:
        return None

    assert estimate(request, []).total > request.budget.input_capacity

    # When / Then
    with pytest.raises(ContextBudgetOverflowError):
        await ConversationCompactor(
            _UnalignableRepository(_Session(items)),
            summarize=summarize,
        ).prepare(
            "task_corrupt_capacity_overflow",
            model_handle=SimpleNamespace(),
            emit=emit,
            request=request,
        )
