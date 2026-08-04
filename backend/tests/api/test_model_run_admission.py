"""Model-readiness API admission regression coverage."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.domain.contracts import TaskRunAccepted
from app.main import create_app
from app.model_settings import ModelConfiguration
from app.runtime.manager import RunExecution


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("model_name", "context_window", "expected_source"),
    [
        ("qwen3.6-flash", None, "catalog"),
        ("unregistered-current-model", 65_536, "user"),
    ],
)
async def test_catalog_and_positive_override_admit_model_backed_tasks(
    tmp_path: Path,
    model_name: str,
    context_window: int | None,
    expected_source: str,
) -> None:
    # Given
    settings_path = tmp_path / "settings" / "model.json"
    settings_path.parent.mkdir(parents=True)
    context_window_field = (
        f',"context_window":{context_window}' if context_window is not None else ""
    )
    settings_path.write_text(
        '{"base_url":"https://provider.example/v1","model_name":"'
        f"{model_name}"
        f'"{context_window_field}}}',
        encoding="utf-8",
    )
    application = create_app(Settings(output_dir=str(tmp_path / "output")))

    async def complete(_execution: RunExecution) -> None:
        return None

    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        application.state.task_manager.run_executor = complete
        readiness = await client.get("/api/v1/settings")

        # When
        accepted = await client.post(
            "/api/v1/tasks",
            json={
                "request_id": f"req_ready_{expected_source}",
                "input": "admissible agent task",
            },
        )

        # Then
        assert readiness.status_code == 200
        assert readiness.json()["context_window_source"] == expected_source
        assert readiness.json()["run_ready"] is True
        assert accepted.status_code == 202


@pytest.mark.asyncio
async def test_invalid_readiness_preserves_existing_request_and_blocks_continuation(
    tmp_path: Path,
) -> None:
    # Given
    executions: list[RunExecution] = []

    async def record_execution(execution: RunExecution) -> None:
        executions.append(execution)

    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        manager = application.state.task_manager
        repository = application.state.task_repository
        manager.run_executor = record_execution
        initial = TaskRunAccepted.model_validate(
            (
                await client.post(
                    "/api/v1/tasks",
                    json={"request_id": "req_ready_initial", "input": "first"},
                )
            ).json()
        )
        await manager.wait_until_idle()
        before = await repository.list_events(initial.task_id)
        # Use invalid compaction ratios to create an unresolvable budget
        application.state.model_settings_store._current = ModelConfiguration(
            base_url="https://provider.example/v1",
            model_name="qwen-max",
            compaction_target_ratio=0.90,
            compaction_trigger_ratio=0.80,
        )

        # When
        retry = await client.post(
            "/api/v1/tasks",
            json={"request_id": "req_ready_initial", "input": "first"},
        )
        rejected = await client.post(
            f"/api/v1/tasks/{initial.task_id}/runs",
            json={"request_id": "req_incomplete_continue", "input": "second"},
        )

        # Then
        assert retry.status_code == 202
        assert retry.json() == initial.model_dump(mode="json")
        assert rejected.status_code == 422
        assert "target ratio must be below trigger ratio" in rejected.json()["detail"]
        after = await repository.get_snapshot(initial.task_id)
        assert after is not None
        assert [run.run_id for run in after.runs] == [initial.run_id]
        assert await repository.find_request("req_incomplete_continue") is None
        assert await repository.list_events(initial.task_id) == before
        assert len(executions) == 1


@pytest.mark.asyncio
async def test_unknown_model_settings_admit_model_backed_task_with_inferred_window(
    tmp_path: Path,
) -> None:
    # Given — unknown model resolves a conservative 512K inferred window.
    settings_path = tmp_path / "settings" / "model.json"
    settings_path.parent.mkdir(parents=True)
    settings_path.write_text(
        '{"base_url":"https://provider.example/v1","model_name":"unregistered-current-model"}',
        encoding="utf-8",
    )
    executions: list[RunExecution] = []

    async def record_execution(execution: RunExecution) -> None:
        executions.append(execution)

    application = create_app(Settings(output_dir=str(tmp_path / "output")))
    async with application.router.lifespan_context(application), httpx.AsyncClient(
        transport=httpx.ASGITransport(app=application), base_url="http://localhost"
    ) as client:
        manager = application.state.task_manager
        manager.run_executor = record_execution

        # When
        accepted = await client.post(
            "/api/v1/tasks",
            json={"request_id": "req_inferred_agent", "input": "admitted agent"},
        )
        await manager.wait_until_idle()

        # Then — admission succeeds and the task is executed; feasibility is
        # decided by remaining input capacity, not by a configured window.
        assert accepted.status_code == 202
        assert len(executions) == 1
