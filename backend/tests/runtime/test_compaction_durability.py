"""Corrupt-marker and raw-session durability regressions for compaction."""

from __future__ import annotations

import json

import pytest
from app.domain.contracts import RunStatus, WarningPayload
from app.runtime.compaction import ConversationCompactor
from compaction_support import (
    budgeted_request,
    completed_snapshot,
    conversation_items,
    valid_summary_record,
)


@pytest.mark.asyncio
async def test_compaction_failure_preserves_raw_session_with_bounded_groups() -> None:
    # Given
    items = conversation_items(27, "x" * 2_000)
    marker = valid_summary_record(items, covered_index=20)

    class Session:
        session_settings = None

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
            return completed_snapshot(task_id, 27)

        async def load_conversation_summary(self, task_id: str) -> dict[str, object]:
            return dict(marker)

        async def save_conversation_summary(
            self,
            task_id: str,
            summary: dict[str, object],
        ) -> None:
            self.saved.append(summary)

    async def summarize(**kwargs: object) -> str:
        raise ValueError("summarizer unavailable")

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    repository = Repository()

    # When
    preparation = await ConversationCompactor(repository, summarize=summarize).prepare(
        "task_fallback",
        model_handle=object(),
        emit=emit,
        request=budgeted_request(),
    )

    # Then
    assert repository.saved == []
    assert preparation.fallback is True
    assert emitted[0].code == "compaction_failed"
    effective = await preparation.session.get_items()
    assert preparation.estimate.total <= 500
    assert effective == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("corruption", "expected_fragment"),
    [
        ("malformed_json", "malformed summary"),
        ("schema_version", "schema_version"),
        ("summary_digest", "summary_digest"),
        ("covered_through_run_id", "coverage"),
        ("covered_run_ids", "covered_run_ids"),
        ("covered_history_digest", "covered_history_digest"),
    ],
)
async def test_corrupt_summary_marker_retains_bounded_compaction_failed_fallback(
    corruption: str,
    expected_fragment: str,
) -> None:
    # Given
    items = conversation_items(25, "answer")
    marker = valid_summary_record(items, covered_index=4)
    if corruption == "schema_version":
        marker["schema_version"] = "2.0"
    elif corruption == "summary_digest":
        marker["summary_digest"] = "00" * 32
    elif corruption == "covered_through_run_id":
        marker["covered_through_run_id"] = "run_missing"
    elif corruption == "covered_run_ids":
        marker["covered_run_ids"] = ["run_4"]
    elif corruption == "covered_history_digest":
        marker["covered_history_digest"] = "00" * 32

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
            return completed_snapshot(task_id, 25)

        async def load_conversation_summary(self, task_id: str) -> dict[str, object]:
            if corruption == "malformed_json":
                raise json.JSONDecodeError("malformed summary", "{", 1)
            return dict(marker)

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    # When
    preparation = await ConversationCompactor(Repository()).prepare(
        "task_invalid_marker",
        model_handle=object(),
        emit=emit,
        request=budgeted_request(),
    )

    # Then
    assert preparation.fallback is True
    assert isinstance(emitted[0], WarningPayload)
    assert emitted[0].code == "compaction_failed"
    assert expected_fragment in emitted[0].message
    effective = await preparation.session.get_items()
    assert preparation.estimate.total <= 500
    assert effective == items[-len(effective) :]
    assert len(effective) % 2 == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("alignment", ["ambiguous", "impossible"])
async def test_non_unique_history_alignment_falls_back_with_bounded_groups(
    alignment: str,
) -> None:
    # Given
    items = conversation_items(7, "x" * 2_000)
    snapshot = completed_snapshot("task_alignment", 7)
    if alignment == "ambiguous":
        items[0]["content"] = "duplicate"
        first_run = snapshot.runs[0]
        snapshot = snapshot.model_copy(
            update={
                "runs": [
                    first_run.model_copy(
                        update={
                            "run_id": "run_cancelled",
                            "input": "duplicate",
                            "status": RunStatus.CANCELLED,
                        }
                    ),
                    first_run.model_copy(
                        update={"run_id": "run_completed", "input": "duplicate"}
                    ),
                    *snapshot.runs[1:],
                ]
            }
        )
    else:
        items[0]["content"] = "missing"

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
            return snapshot

        async def load_conversation_summary(self, task_id: str) -> dict[str, object]:
            return {}

    summarized = False

    async def summarize(**kwargs: object) -> str:
        nonlocal summarized
        summarized = True
        return "unreachable"

    emitted: list[object] = []

    async def emit(payload: object) -> None:
        emitted.append(payload)

    # When
    preparation = await ConversationCompactor(Repository(), summarize=summarize).prepare(
        "task_alignment",
        model_handle=object(),
        emit=emit,
        request=budgeted_request(),
    )

    # Then
    assert summarized is False
    assert preparation.fallback is True
    assert emitted[0].code == "compaction_failed"
    effective = await preparation.session.get_items()
    assert preparation.estimate.total <= 500
    assert effective == []
