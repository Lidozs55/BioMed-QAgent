"""Import admission regression coverage for model budgets."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.main import create_app
from app.runtime.manager import RunExecution


@pytest.mark.asyncio
async def test_import_admits_unknown_model_with_inferred_window(
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
        repository = application.state.task_repository
        manager.run_executor = record_execution

        # When
        response = await client.post(
            "/api/v1/import/tasks",
            data={"request_id": "req-inferred-import", "input": "admitted import"},
            files=[("files", ("patients.csv", b"id\n1\n", "text/csv"))],
        )
        await manager.wait_until_idle()

        # Then — admission succeeds and the import task is enqueued.
        assert response.status_code == 202
        assert await repository.find_request("req-inferred-import") is not None
        assert len(executions) == 1
