from __future__ import annotations

import json
from pathlib import Path

import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.pipeline.tool import run_research_pipeline
from app.tools.workdir import create_task_workdir


@pytest.mark.asyncio
async def test_pipeline_function_tool_runs_explicit_fixture_mode(
    tmp_path: Path,
) -> None:
    context = RunContext(task_id="task_tool")
    context._work_dir = create_task_workdir(  # noqa: SLF001
        "task_tool", base_dir=str(tmp_path / "tasks")
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_1",
        tool_arguments="{}",
    )

    payload = json.loads(
        await run_research_pipeline.on_invoke_tool(
            tool_context,
            json.dumps(
                {
                    "topic": "tool supplied acceptance topic",
                    "databases": ["pubmed", "geo"],
                    "mode": "fixture",
                }
            ),
        )
    )

    assert run_research_pipeline.name == "run_research_pipeline"
    assert payload["task_id"] == "task_tool"
    assert payload["status"] == "completed"
    assert payload["validation_status"] == "valid"
    assert payload["artifact_count"] == 14

    manifest = json.loads(
        (
            tmp_path / "tasks" / "task_tool" / "artifacts" / "run_manifest.json"
        ).read_text("utf-8")
    )
    assert manifest["request"]["topic"] == ("tool supplied acceptance topic")


@pytest.mark.asyncio
async def test_pipeline_function_tool_rejects_unimplemented_fixture_sources(
    tmp_path: Path,
) -> None:
    context = RunContext(task_id="task_tool_invalid")
    context._work_dir = create_task_workdir(  # noqa: SLF001
        "task_tool_invalid", base_dir=str(tmp_path / "tasks")
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_2",
        tool_arguments="{}",
    )

    result = await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "unsupported",
                "databases": ["pubmed", "geo", "gdc"],
                "mode": "fixture",
            }
        ),
    )

    assert "exactly pubmed and geo" in result
    assert not (
        tmp_path / "tasks" / "task_tool_invalid" / "artifacts" / "run_manifest.json"
    ).exists()
