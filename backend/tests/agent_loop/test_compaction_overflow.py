"""Executor coverage for pre-provider context-budget overflow."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import app.agent_loop.runner as runner_module
import pytest
from app.model_config import RunModelSettings, UserSettings
from app.model_config.context_budget import ContextBudgetOverflowError
from app.runtime.manager import RunExecution


class _OverflowCompactor:
    async def prepare(self, task_id: str, **kwargs: object) -> None:
        raise ContextBudgetOverflowError(estimated_tokens=900, limit_tokens=400)


@pytest.mark.asyncio
async def test_executor_does_not_call_provider_after_compaction_overflow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    model = SimpleNamespace(close=AsyncMock())
    build = SimpleNamespace(agent=object(), model=model)
    run_settings = RunModelSettings.from_user_settings(
        UserSettings(model_name="qwen-plus")
    )
    calls: list[object] = []
    execution = RunExecution(
        task_id="task_overflow",
        run_id="run_overflow",
        request_id="request_overflow",
        input="must not reach provider",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
    )
    repository = SimpleNamespace(
        task_session=lambda task_id, *, run_id: SimpleNamespace(),
    )
    executor = runner_module.AgentRunExecutor(repository, compactor=_OverflowCompactor())
    monkeypatch.setattr(runner_module, "to_run_model_settings", lambda _: run_settings)
    monkeypatch.setattr(executor, "_build", lambda _: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: calls.append((args, kwargs)),
    )

    # When / Then
    with pytest.raises(ContextBudgetOverflowError):
        await executor(execution)

    assert calls == []
    model.close.assert_awaited_once_with()
