from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import app.agent_loop.model as model_module
import app.agent_loop.runner as runner_module
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
    monkeypatch.setattr(
        runner_module, "settings", SimpleNamespace(output_dir=str(tmp_path))
    )
    sdk_called = False

    def fail_if_called(*args, **kwargs):
        nonlocal sdk_called
        sdk_called = True
        raise AssertionError("SDK boundary must not run")

    monkeypatch.setattr(runner_module.Runner, "run_streamed", fail_if_called)

    events = [event async for event in runner_module.run_agent_stream("test")]

    assert sdk_called is False
    assert events == [
        {
            "type": "error",
            "code": "configuration_error",
            "message": "DASHSCOPE_API_KEY is required to run the model",
        }
    ]


@pytest.mark.asyncio
async def test_runner_reaches_sdk_boundary_with_configured_key(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    configure_model(monkeypatch, "configured")
    monkeypatch.setattr(
        runner_module, "settings", SimpleNamespace(output_dir=str(tmp_path))
    )
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

    model = SimpleNamespace(close=AsyncMock())
    monkeypatch.setattr(runner_module.Runner, "run_streamed", fake_run_streamed)
    monkeypatch.setattr(
        runner_module,
        "build_agent",
        lambda databases=None: SimpleNamespace(
            agent=object(),
            skill_names=(),
            model=model,
        ),
    )

    events = [event async for event in runner_module.run_agent_stream("test")]

    assert sdk_called is True
    assert events == [{"type": "done", "final_output": "complete"}]


@pytest.mark.asyncio
async def test_legacy_runner_closes_build_model_when_stream_fails(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    model = SimpleNamespace(close=AsyncMock())
    agent = SimpleNamespace(model=model)
    build = SimpleNamespace(agent=agent, skill_names=(), model=model)

    class FakeResult:
        async def stream_events(self):
            raise RuntimeError("legacy stream failed")
            if False:
                yield None

    monkeypatch.setattr(runner_module, "require_model_credentials", lambda: None)
    monkeypatch.setattr(runner_module, "build_agent", lambda databases=None: build)
    monkeypatch.setattr(
        runner_module.Runner,
        "run_streamed",
        lambda *args, **kwargs: FakeResult(),
    )
    monkeypatch.setattr(
        runner_module,
        "settings",
        SimpleNamespace(output_dir=str(tmp_path)),
    )

    events = [event async for event in runner_module.run_agent_stream("test")]

    assert events == [{"type": "error", "message": "legacy stream failed"}]
    model.close.assert_awaited_once_with()
