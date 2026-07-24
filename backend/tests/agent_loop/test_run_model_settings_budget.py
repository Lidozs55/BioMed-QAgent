"""Executor budget-boundary regression coverage."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import Mock

import app.agent_loop.runner as runner_module
import pytest
from app.agent_loop.context import RunContext
from app.model_config.context_budget import ContextBudgetConfigurationError
from app.model_settings import ModelConfiguration
from app.runtime.manager import RunExecution


@pytest.mark.asyncio
async def test_executor_rejects_unresolved_budget_before_agent_construction(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Given
    configuration = ModelConfiguration(
        base_url="https://provider.example/v1",
        model_name="unregistered-current-model",
    )
    repository = Mock()
    executor = runner_module.AgentRunExecutor(repository, compactor=Mock())
    build = Mock()
    monkeypatch.setattr(
        runner_module,
        "get_current_model_configuration",
        lambda: configuration,
    )
    monkeypatch.setattr(executor, "_build", build)
    run_streamed = Mock()
    monkeypatch.setattr(runner_module.Runner, "run_streamed", run_streamed)
    execution = RunExecution(
        task_id="task_unresolved_budget",
        run_id="run_unresolved_budget",
        request_id="req_unresolved_budget",
        input="blocked before SDK",
        context=RunContext(task_id="task_unresolved_budget", base_dir=tmp_path),
    )

    # When / Then
    with pytest.raises(ContextBudgetConfigurationError, match="context window"):
        await executor(execution)

    assert build.call_count == 0
    assert repository.task_session.call_count == 0
    assert run_streamed.call_count == 0
