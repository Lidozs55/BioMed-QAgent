from __future__ import annotations

import asyncio
import json
import shutil
import threading
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from app.config import Settings
from app.domain.contracts import (
    ArtifactManifestEntry,
    ArtifactProducedPayload,
    AssistantDeltaPayload,
    EventEnvelope,
    RunCompletedPayload,
    RunFailedPayload,
    RunFinalizingPayload,
    RunQueuedPayload,
    RunRecord,
    RunStartedPayload,
    RunStatus,
    SubagentCompletedPayload,
    SubagentQueuedPayload,
    SubagentRequest,
    SubagentResult,
    SubagentStartedPayload,
    SubagentStatus,
    SubagentType,
    TaskMode,
    TaskRunAccepted,
    TaskSnapshot,
    TaskSummary,
    build_event,
)
from app.runtime import event_store as event_store_module
from app.runtime import repository as repository_module
from app.runtime.event_store import CorruptEventLogError
from app.runtime.repository import TaskNotFoundError, TaskRepository

NOW = datetime(2026, 7, 13, tzinfo=UTC)


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


def artifact_event(
    task_id: str,
    sequence: int,
    artifact_id: str,
) -> EventEnvelope:
    return build_event(
        task_id=task_id,
        run_id="run_123",
        sequence=sequence,
        timestamp=NOW + timedelta(seconds=sequence),
        payload=ArtifactProducedPayload(
            artifact=ArtifactManifestEntry(
                artifact_id=artifact_id,
                name=f"{artifact_id}.csv",
                relative_path=f"artifacts/{artifact_id}.csv",
                media_type="text/csv",
                size_bytes=12,
                sha256="0" * 64,
                generated_by_step_id="step_123",
            )
        ),
    )


@pytest.mark.asyncio
async def test_repository_backfills_artifact_count_for_legacy_snapshot(
    tmp_path,
) -> None:
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    await repository.initialize()
    task_id = "task_legacy_artifacts"
    base = empty_snapshot(task_id=task_id)
    base = base.model_copy(
        update={
            "task": base.task.model_copy(update={"latest_sequence": 3}),
        }
    )
    await repository.save_snapshot(base)
    try:
        for event in (
            artifact_event(task_id, 1, "artifact_a"),
            artifact_event(task_id, 2, "artifact_b"),
            build_event(
                task_id=task_id,
                run_id="run_123",
                sequence=3,
                timestamp=NOW + timedelta(seconds=3),
                payload=RunFinalizingPayload(),
            ),
        ):
            await asyncio.to_thread(repository.events.append, event)
        snapshot_path = (
            output_dir / "tasks" / task_id / "state" / "task_snapshot.json"
        )
        raw = json.loads(snapshot_path.read_text("utf-8"))
        raw["task"].pop("artifact_count")
        snapshot_path.write_text(json.dumps(raw, ensure_ascii=False), "utf-8")

        loaded = await repository.get_snapshot(task_id)

        assert loaded is not None
        assert loaded.task.artifact_count == 2
        persisted = json.loads(snapshot_path.read_text("utf-8"))
        assert persisted["task"]["artifact_count"] == 2
    finally:
        await repository.close()


@pytest.mark.asyncio
async def test_repository_loads_legacy_snapshot_with_no_artifact_failure_field(
    tmp_path,
) -> None:
    # Snapshots persisted before the no_artifact_failure field was removed carry
    # it in the task sub-dict; strict ContractModel (extra="forbid") must not
    # reject the load — the obsolete key is dropped before validation.
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    await repository.initialize()
    task_id = "task_legacy_no_artifact_failure"
    await repository.save_snapshot(empty_snapshot(task_id=task_id))
    snapshot_path = (
        output_dir / "tasks" / task_id / "state" / "task_snapshot.json"
    )
    raw = json.loads(snapshot_path.read_text("utf-8"))
    raw["task"]["no_artifact_failure"] = True
    snapshot_path.write_text(json.dumps(raw, ensure_ascii=False), "utf-8")

    loaded = await repository.get_snapshot(task_id)

    assert loaded is not None
    assert loaded.task.task_id == task_id
    assert not hasattr(loaded.task, "no_artifact_failure")
    await repository.close()


