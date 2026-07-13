from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from agents import Runner

from app.agent_loop.context import RunContext
from app.core.metrics import MetricsTracker
from app.domain.output import OutputBundle
from scripts import demo_workflow


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["success", "error", "cancel"])
async def test_agent_demo_closes_owned_model_on_every_terminal_path(
    monkeypatch: pytest.MonkeyPatch,
    outcome: str,
) -> None:
    model = SimpleNamespace(close=AsyncMock())
    build = SimpleNamespace(agent=object(), skill_names=(), model=model)

    class FakeResult:
        final_output = "complete"

        async def stream_events(self):
            if outcome == "error":
                raise RuntimeError("demo stream failed")
            if outcome == "cancel":
                raise asyncio.CancelledError
            if False:
                yield None

    monkeypatch.setattr(demo_workflow, "build_agent", lambda: build)
    monkeypatch.setattr(
        Runner,
        "run_streamed",
        lambda *args, **kwargs: FakeResult(),
    )

    pipeline = demo_workflow._run_agent_pipeline(
        RunContext(task_id="task_demo"),
        MetricsTracker(task_id="task_demo"),
    )
    if outcome == "error":
        with pytest.raises(RuntimeError, match="demo stream failed"):
            await pipeline
    elif outcome == "cancel":
        with pytest.raises(asyncio.CancelledError):
            await pipeline
    else:
        assert isinstance(await pipeline, OutputBundle)

    model.close.assert_awaited_once_with()
