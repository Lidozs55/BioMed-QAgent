"""Import admission regression coverage for model budgets."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest
from app.config import Settings
from app.main import create_app
from app.runtime.manager import RunExecution


@pytest.mark.asyncio
async def test_import_rejects_unknown_model_without_context_window(
    tmp_path: Path,
) -> None:
    # Given — unknown model has no trusted context-window metadata.
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

        # Then — admission fails and staged uploads do not create a request.
        assert response.status_code == 422
        assert "positive context window" in response.json()["detail"]
        assert await repository.find_request("req-inferred-import") is None
        assert executions == []
