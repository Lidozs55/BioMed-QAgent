from __future__ import annotations

import asyncio
import json
import threading
from datetime import datetime, timedelta, timezone

import pytest

from app.config import Settings
from app.domain.contracts import (
    AssistantDeltaPayload,
    RunQueuedPayload,
    RunRecord,
    RunStatus,
    TaskMode,
    TaskRunAccepted,
    TaskSnapshot,
    TaskSummary,
    build_event,
)
from app.runtime import repository as repository_module
from app.runtime import event_store as event_store_module
from app.runtime.event_store import CorruptEventLogError
from app.runtime.repository import TaskNotFoundError, TaskRepository


NOW = datetime(2026, 7, 13, tzinfo=timezone.utc)


def empty_snapshot(task_id: str = "task_123") -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=TaskMode.AGENT,
            title="TP53 datasets",
            status=RunStatus.COMPLETED,
            created_at=NOW,
            updated_at=NOW,
        )
    )


def queued_event(task_id: str = "task_123"):
    return build_event(
        task_id=task_id,
        run_id="run_123",
        sequence=1,
        timestamp=NOW + timedelta(seconds=1),
        payload=RunQueuedPayload(request_id="req_123", input="question"),
    )


@pytest.mark.asyncio
async def test_cancelled_append_waits_for_index_projection_before_unlocking(
    tmp_path,
    monkeypatch,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    await repository.save_snapshot(empty_snapshot())
    index_entered = asyncio.Event()
    release_index = asyncio.Event()
    real_upsert = repository.index.upsert_snapshot

    async def blocked_upsert(snapshot) -> None:
        index_entered.set()
        await release_index.wait()
        await real_upsert(snapshot)

    monkeypatch.setattr(repository.index, "upsert_snapshot", blocked_upsert)
    append = asyncio.create_task(repository.append_event(queued_event()))
    try:
        await asyncio.wait_for(index_entered.wait(), timeout=1)
        append.cancel()
        await asyncio.sleep(0)

        lock_probe = asyncio.create_task(repository._task_locks["task_123"].acquire())
        await asyncio.sleep(0.05)
        assert not append.done()
        assert not lock_probe.done()

        release_index.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(append, timeout=1)
        await asyncio.wait_for(lock_probe, timeout=1)
        repository._task_locks["task_123"].release()

        page = await repository.list_tasks()
        summary = next(task for task in page.tasks if task.task_id == "task_123")
        assert summary.latest_sequence == 1
        assert summary.status is RunStatus.QUEUED
    finally:
        release_index.set()
        await asyncio.gather(append, return_exceptions=True)
        await repository.close()


@pytest.mark.asyncio
async def test_cancelled_summary_save_waits_for_atomic_write_before_unlocking(
    tmp_path,
    monkeypatch,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    await repository.save_snapshot(empty_snapshot())
    await repository.save_conversation_summary("task_123", {"summary": "first"})
    write_entered = threading.Event()
    release_write = threading.Event()
    write_finished = threading.Event()
    real_atomic_write = repository_module.atomic_write_json
    lock_probe = None

    def block_summary_write(path, value) -> None:
        if (
            path.name == "conversation_summary.json"
            and dict(value).get("summary") == "second"
        ):
            write_entered.set()
            if not release_write.wait(timeout=3):
                raise TimeoutError("summary write release timed out")
            real_atomic_write(path, value)
            write_finished.set()
            return
        real_atomic_write(path, value)

    monkeypatch.setattr(repository_module, "atomic_write_json", block_summary_write)
    save = asyncio.create_task(
        repository.save_conversation_summary("task_123", {"summary": "second"})
    )
    try:
        await asyncio.wait_for(asyncio.to_thread(write_entered.wait), timeout=1)
        save.cancel()
        await asyncio.sleep(0)

        lock = repository._task_locks["task_123"]
        lock_probe = asyncio.create_task(lock.acquire())
        await asyncio.sleep(0.05)

        assert not save.done()
        assert not lock_probe.done()

        release_write.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(save, timeout=1)
        await asyncio.wait_for(lock_probe, timeout=1)
        lock.release()

        assert write_finished.is_set()
        assert await repository.load_conversation_summary("task_123") == {
            "summary": "second"
        }
    finally:
        release_write.set()
        await asyncio.gather(save, return_exceptions=True)
        if lock_probe is not None and lock_probe.done():
            if not lock_probe.cancelled() and lock_probe.exception() is None:
                lock = repository._task_locks["task_123"]
                if lock.locked():
                    lock.release()
        elif lock_probe is not None:
            lock_probe.cancel()
            await asyncio.gather(lock_probe, return_exceptions=True)
        await repository.close()


def snapshot_with_run(
    *,
    task_id: str = "task_first",
    request_id: str = "req_same",
    run_id: str = "run_first",
) -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=TaskMode.AGENT,
            title="Authoritative task",
            status=RunStatus.QUEUED,
            active_run_id=run_id,
            created_at=NOW,
            updated_at=NOW,
        ),
        runs=[
            RunRecord(
                run_id=run_id,
                task_id=task_id,
                request_id=request_id,
                status=RunStatus.QUEUED,
                input="question",
                created_at=NOW,
                updated_at=NOW,
            )
        ],
    )


