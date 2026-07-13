from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

import app.runtime.compaction as compaction_module
from app.agent_loop.model import LazyDashScopeModel

from app.domain.contracts import (
    ConversationCompactedPayload,
    RunRecord,
    RunStatus,
    TaskMode,
    TaskSnapshot,
    TaskSummary,
    WarningPayload,
)
from app.runtime.compaction import (
    COMPACTION_FAILURE_RUNS,
    COMPACTION_CHARACTER_THRESHOLD,
    RAW_RUNS_AFTER_COMPACTION,
    ConversationCompactor,
)


NOW = datetime(2026, 7, 14, tzinfo=timezone.utc)


def history_digest(items: list[dict]) -> str:
    encoded = json.dumps(
        items,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def valid_summary_record(
    items: list[dict],
    *,
    covered_index: int,
    summary: str = "existing summary",
) -> dict:
    covered_items = items[: (covered_index + 1) * 2]
    return {
        "schema_version": "1.0",
        "summary": summary,
        "summary_digest": hashlib.sha256(summary.encode("utf-8")).hexdigest(),
        "covered_through_run_id": f"run_{covered_index}",
        "covered_run_ids": [f"run_{index}" for index in range(covered_index + 1)],
        "covered_history_digest": history_digest(covered_items),
    }


def completed_snapshot(task_id: str, count: int) -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=TaskMode.AGENT,
            title=task_id,
            status=RunStatus.COMPLETED,
            created_at=NOW,
            updated_at=NOW,
        ),
        runs=[
            RunRecord(
                run_id=f"run_{index}",
                task_id=task_id,
                request_id=f"request_{index}",
                status=RunStatus.COMPLETED,
                input=f"question {index}",
                created_at=NOW,
                updated_at=NOW,
                started_at=NOW,
                finished_at=NOW,
            )
            for index in range(count)
        ],
    )


@pytest.mark.asyncio
async def test_compaction_persists_covered_prefix_and_keeps_five_raw_runs() -> None:
    items = [
        item
        for index in range(7)
        for item in (
            {"role": "user", "content": f"question {index}"},
            {"role": "assistant", "content": "x" * 10_000},
        )
    ]

    class Session:
        def __init__(self):
            self.items = list(items)

        async def get_items(self):
            return list(self.items)

        async def add_items(self, new_items):
            self.items.extend(new_items)

    class Repository:
        def __init__(self):
            self.saved_summary: dict | None = None
            self.session = Session()

        def task_session(self, task_id: str):
            return self.session

        async def get_snapshot(self, task_id: str):
            return completed_snapshot(task_id, 7)

        async def load_conversation_summary(self, task_id: str):
            return {}

        async def save_conversation_summary(self, task_id: str, summary: dict):
            self.saved_summary = summary

    repository = Repository()
    model = object()
    summarized: list[object] = []
    emitted: list[object] = []

    async def summarize(*, model_handle, history, previous_summary):
        assert model_handle is model
        assert previous_summary is None
        summarized.extend(history)
        return "summary of runs zero and one"

    async def emit(payload: object):
        emitted.append(payload)

    preparation = await ConversationCompactor(
        repository,
        summarize=summarize,
    ).prepare("task_compact", model_handle=model, emit=emit)

    assert COMPACTION_CHARACTER_THRESHOLD == 60_000
    assert RAW_RUNS_AFTER_COMPACTION == 5
    assert len(summarized) == 4
    assert repository.saved_summary is not None
    assert repository.saved_summary["covered_through_run_id"] == "run_1"
    assert repository.saved_summary["covered_run_ids"] == ["run_0", "run_1"]
    assert len(repository.saved_summary["summary_digest"]) == 64
    assert len(repository.saved_summary["covered_history_digest"]) == 64
    assert len(items) == 14
    assert isinstance(emitted[0], ConversationCompactedPayload)

    effective = await preparation.session.get_items()
    assert effective[0]["role"] == "system"
    assert "summary of runs zero and one" in effective[0]["content"]
    assert effective[1:11] == items[-10:]
    new_item = {"role": "user", "content": "next question"}
    await preparation.session.add_items([new_item])
    assert repository.session.items == items + [new_item]


