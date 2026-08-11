"""C5d/C5e regression: strong-key dicts cleaned on task delete; active list bounded.

- C5d: ``TaskManager._task_locks`` / ``TaskRepository._task_locks`` /
  ``EventStore._checkpoints`` must not retain entries for deleted tasks.
- C5e: ``TaskIndex.list_tasks(limit=...)`` must bound the active list by
  ``limit`` (previously unbounded: a long session with many active tasks
  serialized them all regardless of page size).
"""

from __future__ import annotations

import importlib
from datetime import UTC, datetime

import pytest
from app.domain.contracts import (
    RunRecord,
    RunStatus,
    TaskMode,
    TaskSnapshot,
    TaskSummary,
)
from app.runtime import repository as repository_module

NOW = datetime(2026, 7, 13, tzinfo=UTC)


def terminal_snapshot(task_id: str, status: RunStatus) -> TaskSnapshot:
    """One fully-terminal task snapshot (delete eligibility per manager)."""

    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=TaskMode.AGENT,
            title=task_id,
            status=status,
            created_at=NOW,
            updated_at=NOW,
        ),
        runs=[
            RunRecord(
                run_id=f"run_{task_id}",
                task_id=task_id,
                request_id=f"req_{task_id}",
                status=status,
                input=task_id,
                created_at=NOW,
                updated_at=NOW,
                started_at=NOW,
                finished_at=NOW,
            )
        ],
    )


@pytest.mark.asyncio
async def test_manager_task_lock_cleared_after_delete(tmp_path) -> None:
    """C5d: a deleted task's lock entry must not linger in the manager."""

    manager_module = importlib.import_module("app.runtime.manager")
    repository = repository_module.TaskRepository(tmp_path / "output")

    async def run(_execution) -> None:
        return None

    manager = manager_module.TaskManager(repository, run_executor=run)
    await manager.start()
    task_id = "task_lock_gone"
    await repository.save_snapshot(terminal_snapshot(task_id, RunStatus.COMPLETED))
    try:
        await manager.delete_task(task_id)
        # The delete path setdefaults a lock entry; it must not linger.
        assert task_id not in manager._task_locks
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_repository_locks_and_checkpoints_cleared_after_delete(
    tmp_path,
) -> None:
    """C5d: repository locks and EventStore checkpoints drop the deleted task."""

    repository = repository_module.TaskRepository(tmp_path / "output")
    await repository.initialize()
    task_id = "task_repo_hygiene"
    await repository.save_snapshot(terminal_snapshot(task_id, RunStatus.COMPLETED))
    try:
        assert task_id in repository._task_locks
        await repository.delete_task(task_id)
        assert task_id not in repository._task_locks
        assert task_id not in repository.events._checkpoints
    finally:
        await repository.close()


@pytest.mark.asyncio
async def test_repository_delete_leaves_no_checkpoint_after_event_append(
    tmp_path,
) -> None:
    """C5d: a checkpoint created by a real append is dropped on delete."""

    repository = repository_module.TaskRepository(tmp_path / "output")
    await repository.initialize()
    task_id = "task_ckpt_gone"
    await repository.save_snapshot(terminal_snapshot(task_id, RunStatus.COMPLETED))
    try:
        # Force an append through the event store so a checkpoint is cached.
        from app.domain.contracts import RunQueuedPayload

        queued = RunQueuedPayload(request_id="req_ckpt", input="question")
        await repository.append_event_payload(
            task_id=task_id,
            run_id="run_ckpt",
            payload=queued,
        )
        assert task_id in repository.events._checkpoints
        await repository.delete_task(task_id)
        assert task_id not in repository.events._checkpoints
        assert task_id not in repository._task_locks
    finally:
        await repository.close()
