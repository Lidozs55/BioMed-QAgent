from __future__ import annotations

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
            {"role": "assistant", "content": "x" * 3_000},
        )
    ]
    initial_summary = {
        "schema_version": "1.0",
        "summary": "existing summary",
        "summary_digest": "ab" * 32,
        "covered_through_run_id": "run_0",
        "covered_run_ids": ["run_0"],
        "covered_history_digest": "cd" * 32,
    }

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
    assert effective[0]["role"] == "system"
    assert effective[1]["content"] == "question 7"
    assert effective[-2]["content"] == "question 26"
    assert len(effective) == 1 + COMPACTION_FAILURE_RUNS * 2


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
