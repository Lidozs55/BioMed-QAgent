"""Durability, cancellation, and truncation contracts for Task 3 compaction."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import app.runtime.compaction as compaction_module
import pytest
from agents.stream_events import RawResponsesStreamEvent
from app.agent_loop.model import LazyDashScopeModel
from app.model_config import RunModelSettings
from app.runtime.compaction import (
    CompactionCancelledError,
    ConversationCompactor,
    ConversationSummarizerTruncatedError,
)
from compaction_support import budgeted_request, completed_snapshot, conversation_items


@pytest.mark.asyncio
async def test_default_summarizer_uses_same_model_without_tools(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    model = LazyDashScopeModel(RunModelSettings.default())
    captured: dict[str, object] = {}

    def run_streamed(agent: object, prompt: str, **kwargs: object) -> SimpleNamespace:
        captured.update(agent=agent, prompt=prompt, kwargs=kwargs)

        async def stream_events():
            return
            yield

        return SimpleNamespace(final_output="compact summary", stream_events=stream_events)

    monkeypatch.setattr(compaction_module.Runner, "run_streamed", run_streamed)

    # When
    summary = await compaction_module._summarize_with_model(
        model_handle=model,
        history=[{"role": "user", "content": "question"}],
        previous_summary=None,
    )

    # Then
    assert summary == "compact summary"
    assert captured["agent"].model is model
    assert captured["agent"].tools == []
    assert captured["kwargs"] == {"max_turns": 1}


@pytest.mark.asyncio
async def test_default_summarizer_raises_on_length_truncation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    class Choice:
        finish_reason = "length"

    class Chunk:
        choices = [Choice()]

    def run_streamed(*args: object, **kwargs: object) -> SimpleNamespace:
        async def stream_events():
            yield RawResponsesStreamEvent(data=Chunk())

        return SimpleNamespace(final_output="partial", stream_events=stream_events)

    monkeypatch.setattr(compaction_module.Runner, "run_streamed", run_streamed)

    # When / Then
    with pytest.raises(ConversationSummarizerTruncatedError, match="finish_reason=length"):
        await compaction_module._summarize_with_model(
            model_handle=LazyDashScopeModel(RunModelSettings.default()),
            history=[{"role": "user", "content": "question"}],
            previous_summary=None,
        )


@pytest.mark.asyncio
async def test_prepare_propagates_truncated_summary_without_fallback() -> None:
    # Given
    items = conversation_items(3, "x" * 2_000)
    emitted: list[object] = []

    class Session:
        async def get_items(self) -> list[dict[str, str]]:
            return list(items)

    class Repository:
        session = Session()

        def task_session(self, task_id: str) -> Session:
            return self.session

        async def get_snapshot(self, task_id: str):
            return completed_snapshot(task_id, 3)

        async def load_conversation_summary(self, task_id: str) -> dict[str, object]:
            return {}

    async def summarize(**kwargs: object) -> str:
        raise ConversationSummarizerTruncatedError("finish_reason=length")

    async def emit(payload: object) -> None:
        emitted.append(payload)

    # When / Then
    with pytest.raises(ConversationSummarizerTruncatedError):
        await ConversationCompactor(Repository(), summarize=summarize).prepare(
            "task_length_truncated",
            model_handle=object(),
            emit=emit,
            request=budgeted_request(),
        )

    assert emitted == []


@pytest.mark.asyncio
async def test_cancellation_before_preparation_skips_summary_and_commit() -> None:
    # Given
    cancellation_requested = asyncio.Event()
    cancellation_requested.set()
    summarized = False
    committed = False

    class Repository:
        def task_session(self, task_id: str) -> object:
            raise AssertionError("cancelled preparation must not load a session")

    async def summarize(**kwargs: object) -> str:
        nonlocal summarized
        summarized = True
        return "summary"

    async def commit(*args: object) -> bool:
        nonlocal committed
        committed = True
        return True

    async def emit(payload: object) -> None:
        raise AssertionError("cancelled preparation must not emit")

    # When / Then
    with pytest.raises(CompactionCancelledError):
        await ConversationCompactor(Repository(), summarize=summarize).prepare(
            "task_cancelled",
            model_handle=object(),
            emit=emit,
            request=budgeted_request(),
            cancellation_requested=cancellation_requested,
            commit=commit,
        )

    assert summarized is False
    assert committed is False


# ── Narrow-catch propagation: unexpected internal errors must not fallback ──


@pytest.mark.asyncio
async def test_unexpected_keyerror_from_repository_get_snapshot_propagates() -> None:
    """KeyError from repository internals must propagate, not silently fall back."""
    # Given
    items = conversation_items(10, "x" * 200)

    class Session:
        async def get_items(self) -> list[dict[str, str]]:
            return list(items)

    class Repository:
        session = Session()

        def task_session(self, task_id: str) -> Session:
            return self.session

        async def get_snapshot(self, task_id: str):
            raise KeyError("unexpected repository bug")

        async def load_conversation_summary(self, task_id: str) -> dict[str, object]:
            raise AssertionError("must not reach summary load after KeyError")

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    # When / Then
    with pytest.raises(KeyError, match="unexpected repository bug"):
        await ConversationCompactor(Repository()).prepare(
            "task_keyerror_propagate",
            model_handle=object(),
            emit=emit,
            request=budgeted_request(),
        )

    assert emitted == []


@pytest.mark.asyncio
async def test_unexpected_runtimeerror_from_repository_get_snapshot_propagates() -> None:
    """RuntimeError from repository internals must propagate, not silently fall back."""
    # Given
    items = conversation_items(10, "x" * 200)

    class Session:
        async def get_items(self) -> list[dict[str, str]]:
            return list(items)

    class Repository:
        session = Session()

        def task_session(self, task_id: str) -> Session:
            return self.session

        async def get_snapshot(self, task_id: str):
            raise RuntimeError("unexpected repository bug")

        async def load_conversation_summary(self, task_id: str) -> dict[str, object]:
            raise AssertionError("must not reach summary load after RuntimeError")

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    # When / Then
    with pytest.raises(RuntimeError, match="unexpected repository bug"):
        await ConversationCompactor(Repository()).prepare(
            "task_rterror_propagate",
            model_handle=object(),
            emit=emit,
            request=budgeted_request(),
        )

    assert emitted == []


@pytest.mark.asyncio
async def test_unexpected_typeerror_from_repository_save_conversation_summary_propagates() -> None:
    """TypeError from repository save must propagate, not silently fall back."""
    # Given
    items = conversation_items(4, "x" * 200)

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

        def task_session(self, task_id: str) -> Session:
            return self.session

        async def get_snapshot(self, task_id: str):
            return completed_snapshot(task_id, 4)

        async def load_conversation_summary(self, task_id: str) -> dict[str, object]:
            return {}

        async def save_conversation_summary(
            self, task_id: str, summary: dict[str, object]
        ) -> None:
            raise TypeError("unexpected repository save bug")

    async def summarize(**kwargs: object) -> str:
        return "short summary"

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    # When / Then
    with pytest.raises(TypeError, match="unexpected repository save bug"):
        await ConversationCompactor(Repository(), summarize=summarize).prepare(
            "task_tperror_propagate",
            model_handle=object(),
            emit=emit,
            request=budgeted_request(),
        )

    assert emitted == []