@pytest.mark.asyncio
async def test_compaction_failure_keeps_marker_and_uses_latest_twenty_runs() -> None:
    items = [
        item
        for index in range(27)
        for item in (
            {"role": "user", "content": f"question {index}"},
            {"role": "assistant", "content": "x" * 11_000},
        )
    ]
    initial_summary = valid_summary_record(items, covered_index=20)

    class Session:
        session_settings = None

        async def get_items(self):
            return list(items)

        async def add_items(self, new_items):
            items.extend(new_items)

        async def pop_item(self):
            return None

        async def clear_session(self):
            items.clear()

    class Repository:
        saved: list[dict] = []
        session = Session()

        def task_session(self, task_id: str):
            return self.session

        async def get_snapshot(self, task_id: str):
            return completed_snapshot(task_id, 27)

        async def load_conversation_summary(self, task_id: str):
            return dict(initial_summary)

        async def save_conversation_summary(self, task_id: str, summary: dict):
            self.saved.append(summary)

    async def fail_summary(**kwargs):
        raise RuntimeError("summarizer unavailable")

    emitted: list[object] = []

    async def emit(payload: object):
        emitted.append(payload)

    repository = Repository()
    preparation = await ConversationCompactor(
        repository,
        summarize=fail_summary,
    ).prepare("task_fallback", model_handle=object(), emit=emit)

    assert COMPACTION_FAILURE_RUNS == 20
    assert repository.saved == []
    assert preparation.fallback is True
    assert isinstance(emitted, list)
    assert len(emitted) == 1
    assert isinstance(emitted[0], WarningPayload)
    assert emitted[0].code == "compaction_failed"
    effective = await preparation.session.get_items()
    assert effective[0]["content"] == "question 7"
    assert effective[-2]["content"] == "question 26"
    assert len(effective) == COMPACTION_FAILURE_RUNS * 2


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
async def test_invalid_summary_marker_warns_and_uses_raw_latest_twenty(
    corruption: str,
    expected_fragment: str,
) -> None:
    items = [
        item
        for index in range(25)
        for item in (
            {"role": "user", "content": f"question {index}"},
            {"role": "assistant", "content": f"answer {index}"},
        )
    ]
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
        session_settings = None

        async def get_items(self):
            return list(items)

        async def add_items(self, new_items):
            items.extend(new_items)

        async def pop_item(self):
            return None

        async def clear_session(self):
            items.clear()

    class Repository:
        session = Session()
        saved: list[dict] = []

        def task_session(self, task_id: str):
            return self.session

        async def get_snapshot(self, task_id: str):
            return completed_snapshot(task_id, 25)

        async def load_conversation_summary(self, task_id: str):
            if corruption == "malformed_json":
                raise json.JSONDecodeError("malformed summary", "{", 1)
            return dict(marker)

        async def save_conversation_summary(self, task_id: str, summary: dict):
            self.saved.append(summary)

    emitted: list[object] = []

    async def emit(payload: object):
        emitted.append(payload)

    repository = Repository()
    preparation = await ConversationCompactor(repository).prepare(
        "task_invalid_marker",
        model_handle=object(),
        emit=emit,
    )

    assert repository.saved == []
    assert preparation.fallback is True
    assert len(emitted) == 1
    assert isinstance(emitted[0], WarningPayload)
    assert emitted[0].code == "compaction_failed"
    assert expected_fragment in emitted[0].message
    effective = await preparation.session.get_items()
    assert len(effective) == COMPACTION_FAILURE_RUNS * 2
    assert effective[0]["content"] == "question 5"
    assert effective[-2]["content"] == "question 24"
    assert all(item.get("role") != "system" for item in effective)


@pytest.mark.asyncio
@pytest.mark.parametrize("alignment", ["ambiguous", "impossible"])
async def test_non_unique_history_alignment_falls_back_without_coverage(
    alignment: str,
) -> None:
    first_input = "duplicate" if alignment == "ambiguous" else "missing"
    items = [
        {"role": "user", "content": first_input},
        {"role": "assistant", "content": "answer"},
        *[
            item
            for index in range(1, 7)
            for item in (
                {"role": "user", "content": f"question {index}"},
                {"role": "assistant", "content": "x" * 11_000},
            )
        ],
    ]
    snapshot = completed_snapshot("task_alignment", 7)
    if alignment == "ambiguous":
        duplicate_runs = [
            snapshot.runs[0].model_copy(
                update={
                    "run_id": "run_cancelled",
                    "input": "duplicate",
                    "status": RunStatus.CANCELLED,
                }
            ),
            snapshot.runs[0].model_copy(
                update={"run_id": "run_completed", "input": "duplicate"}
            ),
        ]
        snapshot = snapshot.model_copy(
            update={"runs": duplicate_runs + snapshot.runs[1:]}
        )

    class Session:
        session_settings = None

        async def get_items(self):
            return list(items)

        async def add_items(self, new_items):
            items.extend(new_items)

        async def pop_item(self):
            return None

        async def clear_session(self):
            items.clear()

    class Repository:
        session = Session()
        saved: list[dict] = []

        def task_session(self, task_id: str):
            return self.session

        async def get_snapshot(self, task_id: str):
            return snapshot

        async def load_conversation_summary(self, task_id: str):
            return {}

        async def save_conversation_summary(self, task_id: str, summary: dict):
            self.saved.append(summary)

    summarized = False
    emitted: list[object] = []

    async def summarize(**kwargs):
        nonlocal summarized
        summarized = True
        return "must not be used"

    async def emit(payload: object):
        emitted.append(payload)

    repository = Repository()
    preparation = await ConversationCompactor(
        repository,
        summarize=summarize,
    ).prepare("task_alignment", model_handle=object(), emit=emit)

    assert summarized is False
    assert repository.saved == []
    assert preparation.fallback is True
    assert len(emitted) == 1
    assert isinstance(emitted[0], WarningPayload)
    assert "alignment" in emitted[0].message
    assert await preparation.session.get_items() == items[-40:]


