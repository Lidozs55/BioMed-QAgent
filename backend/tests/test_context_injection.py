"""Tests for steering context into a task's active run (Codex turn/steer pattern).

Steering must interrupt only the *current* generation and let the same run
continue from session history along the new direction -- no run cancellation,
no restart, and no loss of the conversation so far.  When the task is idle the
labeled text is submitted as a fresh run.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.domain.contracts import RunStatus
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
    """Replaces the run executor; the run stays alive until the stream cancel fires."""

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
async def test_steer_without_active_run_submits_labeled_new_run(
    tmp_path: Path,
) -> None:
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
        body = steered.json()
        assert body["status"] == "steered"
        assert body["run_id"] != ""

        snapshot = await repository.get_snapshot(task_id)
        assert snapshot is not None
        assert "注意：补充说明" in snapshot.runs[-1].input
        assert "方向调整" in snapshot.runs[-1].input
        # 标注后的文本进入模型可见的历史，而不是只做展示。
        session = repository.task_session(task_id)
        model_items = await session.get_items()
        joined = " | ".join(str(item) for item in model_items)
        assert "注意：补充说明" in joined


@pytest.mark.asyncio
async def test_steer_mid_run_keeps_same_run_and_appends_message(
    tmp_path: Path,
) -> None:
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
        body = steered.json()
        assert body["status"] == "steered"
        # 中途转向：仍是同一个 run，不产生新 run，也不取消 run。
        assert body["run_id"] == active_run_id
        assert isinstance(body["message_id"], str) and body["message_id"]
        assert "方向调整" in body["content"]
        assert "immediate" in executor._result.cancel_modes
        await manager.wait_until_idle()

        snapshot = await repository.get_snapshot(task_id)
        assert snapshot is not None
        runs = {run.run_id: run for run in snapshot.runs}
        assert active_run_id in runs
        assert runs[active_run_id].status is not RunStatus.CANCELLED
        assert len(snapshot.runs) == 1
        # 标注后的调整文本作为用户消息进入模型可见的会话历史。
        session = repository.task_session(task_id)
        model_items = await session.get_items()
        joined = " | ".join(str(item) for item in model_items)
        assert "转向：先查 README" in joined
        page = await client.get(f"/api/v1/tasks/{task_id}/messages")
        contents = [
            message["content"]
            for message in page.json()["messages"]
            if message["role"] == "user"
        ]
        assert any("转向：先查 README" in content for content in contents)


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
        # 会优雅地作为新一轮提交（不报错）。
        executor._result.cancel_called.set()
        await manager.wait_until_idle()
        re_steer = await client.post(
            f"/api/v1/tasks/{task_id}/inject-context",
            json={"text": "later", "expected_run_id": active_run_id},
        )
        assert re_steer.status_code == 202
        assert re_steer.json()["status"] == "steered"


@pytest.mark.asyncio
async def test_concurrent_steer_requests_do_not_conflict(tmp_path: Path) -> None:
    """Two racing steers (double-click) must both succeed and both land in history."""

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

        session = repository.task_session(task_id)
        model_items = await session.get_items()
        joined = " | ".join(str(item) for item in model_items)
        assert "转向一" in joined
        assert "转向二" in joined