@pytest.mark.asyncio
async def test_repository_replays_subagent_record_from_events(tmp_path) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    snapshot = snapshot_with_run(
        task_id="task_123",
        request_id="req_123",
        run_id="run_123",
    )
    await repository.save_snapshot(snapshot)
    try:
        queued = build_event(
            task_id="task_123",
            run_id="run_123",
            sequence=1,
            timestamp=NOW + timedelta(seconds=1),
            subagent_id="subagent_1",
            parent_tool_call_id="call_1",
            payload=SubagentQueuedPayload(
                subagent_id="subagent_1",
                request=SubagentRequest(
                    agent_type=SubagentType.SOURCE_RESEARCH,
                    objective="Find public cohort metadata",
                    domain="ncbi.nlm.nih.gov",
                    capability="metadata_search",
                ),
            ),
        )
        started = build_event(
            task_id="task_123",
            run_id="run_123",
            sequence=2,
            timestamp=NOW + timedelta(seconds=2),
            subagent_id="subagent_1",
            parent_tool_call_id="call_1",
            payload=SubagentStartedPayload(subagent_id="subagent_1"),
        )
        completed = build_event(
            task_id="task_123",
            run_id="run_123",
            sequence=3,
            timestamp=NOW + timedelta(seconds=3),
            subagent_id="subagent_1",
            parent_tool_call_id="call_1",
            payload=SubagentCompletedPayload(
                subagent_id="subagent_1",
                result=SubagentResult(
                    subagent_id="subagent_1",
                    status=SubagentStatus.COMPLETED,
                    summary="Found one source asset",
                    source_asset_ids=["source_1"],
                ),
            ),
        )
        for event in (queued, started, completed):
            await asyncio.to_thread(repository.events.append, event)

        rebuilt = await repository.get_snapshot("task_123")

        assert rebuilt is not None
        assert rebuilt.subagents[0].status is SubagentStatus.COMPLETED
        assert rebuilt.subagents[0].source_asset_ids == ["source_1"]
        assert rebuilt.task.latest_sequence == 3
    finally:
        await repository.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("read_operation", ["list_tasks", "find_request"])
