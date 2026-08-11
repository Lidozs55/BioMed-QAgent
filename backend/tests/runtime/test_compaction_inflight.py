"""Regression: continuation preflights must never break on in-flight groups.

The user-facing bug (2026-08-09): after a ``no_progress`` / ``max_turns``
resume, the next invocation preflight runs while the CURRENT Run is still
``RUNNING``. The durable session then contains the current Run's live group
(SDK input copy + assistant/tool items), which has no terminal Run record.
``align_groups_to_records`` treated that group as unalignable history →
``HistoryAlignmentError("impossible")`` → the fallback kept zero groups when
the single in-flight group exceeded the limit → an empty effective session →
``Runner.run_streamed`` raised "Prepared model input is empty" → the Run
failed with ``internal_error``.

Fix semantics: trailing groups without a durable record are the live
in-flight conversation. They are peeled off before alignment, retained
verbatim at the end of the effective view, and never summarized or evicted.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest
from app.domain.contracts import RunRecord, RunStatus, TaskMode, TaskSnapshot, TaskSummary
from app.model_config.context_budget import ContextBudgetOverflowError
from app.runtime.compaction import ConversationCompactor
from compaction_support import (
    budgeted_request,
    completed_snapshot,
    conversation_items,
    valid_summary_record,
)

NOW = datetime(2026, 8, 9, tzinfo=UTC)


def _running_record(task_id: str, *, run_id: str, input_text: str) -> RunRecord:
    """One non-terminal Run record (the live run during a continuation)."""

    return RunRecord(
        run_id=run_id,
        task_id=task_id,
        request_id=f"request_{run_id}",
        status=RunStatus.RUNNING,
        input=input_text,
        created_at=NOW,
        updated_at=NOW,
    )


class _Session:
    def __init__(self, items: list[dict[str, str]]) -> None:
        self._items = items

    async def get_items(self) -> list[dict[str, str]]:
        return list(self._items)

    async def add_items(self, items: list[dict[str, str]]) -> None:
        self._items.extend(items)


class _Repository:
    def __init__(
        self,
        session: _Session,
        snapshot: TaskSnapshot,
        marker: dict[str, object] | None = None,
    ) -> None:
        self._session = session
        self._snapshot = snapshot
        self._marker = marker or {}

    def task_session(self, task_id: str) -> _Session:
        return self._session

    async def get_snapshot(self, task_id: str) -> TaskSnapshot:
        return self._snapshot

    async def load_conversation_summary(self, task_id: str) -> dict[str, object]:
        return self._marker

    async def save_conversation_summary(self, task_id: str, record: dict[str, object]) -> None:
        self._marker = record


@pytest.mark.asyncio
async def test_in_flight_group_is_retained_without_warning_or_summary() -> None:
    """The reported bug: a pure in-flight session must never warn/empty out."""

    task_id = "task_inflight"
    snapshot = completed_snapshot(task_id, 0).model_copy(
        update={
            "task": TaskSummary(
                task_id=task_id,
                mode=TaskMode.AGENT,
                title=task_id,
                status=RunStatus.RUNNING,
                created_at=NOW,
                updated_at=NOW,
            ),
            "runs": [
                _running_record(task_id, run_id="run_live", input_text="live question")
            ],
        }
    )
    items = [
        {"role": "user", "content": "live question"},
        {"role": "assistant", "content": "work so far " + "x" * 3_000},
    ]
    session = _Session(items)
    emitted: list[object] = []
    summarized = False

    async def summarize(**kwargs: object) -> str:
        nonlocal summarized
        summarized = True
        return "unreachable"

    async def emit(payload: object) -> None:
        emitted.append(payload)

    preparation = await ConversationCompactor(
        _Repository(session, snapshot),
        summarize=summarize,
    ).prepare(
        task_id,
        model_handle=object(),
        emit=emit,
        request=budgeted_request(trigger_tokens=500, target_tokens=800),
    )

    effective = await preparation.session.get_items()

    assert summarized is False
    assert preparation.fallback is False
    assert preparation.compacted is False
    assert emitted == []
    assert effective == items  # 在飞组原样保留


@pytest.mark.asyncio
async def test_in_flight_group_survives_history_compaction() -> None:
    """Terminal history is summarized; the live group stays verbatim at the tail."""

    task_id = "task_inflight_plus"
    history = conversation_items(7, "a" * 2_000)
    live = [
        {"role": "user", "content": "live question"},
        {"role": "assistant", "content": "still working " + "b" * 2_000},
    ]
    items = [*history, *live]
    snapshot = completed_snapshot(task_id, 7).model_copy(
        update={
            "task": TaskSummary(
                task_id=task_id,
                mode=TaskMode.AGENT,
                title=task_id,
                status=RunStatus.RUNNING,
                created_at=NOW,
                updated_at=NOW,
            ),
            "runs": [
                *completed_snapshot(task_id, 7).runs,
                _running_record(task_id, run_id="run_live", input_text="live question"),
            ],
        }
    )
    session = _Session(items)
    calls: list[dict[str, object]] = []

    async def summarize(**kwargs: object) -> str:
        calls.append(kwargs)
        return "summarized history"

    async def emit(payload: object) -> None:
        pass

    preparation = await ConversationCompactor(
        _Repository(session, snapshot),
        summarize=summarize,
    ).prepare(
        task_id,
        model_handle=object(),
        emit=emit,
        request=budgeted_request(trigger_tokens=300, target_tokens=500),
    )

    effective = await preparation.session.get_items()

    assert len(calls) == 1
    # 历史被摘要：只覆盖 7 个已完成 run，绝不覆盖在飞 run_live。
    covered = calls[0]["history"]
    assert all(item["content"] != "live question" for item in covered)
    assert preparation.compacted is True
    assert effective[0]["role"] == "system"
    assert "Conversation summary through run_6" in effective[0]["content"]
    assert effective[-2:] == live  # 在飞组保留在尾部


@pytest.mark.asyncio
async def test_marker_suffix_with_in_flight_tail_is_not_degraded() -> None:
    """A summary marker plus a live tail aligns cleanly (no degraded warning)."""

    task_id = "task_marker_live"
    history = conversation_items(7, "a" * 2_000)
    live = [
        {"role": "user", "content": "live question"},
        {"role": "assistant", "content": "current work " + "b" * 2_000},
    ]
    items = [*history, *live]
    snapshot = completed_snapshot(task_id, 7).model_copy(
        update={
            "task": TaskSummary(
                task_id=task_id,
                mode=TaskMode.AGENT,
                title=task_id,
                status=RunStatus.RUNNING,
                created_at=NOW,
                updated_at=NOW,
            ),
            "runs": [
                *completed_snapshot(task_id, 7).runs,
                _running_record(task_id, run_id="run_live", input_text="live question"),
            ],
        }
    )
    marker = valid_summary_record(history, covered_index=2, summary="earlier summary")
    session = _Session(items)
    emitted: list[object] = []

    async def summarize(**kwargs: object) -> str:
        return "new summary"

    async def emit(payload: object) -> None:
        emitted.append(payload)

    preparation = await ConversationCompactor(
        _Repository(session, snapshot, marker=marker),
        summarize=summarize,
    ).prepare(
        task_id,
        model_handle=object(),
        emit=emit,
        request=budgeted_request(trigger_tokens=300, target_tokens=500),
    )

    effective = await preparation.session.get_items()

    assert preparation.degraded_alignment is False
    assert not any(
        getattr(payload, "code", None) == "compaction_alignment_degraded"
        for payload in emitted
    )
    assert effective[0]["role"] == "system"
    assert "new summary" in effective[0]["content"]
    assert "through run_2" in effective[0]["content"]
    assert effective[-2:] == live


@pytest.mark.asyncio
async def test_ambiguous_alignment_fallback_never_returns_empty_session() -> None:
    """Fallback must keep at least the newest group even when it exceeds the limit."""

    task_id = "task_ambiguous_guard"
    items = conversation_items(2, "x" * 6_000)
    items[0]["content"] = "duplicate"
    snapshot = completed_snapshot(task_id, 2).model_copy(
        update={
            "runs": [
                completed_snapshot(task_id, 2).runs[0].model_copy(
                    update={"run_id": "run_cancelled", "input": "duplicate"}
                ),
                completed_snapshot(task_id, 2).runs[0].model_copy(
                    update={"run_id": "run_completed", "input": "duplicate"}
                ),
                *completed_snapshot(task_id, 2).runs[1:],
            ]
        }
    )
    session = _Session(items)
    emitted: list[object] = []

    async def summarize(**kwargs: object) -> str:
        raise AssertionError("ambiguous fallback must not summarize")

    async def emit(payload: object) -> None:
        emitted.append(payload)

    preparation = await ConversationCompactor(
        _Repository(session, snapshot),
        summarize=summarize,
    ).prepare(
        task_id,
        model_handle=object(),
        emit=emit,
        request=budgeted_request(trigger_tokens=500, target_tokens=300),
    )

    effective = await preparation.session.get_items()

    assert preparation.fallback is True
    assert effective  # 永不空
    assert effective == items[-2:]  # 保底保留最新完整组


@pytest.mark.asyncio
async def test_in_flight_group_over_capacity_raises_explicit_overflow() -> None:
    """A live group beyond hard capacity fails loudly, not with an empty input."""

    task_id = "task_inflight_capacity"
    snapshot = completed_snapshot(task_id, 0).model_copy(
        update={
            "task": TaskSummary(
                task_id=task_id,
                mode=TaskMode.AGENT,
                title=task_id,
                status=RunStatus.RUNNING,
                created_at=NOW,
                updated_at=NOW,
            ),
            "runs": [
                _running_record(task_id, run_id="run_live", input_text="live question")
            ],
        }
    )
    items = [
        {"role": "user", "content": "live question"},
        {"role": "assistant", "content": "huge live turn " + "x" * 300_000},
    ]
    session = _Session(items)

    async def summarize(**kwargs: object) -> str:
        raise AssertionError("must not summarize an in-flight-only session")

    async def emit(payload: object) -> None:
        pass

    with pytest.raises(ContextBudgetOverflowError):
        await ConversationCompactor(
            _Repository(session, snapshot),
            summarize=summarize,
        ).prepare(
            task_id,
            model_handle=object(),
            emit=emit,
            request=budgeted_request(trigger_tokens=500, target_tokens=800),
        )