def test_runtime_persistence_settings_have_stable_page_defaults() -> None:
    configured = Settings()

    assert configured.task_page_size == 30
    assert configured.task_page_max_size == 100
    assert configured.task_message_page_size == 100


@pytest.mark.asyncio
async def test_repository_creates_layout_and_hydrates_latest_100_messages(
    tmp_path,
) -> None:
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    await repository.initialize()
    try:
        await repository.save_snapshot(empty_snapshot())
        task_dir = output_dir / "tasks" / "task_123"

        assert (task_dir / "events.jsonl").is_file()
        assert (task_dir / "state" / "task_snapshot.json").is_file()
        assert (task_dir / "state" / "session_items.jsonl").is_file()
        summary_path = task_dir / "state" / "conversation_summary.json"
        assert json.loads(summary_path.read_text("utf-8")) == {}
        assert (output_dir / "tasks" / "task_index.sqlite3").is_file()

        session = repository.task_session("task_123")
        await session.add_items(
            [
                {"role": "user", "content": f"message {number}"}
                for number in range(1, 106)
            ]
        )

        loaded = await repository.get_snapshot("task_123")
        assert loaded is not None
        assert [message.ordinal for message in loaded.messages] == list(range(6, 106))
        assert loaded.older_messages_cursor is not None

        older = await repository.list_messages(
            "task_123",
            cursor=loaded.older_messages_cursor,
        )
        assert [message.ordinal for message in older.messages] == list(range(1, 6))
        assert older.next_cursor is None
    finally:
        await repository.close()


@pytest.mark.asyncio
async def test_repository_recovers_event_after_atomic_snapshot_replace_fails(
    tmp_path,
    monkeypatch,
) -> None:
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    await repository.initialize()
    await repository.save_snapshot(empty_snapshot())
    snapshot_path = output_dir / "tasks" / "task_123" / "state" / "task_snapshot.json"
    original_snapshot = snapshot_path.read_text("utf-8")
    real_replace = repository_module.os.replace

    def fail_replace(source, destination) -> None:
        raise OSError("simulated replace failure")

    monkeypatch.setattr(repository_module.os, "replace", fail_replace)
    with pytest.raises(OSError, match="simulated replace failure"):
        await repository.append_event(queued_event())

    assert snapshot_path.read_text("utf-8") == original_snapshot
    assert (
        len(
            (output_dir / "tasks" / "task_123" / "events.jsonl")
            .read_text("utf-8")
            .splitlines()
        )
        == 1
    )
    assert list(snapshot_path.parent.glob("*.tmp")) == []

    monkeypatch.setattr(repository_module.os, "replace", real_replace)
    await repository.close()

    recovered_repository = TaskRepository(output_dir)
    await recovered_repository.initialize()
    try:
        recovered = await recovered_repository.get_snapshot("task_123")
        assert recovered is not None
        assert recovered.task.latest_sequence == 1
        assert recovered.runs[0].request_id == "req_123"
        assert await recovered_repository.find_request("req_123") == TaskRunAccepted(
            request_id="req_123",
            task_id="task_123",
            run_id="run_123",
        )
        persisted = TaskSnapshot.model_validate_json(snapshot_path.read_text("utf-8"))
        assert persisted.task.latest_sequence == 1
    finally:
        await recovered_repository.close()


@pytest.mark.asyncio
async def test_repository_conversation_summary_replace_is_atomic(
    tmp_path,
    monkeypatch,
) -> None:
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    await repository.initialize()
    await repository.save_snapshot(empty_snapshot())
    await repository.save_conversation_summary(
        "task_123",
        {"summary": "first", "covered_through_run_id": "run_1"},
    )
    real_replace = repository_module.os.replace

    def fail_replace(source, destination) -> None:
        raise OSError("simulated replace failure")

    monkeypatch.setattr(repository_module.os, "replace", fail_replace)
    with pytest.raises(OSError, match="simulated replace failure"):
        await repository.save_conversation_summary(
            "task_123",
            {"summary": "second", "covered_through_run_id": "run_2"},
        )

    monkeypatch.setattr(repository_module.os, "replace", real_replace)
    try:
        assert await repository.load_conversation_summary("task_123") == {
            "summary": "first",
            "covered_through_run_id": "run_1",
        }
    finally:
        await repository.close()


