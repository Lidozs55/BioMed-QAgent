"""C1a: finalize 原子提交回归测试。

崩溃窗口（V2 主线）：finalize 在 task 锁内先持久化发布事实（publication_created
事件 / 工具产物已落盘 datasets_build/），后追加 RunCompletedPayload。任何落在
两者之间的事件追加失败或进程崩溃都会留下"已发布但 run 非成功"的孤立产物。

修复：
1. finalize 异常路径——发布事实已持久化时，事件追加失败不得把 run 标 FAILED，
   而是幂等补发 run_completed，收敛为 COMPLETED。
2. _recover——重启后对 FINALIZING 且发布事实已持久化（无 run_completed）的
   run 补发 run_completed，避免恢复把它标 INTERRUPTED 留下孤立产物。
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import pytest
from app.domain.contracts import (
    PublicationCreatedPayload,
    RunCompletedPayload,
    RunFailedPayload,
    RunFinalizingPayload,
    RunQueuedPayload,
    RunStartedPayload,
    StartTaskRequest,
    TaskMode,
)
from app.domain.contracts.events import build_event
from app.domain.contracts.runtime import RunStatus, TaskSnapshot, TaskSummary
from app.runtime.manager import TaskManager
from app.runtime.repository import TaskRepository

FIXTURE_DIR = Path(__file__).parents[1] / "fixtures" / "ncbi" / "gse178352"

NOW = datetime(2026, 8, 9, tzinfo=UTC)


def make_manager(repository: TaskRepository) -> TaskManager:
    from app.agent_loop.runner import FixtureRunExecutor

    return TaskManager(
        repository,
        run_executor=FixtureRunExecutor(repository, fixture_dir=FIXTURE_DIR),
    )


async def _seed_finalizing_with_publication(
    repository: TaskRepository,
    *,
    task_id: str,
    run_id: str,
) -> None:
    """Seed a run that stopped mid-finalize: publication_created persisted,
    run_completed missing (crash window)."""

    await repository.save_snapshot(
        TaskSnapshot(
            task=TaskSummary(
                task_id=task_id,
                mode=TaskMode.FIXTURE,
                title="fixture atomicity",
                status=RunStatus.QUEUED,
                created_at=NOW,
                updated_at=NOW,
            )
        )
    )
    events = [
        build_event(
            task_id=task_id,
            run_id=run_id,
            sequence=1,
            payload=RunQueuedPayload(
                request_id="req_atomic",
                input="fixture atomicity",
            ),
        ),
        build_event(
            task_id=task_id,
            run_id=run_id,
            sequence=2,
            payload=RunStartedPayload(),
        ),
        build_event(
            task_id=task_id,
            run_id=run_id,
            sequence=3,
            payload=RunFinalizingPayload(),
        ),
        build_event(
            task_id=task_id,
            run_id=run_id,
            sequence=4,
            payload=PublicationCreatedPayload(
                publication_id=f"pub-{run_id}",
                run_id=run_id,
                manifest_sha256="0" * 64,
                published_at=NOW,
            ),
        ),
    ]
    for event in events:
        await repository.append_event(event)


@pytest.mark.asyncio
async def test_finalize_append_failure_after_publication_converges_to_completed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """发布事实已持久化后事件追加失败 → run 收敛 COMPLETED，绝不 FAILED 孤立。"""

    repository = TaskRepository(tmp_path / "output")
    manager = make_manager(repository)
    await manager.start()
    original_append = TaskManager._append_completion_status
    attempts = {"run_completed": 0}

    async def flaky_append(self, accepted, payload, **kwargs):
        if isinstance(payload, RunCompletedPayload):
            attempts["run_completed"] += 1
            if attempts["run_completed"] == 1:
                raise OSError("simulated event-store failure (first attempt)")
        return await original_append(self, accepted, payload, **kwargs)

    monkeypatch.setattr(TaskManager, "_append_completion_status", flaky_append)
    try:
        accepted = await manager.create_task(
            StartTaskRequest(
                request_id="req_atomic_failure",
                input="fixture atomicity failure",
                databases=["gdc"],
                mode=TaskMode.FIXTURE,
            )
        )
        await manager.wait_until_idle()

        snapshot = await repository.get_snapshot(accepted.task_id)
        assert snapshot is not None
        run = snapshot.runs[0]
        # 修复后：run 是 COMPLETED（幂等补发成功），不是 FAILED。
        assert run.status.value == "completed", (
            f"run must converge to COMPLETED, got {run.status.value}; "
            "FAILED would leave an already-published orphan"
        )
        # 发布事实存在，无孤立。
        assert snapshot.publications, "publication must be recorded"
        # 无 RunFailedPayload 事件。
        events = await repository.list_events(accepted.task_id)
        failed = [
            event
            for event in events
            if isinstance(event.payload, RunFailedPayload)
        ]
        assert failed == []
        # run_completed 恰好一条（幂等，不重复）。
        completed = [
            event
            for event in events
            if isinstance(event.payload, RunCompletedPayload)
        ]
        assert len(completed) == 1
    finally:
        await manager.close()


@pytest.mark.asyncio
async def test_recover_closes_finalizing_run_with_persisted_publication(
    tmp_path: Path,
) -> None:
    """重启恢复：FINALIZING + publication_created 已持久化 → 补发 run_completed，
    不把 run 标 INTERRUPTED（否则留下已发布但非成功的孤立）。"""

    task_id = "task_atomic_recover"
    run_id = "run_atomic_recover"
    repository = TaskRepository(tmp_path / "output")
    await _seed_finalizing_with_publication(
        repository,
        task_id=task_id,
        run_id=run_id,
    )

    manager = make_manager(repository)
    await manager.start()  # start 触发 _recover

    try:
        snapshot = await repository.get_snapshot(task_id)
        assert snapshot is not None
        run = snapshot.runs[0]
        assert run.status.value == "completed", (
            f"recover must close the finalizing run to COMPLETED, "
            f"got {run.status.value}"
        )
        # 补发的 run_completed 事件存在。
        events = await repository.list_events(task_id)
        completed = [
            event
            for event in events
            if isinstance(event.payload, RunCompletedPayload)
        ]
        assert len(completed) == 1
        # 发布事实保留。
        assert snapshot.publications
    finally:
        await manager.close()
