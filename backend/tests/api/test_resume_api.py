"""Integration tests for ``POST /api/v1/tasks/{task_id}/runs/{run_id}/resume``.

These tests exercise the HTTP layer of the human-in-the-loop resume endpoint:
error paths (404/409/422/503) and one end-to-end success path driven by a
custom executor that pauses the run in ``AWAITING_USER_INPUT`` and unblocks on
resume.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.domain.contracts import (
    RunStatus,
    UserInputRequiredPayload,
    UserInputResumedPayload,
)
from app.main import create_app
from app.runtime.manager import RunExecution
from fastapi import FastAPI


@asynccontextmanager
async def api_client(
    tmp_path: Path,
    *,
    configured: Settings | None = None,
) -> AsyncIterator[tuple[FastAPI, httpx.AsyncClient]]:
    application = create_app(
        configured or Settings(output_dir=str(tmp_path / "output"))
    )
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        yield application, client


class PausingExecutor:
    """Executor that pauses a run in ``AWAITING_USER_INPUT`` and unblocks on resume.

    Emits ``UserInputRequiredPayload`` via ``execution.emit`` (which the manager
    persists with schema 2.0 + run_id), attaches a real submitter to the live
    execution, then blocks on an ``asyncio.Event`` until the resume decision is
    forwarded by the manager.
    """

    def __init__(self, *, delay_resume_event: bool = False) -> None:
        self.started = asyncio.Event()
        self.paused = asyncio.Event()
        self._release = asyncio.Event()
        self._resume_event_gate = asyncio.Event()
        if not delay_resume_event:
            self._resume_event_gate.set()
        self.decision_received = asyncio.Event()
        self._decision: UserInputResumedPayload | None = None
        self.executions: list[RunExecution] = []

    async def __call__(self, execution: RunExecution) -> None:
        self.executions.append(execution)
        self.started.set()

        def submitter(
            decision: UserInputResumedPayload,
        ) -> bool:
            self._decision = decision
            self.decision_received.set()
            self._release.set()
            return True

        execution.set_user_input_submitter(submitter)
        await execution.emit(
            UserInputRequiredPayload(
                request_id="plan-test",
                prompt_kind="plan_confirmation",
                summary="confirm plan",
            )
        )
        self.paused.set()
        await self._release.wait()
        await self._resume_event_gate.wait()
        # Mirror the real pipeline: emit UserInputResumedPayload after waking
        # so the reducer transitions AWAITING_USER_INPUT -> RUNNING before the
        # manager emits RunFinalizingPayload (RUNNING -> FINALIZING).
        assert self._decision is not None
        await execution.emit(self._decision)


@pytest.mark.asyncio
async def test_resume_missing_task_returns_404(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (_, client):
        response = await client.post(
            "/api/v1/tasks/task_missing/runs/run_1/resume",
            json={
                "request_id": "req_resume",
                "decision": "approve",
                "detail": {},
            },
        )

    assert response.status_code == 404
    assert response.json() == {"detail": "Task not found"}


@pytest.mark.asyncio
async def test_resume_missing_run_returns_404(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (application, client):
        repository = application.state.task_repository
        from app.domain.contracts import TaskMode, TaskSnapshot, TaskSummary

        await repository.save_snapshot(
            TaskSnapshot(
                task=TaskSummary(
                    task_id="task_no_run",
                    mode=TaskMode.AGENT,
                    title="no run",
                    status=RunStatus.COMPLETED,
                    created_at=datetime(2026, 7, 17, tzinfo=UTC),
                    updated_at=datetime(2026, 7, 17, tzinfo=UTC),
                ),
                runs=[],
            )
        )
        response = await client.post(
            "/api/v1/tasks/task_no_run/runs/run_missing/resume",
            json={
                "request_id": "req_resume",
                "decision": "approve",
                "detail": {},
            },
        )

    assert response.status_code == 404
    assert response.json() == {"detail": "Run not found"}


@pytest.mark.asyncio
async def test_resume_run_not_awaiting_returns_409(tmp_path: Path) -> None:
    """A run that is RUNNING (not AWAITING_USER_INPUT) cannot be resumed."""

    executor = PausingExecutor()
    # Override __call__ to never pause — run stays RUNNING.
    started = asyncio.Event()
    release = asyncio.Event()

    async def run_without_pause(execution: RunExecution) -> None:
        executor.executions.append(execution)
        started.set()
        await release.wait()

    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager
        manager.run_executor = run_without_pause
        body = {
            "request_id": "req_running",
            "input": "active run",
            "databases": [],
            "mode": "agent",
        }
        create_response = await client.post("/api/v1/tasks", json=body)
        assert create_response.status_code == 202
        task_id = create_response.json()["task_id"]
        run_id = create_response.json()["run_id"]
        await asyncio.wait_for(started.wait(), timeout=1)

        response = await client.post(
            f"/api/v1/tasks/{task_id}/runs/{run_id}/resume",
            json={
                "request_id": "req_resume",
                "decision": "approve",
                "detail": {},
            },
        )

        assert response.status_code == 409
        assert response.json() == {"detail": "Run is not awaiting user input"}

        release.set()
        await manager.wait_until_idle()


@pytest.mark.asyncio
async def test_resume_validates_body_and_returns_422(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (_, client):
        # Empty body (missing required fields).
        response = await client.post(
            "/api/v1/tasks/task_x/runs/run_x/resume",
            json={},
        )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_resume_invalid_decision_value_returns_422(tmp_path: Path) -> None:
    async with api_client(tmp_path) as (_, client):
        response = await client.post(
            "/api/v1/tasks/task_x/runs/run_x/resume",
            json={
                "request_id": "req_resume",
                "decision": "maybe",  # not in {"approve","reject"}
                "detail": {},
            },
        )

    assert response.status_code == 422


@pytest.mark.asyncio
async def test_resume_without_lifespan_returns_503(tmp_path: Path) -> None:
    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application),
        base_url="http://localhost",
    ) as client:
        response = await client.post(
            "/api/v1/tasks/task_x/runs/run_x/resume",
            json={
                "request_id": "req_resume",
                "decision": "approve",
                "detail": {},
            },
        )

    assert response.status_code == 503
    assert response.json() == {"detail": "Task runtime is unavailable"}


@pytest.mark.asyncio
async def test_resume_approve_unblocks_paused_run_and_returns_202(
    tmp_path: Path,
) -> None:
    """End-to-end: pause a real run, resume via HTTP, verify 202 + state."""

    executor = PausingExecutor()
    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager
        manager.run_executor = executor

        body = {
            "request_id": "req_resume_e2e",
            "input": "pause and resume",
            "databases": [],
            "mode": "agent",
        }
        create_response = await client.post("/api/v1/tasks", json=body)
        assert create_response.status_code == 202
        task_id = create_response.json()["task_id"]
        run_id = create_response.json()["run_id"]

        # Wait for the executor to emit UserInputRequiredPayload and pause.
        await asyncio.wait_for(executor.paused.wait(), timeout=2)

        # The snapshot must reflect AWAITING_USER_INPUT.
        snapshot_response = await client.get(f"/api/v1/tasks/{task_id}")
        assert snapshot_response.status_code == 200
        snapshot = snapshot_response.json()
        assert snapshot["task"]["status"] == "awaiting_user_input"
        assert snapshot["runs"][0]["status"] == "awaiting_user_input"

        # Submit the resume decision.
        resume_response = await client.post(
            f"/api/v1/tasks/{task_id}/runs/{run_id}/resume",
            json={
                "request_id": "plan-test",
                "decision": "approve",
                "detail": {"note": "plan looks good"},
            },
        )

        assert resume_response.status_code == 202
        # The submitter received the decision.
        assert executor._decision is not None
        assert executor._decision.decision == "approve"
        assert executor._decision.request_id == "plan-test"

        # Let the executor finish.
        await manager.wait_until_idle()

        # Final snapshot must be terminal (COMPLETED — executor returns cleanly).
        final_response = await client.get(f"/api/v1/tasks/{task_id}")
        assert final_response.status_code == 200
        final_snapshot = final_response.json()
        assert final_snapshot["task"]["status"] == "completed"


@pytest.mark.asyncio
async def test_resume_reject_decision_is_forwarded(tmp_path: Path) -> None:
    """``reject`` decisions are forwarded to the executor verbatim."""

    executor = PausingExecutor()
    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager
        manager.run_executor = executor

        body = {
            "request_id": "req_resume_reject",
            "input": "pause and reject",
            "databases": [],
            "mode": "agent",
        }
        create_response = await client.post("/api/v1/tasks", json=body)
        task_id = create_response.json()["task_id"]
        run_id = create_response.json()["run_id"]

        await asyncio.wait_for(executor.paused.wait(), timeout=2)

        resume_response = await client.post(
            f"/api/v1/tasks/{task_id}/runs/{run_id}/resume",
            json={
                "request_id": "plan-test",
                "decision": "reject",
                "detail": {"reason": "plan is off-topic"},
            },
        )

        assert resume_response.status_code == 202
        assert executor._decision is not None
        assert executor._decision.decision == "reject"
        assert executor._decision.detail == {"reason": "plan is off-topic"}

        await manager.wait_until_idle()


@pytest.mark.asyncio
async def test_resume_wrong_request_id_returns_409_and_keeps_request_pending(
    tmp_path: Path,
) -> None:

    executor = PausingExecutor()
    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager
        manager.run_executor = executor

        body = {
            "request_id": "req_resume_unknown",
            "input": "pause",
            "databases": [],
            "mode": "agent",
        }
        create_response = await client.post("/api/v1/tasks", json=body)
        task_id = create_response.json()["task_id"]
        run_id = create_response.json()["run_id"]

        await asyncio.wait_for(executor.paused.wait(), timeout=2)

        response = await client.post(
            f"/api/v1/tasks/{task_id}/runs/{run_id}/resume",
            json={
                "request_id": "wrong-id",
                "decision": "approve",
                "detail": {},
            },
        )

        assert response.status_code == 409
        assert response.json() == {"detail": "Run is not awaiting user input"}
        assert executor._decision is None

        accepted = await client.post(
            f"/api/v1/tasks/{task_id}/runs/{run_id}/resume",
            json={
                "request_id": "plan-test",
                "decision": "approve",
                "detail": {},
            },
        )

        assert accepted.status_code == 202
        assert executor._decision is not None
        assert executor._decision.request_id == "plan-test"

        await manager.wait_until_idle()


@pytest.mark.asyncio
async def test_resume_duplicate_decision_returns_409_without_overwrite(
    tmp_path: Path,
) -> None:
    executor = PausingExecutor(delay_resume_event=True)
    async with api_client(tmp_path) as (application, client):
        manager = application.state.task_manager
        manager.run_executor = executor

        create_response = await client.post(
            "/api/v1/tasks",
            json={
                "request_id": "req_resume_duplicate",
                "input": "pause",
                "databases": [],
                "mode": "agent",
            },
        )
        task_id = create_response.json()["task_id"]
        run_id = create_response.json()["run_id"]
        await asyncio.wait_for(executor.paused.wait(), timeout=2)

        first = await client.post(
            f"/api/v1/tasks/{task_id}/runs/{run_id}/resume",
            json={
                "request_id": "plan-test",
                "decision": "approve",
                "detail": {"sequence": 1},
            },
        )
        await asyncio.wait_for(executor.decision_received.wait(), timeout=1)
        duplicate = await client.post(
            f"/api/v1/tasks/{task_id}/runs/{run_id}/resume",
            json={
                "request_id": "plan-test",
                "decision": "reject",
                "detail": {"sequence": 2},
            },
        )

        assert first.status_code == 202
        assert duplicate.status_code == 409
        assert duplicate.json() == {"detail": "Run is not awaiting user input"}
        assert executor._decision is not None
        assert executor._decision.decision == "approve"
        assert executor._decision.detail == {"sequence": 1}

        executor._resume_event_gate.set()
        await manager.wait_until_idle()
