from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest
from app.config import Settings
from app.domain.contracts import (
    RunQueuedPayload,
    RunStatus,
    TaskMode,
    TaskSnapshot,
    TaskSummary,
    build_event,
)
from app.main import create_app
from app.runtime.repository import TaskRepository

NOW = datetime(2026, 7, 16, tzinfo=UTC)


def _empty_snapshot(task_id: str) -> TaskSnapshot:
    return TaskSnapshot(
        task=TaskSummary(
            task_id=task_id,
            mode=TaskMode.AGENT,
            title="responsive storage",
            status=RunStatus.COMPLETED,
            created_at=NOW,
            updated_at=NOW,
        )
    )


def _queued_event(task_id: str):
    return build_event(
        task_id=task_id,
        run_id="run_control",
        sequence=1,
        timestamp=NOW + timedelta(seconds=1),
        payload=RunQueuedPayload(
            request_id="req_control",
            input="keep the control plane responsive",
        ),
    )


def test_repository_storage_remains_responsive_when_default_workers_are_busy(
    tmp_path,
) -> None:
    async def scenario() -> None:
        loop = asyncio.get_running_loop()
        default_executor = ThreadPoolExecutor(
            max_workers=4,
            thread_name_prefix="blocked-runtime",
        )
        storage_executor = ThreadPoolExecutor(
            max_workers=2,
            thread_name_prefix="test-storage",
        )
        loop.set_default_executor(default_executor)
        repository = TaskRepository(
            tmp_path / "output",
            storage_executor=storage_executor,
        )
        task_id = "task_control_executor"
        release_workers = threading.Event()
        all_workers_started = threading.Event()
        started_lock = threading.Lock()
        started_count = 0

        def occupy_default_worker() -> None:
            nonlocal started_count
            with started_lock:
                started_count += 1
                if started_count == 4:
                    all_workers_started.set()
            if not release_workers.wait(timeout=5):
                raise TimeoutError("default worker release timed out")

        await repository.initialize()
        await repository.save_snapshot(_empty_snapshot(task_id))
        blockers = [
            asyncio.create_task(asyncio.to_thread(occupy_default_worker))
            for _ in range(4)
        ]
        try:
            async with asyncio.timeout(1):
                while not all_workers_started.is_set():
                    await asyncio.sleep(0.01)

            snapshot = await asyncio.wait_for(
                repository.get_snapshot(task_id),
                timeout=0.5,
            )
            appended = await asyncio.wait_for(
                repository.append_event(_queued_event(task_id)),
                timeout=0.5,
            )

            assert snapshot is not None
            assert snapshot.task.task_id == task_id
            assert appended.task.latest_sequence == 1
        finally:
            release_workers.set()
            await asyncio.gather(*blockers, return_exceptions=True)
            await repository.close()
            storage_executor.shutdown(wait=True)

    asyncio.run(scenario())


@pytest.mark.asyncio
async def test_fastapi_lifespan_owns_dedicated_storage_executor(tmp_path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))

    async with application.router.lifespan_context(application):
        storage_executor = application.state.storage_executor

        assert isinstance(storage_executor, ThreadPoolExecutor)
        assert storage_executor is not application.state.sync_executor
        assert (
            application.state.task_repository._storage_executor
            is storage_executor
        )
        assert (
            application.state.task_repository.task_session("task_probe")._storage_executor
            is storage_executor
        )

    assert storage_executor._shutdown
    with pytest.raises(RuntimeError, match="cannot schedule new futures after shutdown"):
        storage_executor.submit(lambda: None)
