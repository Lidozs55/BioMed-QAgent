"""Cancellation and atomic persistence contracts for token compaction."""

from __future__ import annotations

import asyncio

import pytest
from app.agent_loop.context import RunContext
from app.domain.contracts import (
    ConversationCompactedPayload,
    TaskRunAccepted,
    build_event,
)
from app.runtime.compaction import CompactionCancelledError, ConversationCompactor
from app.runtime.manager import TaskManager
from compaction_support import budgeted_request, completed_snapshot, conversation_items


@pytest.mark.asyncio
async def test_cancellation_while_summarizer_is_blocked_prevents_commit() -> None:
    # Given
    items = conversation_items(3, "x" * 2_000)
    cancellation_requested = asyncio.Event()
    summary_started = asyncio.Event()
    release_summary = asyncio.Event()
    committed = False

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
        summary_started.set()
        await release_summary.wait()
        return "summary"

    async def commit(*args: object) -> bool:
        nonlocal committed
        committed = True
        return True

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    task = asyncio.create_task(
        ConversationCompactor(Repository(), summarize=summarize).prepare(
            "task_cancelled_summary",
            model_handle=object(),
            emit=emit,
            request=budgeted_request(),
            cancellation_requested=cancellation_requested,
            commit=commit,
        )
    )
    await asyncio.wait_for(summary_started.wait(), timeout=1)

    # When
    cancellation_requested.set()
    release_summary.set()

    # Then
    with pytest.raises(CompactionCancelledError):
        await task
    assert committed is False
    assert emitted == []


@pytest.mark.asyncio
async def test_cancellation_during_marker_load_never_emits_fallback() -> None:
    # Given
    items = conversation_items(3, "x" * 2_000)
    cancellation_requested = asyncio.Event()
    load_started = asyncio.Event()
    release_load = asyncio.Event()

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
            load_started.set()
            await release_load.wait()
            raise ValueError("marker load failed")

    async def summarize(**kwargs: object) -> str:
        raise AssertionError("load failure must not reach summarizer")

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    task = asyncio.create_task(
        ConversationCompactor(Repository(), summarize=summarize).prepare(
            "task_cancelled_load",
            model_handle=object(),
            emit=emit,
            request=budgeted_request(),
            cancellation_requested=cancellation_requested,
        )
    )
    await asyncio.wait_for(load_started.wait(), timeout=1)

    # When
    cancellation_requested.set()
    release_load.set()

    # Then
    with pytest.raises(CompactionCancelledError):
        await task
    assert emitted == []


@pytest.mark.asyncio
async def test_commit_callback_owns_atomic_summary_and_event_persistence() -> None:
    # Given
    task_id = "task_atomic"
    items = conversation_items(3, "x" * 2_000)

    class Session:
        async def get_items(self) -> list[dict[str, str]]:
            return list(items)

    class Repository:
        def __init__(self) -> None:
            self.session = Session()
            self.marker: dict[str, object] = {}
            self.events: list[object] = []

        def task_session(self, requested_task_id: str) -> Session:
            assert requested_task_id == task_id
            return self.session

        async def get_snapshot(self, requested_task_id: str):
            assert requested_task_id == task_id
            return completed_snapshot(task_id, 3)

        async def load_conversation_summary(
            self,
            requested_task_id: str,
        ) -> dict[str, object]:
            assert requested_task_id == task_id
            return dict(self.marker)

        async def save_conversation_summary(
            self,
            requested_task_id: str,
            summary: dict[str, object],
        ) -> None:
            assert requested_task_id == task_id
            self.marker = dict(summary)

        async def append_event_payload(
            self,
            *,
            requested_task_id: str | None = None,
            task_id: str | None = None,
            run_id: str,
            payload: object,
            **kwargs: object,
        ) -> tuple[object, object]:
            resolved_task_id = task_id or requested_task_id
            assert resolved_task_id == "task_atomic"
            event = build_event(
                task_id=resolved_task_id,
                run_id=run_id,
                sequence=4,
                payload=payload,
            )
            self.events.append(event)
            raise RuntimeError("projection failure after event persistence")

        async def find_matching_event(
            self,
            *,
            task_id: str,
            run_id: str,
            payload: object,
            after_sequence: int = 0,
            **kwargs: object,
        ) -> object | None:
            return next(
                (
                    event
                    for event in reversed(self.events)
                    if event.task_id == task_id
                    and event.run_id == run_id
                    and event.payload == payload
                    and event.sequence > after_sequence
                ),
                None,
            )

        async def list_events(self, *args: object, **kwargs: object) -> list[object]:
            return list(self.events)

    async def run(execution: object) -> None:
        return None

    repository = Repository()
    manager = TaskManager(repository, run_executor=run)
    accepted = TaskRunAccepted(
        request_id="request_atomic",
        task_id=task_id,
        run_id="run_atomic",
    )
    context = RunContext(task_id=task_id)

    async def summarize(**kwargs: object) -> str:
        return "atomic summary"

    async def emit(payload: object) -> None:
        raise AssertionError("commit callback owns the compacted event")

    # When
    preparation = await ConversationCompactor(repository, summarize=summarize).prepare(
        task_id,
        model_handle=object(),
        emit=emit,
        request=budgeted_request(),
        cancellation_requested=context.cancellation_requested,
        commit=lambda record, payload: manager._commit_compaction(
            accepted,
            context,
            record,
            payload,
        ),
    )

    # Then
    assert preparation.compacted is True
    assert repository.marker["summary"] == "atomic summary"
    assert isinstance(repository.events[0].payload, ConversationCompactedPayload)
