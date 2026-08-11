"""Tests for steering context into a task's active run (Codex turn/steer pattern).

Injected text must affect the *current* round: the endpoint cancels the active
run and immediately submits a fresh run with the text as its user input, so the
model re-plans along the new direction instead of waiting for the next run.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.domain.contracts import (
    RunCancelledPayload,
    RunQueuedPayload,
    RunStatus,
    TaskRunAccepted,
)
from app.main import create_app
from fastapi import FastAPI


@asynccontextmanager
async def api_client(
    tmp_path: Path,
) -> AsyncIterator[tuple[FastAPI, httpx.AsyncClient]]:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        yield application, client


class CooperativeCancellationExecutor:
    """Replaces the run executor; a run stays active until cancellation is sent."""

    class StreamingResult:
        def __init__(self) -> None:
            self.cancel_called = asyncio.Event()
            self.cancel_modes: list[str] = []

        def cancel(self, mode: str) -> None:
            self.cancel_modes.append(mode)
            self.cancel_called.set()

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self._result = self.StreamingResult()

    async def __call__(self, execution: object) -> None:
        execution.set_streaming_result(self._result)  # type: ignore[attr-defined]
        self.started.set()
        await self._result.cancel_called.wait()


@pytest.mark.asyncio
async def test_steer_without_active_run_queues_new_run(tmp_path: Path) -> None:
    async def complete(_execution: object) -> None:
        return None

    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager
        repository = application.state.task_repository
        manager.run_executor = complete
        created = await client.post(
            "/api/v1/tasks",
            json={"request_id": "req-steer-idle", "input": "research"},
        )
        assert created.status_code == 202
        task_id = created.json()["task_id"]
        await manager.wait_until_idle()

        steered = await client.post(
            f"/api/v1/tasks/{task_id}/inject-context",
            json={"text": "注意：补充说明"},
        )
        assert steered.status_code == 202
        accepted = TaskRunAccepted.model_validate(steered.json())
        assert accepted.task_id == task_id
        assert accepted.status == "queued"

        snapshot = await repository.get_snapshot(task_id)
        assert snapshot is not None
        assert "注意：补充说明" in snapshot.runs[-1].input
        assert "方向调整" in snapshot.runs[-1].input
        # 注入文本进入模型可见的历史，而不是只做展示。
        session = repository.task_session(task_id)
        model_items = await session.get_items()
        assert any("注意：补充说明" in str(item) for item in model_items)
        page = await client.get(f"/api/v1/tasks/{task_id}/messages")
        assert page.status_code == 200
        contents = [
            message["content"]
            for message in page.json()["messages"]
            if message["role"] == "user"
        ]
        assert any("注意：补充说明" in content for content in contents)


@pytest.mark.asyncio
async def test_steer_cancels_active_run_and_starts_new_run(tmp_path: Path) -> None:
    executor = CooperativeCancellationExecutor()
    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager
        repository = application.state.task_repository
        manager.run_executor = executor
        created = await client.post(
            "/api/v1/tasks",
            json={"request_id": "req-steer-active", "input": "original"},
        )
        assert created.status_code == 202
        task_id = created.json()["task_id"]
        await asyncio.wait_for(executor.started.wait(), timeout=1)
        snapshot = await repository.get_snapshot(task_id)
        assert snapshot is not None
        active_run_id = snapshot.task.active_run_id
        assert active_run_id is not None

        steered = await client.post(
            f"/api/v1/tasks/{task_id}/inject-context",
            json={"text": "转向：先查 README", "expected_run_id": active_run_id},
        )
        assert steered.status_code == 202
        assert "immediate" in executor._result.cancel_modes
        accepted = TaskRunAccepted.model_validate(steered.json())
        assert accepted.run_id != active_run_id
        await manager.wait_until_idle()

        snapshot = await repository.get_snapshot(task_id)
        assert snapshot is not None
        old_run = next(run for run in snapshot.runs if run.run_id == active_run_id)
        assert old_run.status is RunStatus.CANCELLED
        new_run = next(run for run in snapshot.runs if run.run_id == accepted.run_id)
        assert "转向：先查 README" in new_run.input
        events = await repository.list_events(task_id)
        assert any(isinstance(event.payload, RunCancelledPayload) for event in events)
        assert any(
            isinstance(event.payload, RunQueuedPayload)
            and "转向：先查 README" in event.payload.input
            for event in events
        )
        session = repository.task_session(task_id)
        model_items = await session.get_items()
        assert any("转向：先查 README" in str(item) for item in model_items)


@pytest.mark.asyncio
async def test_steer_expected_run_id_precondition(tmp_path: Path) -> None:
    executor = CooperativeCancellationExecutor()
    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager
        repository = application.state.task_repository
        manager.run_executor = executor
        created = await client.post(
            "/api/v1/tasks",
            json={"request_id": "req-steer-precondition", "input": "original"},
        )
        assert created.status_code == 202
        task_id = created.json()["task_id"]
        await asyncio.wait_for(executor.started.wait(), timeout=1)
        snapshot = await repository.get_snapshot(task_id)
        assert snapshot is not None
        active_run_id = snapshot.task.active_run_id
        assert active_run_id is not None

        mismatch = await client.post(
            f"/api/v1/tasks/{task_id}/inject-context",
            json={"text": "stale", "expected_run_id": "run_stale"},
        )
        assert mismatch.status_code == 409

        # 释放活动 run，让它正常结束；之后带过期 expected_run_id 的 steer
        # 会优雅地重定向为新 run（不报错）。
        executor._result.cancel_called.set()
        await manager.wait_until_idle()
        re_steer = await client.post(
            f"/api/v1/tasks/{task_id}/inject-context",
            json={"text": "later", "expected_run_id": active_run_id},
        )
        assert re_steer.status_code == 202
        accepted = TaskRunAccepted.model_validate(re_steer.json())
        assert accepted.run_id != active_run_id


@pytest.mark.asyncio
async def test_concurrent_steer_requests_do_not_conflict(tmp_path: Path) -> None:
    """Two racing steers (double-click) must both succeed, not 409-conflict."""

    executor = CooperativeCancellationExecutor()
    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager
        repository = application.state.task_repository
        manager.run_executor = executor
        created = await client.post(
            "/api/v1/tasks",
            json={"request_id": "req-steer-race", "input": "original"},
        )
        assert created.status_code == 202
        task_id = created.json()["task_id"]
        await asyncio.wait_for(executor.started.wait(), timeout=1)
        snapshot = await repository.get_snapshot(task_id)
        assert snapshot is not None
        active_run_id = snapshot.task.active_run_id
        assert active_run_id is not None

        first, second = await asyncio.gather(
            client.post(
                f"/api/v1/tasks/{task_id}/inject-context",
                json={"text": "转向一", "expected_run_id": active_run_id},
            ),
            client.post(
                f"/api/v1/tasks/{task_id}/inject-context",
                json={"text": "转向二", "expected_run_id": active_run_id},
            ),
        )
        assert first.status_code == second.status_code == 202
        await manager.wait_until_idle()

        snapshot = await repository.get_snapshot(task_id)
        assert snapshot is not None
        old_run = next(run for run in snapshot.runs if run.run_id == active_run_id)
        assert old_run.status is RunStatus.CANCELLED
        session = repository.task_session(task_id)
        model_items = await session.get_items()
        joined = " | ".join(str(item) for item in model_items)
        assert "转向一" in joined
        assert "转向二" in joined
