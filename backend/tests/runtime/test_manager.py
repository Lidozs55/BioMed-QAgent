from __future__ import annotations

import asyncio
import importlib
import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.domain.contracts import (
    AssistantDeltaPayload,
    ArtifactManifestEntry,
    ArtifactProducedPayload,
    ConversationCompactedPayload,
    RunCancelRequestedPayload,
    RunCancelledPayload,
    RunCompletedPayload,
    RunFinalizingPayload,
    RunInterruptedPayload,
    RunQueuedPayload,
    RunRecord,
    RunStartedPayload,
    RunStatus,
    StartRunRequest,
    StartTaskRequest,
    TaskMode,
    TaskRunAccepted,
    TaskSnapshot,
    TaskSummary,
    WarningPayload,
    build_event,
)
from app.config import Settings
from app.agent_loop.context import RunContext
from app.runtime.compaction import CompactionCancelledError, ConversationCompactor
from app.runtime.repository import TaskRepository
from app.runtime.hub import EventHub
from app.runtime import repository as repository_module


NOW = datetime(2026, 7, 13, tzinfo=timezone.utc)


def empty_snapshot(
    task_id: str,
    *,
    mode: TaskMode = TaskMode.AGENT,
    databases: list[str] | None = None,
) -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=mode,
            databases=[] if databases is None else databases,
            title=task_id,
            status=RunStatus.COMPLETED,
            created_at=NOW,
            updated_at=NOW,
        )
    )


