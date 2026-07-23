"""Managed streamed-request usage capture regressions."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import app.agent_loop.model as model_module
import app.agent_loop.runner as runner_module
import pytest
from agents import ModelSettings
from agents.usage import Usage
from app.model_config import RunModelSettings, UserSettings
from app.runtime.manager import RunExecution


def _run_settings() -> RunModelSettings:
    return RunModelSettings.from_user_settings(UserSettings(model_name="qwen-plus"))


def test_managed_model_settings_request_authoritative_stream_usage() -> None:
    # Given
    run_settings = _run_settings()

    # When
    request_settings = model_module.build_sdk_model_settings(run_settings)

    # Then
    assert request_settings == ModelSettings(
        max_tokens=run_settings.max_tokens,
        temperature=run_settings.temperature,
        top_p=run_settings.top_p,
        include_usage=True,
        extra_body={
            "repetition_penalty": run_settings.repetition_penalty,
            "enable_search": run_settings.enable_search,
            "enable_thinking": run_settings.thinking_mode,
        },
    )


@pytest.mark.asyncio
async def test_executor_forwards_streamed_usage_to_calibration(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    model = SimpleNamespace(close=AsyncMock())
    build = SimpleNamespace(agent=object(), model=model)
    usage = Usage(input_tokens=345, output_tokens=12, total_tokens=357)
    result = SimpleNamespace(
        raw_responses=[SimpleNamespace(usage=usage)],
        final_output="completed",
    )
    observed: list[object] = []

    class _NoopCompactor:
        async def prepare(self, task_id: str, **kwargs: object) -> SimpleNamespace:
            return SimpleNamespace(
                session=kwargs["session"],
                agent_input=kwargs["request"].agent_input,
                estimate=SimpleNamespace(total=300),
            )

    class _Result:
        raw_responses = result.raw_responses
        final_output = result.final_output

        async def stream_events(self):
            if False:
                yield None

    execution = RunExecution(
        task_id="task_usage",
        run_id="run_usage",
        request_id="request_usage",
        input="capture streamed usage",
        context=SimpleNamespace(cancellation_requested=asyncio.Event()),
    )
    repository = SimpleNamespace(
        task_session=lambda task_id, *, run_id: SimpleNamespace(),
    )
    executor = runner_module.AgentRunExecutor(repository, compactor=_NoopCompactor())
    monkeypatch.setattr(runner_module, "to_run_model_settings", lambda _: _run_settings())
    monkeypatch.setattr(executor, "_build", lambda _: build)
    monkeypatch.setattr(runner_module.Runner, "run_streamed", lambda *args, **kwargs: _Result())
    monkeypatch.setattr(
        runner_module,
        "record_calibration_from_result",
        lambda recorded, estimate, budget: observed.append(recorded),
    )

    # When
    await executor(execution)

    # Then
    assert len(observed) == 1
    assert observed[0].raw_responses[-1].usage.input_tokens == 345
    model.close.assert_awaited_once_with()