@pytest.mark.asyncio
async def test_repository_exposes_idempotent_request_registration(tmp_path) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    await repository.save_snapshot(snapshot_with_run())
    first = TaskRunAccepted(
        request_id="req_same",
        task_id="task_first",
        run_id="run_first",
    )
    try:
        assert await repository.record_request(first) == first
        assert await repository.record_request(first) == first
    finally:
        await repository.close()


@pytest.mark.asyncio
async def test_repository_rejects_non_authoritative_request_registration(
    tmp_path,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    try:
        with pytest.raises(TaskNotFoundError):
            await repository.record_request(
                TaskRunAccepted(
                    request_id="req_missing",
                    task_id="task_missing",
                    run_id="run_missing",
                )
            )

        await repository.save_snapshot(snapshot_with_run())
        with pytest.raises(ValueError, match="authoritative"):
            await repository.record_request(
                TaskRunAccepted(
                    request_id="req_same",
                    task_id="task_first",
                    run_id="run_other",
                )
            )
        with pytest.raises(ValueError, match="authoritative"):
            await repository.record_request(
                TaskRunAccepted(
                    request_id="req_other",
                    task_id="task_first",
                    run_id="run_first",
                )
            )
    finally:
        await repository.close()


@pytest.mark.asyncio
async def test_repository_uses_configured_message_page_size(tmp_path) -> None:
    configured = Settings(
        task_page_size=2,
        task_page_max_size=3,
        task_message_page_size=2,
    )
    repository = TaskRepository(tmp_path / "output", settings=configured)
    await repository.initialize()
    try:
        await repository.save_snapshot(empty_snapshot())
        session = repository.task_session("task_123")
        await session.add_items(
            [{"role": "user", "content": f"message {number}"} for number in range(1, 4)]
        )

        loaded = await repository.get_snapshot("task_123")
        listed = await repository.list_messages("task_123")

        assert loaded is not None
        assert [message.ordinal for message in loaded.messages] == [2, 3]
        assert loaded.older_messages_cursor is not None
        assert [message.ordinal for message in listed.messages] == [2, 3]
        assert listed.next_cursor is not None
    finally:
        await repository.close()


@pytest.mark.asyncio
async def test_repository_event_appends_do_not_replay_a_current_journal(
    tmp_path,
    monkeypatch,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    await repository.save_snapshot(empty_snapshot())
    real_read_jsonl = event_store_module.read_jsonl
    full_scans = 0

    def count_full_scans(path):
        nonlocal full_scans
        full_scans += 1
        return real_read_jsonl(path)

    monkeypatch.setattr(event_store_module, "read_jsonl", count_full_scans)
    try:
        await repository.append_event(queued_event())
        for sequence in range(2, 22):
            await repository.append_event(
                build_event(
                    task_id="task_123",
                    run_id="run_123",
                    sequence=sequence,
                    timestamp=NOW + timedelta(seconds=sequence),
                    payload=AssistantDeltaPayload(delta=f"chunk {sequence}"),
                )
            )

        assert full_scans == 0
        events = await repository.list_events(
            "task_123",
            after_sequence=19,
            limit=2,
        )
        assert [event.sequence for event in events] == [20, 21]
        assert full_scans == 1
    finally:
        await repository.close()


@pytest.mark.asyncio
async def test_repository_revalidates_a_journal_changed_outside_its_checkpoint(
    tmp_path,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    await repository.save_snapshot(empty_snapshot())
    try:
        await repository.append_event(queued_event())
        await repository.append_event(
            build_event(
                task_id="task_123",
                run_id="run_123",
                sequence=2,
                timestamp=NOW + timedelta(seconds=2),
                payload=AssistantDeltaPayload(delta="chunk 2"),
            )
        )
        path = repository.events.path_for("task_123")
        lines = path.read_text("utf-8").splitlines()
        corrupted = json.loads(lines[0])
        corrupted["task_id"] = "task_other"
        path.write_text(
            json.dumps(corrupted, separators=(",", ":")) + "\n" + lines[1] + "\n",
            "utf-8",
        )

        with pytest.raises(CorruptEventLogError, match="task_id"):
            await repository.append_event(
                build_event(
                    task_id="task_123",
                    run_id="run_123",
                    sequence=3,
                    timestamp=NOW + timedelta(seconds=3),
                    payload=AssistantDeltaPayload(delta="chunk 3"),
                )
            )
    finally:
        await repository.close()


@pytest.mark.asyncio
async def test_repository_rejects_snapshot_ahead_of_event_journal(tmp_path) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    persisted = empty_snapshot()
    persisted = persisted.model_copy(
        update={
            "task": persisted.task.model_copy(update={"latest_sequence": 1}),
        }
    )
    await repository.save_snapshot(persisted)
    try:
        with pytest.raises(CorruptEventLogError, match="latest_sequence"):
            await repository.get_snapshot("task_123")
    finally:
        await repository.close()