def snapshot_with_status(task_id: str, status: RunStatus) -> TaskSnapshot:
    active_statuses = {
        RunStatus.QUEUED,
        RunStatus.RUNNING,
        RunStatus.FINALIZING,
        RunStatus.CANCEL_REQUESTED,
    }
    run_id = f"run_{task_id}"
    active = status in active_statuses
    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=TaskMode.AGENT,
            title=task_id,
            status=status,
            active_run_id=run_id if active else None,
            created_at=NOW,
            updated_at=NOW,
        ),
        runs=[
            RunRecord(
                run_id=run_id,
                task_id=task_id,
                request_id=f"req_{task_id}",
                status=status,
                input=task_id,
                created_at=NOW,
                updated_at=NOW,
                started_at=NOW if status is not RunStatus.QUEUED else None,
                finished_at=NOW if not active else None,
                error="expected failure" if status is RunStatus.FAILED else None,
            )
        ],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status",
    [
        RunStatus.COMPLETED,
        RunStatus.FAILED,
        RunStatus.CANCELLED,
        RunStatus.INTERRUPTED,
    ],
)
async def test_manager_deletes_each_terminal_task_status(tmp_path, status) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")

    async def run(_execution) -> None:
        return None

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    task_id = f"task_delete_{status.value}"
    await repository.save_snapshot(snapshot_with_status(task_id, status))
    try:
        await manager.delete_task(task_id)

        assert await repository.get_snapshot(task_id) is None
        assert not (repository.tasks_dir / task_id).exists()
        assert await repository.find_request(f"req_{task_id}") is None
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_cancelled_manager_delete_drains_snapshot_projection_before_unlocking(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")

    async def run(_execution) -> None:
        return None

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    task_id = "task_cancelled_manager_delete"
    stale_snapshot = snapshot_with_status(task_id, RunStatus.FINALIZING)
    await repository.save_snapshot(stale_snapshot)
    await asyncio.to_thread(
        repository.events.append,
        build_event(
            task_id=task_id,
            run_id=f"run_{task_id}",
            sequence=1,
            timestamp=NOW + timedelta(seconds=1),
            payload=RunCompletedPayload(),
        ),
    )
    snapshot_path = repository.tasks_dir / task_id / "state" / "task_snapshot.json"
    task_dir = repository.tasks_dir / task_id
    projection_write_entered = asyncio.Event()
    projection_write_finished = asyncio.Event()
    release_projection_write = threading.Event()
    first_load_lock = threading.Lock()
    load_context = threading.local()
    loop = asyncio.get_running_loop()
    real_load_snapshot = repository._load_snapshot_sync
    real_atomic_write_json = repository_module.atomic_write_json
    first_load_selected = False
    deletion = None
    retry = None

    def blocked_load_snapshot(loaded_task_id: str):
        nonlocal first_load_selected
        block_projection_write = False
        with first_load_lock:
            if loaded_task_id == task_id and not first_load_selected:
                first_load_selected = True
                block_projection_write = True
        load_context.block_projection_write = block_projection_write
        try:
            return real_load_snapshot(loaded_task_id)
        finally:
            load_context.block_projection_write = False

    def blocked_atomic_write_json(path, value) -> None:
        if path == snapshot_path and getattr(
            load_context,
            "block_projection_write",
            False,
        ):
            loop.call_soon_threadsafe(projection_write_entered.set)
            if not release_projection_write.wait(timeout=5):
                raise TimeoutError("snapshot projection release timed out")
            try:
                real_atomic_write_json(path, value)
            finally:
                loop.call_soon_threadsafe(projection_write_finished.set)
            return
        real_atomic_write_json(path, value)

    monkeypatch.setattr(repository, "_load_snapshot_sync", blocked_load_snapshot)
    monkeypatch.setattr(
        repository_module,
        "atomic_write_json",
        blocked_atomic_write_json,
    )

    deletion = asyncio.create_task(manager.delete_task(task_id))
    cancellation_barrier = asyncio.Event()
    try:
        await asyncio.wait_for(projection_write_entered.wait(), timeout=1)
        deletion.cancel()
        loop.call_soon(cancellation_barrier.set)
        await asyncio.wait_for(cancellation_barrier.wait(), timeout=1)
        cancellation_propagated_early = deletion.done()

        retry = asyncio.create_task(manager.delete_task(task_id))
        if cancellation_propagated_early:
            with pytest.raises(asyncio.CancelledError):
                await deletion
            await asyncio.wait_for(retry, timeout=1)
            assert not task_dir.exists()
        else:
            assert manager._admission_lock.locked()
            assert manager._task_locks[task_id].locked()
            assert repository._task_locks[task_id].locked()
            repeated_cancellation_barrier = asyncio.Event()
            deletion.cancel()
            loop.call_soon(repeated_cancellation_barrier.set)
            await asyncio.wait_for(repeated_cancellation_barrier.wait(), timeout=1)
            assert not deletion.done()

        release_projection_write.set()
        await asyncio.wait_for(projection_write_finished.wait(), timeout=1)
        deletion_result, retry_result = await asyncio.gather(
            deletion,
            retry,
            return_exceptions=True,
        )

        assert not task_dir.exists(), (
            "cancelled deletion released manager locks before its snapshot "
            "projection drained"
        )
        assert not snapshot_path.exists()
        assert not cancellation_propagated_early
        assert isinstance(deletion_result, asyncio.CancelledError)
        assert isinstance(retry_result, LookupError)
    finally:
        release_projection_write.set()
        if deletion is not None:
            await asyncio.gather(deletion, return_exceptions=True)
        if retry is not None:
            await asyncio.gather(retry, return_exceptions=True)
        await manager.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "status",
    [
        RunStatus.QUEUED,
        RunStatus.RUNNING,
        RunStatus.FINALIZING,
        RunStatus.CANCEL_REQUESTED,
    ],
)
async def test_manager_rejects_deletion_of_each_active_status(
    tmp_path,
    status,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")

    async def run(_execution) -> None:
        return None

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    task_id = f"task_keep_{status.value}"
    expected = snapshot_with_status(task_id, status)
    await repository.save_snapshot(expected)
    try:
        with pytest.raises(manager_module.TaskDeletionConflictError):
            await manager.delete_task(task_id)

        stored = await repository.get_snapshot(task_id)
        assert stored is not None
        assert stored.task.status is status
        assert (repository.tasks_dir / task_id).is_dir()
        assert await repository.find_request(f"req_{task_id}") == TaskRunAccepted(
            request_id=f"req_{task_id}",
            task_id=task_id,
            run_id=f"run_{task_id}",
        )
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_manager_delete_fails_closed_for_inconsistent_terminal_snapshot(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")

    async def run(_execution) -> None:
        return None

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    terminal_with_active_id = snapshot_with_status(
        "task_terminal_active_id",
        RunStatus.COMPLETED,
    )
    terminal_with_active_id = terminal_with_active_id.model_copy(
        update={
            "task": terminal_with_active_id.task.model_copy(
                update={"active_run_id": "run_task_terminal_active_id"}
            )
        }
    )
    terminal_with_active_run = snapshot_with_status(
        "task_terminal_active_run",
        RunStatus.COMPLETED,
    )
    terminal_with_active_run = terminal_with_active_run.model_copy(
        update={
            "runs": [
                terminal_with_active_run.runs[0].model_copy(
                    update={
                        "status": RunStatus.RUNNING,
                        "finished_at": None,
                    }
                )
            ]
        }
    )
    await repository.save_snapshot(terminal_with_active_id)
    await repository.save_snapshot(terminal_with_active_run)
    try:
        for task_id in ("task_terminal_active_id", "task_terminal_active_run"):
            with pytest.raises(manager_module.TaskDeletionConflictError):
                await manager.delete_task(task_id)
            assert (repository.tasks_dir / task_id).is_dir()
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_continuation_wins_before_delete_and_delete_returns_conflict(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    continuation_started = asyncio.Event()
    release_continuation = asyncio.Event()

    async def run(_execution) -> None:
        continuation_started.set()
        await release_continuation.wait()

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    task_id = "task_continue_wins"
    await repository.save_snapshot(snapshot_with_status(task_id, RunStatus.COMPLETED))
    try:
        await manager.submit_run(
            task_id,
            StartRunRequest(request_id="req_continue_wins", input="continue"),
        )
        await asyncio.wait_for(continuation_started.wait(), timeout=1)

        with pytest.raises(manager_module.TaskDeletionConflictError):
            await manager.delete_task(task_id)
        assert (repository.tasks_dir / task_id).is_dir()
    finally:
        release_continuation.set()
        await manager.wait_until_idle()
        await manager.close()


@pytest.mark.asyncio
async def test_delete_wins_before_continuation_and_continuation_gets_not_found(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")

    async def run(_execution) -> None:
        return None

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    task_id = "task_delete_wins"
    await repository.save_snapshot(snapshot_with_status(task_id, RunStatus.COMPLETED))
    delete_entered = asyncio.Event()
    release_delete = asyncio.Event()
    real_delete = repository.delete_task

    async def blocked_delete(deleted_task_id: str) -> None:
        delete_entered.set()
        await release_delete.wait()
        await real_delete(deleted_task_id)

    monkeypatch.setattr(repository, "delete_task", blocked_delete)
    deletion = asyncio.create_task(manager.delete_task(task_id))
    continuation = None
    try:
        await asyncio.wait_for(delete_entered.wait(), timeout=1)
        continuation = asyncio.create_task(
            manager.submit_run(
                task_id,
                StartRunRequest(
                    request_id="req_after_delete",
                    input="continue",
                ),
            )
        )
        await asyncio.sleep(0.05)
        assert not continuation.done()

        release_delete.set()
        await asyncio.wait_for(deletion, timeout=1)
        with pytest.raises(LookupError):
            await asyncio.wait_for(continuation, timeout=1)
    finally:
        release_delete.set()
        await asyncio.gather(deletion, return_exceptions=True)
        if continuation is not None:
            await asyncio.gather(continuation, return_exceptions=True)
        await manager.close()


@pytest.mark.asyncio
async def test_delete_rejects_queued_run_then_succeeds_after_cancellation(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    blocker_started = asyncio.Event()
    release_blocker = asyncio.Event()

    async def run(execution) -> None:
        if execution.task_id == "task_delete_blocker":
            blocker_started.set()
            await release_blocker.wait()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
    )
    await manager.start()
    for task_id in ("task_delete_blocker", "task_cancel_then_delete"):
        await repository.save_snapshot(
            snapshot_with_status(task_id, RunStatus.COMPLETED)
        )
    try:
        await manager.submit_run(
            "task_delete_blocker",
            StartRunRequest(request_id="req_blocker", input="block"),
        )
        await asyncio.wait_for(blocker_started.wait(), timeout=1)
        queued = await manager.submit_run(
            "task_cancel_then_delete",
            StartRunRequest(request_id="req_cancel_then_delete", input="queue"),
        )

        with pytest.raises(manager_module.TaskDeletionConflictError):
            await manager.delete_task(queued.task_id)
        cancelled = await manager.cancel_run(queued.task_id, queued.run_id)
        assert cancelled.task.status is RunStatus.CANCELLED

        await manager.delete_task(queued.task_id)
        assert await repository.get_snapshot(queued.task_id) is None
    finally:
        release_blocker.set()
        await manager.wait_until_idle()
        await manager.close()


@pytest.mark.asyncio
async def test_concurrent_duplicate_deletes_have_one_success_and_one_not_found(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")

    async def run(_execution) -> None:
        return None

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    task_id = "task_delete_twice"
    await repository.save_snapshot(snapshot_with_status(task_id, RunStatus.COMPLETED))
    try:
        results = await asyncio.gather(
            manager.delete_task(task_id),
            manager.delete_task(task_id),
            return_exceptions=True,
        )

        assert sum(result is None for result in results) == 1
        errors = [result for result in results if isinstance(result, BaseException)]
        assert len(errors) == 1
        assert isinstance(errors[0], LookupError)
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_deleted_request_id_can_create_a_new_authoritative_task(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")

    async def run(_execution) -> None:
        return None

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    task_id = "task_request_reuse"
    request_id = f"req_{task_id}"
    await repository.save_snapshot(snapshot_with_status(task_id, RunStatus.COMPLETED))
    try:
        await manager.delete_task(task_id)
        replacement = await manager.create_task(
            StartTaskRequest(request_id=request_id, input="new request")
        )
        await manager.wait_until_idle()

        assert replacement.task_id != task_id
        assert await repository.find_request(request_id) == replacement
        assert await repository.get_snapshot(replacement.task_id) is not None
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_concurrent_duplicate_create_admits_one_authoritative_task(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    executor_started = asyncio.Event()
    release_executor = asyncio.Event()

    async def run(execution) -> None:
        executor_started.set()
        await release_executor.wait()

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    request = StartTaskRequest(
        request_id="req_create_same",
        input="create exactly once",
        databases=["geo"],
    )
    callers_ready = 0
    callers_lock = asyncio.Lock()
    both_ready = asyncio.Event()

    async def create_after_barrier():
        nonlocal callers_ready
        async with callers_lock:
            callers_ready += 1
            if callers_ready == 2:
                both_ready.set()
        await both_ready.wait()
        return await manager.create_task(request)

    try:
        first, duplicate = await asyncio.gather(
            create_after_barrier(),
            create_after_barrier(),
        )
        await asyncio.wait_for(executor_started.wait(), timeout=1)

        assert duplicate == first
        snapshot = await repository.get_snapshot(first.task_id)
        assert snapshot is not None
        assert len(snapshot.runs) == 1
        assert snapshot.runs[0].run_id == first.run_id
        assert await repository.find_request(request.request_id) == first
        events = await repository.list_events(first.task_id)
        assert sum(isinstance(event.payload, RunQueuedPayload) for event in events) == 1
        task_directories = [
            path for path in repository.tasks_dir.iterdir() if path.is_dir()
        ]
        assert task_directories == [repository.tasks_dir / first.task_id]
    finally:
        release_executor.set()
        await manager.close()


@pytest.mark.asyncio
async def test_create_task_queue_full_leaves_no_orphan_task_or_request(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    active_started = asyncio.Event()
    release_active = asyncio.Event()

    async def run(execution) -> None:
        if execution.input == "active":
            active_started.set()
            await release_active.wait()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
        max_queued_runs=1,
    )
    await manager.start()
    try:
        await manager.create_task(
            StartTaskRequest(request_id="req_create_active", input="active")
        )
        await asyncio.wait_for(active_started.wait(), timeout=1)
        await manager.create_task(
            StartTaskRequest(request_id="req_create_waiting", input="waiting")
        )

        with pytest.raises(manager_module.RunQueueFullError):
            await manager.create_task(
                StartTaskRequest(request_id="req_create_rejected", input="rejected")
            )

        page = await repository.list_tasks()
        assert len(page.tasks) == 2
        assert await repository.find_request("req_create_rejected") is None
        assert (
            len([path for path in repository.tasks_dir.iterdir() if path.is_dir()]) == 2
        )
    finally:
        release_active.set()
        await manager.close()


@pytest.mark.asyncio
async def test_create_task_snapshot_index_failure_recovers_before_restart_retry(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    output_dir = tmp_path / "output"
    task_ids = iter(
        [
            "task_snapshot_projection_failed",
            "task_snapshot_projection_retry",
        ]
    )
    run_ids = iter(
        [
            "run_snapshot_projection_failed",
            "run_snapshot_projection_retry",
        ]
    )
    monkeypatch.setattr(manager_module, "generate_task_id", lambda: next(task_ids))
    monkeypatch.setattr(manager_module, "generate_run_id", lambda: next(run_ids))
    executor_started = asyncio.Event()
    release_executor = asyncio.Event()

    async def run(_execution) -> None:
        executor_started.set()
        await release_executor.wait()

    repository = TaskRepository(output_dir)
    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
    )
    await manager.start()
    await manager._semaphore.acquire()
    semaphore_held = True
    real_upsert_snapshot = repository.index.upsert_snapshot
    failed_once = False

    async def fail_initial_projection(snapshot) -> None:
        nonlocal failed_once
        if snapshot.task.latest_sequence == 0 and not failed_once:
            failed_once = True
            raise OSError("simulated initial snapshot index failure")
        await real_upsert_snapshot(snapshot)

    monkeypatch.setattr(repository.index, "upsert_snapshot", fail_initial_projection)
    request = StartTaskRequest(
        request_id="req_snapshot_projection_failure",
        input="retry after initial projection failure",
    )
    try:
        accepted = await manager.create_task(request)
    finally:
        await manager.close()
        if semaphore_held:
            manager._semaphore.release()
            semaphore_held = False

    reopened = TaskRepository(output_dir)
    restarted = manager_module.TaskManager(
        reopened,
        run_executor=run,
        max_active_runs=1,
    )
    await restarted._semaphore.acquire()
    restarted_semaphore_held = True
    await restarted.start()
    try:
        retried = await restarted.create_task(request)

        assert accepted.task_id == "task_snapshot_projection_failed"
        assert accepted.run_id == "run_snapshot_projection_failed"
        assert retried == accepted
        assert await reopened.find_request(request.request_id) == accepted
        page = await reopened.list_tasks()
        assert [task.task_id for task in page.tasks] == [accepted.task_id]
        assert (reopened.tasks_dir / accepted.task_id).exists()

        restarted._semaphore.release()
        restarted_semaphore_held = False
        await asyncio.wait_for(executor_started.wait(), timeout=1)
    finally:
        release_executor.set()
        await restarted.close()
        if restarted_semaphore_held:
            restarted._semaphore.release()


@pytest.mark.asyncio
async def test_create_task_recovers_durable_first_event_after_index_failure(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    output_dir = tmp_path / "output"
    monkeypatch.setattr(
        manager_module,
        "generate_task_id",
        lambda: "task_first_event_projection",
    )
    monkeypatch.setattr(
        manager_module,
        "generate_run_id",
        lambda: "run_first_event_projection",
    )

    async def run(_execution) -> None:
        raise AssertionError("recovered queued run must remain gated")

    repository = TaskRepository(output_dir)
    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
    )
    await manager.start()
    await manager._semaphore.acquire()
    semaphore_held = True
    real_upsert_snapshot = repository.index.upsert_snapshot
    failed_once = False

    async def fail_first_event_projection(snapshot) -> None:
        nonlocal failed_once
        if snapshot.task.latest_sequence == 1 and not failed_once:
            failed_once = True
            raise OSError("simulated first event index failure")
        await real_upsert_snapshot(snapshot)

    monkeypatch.setattr(
        repository.index,
        "upsert_snapshot",
        fail_first_event_projection,
    )
    request = StartTaskRequest(
        request_id="req_first_event_projection",
        input="recover the durable queued event",
    )
    try:
        accepted = await manager.create_task(request)
        assert await repository.find_request(request.request_id) == accepted
        snapshot = await repository.get_snapshot(accepted.task_id)
        assert snapshot is not None
        assert [run.run_id for run in snapshot.runs] == [accepted.run_id]
        assert len(await repository.list_events(accepted.task_id)) == 1
    finally:
        await manager.close()
        if semaphore_held:
            manager._semaphore.release()
            semaphore_held = False

    reopened = TaskRepository(output_dir)
    restarted = manager_module.TaskManager(
        reopened,
        run_executor=run,
        max_active_runs=1,
    )
    await restarted._semaphore.acquire()
    restarted_semaphore_held = True
    await restarted.start()
    try:
        retried = await restarted.create_task(request)

        assert retried == accepted
        assert await reopened.find_request(request.request_id) == accepted
        page = await reopened.list_tasks()
        assert [task.task_id for task in page.tasks] == [accepted.task_id]
        snapshot = await reopened.get_snapshot(accepted.task_id)
        assert snapshot is not None
        assert [run.run_id for run in snapshot.runs] == [accepted.run_id]
        assert len(await reopened.list_events(accepted.task_id)) == 1
    finally:
        await restarted.close()
        if restarted_semaphore_held:
            restarted._semaphore.release()


@pytest.mark.asyncio
async def test_create_task_seq0_projection_and_rollback_failure_keeps_one_task(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    output_dir = tmp_path / "output"
    task_ids = iter(["task_seq0_orphan", "task_seq0_retry"])
    run_ids = iter(["run_seq0_orphan", "run_seq0_retry"])
    monkeypatch.setattr(manager_module, "generate_task_id", lambda: next(task_ids))
    monkeypatch.setattr(manager_module, "generate_run_id", lambda: next(run_ids))

    async def run(_execution) -> None:
        raise AssertionError("queued run must remain gated")

    repository = TaskRepository(output_dir)
    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
    )
    await manager.start()
    await manager._semaphore.acquire()
    semaphore_held = True
    real_upsert_snapshot = repository.index.upsert_snapshot
    real_delete_task = repository.delete_task

    async def fail_initial_projection(snapshot) -> None:
        if (
            snapshot.task.task_id == "task_seq0_orphan"
            and snapshot.task.latest_sequence == 0
        ):
            raise OSError("simulated seq0 projection failure")
        await real_upsert_snapshot(snapshot)

    async def fail_initial_rollback(task_id: str) -> None:
        if task_id == "task_seq0_orphan":
            raise OSError("simulated seq0 rollback failure")
        await real_delete_task(task_id)

    monkeypatch.setattr(repository.index, "upsert_snapshot", fail_initial_projection)
    monkeypatch.setattr(repository, "delete_task", fail_initial_rollback)
    request = StartTaskRequest(
        request_id="req_seq0_projection_and_rollback_failure",
        input="preserve one authoritative admission",
    )
    first = None
    first_error: OSError | None = None
    try:
        try:
            first = await manager.create_task(request)
        except OSError as error:
            first_error = error

        monkeypatch.setattr(repository.index, "upsert_snapshot", real_upsert_snapshot)
        monkeypatch.setattr(repository, "delete_task", real_delete_task)
        retried = await manager.create_task(request)
    finally:
        await manager.close()
        if semaphore_held:
            manager._semaphore.release()
            semaphore_held = False

    reopened = TaskRepository(output_dir)
    restarted = manager_module.TaskManager(
        reopened,
        run_executor=run,
        max_active_runs=1,
    )
    await restarted._semaphore.acquire()
    restarted_semaphore_held = True
    await restarted.start()
    try:
        page = await reopened.list_tasks()
        assert [task.task_id for task in page.tasks] == [retried.task_id]
        assert first_error is None
        assert first == retried
        assert await reopened.find_request(request.request_id) == retried
        snapshot = await reopened.get_snapshot(retried.task_id)
        assert snapshot is not None
        assert [run.run_id for run in snapshot.runs] == [retried.run_id]
    finally:
        await restarted.close()
        if restarted_semaphore_held:
            restarted._semaphore.release()


@pytest.mark.asyncio
async def test_create_task_seq1_projection_and_rebuild_failure_keeps_one_task(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    output_dir = tmp_path / "output"
    task_ids = iter(["task_seq1_committed", "task_seq1_retry"])
    run_ids = iter(["run_seq1_committed", "run_seq1_retry"])
    monkeypatch.setattr(manager_module, "generate_task_id", lambda: next(task_ids))
    monkeypatch.setattr(manager_module, "generate_run_id", lambda: next(run_ids))

    async def run(_execution) -> None:
        raise AssertionError("queued run must remain gated")

    repository = TaskRepository(output_dir)
    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
    )
    await manager.start()
    await manager._semaphore.acquire()
    semaphore_held = True
    real_upsert_snapshot = repository.index.upsert_snapshot
    real_rebuild = repository.index.rebuild

    async def fail_first_event_projection(snapshot) -> None:
        if (
            snapshot.task.task_id == "task_seq1_committed"
            and snapshot.task.latest_sequence == 1
        ):
            raise OSError("simulated seq1 projection failure")
        await real_upsert_snapshot(snapshot)

    async def fail_rebuild() -> None:
        raise OSError("simulated seq1 rebuild failure")

    monkeypatch.setattr(
        repository.index,
        "upsert_snapshot",
        fail_first_event_projection,
    )
    monkeypatch.setattr(repository.index, "rebuild", fail_rebuild)
    request = StartTaskRequest(
        request_id="req_seq1_projection_and_rebuild_failure",
        input="preserve the committed queued run",
    )
    first = None
    first_error: OSError | None = None
    try:
        try:
            first = await manager.create_task(request)
        except OSError as error:
            first_error = error

        if first is not None:
            with pytest.raises(OSError, match="seq1 rebuild failure"):
                await manager.create_task(request)

        monkeypatch.setattr(repository.index, "upsert_snapshot", real_upsert_snapshot)
        monkeypatch.setattr(repository.index, "rebuild", real_rebuild)
        retried = await manager.create_task(request)
    finally:
        await manager.close()
        if semaphore_held:
            manager._semaphore.release()
            semaphore_held = False

    reopened = TaskRepository(output_dir)
    restarted = manager_module.TaskManager(
        reopened,
        run_executor=run,
        max_active_runs=1,
    )
    await restarted._semaphore.acquire()
    restarted_semaphore_held = True
    restart_error: ValueError | None = None
    try:
        try:
            await restarted.start()
        except ValueError as error:
            restart_error = error

        assert restart_error is None
        page = await reopened.list_tasks()
        assert [task.task_id for task in page.tasks] == [retried.task_id]
        assert first_error is None
        assert first == retried
        assert await reopened.find_request(request.request_id) == retried
        snapshot = await reopened.get_snapshot(retried.task_id)
        assert snapshot is not None
        assert [run.run_id for run in snapshot.runs] == [retried.run_id]
    finally:
        await restarted.close()
        if restarted_semaphore_held:
            restarted._semaphore.release()


@pytest.mark.asyncio
async def test_create_task_revalidates_constructed_fixture_request(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    monkeypatch.setattr(
        manager_module,
        "generate_task_id",
        lambda: "task_fixture_bypass",
    )

    async def run(execution) -> None:
        raise AssertionError("invalid fixture request must not execute")

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    request = StartTaskRequest.model_construct(
        request_id="req_fixture_bypass",
        input="fixture bypass",
        databases=["pubmed"],
        mode="fixture",
    )
    try:
        with pytest.raises(ValueError, match="exactly pubmed and geo"):
            await manager.create_task(request)

        assert (await repository.list_tasks()).tasks == []
        assert await repository.find_request(request.request_id) is None
        assert not (repository.tasks_dir / "task_fixture_bypass").exists()
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_create_task_cancellation_during_snapshot_write_drains_admission(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    snapshot_write_started = asyncio.Event()
    release_snapshot_write = asyncio.Event()
    executor_started = asyncio.Event()
    release_executor = asyncio.Event()
    task_ids = iter(["task_create_cancelled", "task_create_duplicate"])
    run_ids = iter(["run_create_cancelled", "run_create_duplicate"])
    monkeypatch.setattr(manager_module, "generate_task_id", lambda: next(task_ids))
    monkeypatch.setattr(manager_module, "generate_run_id", lambda: next(run_ids))

    async def run(execution) -> None:
        executor_started.set()
        await release_executor.wait()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
    )
    await manager.start()
    await manager._semaphore.acquire()
    semaphore_held = True
    real_save_snapshot = repository.save_snapshot

    async def blocked_save_snapshot(snapshot) -> None:
        if snapshot.task.task_id == "task_create_cancelled":
            snapshot_write_started.set()
            await release_snapshot_write.wait()
        await real_save_snapshot(snapshot)

    monkeypatch.setattr(repository, "save_snapshot", blocked_save_snapshot)
    request = StartTaskRequest(
        request_id="req_create_cancelled",
        input="complete cancelled create admission",
    )
    admission = asyncio.create_task(manager.create_task(request))
    try:
        await asyncio.wait_for(snapshot_write_started.wait(), timeout=1)
        admission.cancel()
        await asyncio.sleep(0)

        assert not admission.done()

        release_snapshot_write.set()
        with pytest.raises(asyncio.CancelledError):
            await admission

        retried = await manager.create_task(request)
        assert retried.task_id == "task_create_cancelled"
        assert retried.run_id == "run_create_cancelled"
        assert await repository.find_request(request.request_id) == retried

        page = await repository.list_tasks()
        assert [task.task_id for task in page.tasks] == [retried.task_id]
        snapshot = await repository.get_snapshot(retried.task_id)
        assert snapshot is not None
        assert len(snapshot.runs) == 1
        assert snapshot.runs[0].run_id == retried.run_id
        assert snapshot.runs[0].status is RunStatus.QUEUED
        events = await repository.list_events(retried.task_id)
        assert len(events) == 1
        assert isinstance(events[0].payload, RunQueuedPayload)

        manager._semaphore.release()
        semaphore_held = False
        await asyncio.wait_for(executor_started.wait(), timeout=1)
    finally:
        release_snapshot_write.set()
        release_executor.set()
        if semaphore_held:
            manager._semaphore.release()
        await asyncio.gather(admission, return_exceptions=True)
        await manager.close()


@pytest.mark.asyncio
async def test_create_task_cancellation_during_queued_projection_drains_admission(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    projection_started = asyncio.Event()
    release_projection = asyncio.Event()
    executor_started = asyncio.Event()
    release_executor = asyncio.Event()
    task_ids = iter(["task_projection_cancelled", "task_projection_duplicate"])
    run_ids = iter(["run_projection_cancelled", "run_projection_duplicate"])
    monkeypatch.setattr(manager_module, "generate_task_id", lambda: next(task_ids))
    monkeypatch.setattr(manager_module, "generate_run_id", lambda: next(run_ids))

    async def run(execution) -> None:
        executor_started.set()
        await release_executor.wait()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
    )
    await manager.start()
    await manager._semaphore.acquire()
    semaphore_held = True
    real_upsert_snapshot = repository.index.upsert_snapshot
    projection_blocked = False

    async def blocked_upsert_snapshot(snapshot) -> None:
        nonlocal projection_blocked
        if (
            snapshot.task.task_id == "task_projection_cancelled"
            and snapshot.task.latest_sequence == 1
            and not projection_blocked
        ):
            projection_blocked = True
            projection_started.set()
            await release_projection.wait()
        await real_upsert_snapshot(snapshot)

    monkeypatch.setattr(repository.index, "upsert_snapshot", blocked_upsert_snapshot)
    request = StartTaskRequest(
        request_id="req_projection_cancelled",
        input="complete projected create admission",
    )
    admission = asyncio.create_task(manager.create_task(request))
    try:
        await asyncio.wait_for(projection_started.wait(), timeout=1)
        admission.cancel()
        await asyncio.sleep(0)

        assert not admission.done()

        release_projection.set()
        with pytest.raises(asyncio.CancelledError):
            await admission

        retried = await manager.create_task(request)
        assert retried.task_id == "task_projection_cancelled"
        assert retried.run_id == "run_projection_cancelled"
        assert await repository.find_request(request.request_id) == retried

        page = await repository.list_tasks()
        assert [task.task_id for task in page.tasks] == [retried.task_id]
        snapshot = await repository.get_snapshot(retried.task_id)
        assert snapshot is not None
        assert len(snapshot.runs) == 1
        assert snapshot.runs[0].run_id == retried.run_id
        assert snapshot.runs[0].status is RunStatus.QUEUED
        events = await repository.list_events(retried.task_id)
        assert len(events) == 1
        assert isinstance(events[0].payload, RunQueuedPayload)

        manager._semaphore.release()
        semaphore_held = False
        await asyncio.wait_for(executor_started.wait(), timeout=1)
    finally:
        release_projection.set()
        release_executor.set()
        if semaphore_held:
            manager._semaphore.release()
        await asyncio.gather(admission, return_exceptions=True)
        await manager.close()


@pytest.mark.asyncio
async def test_submit_run_cancellation_during_request_registration_drains_admission(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    registration_started = asyncio.Event()
    release_registration = asyncio.Event()
    executor_started = asyncio.Event()
    release_executor = asyncio.Event()
    run_ids = iter(["run_submit_cancelled", "run_submit_duplicate"])
    monkeypatch.setattr(manager_module, "generate_run_id", lambda: next(run_ids))

    async def run(execution) -> None:
        executor_started.set()
        await release_executor.wait()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
    )
    await manager.start()
    await repository.save_snapshot(empty_snapshot("task_submit_cancelled"))
    await manager._semaphore.acquire()
    semaphore_held = True
    real_record_request = repository.record_request

    async def blocked_record_request(accepted):
        if accepted.request_id == "req_submit_cancelled":
            registration_started.set()
            await release_registration.wait()
        return await real_record_request(accepted)

    monkeypatch.setattr(repository, "record_request", blocked_record_request)
    request = StartRunRequest(
        request_id="req_submit_cancelled",
        input="complete cancelled continuation admission",
    )
    admission = asyncio.create_task(
        manager.submit_run("task_submit_cancelled", request)
    )
    try:
        await asyncio.wait_for(registration_started.wait(), timeout=1)
        admission.cancel()
        await asyncio.sleep(0)

        assert not admission.done()

        release_registration.set()
        with pytest.raises(asyncio.CancelledError):
            await admission

        retried = await manager.submit_run("task_submit_cancelled", request)
        assert retried.task_id == "task_submit_cancelled"
        assert retried.run_id == "run_submit_cancelled"
        assert await repository.find_request(request.request_id) == retried

        snapshot = await repository.get_snapshot(retried.task_id)
        assert snapshot is not None
        assert len(snapshot.runs) == 1
        assert snapshot.runs[0].run_id == retried.run_id
        assert snapshot.runs[0].status is RunStatus.QUEUED
        events = await repository.list_events(retried.task_id)
        assert len(events) == 1
        assert isinstance(events[0].payload, RunQueuedPayload)

        manager._semaphore.release()
        semaphore_held = False
        await asyncio.wait_for(executor_started.wait(), timeout=1)
    finally:
        release_registration.set()
        release_executor.set()
        if semaphore_held:
            manager._semaphore.release()
        await asyncio.gather(admission, return_exceptions=True)
        await manager.close()


@pytest.mark.asyncio
async def test_task_selection_is_persisted_and_reused_by_continuations(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    executions: list[object] = []

    async def run(execution) -> None:
        executions.append(execution)

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="req_selected_first",
                input="selected first",
                databases=["geo", "pubmed"],
            )
        )
        await manager.wait_until_idle()
        snapshot = await repository.get_snapshot(accepted.task_id)
        assert snapshot is not None
        assert snapshot.task.databases == ["geo", "pubmed"]

        await manager.submit_run(
            accepted.task_id,
            StartRunRequest(
                request_id="req_selected_continuation",
                input="continue selected",
            ),
        )
        await manager.wait_until_idle()

        assert [execution.mode for execution in executions] == [
            TaskMode.AGENT,
            TaskMode.AGENT,
        ]
        assert [execution.databases for execution in executions] == [
            ["geo", "pubmed"],
            ["geo", "pubmed"],
        ]
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_submit_run_rejects_fixture_task_with_typed_conflict(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")

    async def run(execution) -> None:
        return None

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        await repository.save_snapshot(
            empty_snapshot(
                "task_fixture_continuation",
                mode=TaskMode.FIXTURE,
                databases=["pubmed", "geo"],
            )
        )

        with pytest.raises(manager_module.FixtureTaskContinuationError):
            await manager.submit_run(
                "task_fixture_continuation",
                StartRunRequest(
                    request_id="req_fixture_continuation",
                    input="continue fixture",
                ),
            )
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_four_tasks_run_while_fifth_remains_durably_queued(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    release = {f"task_{number}": asyncio.Event() for number in range(5)}
    first_four_started = asyncio.Event()
    fifth_started = asyncio.Event()
    started: list[str] = []
    active: set[str] = set()
    maximum_active = 0

    async def run(execution) -> None:
        nonlocal maximum_active
        started.append(execution.task_id)
        active.add(execution.task_id)
        maximum_active = max(maximum_active, len(active))
        if len(started) == 4:
            first_four_started.set()
        if execution.task_id == "task_4":
            fifth_started.set()
        await release[execution.task_id].wait()
        active.remove(execution.task_id)

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=4,
        max_queued_runs=100,
    )
    await manager.start()
    try:
        for task_id in release:
            await repository.save_snapshot(empty_snapshot(task_id))
        accepted = [
            await manager.submit_run(
                task_id,
                StartRunRequest(
                    request_id=f"req_{number}",
                    input=f"question {number}",
                ),
            )
            for number, task_id in enumerate(release)
        ]

        await asyncio.wait_for(first_four_started.wait(), timeout=1)
        assert maximum_active == 4
        assert started == ["task_0", "task_1", "task_2", "task_3"]
        assert not fifth_started.is_set()
        queued = await repository.get_snapshot("task_4")
        assert queued is not None
        assert queued.runs[-1].run_id == accepted[-1].run_id
        assert queued.runs[-1].status is RunStatus.QUEUED

        release["task_0"].set()
        await asyncio.wait_for(fifth_started.wait(), timeout=1)
        assert started == [
            "task_0",
            "task_1",
            "task_2",
            "task_3",
            "task_4",
        ]
    finally:
        for gate in release.values():
            gate.set()
        await manager.close()


@pytest.mark.asyncio
async def test_second_active_run_in_same_task_is_rejected(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    started = asyncio.Event()
    release = asyncio.Event()

    async def run(execution) -> None:
        started.set()
        await release.wait()

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        await repository.save_snapshot(empty_snapshot("task_same"))
        first = await manager.submit_run(
            "task_same",
            StartRunRequest(request_id="req_first", input="first"),
        )
        await asyncio.wait_for(started.wait(), timeout=1)

        with pytest.raises(manager_module.TaskRunConflictError):
            await manager.submit_run(
                "task_same",
                StartRunRequest(request_id="req_second", input="second"),
            )

        snapshot = await repository.get_snapshot("task_same")
        assert snapshot is not None
        assert [run.run_id for run in snapshot.runs] == [first.run_id]
    finally:
        release.set()
        await manager.close()


@pytest.mark.asyncio
async def test_same_task_conflict_precedes_full_queue_error(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    active_started = asyncio.Event()
    release_active = asyncio.Event()

    async def run(execution) -> None:
        if execution.task_id == "task_active":
            active_started.set()
            await release_active.wait()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
        max_queued_runs=1,
    )
    await manager.start()
    try:
        for task_id in ("task_active", "task_waiting", "task_distinct"):
            await repository.save_snapshot(empty_snapshot(task_id))
        await manager.submit_run(
            "task_active",
            StartRunRequest(request_id="req_active", input="active"),
        )
        await asyncio.wait_for(active_started.wait(), timeout=1)
        await manager.submit_run(
            "task_waiting",
            StartRunRequest(request_id="req_waiting", input="waiting"),
        )

        with pytest.raises(manager_module.TaskRunConflictError):
            await manager.submit_run(
                "task_active",
                StartRunRequest(request_id="req_conflict", input="conflict"),
            )
        with pytest.raises(manager_module.RunQueueFullError):
            await manager.submit_run(
                "task_distinct",
                StartRunRequest(request_id="req_distinct", input="distinct"),
            )
    finally:
        release_active.set()
        await manager.close()


@pytest.mark.asyncio
async def test_queue_limit_rejects_excess_and_retains_fifo_order(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    queued_runs_finished = asyncio.Event()
    started: list[str] = []

    async def run(execution) -> None:
        started.append(execution.task_id)
        if execution.task_id == "task_0":
            first_started.set()
            await release_first.wait()
        if execution.task_id == "task_2":
            queued_runs_finished.set()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
        max_queued_runs=2,
    )
    await manager.start()
    try:
        for number in range(4):
            await repository.save_snapshot(empty_snapshot(f"task_{number}"))
        await manager.submit_run(
            "task_0",
            StartRunRequest(request_id="req_0", input="question 0"),
        )
        await asyncio.wait_for(first_started.wait(), timeout=1)
        for number in (1, 2):
            await manager.submit_run(
                f"task_{number}",
                StartRunRequest(
                    request_id=f"req_{number}",
                    input=f"question {number}",
                ),
            )

        with pytest.raises(manager_module.RunQueueFullError):
            await manager.submit_run(
                "task_3",
                StartRunRequest(request_id="req_3", input="question 3"),
            )
        rejected = await repository.get_snapshot("task_3")
        assert rejected is not None
        assert rejected.runs == []

        release_first.set()
        await asyncio.wait_for(queued_runs_finished.wait(), timeout=1)
        assert started == ["task_0", "task_1", "task_2"]
    finally:
        release_first.set()
        await manager.close()


@pytest.mark.asyncio
async def test_cancelled_waiter_releases_exactly_one_logical_queue_slot(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    active_started = asyncio.Event()
    release_active = asyncio.Event()
    next_waiter_started = asyncio.Event()
    release_next_waiter = asyncio.Event()
    executed: list[str] = []

    async def run(execution) -> None:
        executed.append(execution.task_id)
        if execution.task_id == "task_active":
            active_started.set()
            await release_active.wait()
        elif execution.task_id == "task_waiting_001":
            next_waiter_started.set()
            await release_next_waiter.wait()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
        max_queued_runs=100,
    )
    await manager.start()
    try:
        task_ids = (
            ["task_active"]
            + [f"task_waiting_{number:03d}" for number in range(100)]
            + [
                "task_replacement",
                "task_after_dequeue_one",
                "task_after_dequeue_two",
            ]
        )
        for task_id in task_ids:
            await repository.save_snapshot(empty_snapshot(task_id))

        await manager.submit_run(
            "task_active",
            StartRunRequest(request_id="req_active_100", input="active"),
        )
        await asyncio.wait_for(active_started.wait(), timeout=1)
        waiting = []
        for number in range(100):
            waiting.append(
                await manager.submit_run(
                    f"task_waiting_{number:03d}",
                    StartRunRequest(
                        request_id=f"req_waiting_{number:03d}",
                        input=f"waiting {number}",
                    ),
                )
            )

        await manager.cancel_run(
            "task_waiting_000",
            waiting[0].run_id,
        )
        await manager.submit_run(
            "task_replacement",
            StartRunRequest(request_id="req_replacement", input="replacement"),
        )

        release_active.set()
        await asyncio.wait_for(next_waiter_started.wait(), timeout=1)
        await manager.submit_run(
            "task_after_dequeue_one",
            StartRunRequest(request_id="req_after_one", input="after one"),
        )
        with pytest.raises(manager_module.RunQueueFullError):
            await manager.submit_run(
                "task_after_dequeue_two",
                StartRunRequest(request_id="req_after_two", input="after two"),
            )

        release_next_waiter.set()
        await manager.wait_until_idle()
        assert "task_waiting_000" not in executed
        assert "task_replacement" in executed
        assert "task_after_dequeue_one" in executed
    finally:
        release_active.set()
        release_next_waiter.set()
        await manager.close()


@pytest.mark.asyncio
async def test_cancel_replacement_churn_keeps_physical_fifo_bounded(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    active_started = asyncio.Event()
    release_active = asyncio.Event()

    async def run(execution) -> None:
        if execution.task_id == "task_churn_active":
            active_started.set()
            await release_active.wait()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
        max_queued_runs=3,
    )
    await manager.start()
    try:
        for task_id in (
            "task_churn_active",
            "task_churn_anchor_a",
            "task_churn_anchor_b",
            "task_churn_replace",
        ):
            await repository.save_snapshot(empty_snapshot(task_id))
        await manager.submit_run(
            "task_churn_active",
            StartRunRequest(request_id="req_churn_active", input="active"),
        )
        await asyncio.wait_for(active_started.wait(), timeout=1)
        for suffix in ("a", "b"):
            await manager.submit_run(
                f"task_churn_anchor_{suffix}",
                StartRunRequest(
                    request_id=f"req_churn_anchor_{suffix}",
                    input=f"anchor {suffix}",
                ),
            )
        current = await manager.submit_run(
            "task_churn_replace",
            StartRunRequest(request_id="req_churn_0", input="churn 0"),
        )

        for iteration in range(1, 11):
            await manager.cancel_run("task_churn_replace", current.run_id)
            current = await manager.submit_run(
                "task_churn_replace",
                StartRunRequest(
                    request_id=f"req_churn_{iteration}",
                    input=f"churn {iteration}",
                ),
            )
            assert manager._queue.qsize() <= manager.max_queued_runs
    finally:
        release_active.set()
        await manager.close()


@pytest.mark.asyncio
async def test_queued_cancellation_is_ordered_and_skips_executor(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    active_started = asyncio.Event()
    release_active = asyncio.Event()
    started: list[str] = []

    async def run(execution) -> None:
        started.append(execution.task_id)
        if execution.task_id == "task_active":
            active_started.set()
            await release_active.wait()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
    )
    await manager.start()
    try:
        for task_id in ("task_active", "task_queued"):
            await repository.save_snapshot(empty_snapshot(task_id))
        await manager.submit_run(
            "task_active",
            StartRunRequest(request_id="req_active", input="active"),
        )
        await asyncio.wait_for(active_started.wait(), timeout=1)
        queued = await manager.submit_run(
            "task_queued",
            StartRunRequest(request_id="req_queued", input="queued"),
        )

        cancelled = await manager.cancel_run(
            "task_queued",
            queued.run_id,
            reason="user requested",
        )
        assert cancelled.runs[-1].status is RunStatus.CANCELLED
        events = await repository.list_events("task_queued")
        assert isinstance(events[-2].payload, RunCancelRequestedPayload)
        assert isinstance(events[-1].payload, RunCancelledPayload)

        release_active.set()
        await manager.wait_until_idle()
        assert started == ["task_active"]
    finally:
        release_active.set()
        await manager.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "blocked_payload_type",
    [RunCancelRequestedPayload, RunCancelledPayload],
    ids=["cancel_requested", "cancelled"],
)
async def test_queued_cancelled_during_publish_still_removes_waiting_entry(
    tmp_path,
    monkeypatch,
    blocked_payload_type,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    hub = EventHub()
    active_started = asyncio.Event()
    release_active = asyncio.Event()
    cancelled_publish_entered = asyncio.Event()
    release_cancelled_publish = asyncio.Event()
    blocked_once = False

    async def run(execution) -> None:
        if execution.task_id == "task_publish_active":
            active_started.set()
            await release_active.wait()

    real_publish = hub.publish

    async def block_cancelled_publish(event) -> None:
        nonlocal blocked_once
        if isinstance(event.payload, blocked_payload_type) and not blocked_once:
            blocked_once = True
            cancelled_publish_entered.set()
            await release_cancelled_publish.wait()
        await real_publish(event)

    monkeypatch.setattr(hub, "publish", block_cancelled_publish)
    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
        max_queued_runs=1,
        event_hub=hub,
    )
    await manager.start()
    try:
        for task_id in (
            "task_publish_active",
            "task_publish_cancel",
            "task_publish_replacement",
        ):
            await repository.save_snapshot(empty_snapshot(task_id))
        await manager.submit_run(
            "task_publish_active",
            StartRunRequest(request_id="req_publish_active", input="active"),
        )
        await asyncio.wait_for(active_started.wait(), timeout=1)
        queued = await manager.submit_run(
            "task_publish_cancel",
            StartRunRequest(request_id="req_publish_cancel", input="cancel"),
        )

        cancellation = asyncio.create_task(
            manager.cancel_run("task_publish_cancel", queued.run_id)
        )
        await asyncio.wait_for(cancelled_publish_entered.wait(), timeout=1)
        cancellation.cancel()
        cancellation_delivery_barrier = asyncio.Event()
        asyncio.get_running_loop().call_soon(cancellation_delivery_barrier.set)
        await asyncio.wait_for(cancellation_delivery_barrier.wait(), timeout=1)
        assert not cancellation.done()
        release_cancelled_publish.set()
        with pytest.raises(asyncio.CancelledError):
            await cancellation

        cancelled = await repository.get_snapshot("task_publish_cancel")
        assert cancelled is not None
        assert cancelled.runs[-1].status in {
            RunStatus.CANCEL_REQUESTED,
            RunStatus.CANCELLED,
        }
        await manager.submit_run(
            "task_publish_replacement",
            StartRunRequest(request_id="req_publish_replacement", input="replacement"),
        )
        retried = await manager.cancel_run("task_publish_cancel", queued.run_id)
        assert retried.runs[-1].status is RunStatus.CANCELLED
        assert manager._queue.qsize() == 1
    finally:
        release_cancelled_publish.set()
        release_active.set()
        await manager.close()
        await hub.close()


@pytest.mark.asyncio
async def test_running_cancellation_signals_cancels_drains_then_persists(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    executor_started = asyncio.Event()
    stream_drained = asyncio.Event()
    execution_seen = None
    drained_events: list[str] = []

    class FakeStreamingResult:
        def __init__(self) -> None:
            self.cancel_calls: list[str] = []
            self.cancel_called = asyncio.Event()

        def cancel(self, mode: str) -> None:
            self.cancel_calls.append(mode)
            self.cancel_called.set()

        async def stream_events(self):
            await self.cancel_called.wait()
            yield "tail event"
            stream_drained.set()

    streaming_result = FakeStreamingResult()

    async def run(execution) -> None:
        nonlocal execution_seen
        execution_seen = execution
        execution.set_streaming_result(streaming_result)
        executor_started.set()
        async for event in streaming_result.stream_events():
            drained_events.append(event)

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        await repository.save_snapshot(empty_snapshot("task_running"))
        accepted = await manager.submit_run(
            "task_running",
            StartRunRequest(request_id="req_running", input="running"),
        )
        await asyncio.wait_for(executor_started.wait(), timeout=1)

        cancelled = await manager.cancel_run(
            "task_running",
            accepted.run_id,
            reason="user requested",
        )

        assert execution_seen is not None
        assert execution_seen.context.cancellation_requested.is_set()
        assert streaming_result.cancel_calls == ["after_turn"]
        assert stream_drained.is_set()
        assert drained_events == ["tail event"]
        assert cancelled.runs[-1].status is RunStatus.CANCELLED
        events = await repository.list_events("task_running")
        assert [event.payload.type.value for event in events] == [
            "run_queued",
            "run_started",
            "run_cancel_requested",
            "run_cancelled",
        ]
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_startup_recovers_queued_and_interrupts_in_flight_runs_once(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    output_dir = tmp_path / "output"
    seed = TaskRepository(output_dir)
    await seed.initialize()
    statuses = {
        "task_queued_first": [
            RunQueuedPayload(request_id="req_queued_first", input="queued first")
        ],
        "task_queued_second": [
            RunQueuedPayload(request_id="req_queued_second", input="queued second")
        ],
        "task_running": [
            RunQueuedPayload(request_id="req_running", input="running"),
            RunStartedPayload(),
        ],
        "task_finalizing": [
            RunQueuedPayload(request_id="req_finalizing", input="finalizing"),
            RunStartedPayload(),
            RunFinalizingPayload(),
        ],
        "task_cancelling": [
            RunQueuedPayload(request_id="req_cancelling", input="cancelling"),
            RunStartedPayload(),
            RunCancelRequestedPayload(reason="before restart"),
        ],
    }
    try:
        for task_id, payloads in statuses.items():
            await seed.save_snapshot(empty_snapshot(task_id))
            for sequence, payload in enumerate(payloads, start=1):
                await seed.append_event(
                    build_event(
                        task_id=task_id,
                        run_id=f"run_{task_id}",
                        sequence=sequence,
                        payload=payload,
                    )
                )
    finally:
        await seed.close()

    queued_executed = asyncio.Event()
    executed: list[str] = []

    async def run(execution) -> None:
        executed.append(execution.task_id)
        if len(executed) == 2:
            queued_executed.set()

    repository = TaskRepository(output_dir)
    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
    )
    await manager.start()
    try:
        await asyncio.wait_for(queued_executed.wait(), timeout=1)
        await manager.wait_until_idle()
        assert executed == ["task_queued_first", "task_queued_second"]
        for task_id in (
            "task_running",
            "task_finalizing",
            "task_cancelling",
        ):
            recovered = await repository.get_snapshot(task_id)
            assert recovered is not None
            assert recovered.runs[-1].status is RunStatus.INTERRUPTED
            events = await repository.list_events(task_id)
            assert isinstance(events[-1].payload, RunInterruptedPayload)
    finally:
        await manager.close()

    unexpected: list[str] = []

    async def must_not_run(execution) -> None:
        unexpected.append(execution.task_id)

    reopened_repository = TaskRepository(output_dir)
    reopened = manager_module.TaskManager(
        reopened_repository,
        run_executor=must_not_run,
    )
    await reopened.start()
    try:
        await reopened.wait_until_idle()
        assert unexpected == []
        for task_id in (
            "task_running",
            "task_finalizing",
            "task_cancelling",
        ):
            events = await reopened_repository.list_events(task_id)
            assert (
                sum(
                    isinstance(event.payload, RunInterruptedPayload) for event in events
                )
                == 1
            )
    finally:
        await reopened.close()


@pytest.mark.asyncio
async def test_fastapi_lifespan_owns_runtime_executors_and_manager(tmp_path) -> None:
    main_module = importlib.import_module("app.main")
    runner_module = importlib.import_module("app.agent_loop.runner")
    configured = Settings(
        output_dir=str(tmp_path / "output"),
        runtime_max_active_runs=2,
        runtime_sync_worker_threads=3,
        runtime_run_queue_size=5,
        runtime_subscriber_queue_size=7,
    )
    application = main_module.create_app(configured)

    async with application.router.lifespan_context(application):
        manager = application.state.task_manager
        assert manager.repository is application.state.task_repository
        assert isinstance(manager.run_executor, main_module.ModeDispatchRunExecutor)
        assert isinstance(
            manager.run_executor.agent_executor,
            runner_module.AgentRunExecutor,
        )
        assert manager.event_hub is application.state.event_hub
        assert manager.max_active_runs == 2
        assert manager.max_queued_runs == 5
        assert manager.event_hub.subscriber_queue_size == 7
        assert isinstance(application.state.sync_executor, ThreadPoolExecutor)
        assert application.state.sync_executor._max_workers == 3
        assert manager.repository.index.executor is application.state.index_executor
        assert application.state.index_executor._executor._max_workers == 1

    assert application.state.sync_executor._shutdown
    assert application.state.index_executor._closed


@pytest.mark.asyncio
async def test_manager_publishes_durable_lifecycle_events_in_order(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    hub = EventHub()
    subscription = await hub.subscribe(task_ids={"task_events"})

    async def run(execution) -> None:
        return None

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        event_hub=hub,
    )
    await manager.start()
    try:
        await repository.save_snapshot(empty_snapshot("task_events"))
        await manager.submit_run(
            "task_events",
            StartRunRequest(request_id="req_events", input="events"),
        )
        received = [
            await asyncio.wait_for(subscription.receive(), timeout=1) for _ in range(4)
        ]
        persisted = await repository.list_events("task_events")

        assert [event.sequence for event in received] == [1, 2, 3, 4]
        assert [event.event_id for event in received] == [
            event.event_id for event in persisted
        ]
    finally:
        await manager.close()
        await hub.close()


@pytest.mark.asyncio
async def test_event_reconciliation_requires_exact_envelope_identity() -> None:
    expected = build_event(
        task_id="task_exact_event",
        run_id="run_exact_event",
        sequence=1,
        timestamp=NOW,
        payload=AssistantDeltaPayload(delta="same payload"),
    )
    persisted_exact = type(expected).model_validate_json(expected.model_dump_json())
    assert persisted_exact is not expected

    class Repository:
        events = [persisted_exact]

        async def list_events(self, *args, **kwargs):
            return self.events

    async def run(execution) -> None:
        return None

    repository = Repository()
    manager = importlib.import_module("app.runtime.manager").TaskManager(
        repository,
        run_executor=run,
    )

    assert await manager._event_is_durable(expected) is True

    mismatches = {
        "task_id": expected.model_copy(update={"task_id": "task_other"}),
        "run_id": expected.model_copy(update={"run_id": "run_other"}),
        "sequence": expected.model_copy(update={"sequence": 2}),
        "timestamp": expected.model_copy(
            update={"timestamp": NOW + timedelta(seconds=1)}
        ),
        "payload": expected.model_copy(
            update={"payload": AssistantDeltaPayload(delta="different payload")}
        ),
    }
    for field, persisted in mismatches.items():
        assert persisted.event_id == expected.event_id
        repository.events = [persisted]
        assert await manager._event_is_durable(expected) is False, field


@pytest.mark.asyncio
async def test_executor_cancelled_error_after_cancel_keeps_single_worker_alive(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    runner_module = importlib.import_module("app.agent_loop.runner")
    repository = TaskRepository(tmp_path / "output")
    first_started = asyncio.Event()
    first_cancelled = asyncio.Event()
    second_executed = asyncio.Event()
    models: list[object] = []

    class CancelledStreamingResult:
        def cancel(self, mode: str) -> None:
            assert mode == "after_turn"
            first_cancelled.set()

        async def stream_events(self):
            await first_cancelled.wait()
            raise asyncio.CancelledError
            if False:
                yield None

    class CompletedStreamingResult:
        def cancel(self, mode: str) -> None:
            raise AssertionError("completed Run must not be cancelled")

        async def stream_events(self):
            second_executed.set()
            if False:
                yield None

    class NoopCompactor:
        async def prepare(self, task_id, **kwargs):
            return SimpleNamespace(session=kwargs["session"])

    streaming_result = CancelledStreamingResult()

    def build_agent(databases=None):
        model = SimpleNamespace(close=AsyncMock())
        models.append(model)
        return SimpleNamespace(agent=object(), skill_names=(), model=model)

    def run_streamed(agent, input, **kwargs):
        if input == "first":
            first_started.set()
            return streaming_result
        return CompletedStreamingResult()

    monkeypatch.setattr(runner_module, "build_agent", build_agent)
    monkeypatch.setattr(runner_module.Runner, "run_streamed", run_streamed)
    executor = runner_module.AgentRunExecutor(
        repository,
        compactor=NoopCompactor(),
    )

    manager = manager_module.TaskManager(
        repository,
        run_executor=executor,
        max_active_runs=1,
    )
    await manager.start()
    try:
        for task_id in ("task_executor_cancelled", "task_after_cancel"):
            await repository.save_snapshot(empty_snapshot(task_id))
        first = await manager.submit_run(
            "task_executor_cancelled",
            StartRunRequest(request_id="req_executor_cancelled", input="first"),
        )
        await asyncio.wait_for(first_started.wait(), timeout=1)
        await manager.submit_run(
            "task_after_cancel",
            StartRunRequest(request_id="req_after_cancel", input="second"),
        )

        cancelled = await asyncio.wait_for(
            manager.cancel_run("task_executor_cancelled", first.run_id),
            timeout=1,
        )
        await asyncio.wait_for(second_executed.wait(), timeout=1)
        await manager.wait_until_idle()

        completed = await repository.get_snapshot("task_after_cancel")
        assert cancelled.runs[-1].status is RunStatus.CANCELLED
        assert completed is not None
        assert completed.runs[-1].status is RunStatus.COMPLETED
        assert len(manager._workers) == 1
        assert not manager._workers[0].done()
        assert len(models) == 2
        for model in models:
            model.close.assert_awaited_once_with()
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_unrequested_executor_cancelled_error_fails_run_and_keeps_worker(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    second_executed = asyncio.Event()

    async def run(execution) -> None:
        if execution.task_id == "task_unrequested_cancelled_error":
            first_started.set()
            await release_first.wait()
            raise asyncio.CancelledError
        second_executed.set()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
    )
    await manager.start()
    try:
        for task_id in (
            "task_unrequested_cancelled_error",
            "task_after_executor_error",
        ):
            await repository.save_snapshot(empty_snapshot(task_id))
        await manager.submit_run(
            "task_unrequested_cancelled_error",
            StartRunRequest(request_id="req_unrequested_cancel", input="first"),
        )
        await asyncio.wait_for(first_started.wait(), timeout=1)
        await manager.submit_run(
            "task_after_executor_error",
            StartRunRequest(request_id="req_after_executor_error", input="second"),
        )

        release_first.set()
        await asyncio.wait_for(second_executed.wait(), timeout=1)
        await manager.wait_until_idle()

        failed = await repository.get_snapshot("task_unrequested_cancelled_error")
        completed = await repository.get_snapshot("task_after_executor_error")
        assert failed is not None
        assert failed.runs[-1].status is RunStatus.FAILED
        assert failed.runs[-1].error == "CancelledError"
        assert completed is not None
        assert completed.runs[-1].status is RunStatus.COMPLETED
        assert len(manager._workers) == 1
        assert not manager._workers[0].done()
    finally:
        release_first.set()
        await manager.close()


@pytest.mark.asyncio
async def test_duplicate_request_returns_authoritative_active_run(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    started = asyncio.Event()
    release = asyncio.Event()

    async def run(execution) -> None:
        started.set()
        await release.wait()

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        await repository.save_snapshot(empty_snapshot("task_idempotent"))
        request = StartRunRequest(request_id="req_same", input="question")
        first = await manager.submit_run("task_idempotent", request)
        await asyncio.wait_for(started.wait(), timeout=1)

        duplicate = await manager.submit_run("task_idempotent", request)

        assert duplicate == first
        snapshot = await repository.get_snapshot("task_idempotent")
        assert snapshot is not None
        assert [run.run_id for run in snapshot.runs] == [first.run_id]
    finally:
        release.set()
        await manager.close()


@pytest.mark.asyncio
async def test_running_cancel_waits_for_late_stream_and_retry_is_idempotent(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    hub = EventHub()
    subscription = await hub.subscribe(task_ids={"task_cancel_race"})
    executor_entered = asyncio.Event()
    allow_stream_attach = asyncio.Event()
    release_stream = asyncio.Event()
    execution_seen = None

    class FakeStreamingResult:
        def __init__(self) -> None:
            self.cancel_calls: list[str] = []
            self.cancel_called = asyncio.Event()

        def cancel(self, mode: str) -> None:
            self.cancel_calls.append(mode)
            self.cancel_called.set()

        async def stream_events(self):
            await self.cancel_called.wait()
            await release_stream.wait()
            if False:
                yield None

    streaming_result = FakeStreamingResult()

    async def run(execution) -> None:
        nonlocal execution_seen
        execution_seen = execution
        executor_entered.set()
        await allow_stream_attach.wait()
        execution.set_streaming_result(streaming_result)
        async for _ in streaming_result.stream_events():
            pass

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        event_hub=hub,
    )
    await manager.start()
    try:
        await repository.save_snapshot(empty_snapshot("task_cancel_race"))
        accepted = await manager.submit_run(
            "task_cancel_race",
            StartRunRequest(request_id="req_cancel_race", input="race"),
        )
        await asyncio.wait_for(executor_entered.wait(), timeout=1)
        await asyncio.wait_for(subscription.receive(), timeout=1)
        await asyncio.wait_for(subscription.receive(), timeout=1)

        first_cancel = asyncio.create_task(
            manager.cancel_run("task_cancel_race", accepted.run_id)
        )
        cancel_requested = await asyncio.wait_for(subscription.receive(), timeout=1)
        assert isinstance(cancel_requested.payload, RunCancelRequestedPayload)
        assert execution_seen is not None
        assert execution_seen.context.cancellation_requested.is_set()

        retry_cancel = asyncio.create_task(
            manager.cancel_run("task_cancel_race", accepted.run_id)
        )
        allow_stream_attach.set()
        await asyncio.wait_for(streaming_result.cancel_called.wait(), timeout=1)
        release_stream.set()
        first_result, retry_result = await asyncio.gather(
            first_cancel,
            retry_cancel,
        )

        assert first_result == retry_result
        assert streaming_result.cancel_calls == ["after_turn"]
        events = await repository.list_events("task_cancel_race")
        assert (
            sum(isinstance(event.payload, RunCancelledPayload) for event in events) == 1
        )
    finally:
        allow_stream_attach.set()
        release_stream.set()
        await manager.close()
        await hub.close()


@pytest.mark.asyncio
async def test_cancel_retry_survives_drained_terminal_append_failure(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    executor_started = asyncio.Event()

    class FakeStreamingResult:
        def __init__(self) -> None:
            self.cancel_calls: list[str] = []
            self.cancel_called = asyncio.Event()

        def cancel(self, mode: str) -> None:
            self.cancel_calls.append(mode)
            self.cancel_called.set()

        async def stream_events(self):
            await self.cancel_called.wait()
            if False:
                yield None

    streaming_result = FakeStreamingResult()

    async def run(execution) -> None:
        execution.set_streaming_result(streaming_result)
        executor_started.set()
        async for _ in streaming_result.stream_events():
            pass

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        await repository.save_snapshot(empty_snapshot("task_cancel_append"))
        accepted = await manager.submit_run(
            "task_cancel_append",
            StartRunRequest(request_id="req_cancel_append", input="cancel"),
        )
        await asyncio.wait_for(executor_started.wait(), timeout=1)
        real_append_event = repository.append_event
        terminal_append_entered = asyncio.Event()
        release_terminal_failure = asyncio.Event()
        failed_once = False

        async def fail_first_terminal_append(event):
            nonlocal failed_once
            if isinstance(event.payload, RunCancelledPayload) and not failed_once:
                failed_once = True
                terminal_append_entered.set()
                await release_terminal_failure.wait()
                raise OSError("simulated terminal append failure")
            return await real_append_event(event)

        monkeypatch.setattr(repository, "append_event", fail_first_terminal_append)
        first_cancel = asyncio.create_task(
            manager.cancel_run("task_cancel_append", accepted.run_id)
        )
        await asyncio.wait_for(terminal_append_entered.wait(), timeout=1)
        retry_cancel = asyncio.create_task(
            manager.cancel_run("task_cancel_append", accepted.run_id)
        )
        release_terminal_failure.set()

        with pytest.raises(OSError, match="terminal append failure"):
            await first_cancel
        cancelled = await retry_cancel

        assert cancelled.runs[-1].status is RunStatus.CANCELLED
        assert streaming_result.cancel_calls == ["after_turn"]
        events = await repository.list_events("task_cancel_append")
        assert (
            sum(isinstance(event.payload, RunCancelledPayload) for event in events) == 1
        )
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_concurrent_terminal_retry_clears_retained_coordination(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    hub = EventHub()
    executor_started = asyncio.Event()
    release_stream = asyncio.Event()
    both_waiting_for_drain = asyncio.Event()
    terminal_publish_entered = asyncio.Event()
    terminal_publisher = None
    drain_waiters = 0

    class FakeStreamingResult:
        def __init__(self) -> None:
            self.cancel_calls: list[str] = []
            self.cancel_called = asyncio.Event()

        def cancel(self, mode: str) -> None:
            self.cancel_calls.append(mode)
            self.cancel_called.set()

        async def stream_events(self):
            await self.cancel_called.wait()
            await release_stream.wait()
            if False:
                yield None

    streaming_result = FakeStreamingResult()

    async def run(execution) -> None:
        execution.set_streaming_result(streaming_result)
        executor_started.set()
        async for _ in streaming_result.stream_events():
            pass

    real_wait_until_drained = manager_module.RunExecution.wait_until_drained

    async def count_drain_waiters(execution) -> None:
        nonlocal drain_waiters
        drain_waiters += 1
        if drain_waiters == 2:
            both_waiting_for_drain.set()
        await real_wait_until_drained(execution)

    monkeypatch.setattr(
        manager_module.RunExecution,
        "wait_until_drained",
        count_drain_waiters,
    )
    real_publish = hub.publish

    async def block_terminal_publish(event) -> None:
        nonlocal terminal_publisher
        if isinstance(event.payload, RunCancelledPayload):
            terminal_publisher = asyncio.current_task()
            terminal_publish_entered.set()
            await asyncio.Event().wait()
        await real_publish(event)

    monkeypatch.setattr(hub, "publish", block_terminal_publish)
    manager = manager_module.TaskManager(repository, run_executor=run, event_hub=hub)
    await manager.start()
    try:
        await repository.save_snapshot(empty_snapshot("task_terminal_retry"))
        accepted = await manager.submit_run(
            "task_terminal_retry",
            StartRunRequest(request_id="req_terminal_retry", input="cancel"),
        )
        await asyncio.wait_for(executor_started.wait(), timeout=1)
        cancellations = [
            asyncio.create_task(
                manager.cancel_run("task_terminal_retry", accepted.run_id)
            )
            for _ in range(2)
        ]
        await asyncio.wait_for(both_waiting_for_drain.wait(), timeout=1)
        release_stream.set()
        await asyncio.wait_for(terminal_publish_entered.wait(), timeout=1)
        assert terminal_publisher is not None
        terminal_publisher.cancel()
        results = await asyncio.gather(*cancellations, return_exceptions=True)

        assert (
            sum(isinstance(result, asyncio.CancelledError) for result in results) == 1
        )
        assert any(
            isinstance(result, TaskSnapshot)
            and result.runs[-1].status is RunStatus.CANCELLED
            for result in results
        )
        assert ("task_terminal_retry", accepted.run_id) not in manager._running
        assert streaming_result.cancel_calls == ["after_turn"]
    finally:
        release_stream.set()
        await manager.close()
        await hub.close()


@pytest.mark.asyncio
async def test_worker_survives_finalization_failure_and_runs_next_item(
    tmp_path,
    monkeypatch,
    caplog,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    first_started = asyncio.Event()
    release_first = asyncio.Event()
    second_executed = asyncio.Event()

    async def run(execution) -> None:
        if execution.task_id == "task_worker_failure":
            first_started.set()
            await release_first.wait()
        elif execution.task_id == "task_worker_next":
            second_executed.set()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
    )
    await manager.start()
    try:
        for task_id in ("task_worker_failure", "task_worker_next"):
            await repository.save_snapshot(empty_snapshot(task_id))
        real_append_event = repository.append_event
        failed_once = False

        async def fail_first_finalizing_append(event):
            nonlocal failed_once
            if (
                event.task_id == "task_worker_failure"
                and isinstance(event.payload, RunFinalizingPayload)
                and not failed_once
            ):
                failed_once = True
                raise OSError("simulated finalization append failure")
            return await real_append_event(event)

        monkeypatch.setattr(repository, "append_event", fail_first_finalizing_append)
        caplog.set_level(logging.ERROR, logger="app.runtime.manager")
        await manager.submit_run(
            "task_worker_failure",
            StartRunRequest(request_id="req_worker_failure", input="first"),
        )
        await asyncio.wait_for(first_started.wait(), timeout=1)
        await manager.submit_run(
            "task_worker_next",
            StartRunRequest(request_id="req_worker_next", input="second"),
        )

        release_first.set()
        await asyncio.wait_for(second_executed.wait(), timeout=1)
        await manager.wait_until_idle()

        failed = await repository.get_snapshot("task_worker_failure")
        completed = await repository.get_snapshot("task_worker_next")
        assert failed is not None
        assert failed.runs[-1].status is RunStatus.FAILED
        assert "simulated finalization append failure" in (failed.runs[-1].error or "")
        assert completed is not None
        assert completed.runs[-1].status is RunStatus.COMPLETED
        assert "run worker failed" in caplog.text
    finally:
        release_first.set()
        await manager.close()


@pytest.mark.asyncio
async def test_context_setup_failure_terminalizes_before_worker_continues(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    setup_failed = asyncio.Event()
    second_executed = asyncio.Event()
    executor_tasks: list[str] = []

    def create_context(task_id: str) -> RunContext:
        if task_id == "task_setup_failure":
            setup_failed.set()
            raise RuntimeError("simulated context setup failure")
        return RunContext(task_id=task_id)

    async def run(execution) -> None:
        executor_tasks.append(execution.task_id)
        second_executed.set()

    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        max_active_runs=1,
        context_factory=create_context,
    )
    await manager.start()
    try:
        for task_id in ("task_setup_failure", "task_setup_next"):
            await repository.save_snapshot(empty_snapshot(task_id))
        first = await manager.submit_run(
            "task_setup_failure",
            StartRunRequest(request_id="req_setup_failure", input="first"),
        )
        await asyncio.wait_for(setup_failed.wait(), timeout=1)
        await manager.submit_run(
            "task_setup_next",
            StartRunRequest(request_id="req_setup_next", input="second"),
        )

        await asyncio.wait_for(second_executed.wait(), timeout=1)
        await manager.wait_until_idle()
        failed = await repository.get_snapshot("task_setup_failure")
        completed = await repository.get_snapshot("task_setup_next")

        assert failed is not None
        assert failed.runs[-1].run_id == first.run_id
        assert failed.runs[-1].status is RunStatus.FAILED
        assert "simulated context setup failure" in (failed.runs[-1].error or "")
        assert completed is not None
        assert completed.runs[-1].status is RunStatus.COMPLETED
        assert executor_tasks == ["task_setup_next"]
        assert manager._queue.qsize() == 0
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_close_cancels_live_workers_without_waiting_for_executor(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    executor_started = asyncio.Event()
    release_executor = asyncio.Event()
    executor_cancelled = asyncio.Event()

    async def run(execution) -> None:
        executor_started.set()
        try:
            await release_executor.wait()
        except asyncio.CancelledError:
            executor_cancelled.set()
            raise

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    await repository.save_snapshot(empty_snapshot("task_shutdown"))
    await manager.submit_run(
        "task_shutdown",
        StartRunRequest(request_id="req_shutdown", input="shutdown"),
    )
    await asyncio.wait_for(executor_started.wait(), timeout=1)
    workers = tuple(manager._workers)
    close_task = asyncio.create_task(manager.close())
    try:
        done, _ = await asyncio.wait({close_task}, timeout=0.1)
        assert close_task in done
        assert executor_cancelled.is_set()
        assert manager._running == {}
        assert all(worker.done() for worker in workers)
    finally:
        release_executor.set()
        await close_task


@pytest.mark.asyncio
async def test_close_waits_for_in_flight_admission_before_repository_shutdown(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    admission_entered = asyncio.Event()
    release_admission = asyncio.Event()

    async def run(execution) -> None:
        return None

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    await repository.save_snapshot(empty_snapshot("task_admission"))
    real_find_request = repository.find_request

    async def blocked_find_request(request_id: str):
        admission_entered.set()
        await release_admission.wait()
        return await real_find_request(request_id)

    monkeypatch.setattr(repository, "find_request", blocked_find_request)
    submission = asyncio.create_task(
        manager.submit_run(
            "task_admission",
            StartRunRequest(request_id="req_admission", input="admission"),
        )
    )
    await asyncio.wait_for(admission_entered.wait(), timeout=1)
    close_task = asyncio.create_task(manager.close())
    try:
        done, _ = await asyncio.wait({close_task}, timeout=0.1)
        assert close_task not in done
        release_admission.set()
        accepted = await submission
        await close_task
        assert accepted.task_id == "task_admission"
    finally:
        release_admission.set()
        await asyncio.gather(submission, close_task, return_exceptions=True)


@pytest.mark.asyncio
async def test_execution_activity_is_sequenced_through_manager(tmp_path) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")

    async def run(execution) -> None:
        await execution.emit(AssistantDeltaPayload(delta="durable answer"))

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        await repository.save_snapshot(empty_snapshot("task_activity"))
        accepted = await manager.submit_run(
            "task_activity",
            StartRunRequest(request_id="req_activity", input="answer me"),
        )
        await manager.wait_until_idle()

        events = await repository.list_events("task_activity")
        assert isinstance(events[2].payload, AssistantDeltaPayload)
        assert [event.sequence for event in events] == list(range(1, 6))
        assert events[2].run_id == accepted.run_id
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_manager_suppresses_artifact_when_cancel_wins_emitter_lock(
    tmp_path,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    execution_ready = asyncio.Event()
    release_artifact = asyncio.Event()
    execution_seen = None

    async def run(execution) -> None:
        nonlocal execution_seen
        execution_seen = execution
        execution_ready.set()
        await release_artifact.wait()
        await execution.emit(
            ArtifactProducedPayload(
                artifact=ArtifactManifestEntry(
                    artifact_id="artifact_cancel_race",
                    name="cancelled.csv",
                    relative_path="artifacts/cancelled.csv",
                    media_type="text/csv",
                    size_bytes=1,
                    sha256="ab" * 32,
                    generated_by_step_id="step_cancel_race",
                )
            )
        )

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        await repository.save_snapshot(empty_snapshot("task_artifact_cancel"))
        accepted = await manager.submit_run(
            "task_artifact_cancel",
            StartRunRequest(request_id="req_artifact_cancel", input="cancel artifact"),
        )
        await asyncio.wait_for(execution_ready.wait(), timeout=1)
        assert execution_seen is not None

        cancellation = asyncio.create_task(
            manager.cancel_run("task_artifact_cancel", accepted.run_id)
        )
        await asyncio.wait_for(
            execution_seen.context.cancellation_requested.wait(),
            timeout=1,
        )
        release_artifact.set()
        await asyncio.wait_for(cancellation, timeout=1)

        events = await repository.list_events("task_artifact_cancel")
        assert not any(
            isinstance(event.payload, ArtifactProducedPayload) for event in events
        )
        assert [event.sequence for event in events] == list(range(1, len(events) + 1))
    finally:
        release_artifact.set()
        await manager.close()


@pytest.mark.asyncio
async def test_cancellation_during_compaction_commit_restores_previous_marker(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    execution_ready = asyncio.Event()
    release_executor = asyncio.Event()
    save_entered = asyncio.Event()
    release_save = asyncio.Event()
    execution_seen = None

    async def run(execution) -> None:
        nonlocal execution_seen
        execution_seen = execution
        execution_ready.set()
        await release_executor.wait()

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        task_id = "task_compaction_cancel"
        await repository.save_snapshot(empty_snapshot(task_id))
        await repository.save_conversation_summary(task_id, {})
        real_save = repository.save_conversation_summary
        save_calls = 0

        async def blocking_save(saved_task_id, summary):
            nonlocal save_calls
            save_calls += 1
            await real_save(saved_task_id, summary)
            if save_calls == 1:
                save_entered.set()
                await release_save.wait()

        monkeypatch.setattr(repository, "save_conversation_summary", blocking_save)
        accepted = await manager.submit_run(
            task_id,
            StartRunRequest(request_id="req_compaction_cancel", input="compact"),
        )
        await asyncio.wait_for(execution_ready.wait(), timeout=1)
        assert execution_seen is not None
        record = {
            "schema_version": "1.0",
            "summary": "new summary",
            "summary_digest": "ab" * 32,
            "covered_through_run_id": "run_old",
            "covered_run_ids": ["run_old"],
            "covered_history_digest": "cd" * 32,
        }
        payload = ConversationCompactedPayload(
            covered_through_run_id="run_old",
            summary_digest="ab" * 32,
        )

        commit = asyncio.create_task(execution_seen.commit_compaction(record, payload))
        await asyncio.wait_for(save_entered.wait(), timeout=1)
        cancellation = asyncio.create_task(manager.cancel_run(task_id, accepted.run_id))
        await asyncio.wait_for(
            execution_seen.context.cancellation_requested.wait(),
            timeout=1,
        )
        release_save.set()

        assert await asyncio.wait_for(commit, timeout=1) is False
        assert await repository.load_conversation_summary(task_id) == {}
        events = await repository.list_events(task_id)
        assert not any(
            isinstance(event.payload, ConversationCompactedPayload) for event in events
        )

        release_executor.set()
        cancelled = await asyncio.wait_for(cancellation, timeout=1)
        assert cancelled.runs[-1].status is RunStatus.CANCELLED
    finally:
        release_save.set()
        release_executor.set()
        await manager.close()


@pytest.mark.asyncio
async def test_direct_commit_cancellation_during_marker_write_restores_previous_marker(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    execution_ready = asyncio.Event()
    release_executor = asyncio.Event()
    write_entered = threading.Event()
    release_write = threading.Event()
    write_finished = threading.Event()
    execution_seen = None
    commit = None

    async def run(execution) -> None:
        nonlocal execution_seen
        execution_seen = execution
        execution_ready.set()
        await release_executor.wait()

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    task_id = "task_compaction_direct_cancel"
    previous = {"marker": "previous"}
    record = {
        "schema_version": "1.0",
        "summary": "new summary",
        "summary_digest": "ab" * 32,
        "covered_through_run_id": "run_old",
        "covered_run_ids": ["run_old"],
        "covered_history_digest": "cd" * 32,
    }
    payload = ConversationCompactedPayload(
        covered_through_run_id="run_old",
        summary_digest="ab" * 32,
    )
    try:
        await repository.save_snapshot(empty_snapshot(task_id))
        await repository.save_conversation_summary(task_id, previous)
        real_atomic_write = repository_module.atomic_write_json

        def block_new_marker_write(path, value) -> None:
            if path.name == "conversation_summary.json" and dict(value) == record:
                write_entered.set()
                if not release_write.wait(timeout=3):
                    raise TimeoutError("summary write release timed out")
                real_atomic_write(path, value)
                write_finished.set()
                return
            real_atomic_write(path, value)

        monkeypatch.setattr(
            repository_module,
            "atomic_write_json",
            block_new_marker_write,
        )
        await manager.submit_run(
            task_id,
            StartRunRequest(
                request_id="req_compaction_direct_cancel",
                input="compact",
            ),
        )
        await asyncio.wait_for(execution_ready.wait(), timeout=1)
        assert execution_seen is not None

        commit = asyncio.create_task(execution_seen.commit_compaction(record, payload))
        await asyncio.wait_for(asyncio.to_thread(write_entered.wait), timeout=1)
        commit.cancel()
        await asyncio.sleep(0)
        release_write.set()

        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(commit, timeout=1)
        await asyncio.wait_for(asyncio.to_thread(write_finished.wait), timeout=1)

        assert await repository.load_conversation_summary(task_id) == previous
        events = await repository.list_events(task_id)
        assert not any(
            isinstance(event.payload, ConversationCompactedPayload) for event in events
        )

    finally:
        release_write.set()
        release_executor.set()
        if commit is not None:
            await asyncio.gather(commit, return_exceptions=True)
        await manager.close()


@pytest.mark.asyncio
async def test_compaction_append_failure_restores_previous_marker(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    execution_ready = asyncio.Event()
    release_executor = asyncio.Event()
    execution_seen = None

    async def run(execution) -> None:
        nonlocal execution_seen
        execution_seen = execution
        execution_ready.set()
        await release_executor.wait()

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        task_id = "task_compaction_append_failure"
        previous = {"marker": "previous"}
        record = {
            "schema_version": "1.0",
            "summary": "new summary",
            "summary_digest": "ab" * 32,
            "covered_through_run_id": "run_old",
            "covered_run_ids": ["run_old"],
            "covered_history_digest": "cd" * 32,
        }
        payload = ConversationCompactedPayload(
            covered_through_run_id="run_old",
            summary_digest="ab" * 32,
        )
        await repository.save_snapshot(empty_snapshot(task_id))
        await repository.save_conversation_summary(task_id, previous)
        real_append = repository.events.append

        def fail_compaction_append(event) -> None:
            if isinstance(event.payload, ConversationCompactedPayload):
                raise RuntimeError("durable append failed")
            real_append(event)

        monkeypatch.setattr(repository.events, "append", fail_compaction_append)
        await manager.submit_run(
            task_id,
            StartRunRequest(
                request_id="req_compaction_append_failure",
                input="compact",
            ),
        )
        await asyncio.wait_for(execution_ready.wait(), timeout=1)
        assert execution_seen is not None

        with pytest.raises(RuntimeError, match="durable append failed"):
            await execution_seen.commit_compaction(record, payload)

        assert await repository.load_conversation_summary(task_id) == previous
        events = await repository.list_events(task_id)
        assert not any(
            isinstance(event.payload, ConversationCompactedPayload) for event in events
        )
    finally:
        release_executor.set()
        await manager.close()


@pytest.mark.asyncio
async def test_compaction_snapshot_failure_keeps_journal_marker_on_restart(
    tmp_path,
    monkeypatch,
) -> None:
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    execution_ready = asyncio.Event()
    release_executor = asyncio.Event()
    execution_seen = None

    async def run(execution) -> None:
        nonlocal execution_seen
        execution_seen = execution
        execution_ready.set()
        await release_executor.wait()

    manager_module = importlib.import_module("app.runtime.manager")
    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    task_id = "task_compaction_snapshot_failure"
    record = {
        "schema_version": "1.0",
        "summary": "new summary",
        "summary_digest": "ab" * 32,
        "covered_through_run_id": "run_old",
        "covered_run_ids": ["run_old"],
        "covered_history_digest": "cd" * 32,
    }
    payload = ConversationCompactedPayload(
        covered_through_run_id="run_old",
        summary_digest="ab" * 32,
    )
    summary_path = (
        output_dir / "tasks" / task_id / "state" / "conversation_summary.json"
    )
    try:
        await repository.save_snapshot(empty_snapshot(task_id))
        await repository.save_conversation_summary(task_id, {"marker": "previous"})
        await manager.submit_run(
            task_id,
            StartRunRequest(
                request_id="req_compaction_snapshot_failure",
                input="compact",
            ),
        )
        await asyncio.wait_for(execution_ready.wait(), timeout=1)
        assert execution_seen is not None
        real_atomic_write = repository_module.atomic_write_json
        projection_failed = False

        def fail_compaction_projection(path, value) -> None:
            nonlocal projection_failed
            if path.name == "task_snapshot.json" and not projection_failed:
                projection_failed = True
                raise OSError("snapshot projection failed")
            real_atomic_write(path, value)

        monkeypatch.setattr(
            repository_module,
            "atomic_write_json",
            fail_compaction_projection,
        )

        assert await execution_seen.commit_compaction(record, payload) is True

        assert json.loads(summary_path.read_text("utf-8")) == record
        durable_events = await repository.list_events(task_id)
        compacted = [
            event
            for event in durable_events
            if isinstance(event.payload, ConversationCompactedPayload)
        ]
        assert len(compacted) == 1
        assert compacted[0].payload.summary_digest == record["summary_digest"]
    finally:
        await manager.close()
        release_executor.set()
        await repository.close()

    reopened = TaskRepository(output_dir)
    await reopened.initialize()
    try:
        recovered = await reopened.get_snapshot(task_id)
        assert recovered is not None
        replay = await reopened.list_events(task_id)
        compacted = [
            event
            for event in replay
            if isinstance(event.payload, ConversationCompactedPayload)
        ]
        assert len(compacted) == 1
        assert recovered.task.latest_sequence == compacted[0].sequence
        assert await reopened.load_conversation_summary(task_id) == record
    finally:
        await reopened.close()


@pytest.mark.asyncio
async def test_cancelled_partial_append_waits_for_thread_and_keeps_commit(
    tmp_path,
    monkeypatch,
) -> None:
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    execution_ready = asyncio.Event()
    release_executor = asyncio.Event()
    projection_entered = threading.Event()
    release_projection = threading.Event()
    projection_finished = threading.Event()
    execution_seen = None
    manager_probe = None
    repository_probe = None
    commit = None

    async def run(execution) -> None:
        nonlocal execution_seen
        execution_seen = execution
        execution_ready.set()
        await release_executor.wait()

    manager_module = importlib.import_module("app.runtime.manager")
    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    task_id = "task_compaction_partial_cancel"
    record = {
        "schema_version": "1.0",
        "summary": "new summary",
        "summary_digest": "ab" * 32,
        "covered_through_run_id": "run_old",
        "covered_run_ids": ["run_old"],
        "covered_history_digest": "cd" * 32,
    }
    payload = ConversationCompactedPayload(
        covered_through_run_id="run_old",
        summary_digest="ab" * 32,
    )
    summary_path = (
        output_dir / "tasks" / task_id / "state" / "conversation_summary.json"
    )
    try:
        await repository.save_snapshot(empty_snapshot(task_id))
        await repository.save_conversation_summary(task_id, {"marker": "previous"})
        await manager.submit_run(
            task_id,
            StartRunRequest(
                request_id="req_compaction_partial_cancel",
                input="compact",
            ),
        )
        await asyncio.wait_for(execution_ready.wait(), timeout=1)
        assert execution_seen is not None
        real_atomic_write = repository_module.atomic_write_json
        projection_blocked = False

        def block_compaction_projection(path, value) -> None:
            nonlocal projection_blocked
            if path.name == "task_snapshot.json" and not projection_blocked:
                projection_blocked = True
                projection_entered.set()
                if not release_projection.wait(timeout=3):
                    raise TimeoutError("projection release timed out")
                real_atomic_write(path, value)
                projection_finished.set()
                return
            real_atomic_write(path, value)

        monkeypatch.setattr(
            repository_module,
            "atomic_write_json",
            block_compaction_projection,
        )

        commit = asyncio.create_task(execution_seen.commit_compaction(record, payload))
        await asyncio.wait_for(
            asyncio.to_thread(projection_entered.wait),
            timeout=1,
        )
        commit.cancel()
        await asyncio.sleep(0)

        manager_lock = manager._task_locks[task_id]
        repository_lock = repository._task_locks[task_id]
        manager_probe = asyncio.create_task(manager_lock.acquire())
        repository_probe = asyncio.create_task(repository_lock.acquire())
        await asyncio.sleep(0.05)

        assert not commit.done()
        assert not manager_probe.done()
        assert not repository_probe.done()

        release_projection.set()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(commit, timeout=1)
        await asyncio.wait_for(manager_probe, timeout=1)
        manager_lock.release()
        await asyncio.wait_for(repository_probe, timeout=1)
        repository_lock.release()
        assert projection_finished.is_set()

        assert json.loads(summary_path.read_text("utf-8")) == record
        durable_events = await repository.list_events(task_id)
        compacted = [
            event
            for event in durable_events
            if isinstance(event.payload, ConversationCompactedPayload)
        ]
        assert len(compacted) == 1
        assert compacted[0].payload.summary_digest == record["summary_digest"]
    finally:
        release_projection.set()
        if commit is not None:
            await asyncio.gather(commit, return_exceptions=True)
        if manager_probe is not None and manager_probe.done():
            if not manager_probe.cancelled() and manager_probe.exception() is None:
                lock = manager._task_locks[task_id]
                if lock.locked():
                    lock.release()
        elif manager_probe is not None:
            manager_probe.cancel()
        if repository_probe is not None and repository_probe.done():
            if (
                not repository_probe.cancelled()
                and repository_probe.exception() is None
            ):
                lock = repository._task_locks[task_id]
                if lock.locked():
                    lock.release()
        elif repository_probe is not None:
            repository_probe.cancel()
        await manager.close()
        release_executor.set()
        await repository.close()

    reopened = TaskRepository(output_dir)
    await reopened.initialize()
    try:
        recovered = await reopened.get_snapshot(task_id)
        assert recovered is not None
        replay = await reopened.list_events(task_id)
        assert (
            sum(
                isinstance(event.payload, ConversationCompactedPayload)
                for event in replay
            )
            == 1
        )
        assert await reopened.load_conversation_summary(task_id) == record
    finally:
        await reopened.close()


@pytest.mark.asyncio
async def test_cancelled_live_publish_retains_durable_compaction_on_restart(
    tmp_path,
) -> None:
    output_dir = tmp_path / "output"
    repository = TaskRepository(output_dir)
    execution_ready = asyncio.Event()
    release_executor = asyncio.Event()
    publish_entered = asyncio.Event()
    release_publish = asyncio.Event()
    execution_seen = None

    class BlockingCompactionHub(EventHub):
        async def publish(self, event) -> None:
            if isinstance(event.payload, ConversationCompactedPayload):
                publish_entered.set()
                await release_publish.wait()
            await super().publish(event)

    async def run(execution) -> None:
        nonlocal execution_seen
        execution_seen = execution
        execution_ready.set()
        await release_executor.wait()

    manager_module = importlib.import_module("app.runtime.manager")
    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        event_hub=BlockingCompactionHub(),
    )
    await manager.start()
    task_id = "task_compaction_publish_cancel"
    previous = {"marker": "previous"}
    record = {
        "schema_version": "1.0",
        "summary": "new summary",
        "summary_digest": "ab" * 32,
        "covered_through_run_id": "run_old",
        "covered_run_ids": ["run_old"],
        "covered_history_digest": "cd" * 32,
    }
    payload = ConversationCompactedPayload(
        covered_through_run_id="run_old",
        summary_digest="ab" * 32,
    )
    try:
        await repository.save_snapshot(empty_snapshot(task_id))
        await repository.save_conversation_summary(task_id, previous)
        await manager.submit_run(
            task_id,
            StartRunRequest(
                request_id="req_compaction_publish_cancel",
                input="compact",
            ),
        )
        await asyncio.wait_for(execution_ready.wait(), timeout=1)
        assert execution_seen is not None

        commit = asyncio.create_task(execution_seen.commit_compaction(record, payload))
        await asyncio.wait_for(publish_entered.wait(), timeout=1)
        durable_events = await repository.list_events(task_id)
        assert (
            sum(
                isinstance(event.payload, ConversationCompactedPayload)
                for event in durable_events
            )
            == 1
        )

        commit.cancel()
        with pytest.raises(asyncio.CancelledError):
            await commit

        stored = await repository.load_conversation_summary(task_id)
        compacted = next(
            event.payload
            for event in durable_events
            if isinstance(event.payload, ConversationCompactedPayload)
        )
        assert stored == record
        assert stored["summary_digest"] == compacted.summary_digest
        assert stored["covered_through_run_id"] == compacted.covered_through_run_id
    finally:
        release_publish.set()
        release_executor.set()
        await manager.close()
        await repository.close()

    reopened = TaskRepository(output_dir)
    await reopened.initialize()
    try:
        assert await reopened.load_conversation_summary(task_id) == record
        replay = await reopened.list_events(task_id)
        assert (
            sum(
                isinstance(event.payload, ConversationCompactedPayload)
                for event in replay
            )
            == 1
        )
    finally:
        await reopened.close()


@pytest.mark.asyncio
async def test_compaction_live_publish_failure_keeps_durable_commit(
    tmp_path,
    caplog,
) -> None:
    repository = TaskRepository(tmp_path / "output")
    execution_ready = asyncio.Event()
    release_executor = asyncio.Event()
    execution_seen = None

    class FailingCompactionHub(EventHub):
        async def publish(self, event) -> None:
            if isinstance(event.payload, ConversationCompactedPayload):
                raise RuntimeError("live fan-out failed")
            await super().publish(event)

    async def run(execution) -> None:
        nonlocal execution_seen
        execution_seen = execution
        execution_ready.set()
        await release_executor.wait()

    manager_module = importlib.import_module("app.runtime.manager")
    manager = manager_module.TaskManager(
        repository,
        run_executor=run,
        event_hub=FailingCompactionHub(),
    )
    await manager.start()
    try:
        task_id = "task_compaction_publish_failure"
        record = {
            "schema_version": "1.0",
            "summary": "new summary",
            "summary_digest": "ab" * 32,
            "covered_through_run_id": "run_old",
            "covered_run_ids": ["run_old"],
            "covered_history_digest": "cd" * 32,
        }
        payload = ConversationCompactedPayload(
            covered_through_run_id="run_old",
            summary_digest="ab" * 32,
        )
        await repository.save_snapshot(empty_snapshot(task_id))
        await repository.save_conversation_summary(task_id, {"marker": "previous"})
        await manager.submit_run(
            task_id,
            StartRunRequest(
                request_id="req_compaction_publish_failure",
                input="compact",
            ),
        )
        await asyncio.wait_for(execution_ready.wait(), timeout=1)
        assert execution_seen is not None

        with caplog.at_level(logging.ERROR, logger="app.runtime.manager"):
            committed = await execution_seen.commit_compaction(record, payload)

        assert committed is True
        assert await repository.load_conversation_summary(task_id) == record
        events = await repository.list_events(task_id)
        assert (
            sum(
                isinstance(event.payload, ConversationCompactedPayload)
                for event in events
            )
            == 1
        )
        assert "failed to publish durable compaction event" in caplog.text
    finally:
        release_executor.set()
        await manager.close()


@pytest.mark.asyncio
async def test_manager_suppresses_compaction_warning_when_cancel_wins_lock(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    warning_ready = asyncio.Event()
    release_warning = asyncio.Event()
    cancel_persisted = asyncio.Event()
    cancellation_seen = asyncio.Event()
    real_append = repository.append_event

    async def append_event(event):
        snapshot = await real_append(event)
        if isinstance(event.payload, RunCancelRequestedPayload):
            cancel_persisted.set()
        return snapshot

    async def fail_summary_load(task_id: str):
        raise RuntimeError("summary marker unavailable")

    monkeypatch.setattr(repository, "append_event", append_event)
    monkeypatch.setattr(
        repository,
        "load_conversation_summary",
        fail_summary_load,
    )

    async def run(execution) -> None:
        async def delayed_emit(payload):
            if isinstance(payload, WarningPayload):
                warning_ready.set()
                await release_warning.wait()
            return await execution.emit(payload)

        try:
            await ConversationCompactor(repository).prepare(
                execution.task_id,
                model_handle=object(),
                emit=delayed_emit,
                cancellation_requested=execution.context.cancellation_requested,
                commit=execution.commit_compaction,
            )
        except CompactionCancelledError:
            cancellation_seen.set()
            raise

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        task_id = "task_compaction_warning_cancel"
        await repository.save_snapshot(empty_snapshot(task_id))
        accepted = await manager.submit_run(
            task_id,
            StartRunRequest(
                request_id="req_compaction_warning_cancel",
                input="cancel warning fallback",
            ),
        )
        await asyncio.wait_for(warning_ready.wait(), timeout=1)

        cancellation = asyncio.create_task(manager.cancel_run(task_id, accepted.run_id))
        await asyncio.wait_for(cancel_persisted.wait(), timeout=1)
        release_warning.set()
        cancelled = await asyncio.wait_for(cancellation, timeout=1)

        assert cancellation_seen.is_set()
        assert cancelled.runs[-1].status is RunStatus.CANCELLED
        events = await repository.list_events(task_id)
        assert not any(isinstance(event.payload, WarningPayload) for event in events)
        assert [event.sequence for event in events] == list(range(1, len(events) + 1))
    finally:
        release_warning.set()
        await manager.close()


@pytest.mark.asyncio
async def test_manager_retains_compaction_warning_when_warning_wins_lock(
    tmp_path,
    monkeypatch,
) -> None:
    manager_module = importlib.import_module("app.runtime.manager")
    repository = TaskRepository(tmp_path / "output")
    warning_persisted = asyncio.Event()
    cancel_persisted = asyncio.Event()
    release_executor = asyncio.Event()
    real_append = repository.append_event

    async def append_event(event):
        snapshot = await real_append(event)
        if isinstance(event.payload, WarningPayload):
            warning_persisted.set()
        if isinstance(event.payload, RunCancelRequestedPayload):
            cancel_persisted.set()
        return snapshot

    async def fail_summary_load(task_id: str):
        raise RuntimeError("summary marker unavailable")

    monkeypatch.setattr(repository, "append_event", append_event)
    monkeypatch.setattr(
        repository,
        "load_conversation_summary",
        fail_summary_load,
    )

    async def run(execution) -> None:
        await ConversationCompactor(repository).prepare(
            execution.task_id,
            model_handle=object(),
            emit=execution.emit,
            cancellation_requested=execution.context.cancellation_requested,
            commit=execution.commit_compaction,
        )
        await release_executor.wait()

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    try:
        task_id = "task_compaction_warning_first"
        await repository.save_snapshot(empty_snapshot(task_id))
        accepted = await manager.submit_run(
            task_id,
            StartRunRequest(
                request_id="req_compaction_warning_first",
                input="warn before cancel",
            ),
        )
        await asyncio.wait_for(warning_persisted.wait(), timeout=1)

        cancellation = asyncio.create_task(manager.cancel_run(task_id, accepted.run_id))
        await asyncio.wait_for(cancel_persisted.wait(), timeout=1)
        release_executor.set()
        await asyncio.wait_for(cancellation, timeout=1)

        events = await repository.list_events(task_id)
        warnings = [
            event.payload
            for event in events
            if isinstance(event.payload, WarningPayload)
        ]
        assert len(warnings) == 1
        assert warnings[0].code == "compaction_failed"
        assert [event.sequence for event in events] == list(range(1, len(events) + 1))
    finally:
        release_executor.set()
        await manager.close()
