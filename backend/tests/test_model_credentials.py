from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import app.agent_loop.model as model_module
import app.agent_loop.runner as runner_module
import pytest
from app.agent_loop.agent import create_agent
from app.agent_loop.model import (
    LazyDashScopeModel,
    ModelConfigurationError,
    require_model_credentials,
)


def configure_model(monkeypatch: pytest.MonkeyPatch, api_key: str) -> None:
    monkeypatch.setattr(
        model_module,
        "settings",
        SimpleNamespace(
            dashscope_api_key=api_key,
            dashscope_base_url="https://example.test/v1",
            model_name="test-model",
        ),
    )


def test_agent_construction_succeeds_without_model_credentials(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_model(monkeypatch, "")

    agent = create_agent()

    assert isinstance(agent.model, LazyDashScopeModel)


def test_execution_guard_raises_stable_configuration_error_without_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    configure_model(monkeypatch, "")

    with pytest.raises(ModelConfigurationError) as caught:
        require_model_credentials()

    assert caught.value.code == "configuration_error"
    assert "DASHSCOPE_API_KEY" in str(caught.value)


@pytest.mark.asyncio
async def test_runner_stops_before_sdk_boundary_without_key(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure_model(monkeypatch, "")
    monkeypatch.setattr(runner_module, "settings", SimpleNamespace(output_dir=str(tmp_path)))
    sdk_called = False

    def fail_if_called(*args, **kwargs):
        nonlocal sdk_called
        sdk_called = True
        raise AssertionError("SDK boundary must not run")

    monkeypatch.setattr(runner_module.Runner, "run_streamed", fail_if_called)

    events = [event async for event in runner_module.run_agent_stream("test")]

    assert sdk_called is False
    assert events == [{
        "type": "error",
        "code": "configuration_error",
        "message": "DASHSCOPE_API_KEY is required to run the model",
    }]


@pytest.mark.asyncio
async def test_runner_reaches_sdk_boundary_with_configured_key(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure_model(monkeypatch, "configured")
    monkeypatch.setattr(runner_module, "settings", SimpleNamespace(output_dir=str(tmp_path)))
    sdk_called = False

    class FakeResult:
        final_output = "complete"

        async def stream_events(self):
            if False:
                yield None

    def fake_run_streamed(*args, **kwargs):
        nonlocal sdk_called
        sdk_called = True
        return FakeResult()

    monkeypatch.setattr(runner_module.Runner, "run_streamed", fake_run_streamed)
    monkeypatch.setattr(runner_module, "get_loaded_skill_names", lambda: [])

    events = [event async for event in runner_module.run_agent_stream("test")]

    assert sdk_called is True
    assert events == [{"type": "done", "final_output": "complete"}]