async def test_failed_projection_serializes_index_backed_reads(
    tmp_path,
    monkeypatch,
    read_operation: str,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    projection_entered = threading.Event()
    release_projection = threading.Event()
    read_started = asyncio.Event()
    writer = None
    reader = None

    def fail_projection(_snapshot) -> None:
        projection_entered.set()
        if not release_projection.wait(timeout=3):
            raise TimeoutError("projection release timed out")
        raise OSError("simulated index projection failure")

    def fail_rebuild() -> None:
        raise OSError("simulated index rebuild failure")

    monkeypatch.setattr(repository.index, "_upsert_snapshot_sync", fail_projection)
    monkeypatch.setattr(repository.index, "_rebuild_sync", fail_rebuild)
    persisted = snapshot_with_run(
        task_id="task_failed_projection_read",
        request_id="req_failed_projection_read",
        run_id="run_failed_projection_read",
    )

    async def read_index():
        read_started.set()
        if read_operation == "list_tasks":
            return await repository.list_tasks()
        return await repository.find_request("req_failed_projection_read")

    writer = asyncio.create_task(repository.save_snapshot(persisted))
    try:
        assert await asyncio.to_thread(projection_entered.wait, 2)
        reader = asyncio.create_task(read_index())
        await read_started.wait()
        release_projection.set()

        await writer
        with pytest.raises(OSError, match="index rebuild failure"):
            await reader
        assert repository._index_dirty is True
    finally:
        release_projection.set()
        if writer is not None:
            await asyncio.gather(writer, return_exceptions=True)
        if reader is not None:
            await asyncio.gather(reader, return_exceptions=True)
        await repository.close()


@pytest.mark.asyncio
async def test_repository_rejects_snapshot_save_after_close_without_writing(
    tmp_path,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    await repository.close()

    with pytest.raises(RuntimeError, match="repository is closed"):
        await repository.save_snapshot(empty_snapshot("task_after_close"))

    assert not (repository.tasks_dir / "task_after_close").exists()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "read_operation",
    ["list_messages", "load_conversation_summary"],
)
async def test_repository_rejects_recovery_reads_after_close_without_writing(
    tmp_path,
    read_operation: str,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    task_id = "task_recovery_after_close"
    await repository.save_snapshot(empty_snapshot(task_id))
    await asyncio.to_thread(repository.events.append, queued_event(task_id))
    snapshot_path = repository._snapshot_path(task_id)
    assert (
        TaskSnapshot.model_validate_json(
            snapshot_path.read_text("utf-8")
        ).task.latest_sequence
        == 0
    )
    await repository.close()

    with pytest.raises(RuntimeError, match="repository is closed"):
        if read_operation == "list_messages":
            await repository.list_messages(task_id)
        else:
            await repository.load_conversation_summary(task_id)

    assert (
        TaskSnapshot.model_validate_json(
            snapshot_path.read_text("utf-8")
        ).task.latest_sequence
        == 0
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "recovery_operation",
    ["list_messages", "load_conversation_summary", "save_conversation_summary"],
)
async def test_cancelled_snapshot_recovery_drains_before_repository_close(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
    recovery_operation: str,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    task_id = "task_cancelled_recovery_read"
    await repository.save_snapshot(empty_snapshot(task_id))
    await asyncio.to_thread(repository.events.append, queued_event(task_id))
    recovery_entered = threading.Event()
    release_recovery = threading.Event()
    recovery_finished = threading.Event()
    close_drain_started = asyncio.Event()
    real_load_snapshot = repository._load_snapshot_sync
    real_close_when_drained = repository._close_index_when_drained
    real_index_close = repository.index.close
    index_closed_before_recovery = False

    def blocked_load_snapshot(requested_task_id: str) -> TaskSnapshot | None:
        recovery_entered.set()
        if not release_recovery.wait(timeout=3):
            raise TimeoutError("recovery release timed out")
        try:
            return real_load_snapshot(requested_task_id)
        finally:
            recovery_finished.set()

    async def observed_close_when_drained() -> None:
        close_drain_started.set()
        await real_close_when_drained()

    async def observed_index_close() -> None:
        nonlocal index_closed_before_recovery
        if not recovery_finished.is_set():
            index_closed_before_recovery = True
        await real_index_close()

    monkeypatch.setattr(repository, "_load_snapshot_sync", blocked_load_snapshot)
    monkeypatch.setattr(
        repository,
        "_close_index_when_drained",
        observed_close_when_drained,
    )
    monkeypatch.setattr(repository.index, "close", observed_index_close)
    if recovery_operation == "list_messages":
        recovery_read = asyncio.create_task(repository.list_messages(task_id))
    elif recovery_operation == "load_conversation_summary":
        recovery_read = asyncio.create_task(
            repository.load_conversation_summary(task_id)
        )
    else:
        recovery_read = asyncio.create_task(
            repository.save_conversation_summary(task_id, {"summary": "updated"})
        )
    close = None
    try:
        assert await asyncio.to_thread(recovery_entered.wait, 2)
        recovery_read.cancel()
        close = asyncio.create_task(repository.close())
        await close_drain_started.wait()
        release_recovery.set()

        with pytest.raises(asyncio.CancelledError):
            await recovery_read
        await close
        assert recovery_finished.is_set()
        assert index_closed_before_recovery is False
    finally:
        release_recovery.set()
        await asyncio.gather(recovery_read, return_exceptions=True)
        if close is not None:
            await asyncio.gather(close, return_exceptions=True)
        await repository.close()


@pytest.mark.asyncio
async def test_cancelled_snapshot_save_drains_index_projection(
    tmp_path,
    monkeypatch,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    projection_entered = asyncio.Event()
    release_projection = asyncio.Event()
    projection_finished = asyncio.Event()
    real_upsert = repository.index.upsert_snapshot

    async def blocked_upsert(snapshot) -> None:
        projection_entered.set()
        await release_projection.wait()
        await real_upsert(snapshot)
        projection_finished.set()

    monkeypatch.setattr(repository.index, "upsert_snapshot", blocked_upsert)
    save = asyncio.create_task(
        repository.save_snapshot(empty_snapshot("task_cancelled_snapshot_save"))
    )
    try:
        await projection_entered.wait()
        save.cancel()
        release_projection.set()

        with pytest.raises(asyncio.CancelledError):
            await save
        assert projection_finished.is_set()
        page = await repository.list_tasks()
        assert [task.task_id for task in page.tasks] == ["task_cancelled_snapshot_save"]
    finally:
        release_projection.set()
        await asyncio.gather(save, return_exceptions=True)
        await repository.close()


@pytest.mark.asyncio
async def test_cancelled_snapshot_get_drains_index_projection(
    tmp_path,
    monkeypatch,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    task_id = "task_cancelled_snapshot_get"
    await repository.save_snapshot(empty_snapshot(task_id))
    await asyncio.to_thread(repository._append_event_sync, queued_event(task_id))
    projection_entered = asyncio.Event()
    release_projection = asyncio.Event()
    projection_finished = asyncio.Event()
    real_upsert = repository.index.upsert_snapshot

    async def blocked_upsert(snapshot) -> None:
        projection_entered.set()
        await release_projection.wait()
        await real_upsert(snapshot)
        projection_finished.set()

    monkeypatch.setattr(repository.index, "upsert_snapshot", blocked_upsert)
    load = asyncio.create_task(repository.get_snapshot(task_id))
    try:
        await projection_entered.wait()
        load.cancel()
        release_projection.set()

        with pytest.raises(asyncio.CancelledError):
            await load
        assert projection_finished.is_set()
        page = await repository.list_tasks()
        summary = next(task for task in page.tasks if task.task_id == task_id)
        assert summary.latest_sequence == 1
        assert summary.active_run_id == "run_123"
    finally:
        release_projection.set()
        await asyncio.gather(load, return_exceptions=True)
        await repository.close()


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


@pytest.mark.asyncio
async def test_legacy_events_replay_without_string_scan(tmp_path) -> None:
    # Old-style journal: run_failed carries only error (no error_code key),
    # run_completed has no build_result key, and no publication events exist.
    # Replay must build the snapshot, project partial run summaries, and
    # leave current_publication_id unset. The journal is written as RAW JSON
    # with the optional payload keys omitted entirely (not explicit nulls) so
    # the model's optional-field defaults are genuinely exercised on load.
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    task_id = "task_legacy_replay"
    await repository.save_snapshot(empty_snapshot(task_id=task_id))
    events_path = repository.events.path_for(task_id)
    try:
        for event in (
            build_event(
                task_id=task_id,
                run_id="run_123",
                sequence=1,
                timestamp=NOW + timedelta(seconds=1),
                payload=RunQueuedPayload(request_id="req_legacy", input="question"),
            ),
            build_event(
                task_id=task_id,
                run_id="run_123",
                sequence=2,
                timestamp=NOW + timedelta(seconds=2),
                payload=RunStartedPayload(),
            ),
            build_event(
                task_id=task_id,
                run_id="run_123",
                sequence=3,
                timestamp=NOW + timedelta(seconds=3),
                payload=RunFailedPayload(error="legacy failure"),
            ),
            build_event(
                task_id=task_id,
                run_id="run_456",
                sequence=4,
                timestamp=NOW + timedelta(seconds=4),
                payload=RunQueuedPayload(request_id="req_456", input="second"),
            ),
            build_event(
                task_id=task_id,
                run_id="run_456",
                sequence=5,
                timestamp=NOW + timedelta(seconds=5),
                payload=RunStartedPayload(),
            ),
            build_event(
                task_id=task_id,
                run_id="run_456",
                sequence=6,
                timestamp=NOW + timedelta(seconds=6),
                payload=RunFinalizingPayload(),
            ),
            build_event(
                task_id=task_id,
                run_id="run_456",
                sequence=7,
                timestamp=NOW + timedelta(seconds=7),
                payload=RunCompletedPayload(),
            ),
        ):
            raw = event.model_dump(mode="json")
            payload = raw["payload"]
            if payload["type"] == "run_failed":
                payload.pop("error_code", None)
            if payload["type"] == "run_completed":
                payload.pop("build_result", None)
            event_store_module.append_jsonl(events_path, raw)

        # The raw journal genuinely omits the optional payload keys.
        raw_text = events_path.read_text("utf-8")
        assert "error_code" not in raw_text
        assert "build_result" not in raw_text

        loaded = await repository.get_snapshot(task_id)

        assert loaded is not None
        assert loaded.task.latest_sequence == 7
        failed = next(run for run in loaded.runs if run.run_id == "run_123")
        assert failed.status is RunStatus.FAILED
        assert failed.summary is not None
        assert failed.summary.error_code is None
        assert failed.summary.build_result is None
        assert failed.summary.user_message == "legacy failure"
        completed = next(run for run in loaded.runs if run.run_id == "run_456")
        assert completed.status is RunStatus.COMPLETED
        assert completed.summary is not None
        assert completed.summary.build_result is None
        assert completed.summary.user_message is None
        assert loaded.current_publication_id is None
        assert loaded.publications == []
    finally:
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

        session = repository.task_session("task_123", run_id="run_123")
        assert session.run_id == "run_123"
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
async def test_repository_delete_removes_complete_task_tree_only(tmp_path) -> None:
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    await repository.initialize()
    deleted = snapshot_with_run(
        task_id="task_deleted",
        request_id="req_deleted",
        run_id="run_deleted",
    )
    sibling = snapshot_with_run(
        task_id="task_sibling",
        request_id="req_sibling",
        run_id="run_sibling",
    )
    await repository.save_snapshot(deleted)
    await repository.save_snapshot(sibling)
    deleted_dir = repository.tasks_dir / "task_deleted"
    sibling_sentinel = repository.tasks_dir / "task_sibling" / "sibling.txt"
    shared_sentinel = output_dir / "shared_cache" / "shared.bin"
    external_sentinel = tmp_path / "external" / "sentinel.txt"
    for relative_path in (
        "source_assets/source.txt",
        "download_tmp/download.part",
        "parsed/parsed.json",
        "normalized/normalized.json",
        "staging/staged.bin",
        "artifacts/result.csv",
        "logs/runtime.log",
        "state/extra-state.json",
    ):
        path = deleted_dir / relative_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(relative_path, "utf-8")
    for sentinel in (sibling_sentinel, shared_sentinel, external_sentinel):
        sentinel.parent.mkdir(parents=True, exist_ok=True)
        sentinel.write_text("keep", "utf-8")
    index_path = repository.index.path
    try:
        await repository.delete_task("task_deleted")

        assert not deleted_dir.exists()
        assert index_path.is_file()
        assert sibling_sentinel.read_text("utf-8") == "keep"
        assert shared_sentinel.read_text("utf-8") == "keep"
        assert external_sentinel.read_text("utf-8") == "keep"
        assert await repository.get_snapshot("task_sibling") is not None
        assert await repository.find_request("req_deleted") is None
        assert await repository.find_request("req_sibling") == TaskRunAccepted(
            request_id="req_sibling",
            task_id="task_sibling",
            run_id="run_sibling",
        )
    finally:
        await repository.close()


@pytest.mark.asyncio
async def test_repository_delete_rejects_missing_and_unsafe_task_ids(
    tmp_path,
) -> None:
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    await repository.initialize()
    external_sentinel = tmp_path / "external" / "sentinel.txt"
    external_sentinel.parent.mkdir(parents=True)
    external_sentinel.write_text("keep", "utf-8")
    unsafe_ids = [
        "",
        ".",
        "..",
        "../external",
        str(external_sentinel.parent.resolve()),
    ]
    try:
        for task_id in ["task_missing", *unsafe_ids]:
            with pytest.raises(TaskNotFoundError):
                await repository.delete_task(task_id)
        assert external_sentinel.read_text("utf-8") == "keep"
    finally:
        await repository.close()


@pytest.mark.asyncio
async def test_repository_delete_rejects_task_root_symlink(tmp_path) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    external_dir = tmp_path / "external-target"
    external_dir.mkdir()
    sentinel = external_dir / "sentinel.txt"
    sentinel.write_text("keep", "utf-8")
    task_link = repository.tasks_dir / "task_link"
    try:
        try:
            task_link.symlink_to(external_dir, target_is_directory=True)
        except OSError as error:
            pytest.skip(f"directory symlinks are unavailable: {error}")

        with pytest.raises(TaskNotFoundError):
            await repository.delete_task("task_link")
        assert task_link.is_symlink()
        assert sentinel.read_text("utf-8") == "keep"
    finally:
        task_link.unlink(missing_ok=True)
        await repository.close()


@pytest.mark.asyncio
async def test_repository_delete_rejects_task_root_junction(
    tmp_path,
    monkeypatch,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    task_dir = repository.tasks_dir / "task_junction"
    task_dir.mkdir()
    sentinel = task_dir / "sentinel.txt"
    sentinel.write_text("keep", "utf-8")
    real_is_junction = Path.is_junction

    def report_test_directory_as_junction(path: Path) -> bool:
        return path == task_dir or real_is_junction(path)

    monkeypatch.setattr(Path, "is_junction", report_test_directory_as_junction)
    try:
        with pytest.raises(TaskNotFoundError):
            await repository.delete_task("task_junction")
        assert sentinel.read_text("utf-8") == "keep"
    finally:
        await repository.close()


@pytest.mark.asyncio
async def test_cancelled_repository_delete_drains_tree_and_index_before_unlocking(
    tmp_path,
    monkeypatch,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    task_id = "task_cancelled_delete"
    request_id = "req_cancelled_delete"
    await repository.save_snapshot(
        snapshot_with_run(
            task_id=task_id,
            request_id=request_id,
            run_id="run_cancelled_delete",
        )
    )
    task_dir = repository.tasks_dir / task_id
    tree_entered = threading.Event()
    release_tree = threading.Event()
    tree_finished = threading.Event()
    index_entered = asyncio.Event()
    release_index = asyncio.Event()
    real_rmtree = shutil.rmtree
    real_index_delete = repository.index.delete_task
    lock_probe = None

    def blocked_rmtree(path: Path) -> None:
        tree_entered.set()
        if not release_tree.wait(timeout=3):
            raise TimeoutError("tree deletion release timed out")
        real_rmtree(path)
        tree_finished.set()

    async def blocked_index_delete(deleted_task_id: str) -> None:
        index_entered.set()
        await release_index.wait()
        await real_index_delete(deleted_task_id)

    monkeypatch.setattr(shutil, "rmtree", blocked_rmtree)
    monkeypatch.setattr(repository.index, "delete_task", blocked_index_delete)
    deletion = asyncio.create_task(repository.delete_task(task_id))
    try:
        await asyncio.wait_for(asyncio.to_thread(tree_entered.wait), timeout=1)
        deletion.cancel()
        await asyncio.sleep(0)
        lock = repository._task_locks[task_id]
        lock_probe = asyncio.create_task(lock.acquire())
        await asyncio.sleep(0.05)
        assert not deletion.done()
        assert not lock_probe.done()

        release_tree.set()
        await asyncio.wait_for(index_entered.wait(), timeout=1)
        assert tree_finished.is_set()
        assert not task_dir.exists()
        assert not deletion.done()
        assert not lock_probe.done()

        release_index.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(deletion, timeout=1)
        await asyncio.wait_for(lock_probe, timeout=1)
        lock.release()
        assert await repository.find_request(request_id) is None
    finally:
        release_tree.set()
        release_index.set()
        await asyncio.gather(deletion, return_exceptions=True)
        if lock_probe is not None and lock_probe.done():
            if not lock_probe.cancelled() and lock_probe.exception() is None:
                lock = repository._task_locks[task_id]
                if lock.locked():
                    lock.release()
        elif lock_probe is not None:
            lock_probe.cancel()
            await asyncio.gather(lock_probe, return_exceptions=True)
        await repository.close()


@pytest.mark.asyncio
async def test_repository_delete_rebuilds_index_after_cleanup_failure(
    tmp_path,
    monkeypatch,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    await repository.initialize()
    task_id = "task_index_failure"
    request_id = "req_index_failure"
    await repository.save_snapshot(
        snapshot_with_run(
            task_id=task_id,
            request_id=request_id,
            run_id="run_index_failure",
        )
    )
    task_dir = repository.tasks_dir / task_id
    rebuild_calls = 0
    real_rebuild = repository.index.rebuild

    async def fail_index_delete(deleted_task_id: str) -> None:
        assert deleted_task_id == task_id
        assert not task_dir.exists()
        raise OSError("simulated index cleanup failure")

    async def count_rebuild() -> None:
        nonlocal rebuild_calls
        rebuild_calls += 1
        await real_rebuild()

    monkeypatch.setattr(repository.index, "delete_task", fail_index_delete)
    monkeypatch.setattr(repository.index, "rebuild", count_rebuild)
    try:
        with pytest.raises(OSError, match="index cleanup failure"):
            await repository.delete_task(task_id)

        assert rebuild_calls == 1
        assert not task_dir.exists()
        assert await repository.find_request(request_id) is None
        assert all(
            item.task_id != task_id for item in (await repository.list_tasks()).tasks
        )
    finally:
        await repository.close()


@pytest.mark.asyncio
async def test_repository_restart_rebuild_drops_stale_deleted_projection(
    tmp_path,
) -> None:
    output_dir = tmp_path / "output"
    task_id = "task_restart_deleted"
    request_id = "req_restart_deleted"
    repository = TaskRepository(output_dir)
    await repository.initialize()
    await repository.save_snapshot(
        snapshot_with_run(
            task_id=task_id,
            request_id=request_id,
            run_id="run_restart_deleted",
        )
    )
    shutil.rmtree(repository.tasks_dir / task_id)
    assert await repository.find_request(request_id) is not None
    await repository.close()

    reopened = TaskRepository(output_dir)
    await reopened.initialize()
    try:
        assert await reopened.get_snapshot(task_id) is None
        assert await reopened.find_request(request_id) is None
        assert all(
            item.task_id != task_id for item in (await reopened.list_tasks()).tasks
        )
    finally:
        await reopened.close()


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
