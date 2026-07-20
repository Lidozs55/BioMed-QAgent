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
from app.model_config import AdvancedParams, RunModelSettings, UserSettings
from app.runtime.manager import RunExecution


class NoopCompactor:
    async def prepare(self, task_id, **kwargs):
        return SimpleNamespace(session=object())


def test_run_model_settings_copies_all_persisted_generation_fields() -> None:
    # Given
    user_settings = UserSettings(
        api_key="run-api-key",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name="qwen3.5-plus",
        max_tokens=4096,
        advanced=AdvancedParams(
            temperature=0.2,
            top_p=0.65,
            repetition_penalty=1.15,
            enable_search=False,
            thinking_mode=True,
        ),
    )

    # When
    run_settings = RunModelSettings.from_user_settings(user_settings)

    # Then
    assert run_settings.max_tokens == 4096
    assert run_settings.temperature == 0.2
    assert run_settings.top_p == 0.65
    assert run_settings.repetition_penalty == 1.15
    assert run_settings.enable_search is False
    assert run_settings.thinking_mode is True


@pytest.mark.asyncio
async def test_executor_keeps_run_start_settings_before_first_model_call(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    # Given
    initial_settings = UserSettings(
        api_key="run-api-key",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model_name="qwen-plus",
        max_tokens=1234,
        advanced=AdvancedParams(
            temperature=0.23,
            top_p=0.67,
            repetition_penalty=1.11,
            enable_search=False,
            thinking_mode=True,
        ),
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
    monkeypatch.setattr(model_module, "validate_public_http_url", lambda url: url)
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
        def __init__(self, agent) -> None:
            self._agent = agent
            self._model = agent.model

        async def stream_events(self):
            settings_getter.return_value = updated_settings
            assert self._agent.model_settings.max_tokens == 1234
            assert self._agent.model_settings.temperature == 0.23
            assert self._agent.model_settings.top_p == 0.67
            assert self._agent.model_settings.extra_body == {
                "repetition_penalty": 1.11,
                "enable_search": False,
                "enable_thinking": True,
            }
            assert self._model.stream_response("first model call") == "stream"
            if False:
                yield None

    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda agent, *args, **kwargs: FakeResult(agent),
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
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
    )
    delegate_factory.assert_called_once_with(
        model="qwen-plus",
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
    monkeypatch.setattr(model_module, "validate_public_http_url", lambda url: url)

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
