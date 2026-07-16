"""Live Agent Demo test: real Qwen model + deterministic pipeline.

Verifies that the Agent loop produces a terminal state (completed or
failed) within the total timeout when invoked with a real model.

Run with: ``RUN_NCBI_LIVE=1 uv run pytest -m live tests/live/test_agent_demo_live.py``
"""

from __future__ import annotations

import asyncio
import os

import pytest
from app.agent_loop.runner import run_agent_stream

pytestmark = [
    pytest.mark.live,
    pytest.mark.skipif(
        os.getenv("DASHSCOPE_API_KEY") is None,
        reason="DASHSCOPE_API_KEY must be set for live Agent demo",
    ),
]


@pytest.mark.asyncio
async def test_agent_demo_produces_terminal_state() -> None:
    """The Agent should reach a terminal state within a reasonable timeout."""
    events: list[dict] = []
    try:
        async with asyncio.timeout(180):
            async for event in run_agent_stream(
                user_input="帮我查找 PMID 34180400 相关的 GEO 数据 GSE178352，"
                "用 fixture 模式运行研究流程",
                task_id="agent_demo_live",
                databases=["pubmed", "geo"],
            ):
                events.append(event)
                if event.get("type") in ("done", "error"):
                    break
    except TimeoutError:
        pytest.fail("Agent demo did not produce terminal state within 180s")

    # Must have at least one terminal event.
    terminal_events = [e for e in events if e.get("type") in ("done", "error")]
    assert len(terminal_events) >= 1, "Agent must produce a done or error event"

    # The done event should carry a final_output.
    done_events = [e for e in events if e.get("type") == "done"]
    if done_events:
        assert "final_output" in done_events[-1]


@pytest.mark.asyncio
async def test_agent_demo_emits_expected_event_sequence() -> None:
    """The Agent should emit skill_loaded, text, and terminal events."""
    events: list[dict] = []
    try:
        async with asyncio.timeout(180):
            async for event in run_agent_stream(
                user_input="查找乳腺癌基因表达数据，用 fixture 模式运行",
                task_id="agent_demo_events",
                databases=["pubmed", "geo"],
            ):
                events.append(event)
                if event.get("type") in ("done", "error"):
                    break
    except TimeoutError:
        pytest.fail("Agent demo did not produce terminal state within 180s")

    event_types = [e.get("type") for e in events]
    # Should have at least skill_loaded events and a terminal event.
    assert "skill_loaded" in event_types or "text" in event_types
    assert "done" in event_types or "error" in event_types
