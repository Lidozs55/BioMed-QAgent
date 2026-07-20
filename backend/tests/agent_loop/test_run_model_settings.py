"""Run-owned model-settings regression coverage."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import app.agent_loop.model as model_module
import app.agent_loop.runner as runner_module
import app.settings_manager as settings_manager
import pytest
from app.agent_loop.context import RunContext
from app.agent_loop.import_agent import build_attachment_parsing_agent
from app.agent_loop.model import run_model_settings_scope
from app.model_config import RunModelSettings, UserSettings
from app.runtime.manager import RunExecution


class NoopCompactor:
    async def prepare(self, task_id, **kwargs):
        return SimpleNamespace(session=object())


@pytest.mark.asyncio
async def test_executor_keeps_run_start_settings_before_first_model_call(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Given
    initial_settings = UserSettings(
        api_key="run-api-key",
        base_url="https://run.example/v1",
        model_name="run-model",
    )
    updated_settings = UserSettings(
        api_key="updated-api-key",
        base_url="https://updated.example/v1",
        model_name="updated-model",
    )
    settings_getter = Mock(return_value=initial_settings)
    monkeypatch.setattr(settings_manager, "get_settings", settings_getter)
    client = object()
    delegate = SimpleNamespace(
        stream_response=Mock(return_value="stream"),
        close=AsyncMock(),
    )
    client_factory = Mock(return_value=client)
    delegate_factory = Mock(return_value=delegate)
    monkeypatch.setattr(model_module, "AsyncOpenAI", client_factory)
    monkeypatch.setattr(model_module, "OpenAIChatCompletionsModel", delegate_factory)
    context = RunContext(
        task_id="task_model_snapshot",
        base_dir=tmp_path,
        managed_run_id="run_model_snapshot",
    )
    execution = RunExecution(
        task_id=context.task_id,
        run_id="run_model_snapshot",
        request_id="request_model_snapshot",
        input="test run settings snapshot",
        context=context,
    )

    class FakeResult:
        def __init__(self, model) -> None:
            self._model = model

        async def stream_events(self):
            settings_getter.return_value = updated_settings
            assert self._model.stream_response("first model call") == "stream"
            if False:
                yield None

    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda agent, *args, **kwargs: FakeResult(agent.model),
    )
    executor = runner_module.AgentRunExecutor(
        SimpleNamespace(task_session=lambda task_id, *, run_id: object()),
        compactor=NoopCompactor(),
    )

    # When
    await executor(execution)

    # Then
    settings_getter.assert_called_once_with()
    client_factory.assert_called_once_with(
        api_key="run-api-key",
        base_url="https://run.example/v1",
    )
    delegate_factory.assert_called_once_with(
        model="run-model",
        openai_client=client,
    )


def test_attachment_agent_uses_active_run_settings_snapshot(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Given
    run_settings = UserSettings(
        api_key="attachment-api-key",
        base_url="https://attachment.example/v1",
        model_name="attachment-model",
    )
    runtime_getter = Mock(
        return_value=UserSettings(
            api_key="updated-api-key",
            base_url="https://updated.example/v1",
            model_name="updated-model",
        )
    )
    monkeypatch.setattr(settings_manager, "get_settings", runtime_getter)
    client = object()
    client_factory = Mock(return_value=client)
    delegate_factory = Mock(return_value=Mock(stream_response=Mock(return_value="stream")))
    monkeypatch.setattr(model_module, "AsyncOpenAI", client_factory)
    monkeypatch.setattr(model_module, "OpenAIChatCompletionsModel", delegate_factory)

    # When
    with run_model_settings_scope(RunModelSettings.from_user_settings(run_settings)):
        build = build_attachment_parsing_agent()
    assert build.model.stream_response("first model call") == "stream"

    # Then
    runtime_getter.assert_not_called()
    client_factory.assert_called_once_with(
        api_key="attachment-api-key",
        base_url="https://attachment.example/v1",
    )
    delegate_factory.assert_called_once_with(
        model="attachment-model",
        openai_client=client,
    )
