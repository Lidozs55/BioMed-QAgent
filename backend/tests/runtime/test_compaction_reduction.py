"""Target budgeting and duplicate-anchor behavior for Task 3 compaction."""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from app.domain.contracts import RunStatus, WarningPayload
from app.model_config.token_estimation import ConservativeUtf8TokenCounter
from app.runtime.compaction import ConversationCompactor
from compaction_support import (
    budgeted_request,
    completed_snapshot,
    conversation_items,
    valid_summary_record,
)


class CountingCounter(ConservativeUtf8TokenCounter):
    """Observe repeated local prompt estimates without provider I/O."""

    def __init__(self) -> None:
        self.calls = 0

    def count(self, text: str) -> int:
        self.calls += 1
        return super().count(text)


@pytest.mark.asyncio
async def test_compaction_reestimates_to_target_and_keeps_newest_runs_whole() -> None:
    # Given
    items = conversation_items(4, "a" * 180)

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
        saved: list[dict[str, object]] = []

        def task_session(self, task_id: str) -> Session:
            return self.session

        async def get_snapshot(self, task_id: str):
            return completed_snapshot(task_id, 4)

        async def load_conversation_summary(self, task_id: str) -> dict[str, object]:
            return {}

        async def save_conversation_summary(
            self,
            task_id: str,
            summary: dict[str, object],
        ) -> None:
            self.saved.append(summary)

    request = budgeted_request(trigger_tokens=300, target_tokens=450)
    counter = CountingCounter()
    request = request.__class__(
        agent_input=request.agent_input,
        prompt_shape=request.prompt_shape,
        resolved_instructions=request.resolved_instructions,
        budget=request.budget,
        estimator=request.estimator.__class__(counter),
    )

    async def summarize(**kwargs: object) -> str:
        return "short summary"

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    # When
    preparation = await ConversationCompactor(Repository(), summarize=summarize).prepare(
        "task_target",
        model_handle=object(),
        emit=emit,
        request=request,
    )

    # Then
    effective = await preparation.session.get_items()
    assert preparation.estimate.total <= request.budget.target_tokens
    assert counter.calls > len(items)
    assert effective[-2:] == items[-2:]
    assert all(item in items for item in effective[1:])
    assert emitted[0].type == "conversation_compacted"


@pytest.mark.asyncio
async def test_existing_summary_is_shortened_once_before_evicting_newer_runs() -> None:
    # Given
    items = conversation_items(3, "suffix")
    marker = valid_summary_record(items, covered_index=0, summary="old" * 500)

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
        saved: list[dict[str, object]] = []

        def task_session(self, task_id: str) -> Session:
            return self.session

        async def get_snapshot(self, task_id: str):
            return completed_snapshot(task_id, 3)

        async def load_conversation_summary(self, task_id: str) -> dict[str, object]:
            return dict(marker)

        async def save_conversation_summary(
            self,
            task_id: str,
            summary: dict[str, object],
        ) -> None:
            self.saved.append(summary)

    calls: list[dict[str, object]] = []

    async def summarize(**kwargs: object) -> str:
        calls.append(kwargs)
        return "brief"

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    request = budgeted_request(trigger_tokens=200, target_tokens=500)
    repository = Repository()

    # When
    preparation = await ConversationCompactor(repository, summarize=summarize).prepare(
        "task_shorten",
        model_handle=object(),
        emit=emit,
        request=request,
    )

    # Then
    effective = await preparation.session.get_items()
    assert len(calls) == 1
    assert calls[0]["previous_summary"] == marker["summary"]
    assert calls[0]["history"] == []
    assert effective[1:] == items[2:]
    assert repository.saved[0]["summary"] == "brief"


@pytest.mark.asyncio
async def test_valid_anchor_degrades_duplicate_suffix_without_discarding_summary() -> None:
    # Given
    items = conversation_items(2, "suffix")
    items[2]["content"] = "duplicate"
    marker = valid_summary_record(items, covered_index=0, summary="existing")
    snapshot = completed_snapshot("task_duplicate", 3).model_copy(
        update={
            "runs": [
                completed_snapshot("task_duplicate", 3).runs[0],
                completed_snapshot("task_duplicate", 3).runs[1].model_copy(
                    update={"run_id": "run_1", "input": "duplicate", "status": RunStatus.COMPLETED}
                ),
                completed_snapshot("task_duplicate", 3).runs[2].model_copy(
                    update={"run_id": "run_2", "input": "duplicate", "status": RunStatus.COMPLETED}
                ),
            ]
        }
    )

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
        saved: list[dict[str, object]] = []

        def task_session(self, task_id: str) -> Session:
            return self.session

        async def get_snapshot(self, task_id: str) -> SimpleNamespace:
            return snapshot

        async def load_conversation_summary(self, task_id: str) -> dict[str, object]:
            return dict(marker)

        async def save_conversation_summary(
            self,
            task_id: str,
            summary: dict[str, object],
        ) -> None:
            self.saved.append(summary)

    async def summarize(**kwargs: object) -> str:
        return "short"

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    # When
    preparation = await ConversationCompactor(Repository(), summarize=summarize).prepare(
        "task_duplicate",
        model_handle=object(),
        emit=emit,
        request=budgeted_request(trigger_tokens=100, target_tokens=500),
    )

    # Then
    assert preparation.degraded_alignment is True
    assert isinstance(emitted[-1], WarningPayload)
    assert emitted[-1].code == "compaction_alignment_degraded"
    effective = await preparation.session.get_items()
    assert effective[0]["content"].endswith("short")


@pytest.mark.asyncio
async def test_oldest_complete_segments_leave_first_newest_runs_preserved_whole() -> None:
    # Given: 5 runs using conversation_items for runtime alignment, with
    # assistant content short enough that the oldest-first eviction pattern
    # is observable after compaction.
    items = conversation_items(5, "x")

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
        saved: list[dict[str, object]] = []

        def task_session(self, task_id: str) -> Session:
            return self.session

        async def get_snapshot(self, task_id: str):
            return completed_snapshot(task_id, 5)

        async def load_conversation_summary(self, task_id: str) -> dict[str, object]:
            return {}

        async def save_conversation_summary(
            self,
            task_id: str,
            summary: dict[str, object],
        ) -> None:
            self.saved.append(summary)

    # Budget: trigger below 5-run raw estimate (~434 tokens with JSON-serialized
    # items), target fits summary + 1 newest complete segment (runs 4) but not
    # 2 segments (runs 3,4), forcing oldest-first segment eviction.
    request = budgeted_request(trigger_tokens=300, target_tokens=250)
    repository = Repository()

    async def summarize(**kwargs: object) -> str:
        return "covering oldest runs"

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    # When
    preparation = await ConversationCompactor(repository, summarize=summarize).prepare(
        "task_oldest_first",
        model_handle=object(),
        emit=emit,
        request=request,
    )

    # Then
    effective = await preparation.session.get_items()
    assert preparation.compacted is True
    # Summary marker is the first effective item
    assert effective[0]["role"] == "system"
    # Newest run (question 4) survives whole
    assert any(
        isinstance(item, dict) and item.get("content") == "question 4"
        for item in effective
    )
    # Oldest run (question 0) was evicted first
    assert not any(
        isinstance(item, dict) and item.get("content") == "question 0"
        for item in effective
    )
    # Estimate is at or below target after reduction
    assert preparation.estimate.total <= request.budget.target_tokens
    assert emitted[0].type == "conversation_compacted"
