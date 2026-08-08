from __future__ import annotations

import asyncio
import json
import sqlite3
import threading
from datetime import UTC, datetime, timedelta

import pytest
from app.config import Settings
from app.domain.contracts import (
    ArtifactManifestEntry,
    ArtifactProducedPayload,
    RunQueuedPayload,
    RunRecord,
    RunStatus,
    TaskMode,
    TaskRunAccepted,
    TaskSnapshot,
    TaskSummary,
    build_event,
)
from app.domain.contracts.dataset_state import (
    ArtifactRole,
    BuildResult,
    BuildResultStatus,
)
from app.domain.contracts.runtime import RunSummary
from app.runtime.event_store import CorruptEventLogError, EventStore
from app.runtime.index import SingleThreadExecutor, TaskIndex

NOW = datetime(2026, 7, 13, tzinfo=UTC)


def snapshot(
    task_id: str,
    *,
    status: RunStatus = RunStatus.COMPLETED,
    request_id: str | None = None,
    run_id: str | None = None,
    created_at: datetime = NOW,
    databases: list[str] | None = None,
) -> TaskSnapshot:
    runs = []
    if request_id is not None and run_id is not None:
        runs.append(
            RunRecord(
                run_id=run_id,
                task_id=task_id,
                request_id=request_id,
                status=status,
                input="question",
                created_at=created_at,
                updated_at=created_at,
                started_at=created_at if status is not RunStatus.QUEUED else None,
            )
        )
    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=TaskMode.AGENT,
            databases=[] if databases is None else databases,
            title=f"Task {task_id}",
            status=status,
            active_run_id=(
                run_id
                if status
                in {
                    RunStatus.QUEUED,
                    RunStatus.RUNNING,
                    RunStatus.FINALIZING,
                    RunStatus.CANCEL_REQUESTED,
                }
                else None
            ),
            created_at=created_at,
            updated_at=created_at,
        ),
        runs=runs,
    )


@pytest.mark.asyncio
async def test_index_persists_selected_databases_across_reopen_and_rebuild(
    tmp_path,
) -> None:
    tasks_dir = tmp_path / "tasks"
    index = TaskIndex(tasks_dir)
    await index.initialize()
    try:
        await index.upsert_snapshot(
            snapshot("task_selected", databases=["geo", "pubmed"])
        )
        listed = await index.list_tasks()
        assert listed.tasks[0].databases == ["geo", "pubmed"]
    finally:
        await index.close()

    state_dir = tasks_dir / "task_selected" / "state"
    state_dir.mkdir(parents=True)
    (state_dir / "task_snapshot.json").write_text(
        snapshot(
            "task_selected",
            databases=["geo", "pubmed"],
        ).model_dump_json(indent=2)
        + "\n",
        "utf-8",
    )
    reopened = TaskIndex(tasks_dir)
    await reopened.initialize()
    try:
        await reopened.rebuild()
        rebuilt = await reopened.list_tasks()
        assert rebuilt.tasks[0].databases == ["geo", "pubmed"]
    finally:
        await reopened.close()


