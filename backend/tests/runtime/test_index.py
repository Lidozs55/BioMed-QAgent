from __future__ import annotations

import asyncio
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

import pytest

from app.config import Settings
from app.domain.contracts import (
    RunQueuedPayload,
    RunRecord,
    RunStatus,
    TaskMode,
    TaskRunAccepted,
    TaskSnapshot,
    TaskSummary,
    build_event,
)
from app.runtime.event_store import EventStore
from app.runtime.index import SingleThreadExecutor, TaskIndex


NOW = datetime(2026, 7, 13, tzinfo=timezone.utc)


def snapshot(
    task_id: str,
    *,
    status: RunStatus = RunStatus.COMPLETED,
    request_id: str | None = None,
    run_id: str | None = None,
    created_at: datetime = NOW,
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

        assert [len(first.tasks), len(second.tasks), len(third.tasks)] == [30, 30, 5]
        task_ids = [
            task.task_id for page in (first, second, third) for task in page.tasks
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
        assert active_ids <= {task.task_id for task in first.tasks}
        assert active_ids <= {task.task_id for task in second.tasks}
        assert len(first.tasks) == 32
        assert len(second.tasks) == 7
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
async def test_index_rebuild_preserves_an_unpublished_request_reservation(
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

        assert await reopened.find_request("req_crash") == accepted
    finally:
        await reopened.close()


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
