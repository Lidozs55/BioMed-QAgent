"""C5e overflow recovery regression: _recover must see ALL active tasks.

The C5e change bounded ``TaskIndex.list_tasks(limit=...)`` active list by
``limit`` (default ``task_page_max_size`` = 100). ``_recover`` (manager,
start-time scan) built its task inventory from the paginated surface — active
tasks appear only on page 1 and were silently truncated. With a saturated
queue (max_queued_runs=100 + max_active_runs=4 = 104 possible active tasks),
the OLDEST active tasks vanished from recovery: their RUNNING runs were never
interrupted and their QUEUED runs were never re-queued, on every restart.

Fix: a dedicated unbounded active-tasks query (``TaskIndex.list_active_tasks``
+ repository passthrough); ``_recover`` scans with it and keeps the paginated
history loop for inactive tasks only.
"""

from __future__ import annotations

import tempfile
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from app.domain.contracts import RunRecord, RunStatus, TaskMode, TaskSnapshot, TaskSummary
from app.runtime import repository as repository_module
from app.runtime.index import TaskIndex
from app.runtime.manager import TaskManager

NOW = datetime(2026, 7, 13, tzinfo=UTC)
# task_page_max_size default = 100; max_queued_runs=100 + max_active_runs=4.
_PAGE_LIMIT = 100
_QUEUED_COUNT = 100
_RUNNING_COUNT = 4


def _active_snapshot(
    task_id: str,
    *,
    status: RunStatus,
    run_id: str,
    created_at: datetime,
) -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=TaskMode.AGENT,
            title=task_id,
            status=status,
            active_run_id=run_id,
            created_at=created_at,
            updated_at=created_at,
        ),
        runs=[
            RunRecord(
                run_id=run_id,
                task_id=task_id,
                request_id=f"req_{task_id}",
                status=status,
                input=f"input {task_id}",
                created_at=created_at,
                updated_at=created_at,
            )
        ],
    )


async def _seed_saturated_active_tasks(repository) -> None:
    """Seed 104 active tasks: 100 QUEUED + 4 RUNNING (RUNNING are OLDEST)."""

    # RUNNING tasks first with the oldest created_at so the bounded active
    # list (created_at DESC) would truncate them.
    for index in range(_RUNNING_COUNT):
        created = NOW - timedelta(hours=_RUNNING_COUNT - index + 1)
        await repository.save_snapshot(
            _active_snapshot(
                f"task_r_{index}",
                status=RunStatus.RUNNING,
                run_id=f"run_r_{index}",
                created_at=created,
            )
        )
    for index in range(_QUEUED_COUNT):
        created = NOW - timedelta(minutes=_QUEUED_COUNT - index)
        await repository.save_snapshot(
            _active_snapshot(
                f"task_q_{index:03d}",
                status=RunStatus.QUEUED,
                run_id=f"run_q_{index:03d}",
                created_at=created,
            )
        )


@pytest.mark.asyncio
async def test_index_list_active_tasks_is_unbounded() -> None:
    """The dedicated active query returns ALL active tasks, no limit truncation."""

    index = TaskIndex(Path(tempfile.mkdtemp()) / "tasks")
    await index.initialize()
    try:
        for number in range(_QUEUED_COUNT):
            await index.upsert_snapshot(
                _active_snapshot(
                    f"task_q_{number:03d}",
                    status=RunStatus.QUEUED,
                    run_id=f"run_q_{number:03d}",
                    created_at=NOW - timedelta(minutes=number),
                )
            )

        active = await index.list_active_tasks()
        assert len(active) == _QUEUED_COUNT  # 无界：全部可见

        # C5e 分页语义不变：active_items 仍受 limit 约束。
        page = await index.list_tasks(limit=_PAGE_LIMIT)
        assert len(page.active_items) == _PAGE_LIMIT
    finally:
        await index.close()


@pytest.mark.asyncio
async def test_recover_sees_active_tasks_beyond_page_limit(tmp_path) -> None:
    """Saturated restart: the OLDEST RUNNING tasks are interrupted and all
    QUEUED runs re-queued — the paginated surface must not hide them."""

    repository = repository_module.TaskRepository(tmp_path / "output")
    await repository.initialize()

    async def run(_execution) -> None:
        return None

    manager = TaskManager(repository, run_executor=run)
    try:
        await _seed_saturated_active_tasks(repository)
        await manager._recover()  # 直接调用，避免 start() 的 worker 消费队列

        # 4 个最老的 RUNNING 任务必须被恢复中断（分页 surface 会漏掉它们）。
        for index in range(_RUNNING_COUNT):
            snapshot = await repository.get_snapshot(f"task_r_{index}")
            assert snapshot is not None
            assert snapshot.runs[0].status is RunStatus.INTERRUPTED, (
                f"oldest RUNNING run must be interrupted by recovery, "
                f"got {snapshot.runs[0].status.value}"
            )

        # 100 个 QUEUED run 全部重新排队。
        assert manager._queue.qsize() == _QUEUED_COUNT
    finally:
        await manager.close()