@pytest.mark.asyncio
async def test_index_migrates_legacy_summary_table_with_empty_databases(
    tmp_path,
) -> None:
    tasks_dir = tmp_path / "tasks"
    tasks_dir.mkdir(parents=True)
    path = tasks_dir / "task_index.sqlite3"
    with sqlite3.connect(path) as connection:
        connection.executescript(
            """
            CREATE TABLE task_summaries (
                task_id TEXT PRIMARY KEY,
                mode TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                active_run_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                latest_sequence INTEGER NOT NULL
            );
            CREATE TABLE request_ids (
                request_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                run_id TEXT NOT NULL
            );
            """
        )
        connection.execute(
            """
            INSERT INTO task_summaries (
                task_id, mode, title, status, active_run_id,
                created_at, updated_at, latest_sequence
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "task_legacy_index",
                "agent",
                "Legacy index",
                "completed",
                None,
                NOW.isoformat(),
                NOW.isoformat(),
                0,
            ),
        )

    index = TaskIndex(tasks_dir)
    await index.initialize()
    try:
        page = await index.list_tasks()
        assert page.tasks[0].databases == []
        assert page.tasks[0].artifact_count == 0
        await index.upsert_snapshot(snapshot("task_legacy_index", databases=["geo"]))
        updated = await index.list_tasks()
        assert updated.tasks[0].databases == ["geo"]
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_persists_artifact_count(tmp_path) -> None:
    tasks_dir = tmp_path / "tasks"
    index = TaskIndex(tasks_dir)
    await index.initialize()
    try:
        base = snapshot("task_artifact_count")
        base.task = base.task.model_copy(update={"artifact_count": 3})
        await index.upsert_snapshot(base)
        listed = await index.list_tasks()
        assert listed.tasks[0].artifact_count == 3
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_persists_latest_build_status_from_run_summary(tmp_path) -> None:
    tasks_dir = tmp_path / "tasks"
    index = TaskIndex(tasks_dir)
    await index.initialize()
    try:
        base = snapshot(
            "task_build_status",
            request_id="req_1",
            run_id="run_1",
        )
        base.runs[0] = base.runs[0].model_copy(
            update={
                "status": RunStatus.COMPLETED,
                "started_at": NOW,
                "finished_at": NOW,
                "summary": RunSummary(
                    run_status=RunStatus.COMPLETED,
                    build_result=BuildResult(
                        status=BuildResultStatus.SUCCEEDED,
                        valid_row_count=10,
                        successful_sources=["pubmed"],
                        publication_id="pub-run_1",
                    ),
                ),
            }
        )
        await index.upsert_snapshot(base)
        listed = await index.list_tasks()
        assert listed.tasks[0].latest_build_status is BuildResultStatus.SUCCEEDED
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_normalizes_legacy_no_artifact_failure(tmp_path) -> None:
    tasks_dir = tmp_path / "tasks"
    index = TaskIndex(tasks_dir)
    await index.initialize()
    try:
        legacy = snapshot(
            "task_legacy_no_data",
            status=RunStatus.FAILED,
            request_id="req_legacy",
            run_id="run_legacy",
        )
        legacy.runs[0] = legacy.runs[0].model_copy(
            update={
                "status": RunStatus.FAILED,
                "started_at": NOW,
                "finished_at": NOW,
                "error": "run failed without producing any artifacts",
            }
        )
        genuine = snapshot(
            "task_genuine_error",
            status=RunStatus.FAILED,
            request_id="req_genuine",
            run_id="run_genuine",
        )
        genuine.runs[0] = genuine.runs[0].model_copy(
            update={
                "status": RunStatus.FAILED,
                "started_at": NOW,
                "finished_at": NOW,
                "error": "model request failed: connection refused",
            }
        )
        await index.upsert_snapshot(legacy)
        await index.upsert_snapshot(genuine)
        listed = await index.list_tasks()
        by_id = {task.task_id: task for task in listed.tasks}
        assert by_id["task_legacy_no_data"].latest_build_status is (
            BuildResultStatus.NO_DATA
        )
        assert by_id["task_genuine_error"].latest_build_status is None
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_rebuild_backfills_latest_build_status(tmp_path) -> None:
    tasks_dir = tmp_path / "tasks"
    index = TaskIndex(tasks_dir)
    await index.initialize()
    try:
        await index.upsert_snapshot(
            snapshot(
                "task_backfill",
                status=RunStatus.COMPLETED,
                request_id="req_old",
                run_id="run_old",
            )
        )
    finally:
        await index.close()

    state_dir = tasks_dir / "task_backfill" / "state"
    state_dir.mkdir(parents=True)
    legacy = snapshot(
        "task_backfill",
        status=RunStatus.FAILED,
        request_id="req_old",
        run_id="run_old",
    )
    legacy.runs[0] = legacy.runs[0].model_copy(
        update={
            "status": RunStatus.FAILED,
            "started_at": NOW,
            "finished_at": NOW,
            "error": "manifest missing or unchanged",
        }
    )
    (state_dir / "task_snapshot.json").write_text(
        legacy.model_dump_json(indent=2) + "\n",
        "utf-8",
    )

    reopened = TaskIndex(tasks_dir)
    await reopened.initialize()
    try:
        await reopened.rebuild()
        rebuilt = await reopened.list_tasks()
        assert rebuilt.tasks[0].latest_build_status is BuildResultStatus.NO_DATA
    finally:
        await reopened.close()


@pytest.mark.asyncio
async def test_single_thread_executor_serializes_work_off_the_event_loop() -> None:
    executor = SingleThreadExecutor("test-index")
    caller_thread = threading.get_ident()
    try:
        worker_threads = await asyncio.gather(
            *(executor.run(threading.get_ident) for _ in range(20))
        )
    finally:
        await executor.close()

    assert set(worker_threads) == {worker_threads[0]}
    assert worker_threads[0] != caller_thread


@pytest.mark.asyncio
async def test_index_close_is_idempotent_and_rejects_later_work(tmp_path) -> None:
    index = TaskIndex(tmp_path / "tasks")
    await index.initialize()

    await index.close()
    await index.close()

    with pytest.raises(RuntimeError, match="closed"):
        await index.list_tasks()


@pytest.mark.asyncio
async def test_index_close_serializes_and_rejects_concurrent_work(
    tmp_path,
    monkeypatch,
) -> None:
    index = TaskIndex(tmp_path / "tasks")
    await index.initialize()
    entered = threading.Event()
    release = threading.Event()
    real_close = index._close_sync

    def blocking_close() -> None:
        entered.set()
        if not release.wait(timeout=2):
            raise RuntimeError("close was not released")
        real_close()

    monkeypatch.setattr(index, "_close_sync", blocking_close)
    closing = asyncio.create_task(index.close())
    assert await asyncio.to_thread(entered.wait, 2)
    work_started = asyncio.Event()

    async def start_work():
        work_started.set()
        return await index.list_tasks()

    concurrent_work = asyncio.create_task(start_work())
    await work_started.wait()
    assert not concurrent_work.done()

    release.set()
    await closing
    with pytest.raises(RuntimeError, match="closed"):
        await concurrent_work


@pytest.mark.asyncio
async def test_index_close_shuts_down_executor_when_connection_close_fails(
    tmp_path,
    monkeypatch,
) -> None:
    index = TaskIndex(tmp_path / "tasks")

    def fail_close() -> None:
        raise OSError("simulated connection close failure")

    monkeypatch.setattr(index, "_close_sync", fail_close)
    with pytest.raises(OSError, match="simulated connection close failure"):
        await index.close()

    assert index.executor._closed is True
    await index.close()


@pytest.mark.asyncio
async def test_index_uses_wal_at_the_required_output_path(tmp_path) -> None:
    index = TaskIndex(tmp_path / "output" / "tasks")
    await index.initialize()
    try:
        with sqlite3.connect(index.path) as connection:
            mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
        assert index.path == tmp_path / "output" / "tasks" / "task_index.sqlite3"
        assert mode.lower() == "wal"
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_pages_65_inactive_tasks_without_duplicates(tmp_path) -> None:
    index = TaskIndex(tmp_path / "tasks")
    await index.initialize()
    try:
        for number in range(65):
            await index.upsert_snapshot(snapshot(f"task_{number:03d}"))

        first = await index.list_tasks()
        second = await index.list_tasks(cursor=first.next_cursor)
        third = await index.list_tasks(cursor=second.next_cursor)

        assert [
            len(first.items),
            len(second.items),
            len(third.items),
        ] == [30, 30, 5]
        assert first.active_items == second.active_items == third.active_items == []
        task_ids = [
            task.task_id for page in (first, second, third) for task in page.items
        ]
        assert len(task_ids) == len(set(task_ids)) == 65
        assert task_ids == sorted(task_ids, reverse=True)
        assert first.next_cursor is not None and not first.next_cursor.startswith(
            "task_"
        )
        assert second.next_cursor is not None
        assert third.next_cursor is None

        with pytest.raises(ValueError, match="between 1 and 100"):
            await index.list_tasks(limit=101)
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_returns_all_active_tasks_plus_inactive_page(tmp_path) -> None:
    index = TaskIndex(tmp_path / "tasks")
    await index.initialize()
    try:
        for number in range(35):
            await index.upsert_snapshot(snapshot(f"task_history_{number:03d}"))
        for number in range(2):
            await index.upsert_snapshot(
                snapshot(
                    f"task_active_{number}",
                    status=RunStatus.RUNNING,
                    request_id=f"req_active_{number}",
                    run_id=f"run_active_{number}",
                )
            )

        first = await index.list_tasks(limit=30)
        second = await index.list_tasks(limit=30, cursor=first.next_cursor)

        active_ids = {"task_active_0", "task_active_1"}
        assert {task.task_id for task in first.active_items} == active_ids
        assert {task.task_id for task in second.active_items} == active_ids
        assert len(first.items) == 30
        assert len(second.items) == 5
        assert active_ids.isdisjoint(task.task_id for task in first.items)
        assert active_ids.isdisjoint(task.task_id for task in second.items)
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_request_idempotency_returns_the_original_acceptance(
    tmp_path,
) -> None:
    index = TaskIndex(tmp_path / "tasks")
    await index.initialize()
    first = TaskRunAccepted(
        request_id="req_same",
        task_id="task_first",
        run_id="run_first",
    )
    duplicate = TaskRunAccepted(
        request_id="req_same",
        task_id="task_duplicate",
        run_id="run_duplicate",
    )
    try:
        assert await index.record_request(first) == first
        assert await index.record_request(duplicate) == first
        assert await index.find_request("req_same") == first
        assert await index.find_request("req_missing") is None
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_delete_task_removes_all_rows_and_allows_request_reuse(
    tmp_path,
) -> None:
    index = TaskIndex(tmp_path / "tasks")
    await index.initialize()
    deleted = TaskSnapshot(
        task=snapshot("task_deleted").task,
        runs=[
            RunRecord(
                run_id="run_deleted_first",
                task_id="task_deleted",
                request_id="req_deleted_first",
                status=RunStatus.COMPLETED,
                input="first",
                created_at=NOW,
                updated_at=NOW,
                started_at=NOW,
                finished_at=NOW,
            ),
            RunRecord(
                run_id="run_deleted_second",
                task_id="task_deleted",
                request_id="req_deleted_second",
                status=RunStatus.FAILED,
                input="second",
                created_at=NOW,
                updated_at=NOW,
                started_at=NOW,
                finished_at=NOW,
                error="expected failure",
            ),
        ],
    )
    sibling = snapshot(
        "task_sibling",
        request_id="req_sibling",
        run_id="run_sibling",
    )
    replacement = TaskRunAccepted(
        request_id="req_deleted_first",
        task_id="task_replacement",
        run_id="run_replacement",
    )
    try:
        await index.upsert_snapshot(deleted)
        await index.upsert_snapshot(sibling)

        await index.delete_task("task_deleted")

        page = await index.list_tasks()
        assert [item.task_id for item in page.tasks] == ["task_sibling"]
        assert await index.find_request("req_deleted_first") is None
        assert await index.find_request("req_deleted_second") is None
        assert await index.find_request("req_sibling") == TaskRunAccepted(
            request_id="req_sibling",
            task_id="task_sibling",
            run_id="run_sibling",
        )
        assert await index.record_request(replacement) == replacement
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_cursor_remains_usable_after_boundary_task_is_deleted(
    tmp_path,
) -> None:
    index = TaskIndex(tmp_path / "tasks")
    await index.initialize()
    try:
        for number in range(5):
            await index.upsert_snapshot(
                snapshot(
                    f"task_{number}",
                    created_at=NOW + timedelta(minutes=number),
                )
            )

        first = await index.list_tasks(limit=2)
        assert [item.task_id for item in first.items] == ["task_4", "task_3"]
        assert first.next_cursor is not None

        await index.delete_task("task_3")

        second = await index.list_tasks(limit=2, cursor=first.next_cursor)
        third = await index.list_tasks(limit=2, cursor=second.next_cursor)
        assert [item.task_id for item in second.items] == ["task_2", "task_1"]
        assert [item.task_id for item in third.items] == ["task_0"]
        assert second.next_cursor is not None
        assert third.next_cursor is None
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_rebuild_removes_an_orphan_request_reservation(
    tmp_path,
) -> None:
    tasks_dir = tmp_path / "tasks"
    accepted = TaskRunAccepted(
        request_id="req_crash",
        task_id="task_crash",
        run_id="run_crash",
    )
    index = TaskIndex(tasks_dir)
    await index.initialize()
    await index.record_request(accepted)
    await index.close()

    reopened = TaskIndex(tasks_dir)
    await reopened.initialize()
    try:
        await reopened.rebuild()

        assert await reopened.find_request("req_crash") is None
    finally:
        await reopened.close()


@pytest.mark.asyncio
async def test_index_rebuild_rejects_conflicting_authoritative_request_ids(
    tmp_path,
) -> None:
    tasks_dir = tmp_path / "tasks"
    for task_id, run_id in (("task_first", "run_first"), ("task_second", "run_second")):
        state_dir = tasks_dir / task_id / "state"
        state_dir.mkdir(parents=True)
        persisted = snapshot(
            task_id,
            request_id="req_conflict",
            run_id=run_id,
        )
        (state_dir / "task_snapshot.json").write_text(
            persisted.model_dump_json(indent=2) + "\n",
            "utf-8",
        )

    index = TaskIndex(tasks_dir)
    await index.initialize()
    try:
        with pytest.raises(ValueError, match="conflicting.*request_id"):
            await index.rebuild()
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_rebuild_rejects_snapshot_ahead_of_event_journal(
    tmp_path,
) -> None:
    tasks_dir = tmp_path / "tasks"
    persisted = snapshot("task_ahead")
    persisted = persisted.model_copy(
        update={
            "task": persisted.task.model_copy(update={"latest_sequence": 1}),
        }
    )
    state_dir = tasks_dir / "task_ahead" / "state"
    state_dir.mkdir(parents=True)
    (state_dir / "task_snapshot.json").write_text(
        persisted.model_dump_json(indent=2) + "\n",
        "utf-8",
    )

    index = TaskIndex(tasks_dir)
    await index.initialize()
    try:
        with pytest.raises(CorruptEventLogError, match="latest_sequence"):
            await index.rebuild()
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_rebuild_rejects_snapshot_in_the_wrong_task_directory(
    tmp_path,
) -> None:
    tasks_dir = tmp_path / "tasks"
    state_dir = tasks_dir / "task_directory" / "state"
    state_dir.mkdir(parents=True)
    (state_dir / "task_snapshot.json").write_text(
        snapshot("task_snapshot").model_dump_json(indent=2) + "\n",
        "utf-8",
    )

    index = TaskIndex(tasks_dir)
    await index.initialize()
    try:
        with pytest.raises(ValueError, match="directory.*task_id"):
            await index.rebuild()
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_rebuilds_from_snapshot_and_newer_events(tmp_path) -> None:
    tasks_dir = tmp_path / "tasks"
    task_id = "task_recovered"
    initial = snapshot(task_id)
    state_dir = tasks_dir / task_id / "state"
    state_dir.mkdir(parents=True)
    (state_dir / "task_snapshot.json").write_text(
        initial.model_dump_json(indent=2) + "\n",
        "utf-8",
    )
    EventStore(tasks_dir).append(
        build_event(
            task_id=task_id,
            run_id="run_recovered",
            sequence=1,
            timestamp=NOW,
            payload=RunQueuedPayload(
                request_id="req_recovered",
                input="question",
            ),
        )
    )
    index = TaskIndex(tasks_dir)
    await index.initialize()
    try:
        await index.upsert_snapshot(snapshot("task_stale"))

        await index.rebuild()

        page = await index.list_tasks()
        assert [task.task_id for task in page.tasks] == [task_id]
        assert page.tasks[0].latest_sequence == 1
        assert await index.find_request("req_recovered") == TaskRunAccepted(
            request_id="req_recovered",
            task_id=task_id,
            run_id="run_recovered",
        )
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_rebuild_backfills_legacy_snapshot_artifact_count(
    tmp_path,
) -> None:
    tasks_dir = tmp_path / "tasks"
    task_id = "task_legacy_artifacts"
    initial = snapshot(
        task_id,
        request_id="req_legacy",
        run_id="run_legacy",
        status=RunStatus.COMPLETED,
    )
    initial = initial.model_copy(
        update={"task": initial.task.model_copy(update={"latest_sequence": 2})}
    )
    state_dir = tasks_dir / task_id / "state"
    state_dir.mkdir(parents=True)
    raw = initial.model_dump(mode="json")
    raw["task"].pop("artifact_count")
    (state_dir / "task_snapshot.json").write_text(
        json.dumps(raw, ensure_ascii=False) + "\n",
        "utf-8",
    )
    event_store = EventStore(tasks_dir)
    for sequence, artifact_id in ((1, "artifact_a"), (2, "artifact_b")):
        event_store.append(
            build_event(
                task_id=task_id,
                run_id="run_legacy",
                sequence=sequence,
                timestamp=NOW + timedelta(seconds=sequence),
                payload=ArtifactProducedPayload(
                    artifact=ArtifactManifestEntry(
                        artifact_id=artifact_id,
                        role=ArtifactRole.AUDIT_REPORT,
                        name=f"{artifact_id}.csv",
                        relative_path=f"artifacts/{artifact_id}.csv",
                        media_type="text/csv",
                        size_bytes=12,
                        sha256="0" * 64,
                        generated_by_step_id="step_legacy",
                    )
                ),
            )
        )
    index = TaskIndex(tasks_dir)
    await index.initialize()
    try:
        await index.rebuild()
        listed = await index.list_tasks()
        assert listed.tasks[0].artifact_count == 2
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_rebuild_loads_legacy_snapshot_with_no_artifact_failure_field(
    tmp_path,
) -> None:
    # Snapshots persisted before the no_artifact_failure field was removed carry
    # it in the task sub-dict; the rebuild must tolerate it (the obsolete key is
    # dropped before validation) instead of failing at startup.
    tasks_dir = tmp_path / "tasks"
    task_id = "task_legacy_no_artifact_failure"
    state_dir = tasks_dir / task_id / "state"
    state_dir.mkdir(parents=True)
    raw = snapshot(task_id).model_dump(mode="json")
    raw["task"]["no_artifact_failure"] = True
    (state_dir / "task_snapshot.json").write_text(
        json.dumps(raw, ensure_ascii=False) + "\n",
        "utf-8",
    )
    index = TaskIndex(tasks_dir)
    await index.initialize()
    try:
        await index.rebuild()
        page = await index.list_tasks()
        assert [task.task_id for task in page.tasks] == [task_id]
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_active_and_inactive_tasks_are_globally_ordered_on_every_page(
    tmp_path,
) -> None:
    index = TaskIndex(tmp_path / "tasks")
    await index.initialize()
    try:
        await index.upsert_snapshot(
            snapshot("task_inactive_new", created_at=NOW + timedelta(minutes=4))
        )
        await index.upsert_snapshot(
            snapshot(
                "task_active_middle",
                status=RunStatus.RUNNING,
                request_id="req_active_middle",
                run_id="run_active_middle",
                created_at=NOW + timedelta(minutes=3),
            )
        )
        await index.upsert_snapshot(
            snapshot("task_inactive_old", created_at=NOW + timedelta(minutes=2))
        )
        await index.upsert_snapshot(
            snapshot(
                "task_active_oldest",
                status=RunStatus.RUNNING,
                request_id="req_active_oldest",
                run_id="run_active_oldest",
                created_at=NOW + timedelta(minutes=1),
            )
        )

        first = await index.list_tasks(limit=1)
        second = await index.list_tasks(limit=1, cursor=first.next_cursor)

        assert [task.task_id for task in first.tasks] == [
            "task_inactive_new",
            "task_active_middle",
            "task_active_oldest",
        ]
        assert [task.task_id for task in second.tasks] == [
            "task_active_middle",
            "task_inactive_old",
            "task_active_oldest",
        ]
        assert first.next_cursor is not None
        assert second.next_cursor is None
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_index_uses_configured_task_page_default_and_maximum(tmp_path) -> None:
    configured = Settings(
        task_page_size=2,
        task_page_max_size=3,
        task_message_page_size=2,
    )
    index = TaskIndex(tmp_path / "tasks", settings=configured)
    await index.initialize()
    try:
        for number in range(4):
            await index.upsert_snapshot(snapshot(f"task_{number}"))

        page = await index.list_tasks()

        assert len(page.tasks) == 2
        assert page.next_cursor is not None
        with pytest.raises(ValueError, match="between 1 and 3"):
            await index.list_tasks(limit=4)
    finally:
        await index.close()