@pytest.mark.asyncio
async def test_compaction_requires_history_to_strictly_exceed_threshold() -> None:
    items = [
        item
        for index in range(6)
        for item in (
            {"role": "user", "content": f"question {index}"},
            {"role": "assistant", "content": ""},
        )
    ]

    class Session:
        async def get_items(self):
            return list(items)

    class Repository:
        session = Session()

        def task_session(self, task_id: str):
            return self.session

        async def get_snapshot(self, task_id: str):
            return completed_snapshot(task_id, 6)

        async def load_conversation_summary(self, task_id: str):
            return {}

        async def save_conversation_summary(self, task_id: str, summary: dict):
            raise AssertionError("summary must not advance at the threshold")

    async def summarize(**kwargs):
        raise AssertionError("summarizer must not run at the threshold")

    emitted: list[object] = []
    repository = Repository()
    preparation = await ConversationCompactor(
        repository,
        summarize=summarize,
        character_threshold=60,
    ).prepare(
        "task_threshold",
        model_handle=object(),
        emit=lambda payload: emitted.append(payload),
    )

    assert preparation.session is repository.session
    assert emitted == []


@pytest.mark.asyncio
async def test_default_summarizer_uses_same_model_without_tools(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    model = LazyDashScopeModel()
    captured: dict[str, object] = {}

    async def run(agent, prompt, **kwargs):
        captured["agent"] = agent
        captured["prompt"] = prompt
        captured["kwargs"] = kwargs
        return SimpleNamespace(final_output="compact summary")

    monkeypatch.setattr(compaction_module.Runner, "run", run)

    summary = await compaction_module._summarize_with_model(
        model_handle=model,
        history=[{"role": "user", "content": "question"}],
        previous_summary=None,
    )

    assert summary == "compact summary"
    assert captured["agent"].model is model
    assert captured["agent"].tools == []
    assert captured["kwargs"] == {"max_turns": 1}


@pytest.mark.asyncio
async def test_cancelled_preparation_never_starts_summarizer_or_commit() -> None:
    items = [
        item
        for index in range(7)
        for item in (
            {"role": "user", "content": f"question {index}"},
            {"role": "assistant", "content": "x" * 10_000},
        )
    ]
    cancellation_requested = asyncio.Event()
    cancellation_requested.set()
    summarized = False
    committed = False

    class Session:
        async def get_items(self):
            return list(items)

    class Repository:
        session = Session()

        def task_session(self, task_id: str):
            return self.session

        async def get_snapshot(self, task_id: str):
            return completed_snapshot(task_id, 7)

        async def load_conversation_summary(self, task_id: str):
            return {}

    async def summarize(**kwargs):
        nonlocal summarized
        summarized = True
        return "summary"

    async def commit(record, payload):
        nonlocal committed
        committed = True
        return True

    async def emit(payload):
        raise AssertionError("cancelled preparation must not emit")

    with pytest.raises(compaction_module.CompactionCancelledError):
        await ConversationCompactor(
            Repository(),
            summarize=summarize,
        ).prepare(
            "task_cancelled_prepare",
            model_handle=object(),
            emit=emit,
            cancellation_requested=cancellation_requested,
            commit=commit,
        )

    assert summarized is False
    assert committed is False


@pytest.mark.asyncio
async def test_cancellation_while_summarizer_is_blocked_prevents_commit() -> None:
    items = [
        item
        for index in range(7)
        for item in (
            {"role": "user", "content": f"question {index}"},
            {"role": "assistant", "content": "x" * 10_000},
        )
    ]
    cancellation_requested = asyncio.Event()
    summarizer_started = asyncio.Event()
    release_summarizer = asyncio.Event()
    saved: list[dict] = []
    emitted: list[object] = []
    committed = False

    class Session:
        async def get_items(self):
            return list(items)

    class Repository:
        session = Session()

        def task_session(self, task_id: str):
            return self.session

        async def get_snapshot(self, task_id: str):
            return completed_snapshot(task_id, 7)

        async def load_conversation_summary(self, task_id: str):
            return {}

        async def save_conversation_summary(self, task_id: str, summary: dict):
            saved.append(summary)

    async def summarize(**kwargs):
        summarizer_started.set()
        await release_summarizer.wait()
        return "blocked summary"

    async def commit(record, payload):
        nonlocal committed
        committed = True
        return True

    async def emit(payload):
        emitted.append(payload)

    preparation = asyncio.create_task(
        ConversationCompactor(
            Repository(),
            summarize=summarize,
        ).prepare(
            "task_cancelled_summary",
            model_handle=object(),
            emit=emit,
            cancellation_requested=cancellation_requested,
            commit=commit,
        )
    )
    await asyncio.wait_for(summarizer_started.wait(), timeout=1)
    cancellation_requested.set()
    release_summarizer.set()

    with pytest.raises(compaction_module.CompactionCancelledError):
        await preparation

    assert committed is False
    assert saved == []
    assert emitted == []


@pytest.mark.asyncio
@pytest.mark.parametrize("failure_stage", ["load", "summarizer"])
async def test_cancellation_while_failure_is_blocked_never_falls_back(
    failure_stage: str,
) -> None:
    items = [
        item
        for index in range(7)
        for item in (
            {"role": "user", "content": f"question {index}"},
            {"role": "assistant", "content": "x" * 10_000},
        )
    ]
    cancellation_requested = asyncio.Event()
    failure_blocked = asyncio.Event()
    release_failure = asyncio.Event()
    saved: list[dict] = []
    emitted: list[object] = []

    class Session:
        async def get_items(self):
            return list(items)

    class Repository:
        session = Session()

        def task_session(self, task_id: str):
            return self.session

        async def get_snapshot(self, task_id: str):
            return completed_snapshot(task_id, 7)

        async def load_conversation_summary(self, task_id: str):
            if failure_stage == "load":
                failure_blocked.set()
                await release_failure.wait()
                raise RuntimeError("marker load failed")
            return {}

        async def save_conversation_summary(self, task_id: str, summary: dict):
            saved.append(summary)

    async def summarize(**kwargs):
        assert failure_stage == "summarizer"
        failure_blocked.set()
        await release_failure.wait()
        raise RuntimeError("summarizer failed")

    async def emit(payload):
        emitted.append(payload)

    preparation = asyncio.create_task(
        ConversationCompactor(
            Repository(),
            summarize=summarize,
        ).prepare(
            "task_cancelled_failure",
            model_handle=object(),
            emit=emit,
            cancellation_requested=cancellation_requested,
        )
    )
    await asyncio.wait_for(failure_blocked.wait(), timeout=1)
    cancellation_requested.set()
    release_failure.set()

    with pytest.raises(compaction_module.CompactionCancelledError):
        await preparation

    assert saved == []
    assert emitted == []


@pytest.mark.asyncio
async def test_compaction_delegates_marker_and_event_to_commit_callback() -> None:
    items = [
        item
        for index in range(7)
        for item in (
            {"role": "user", "content": f"question {index}"},
            {"role": "assistant", "content": "x" * 10_000},
        )
    ]
    committed: list[tuple[dict, object]] = []

    class Session:
        async def get_items(self):
            return list(items)

    class Repository:
        session = Session()

        def task_session(self, task_id: str):
            return self.session

        async def get_snapshot(self, task_id: str):
            return completed_snapshot(task_id, 7)

        async def load_conversation_summary(self, task_id: str):
            return {}

        async def save_conversation_summary(self, task_id: str, summary: dict):
            raise AssertionError("manager callback must own summary persistence")

    async def summarize(**kwargs):
        return "delegated summary"

    async def commit(record, payload):
        committed.append((dict(record), payload))
        return True

    async def emit(payload):
        raise AssertionError("manager callback must own compacted event emission")

    preparation = await ConversationCompactor(
        Repository(),
        summarize=summarize,
    ).prepare(
        "task_delegated_commit",
        model_handle=object(),
        emit=emit,
        commit=commit,
    )

    assert preparation.compacted is True
    assert len(committed) == 1
    record, payload = committed[0]
    assert record["covered_through_run_id"] == "run_1"
    assert isinstance(payload, ConversationCompactedPayload)
