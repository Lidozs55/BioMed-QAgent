"""Import admission regression coverage for incomplete model budgets."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.main import create_app
from app.runtime.manager import RunExecution


@pytest.mark.asyncio
async def test_import_rejects_incomplete_model_before_creating_task_and_cleans_staging(
    tmp_path: Path,
) -> None:
    # Given
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
        repository = application.state.task_repository
        manager.run_executor = record_execution

        # When
        response = await client.post(
            "/api/v1/import/tasks",
            data={"request_id": "req-incomplete-import", "input": "blocked import"},
            files=[("files", ("patients.csv", b"id\n1\n", "text/csv"))],
        )

        # Then
        assert response.status_code == 422
        assert response.json() == {
            "detail": "a positive context window is required",
        }
        assert [
            path
            for path in repository.tasks_dir.iterdir()
            if path.is_dir() and path.name != ".uploads"
        ] == []
        assert await repository.find_request("req-incomplete-import") is None
        assert not (repository.tasks_dir / ".uploads").exists()
        assert executions == []
