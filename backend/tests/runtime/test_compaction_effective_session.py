"""Effective-session delegation and complete-Run preservation tests."""

from __future__ import annotations

import pytest
from app.domain.contracts import ConversationCompactedPayload
from app.runtime.compaction import ConversationCompactor
from compaction_support import budgeted_request, completed_snapshot, conversation_items


@pytest.mark.asyncio
async def test_compaction_persists_covered_prefix_and_delegates_raw_appends() -> None:
    # Given
    items = conversation_items(4, "x" * 2_000)

    class Session:
        def __init__(self) -> None:
            self.items = list(items)

        async def get_items(self) -> list[dict[str, str]]:
            return list(self.items)

        async def add_items(self, new_items: list[dict[str, str]]) -> None:
            self.items.extend(new_items)

        async def pop_item(self) -> None:
            return None

        async def clear_session(self) -> None:
            self.items.clear()

    class Repository:
        def __init__(self) -> None:
            self.session = Session()
            self.saved_summary: dict[str, object] | None = None

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
            self.saved_summary = summary

    repository = Repository()
    model = object()

    async def summarize(**kwargs: object) -> str:
        assert kwargs["model_handle"] is model
        return "durable summary"

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    # When
    preparation = await ConversationCompactor(repository, summarize=summarize).prepare(
        "task_effective",
        model_handle=model,
        emit=emit,
        request=budgeted_request(target_tokens=3_000),
    )
    new_item = {"role": "user", "content": "next question"}
    await preparation.session.add_items([new_item])

    # Then
    assert preparation.compacted is True
    assert repository.saved_summary is not None
    assert isinstance(emitted[0], ConversationCompactedPayload)
    assert repository.session.items == [*items, new_item]
    effective = await preparation.session.get_items()
    assert effective[0]["role"] == "system"
    assert effective[-2:] == items[-2:]
