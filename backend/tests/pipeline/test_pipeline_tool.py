from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import app.pipeline.tool as pipeline_tool_module
import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.model_config import RunModelSettings, UserSettings
from app.pipeline.runner import PendingPublicationCleanup
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
    assert payload["artifact_count"] == 15

    # Tool 必须返回实际 artifact 文件名清单，避免 LLM 在报告中编造文件名
    # (例如把 main_data.csv 编造成 merged_comorbidity_data.csv)。
    # See docs/REVIEW_2026-07-18.md §15.2 / §16.
    assert "artifacts" in payload
    artifact_names = [entry["name"] for entry in payload["artifacts"]]
    assert "main_data.csv" in artifact_names
    assert "literature.csv" in artifact_names
    assert "run_manifest.json" not in artifact_names  # manifest 不在 artifacts 列表
    # 每个 artifact entry 必须包含 name/size_bytes/media_type
    for entry in payload["artifacts"]:
        assert {"name", "size_bytes", "media_type"} <= set(entry.keys())
    # note 字段提示 LLM 不要编造文件名
    assert "do not invent filenames" in payload["note"]

    manifest = json.loads(
        (
            tmp_path / "tasks" / "task_tool" / "artifacts" / "run_manifest.json"
        ).read_text("utf-8")
    )
    assert manifest["request"]["topic"] == ("tool supplied acceptance topic")
    assert context.take_pending_publication() is None


@pytest.mark.asyncio
async def test_pipeline_function_tool_defers_managed_run_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_id = "run_tool_managed"
    context = RunContext(
        task_id="task_tool_managed",
        base_dir=tmp_path / "tasks",
        managed_run_id=run_id,
        model_settings=RunModelSettings.from_user_settings(
            UserSettings(model_name="run-start-model", context_window=65_536)
        ),
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_managed",
        tool_arguments="{}",
    )
    pending = SimpleNamespace(run_id=run_id)
    captured: dict[str, object] = {}

    class FakeRunner:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)

        async def run(self):
            return SimpleNamespace(
                task_id=context.task_id,
                task_state=SimpleNamespace(value="completed"),
                validation=SimpleNamespace(status="valid"),
                artifacts=[],
            )

        def pending_publication(self):
            return pending

    monkeypatch.setattr(pipeline_tool_module, "PipelineRunner", FakeRunner)

    await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "managed publication",
                "databases": ["pubmed", "geo"],
                "mode": "fixture",
            }
        ),
    )

    assert captured["run_id"] == run_id
    assert captured["defer_publication"] is True
    assert captured["model_name"] == "run-start-model"
    assert context.take_pending_publication() is pending


@pytest.mark.asyncio
async def test_pipeline_function_tool_retains_cleanup_when_abort_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_id = "run_tool_abort_failure"
    context = RunContext(
        task_id="task_tool_abort_failure",
        base_dir=tmp_path / "tasks",
        managed_run_id=run_id,
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_abort_failure",
        tool_arguments="{}",
    )

    class FakeRunner:
        def __init__(self, **kwargs) -> None:
            pass

        async def run(self):
            raise RuntimeError("pipeline failed")

        def abort(self) -> None:
            raise OSError("abort failed")

    monkeypatch.setattr(pipeline_tool_module, "PipelineRunner", FakeRunner)

    result = await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "failed managed publication",
                "databases": ["pubmed", "geo"],
                "mode": "fixture",
            }
        ),
    )

    assert "abort failed" in result
    with pytest.raises(RuntimeError, match="already reserved"):
        context.reserve_pipeline_publication()
    cleanup = context.take_pending_publication()
    assert isinstance(cleanup, PendingPublicationCleanup)
    assert cleanup.run_id == run_id
    assert isinstance(cleanup.error, OSError)
    assert str(cleanup.error) == "abort failed"
    assert context.reserve_pipeline_publication() == run_id


@pytest.mark.asyncio
async def test_pipeline_function_tool_rejects_parallel_managed_invocation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run_id = "run_tool_parallel"
    context = RunContext(
        task_id="task_tool_parallel",
        base_dir=tmp_path / "tasks",
        managed_run_id=run_id,
    )
    started = asyncio.Event()
    release = asyncio.Event()
    constructed = 0
    pending = SimpleNamespace(run_id=run_id)

    class FakeRunner:
        def __init__(self, **kwargs) -> None:
            nonlocal constructed
            constructed += 1

        async def run(self):
            started.set()
            await release.wait()
            return SimpleNamespace(
                task_id=context.task_id,
                task_state=SimpleNamespace(value="completed"),
                validation=SimpleNamespace(status="valid"),
                artifacts=[],
            )

        def pending_publication(self):
            return pending

    monkeypatch.setattr(pipeline_tool_module, "PipelineRunner", FakeRunner)

    def tool_context(call_id: str) -> ToolContext[RunContext]:
        return ToolContext(
            context=context,
            tool_name="run_research_pipeline",
            tool_call_id=call_id,
            tool_arguments="{}",
        )

    arguments = json.dumps(
        {
            "topic": "parallel managed invocation",
            "databases": ["pubmed", "geo"],
            "mode": "fixture",
        }
    )
    first = asyncio.create_task(
        run_research_pipeline.on_invoke_tool(tool_context("call_parallel_1"), arguments)
    )
    await asyncio.wait_for(started.wait(), timeout=1)

    second = await run_research_pipeline.on_invoke_tool(
        tool_context("call_parallel_2"),
        arguments,
    )

    result = json.loads(second)
    assert result["status"] == "already_run"
    assert constructed == 1
    release.set()
    await first
    assert context.take_pending_publication() is pending


@pytest.mark.asyncio
async def test_pipeline_function_tool_ignores_extra_databases_in_fixture_mode(
    tmp_path: Path,
) -> None:
    context = RunContext(task_id="task_tool_extra_dbs")
    context._work_dir = create_task_workdir(  # noqa: SLF001
        "task_tool_extra_dbs", base_dir=str(tmp_path / "tasks")
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

    # Fixture mode always runs the pinned Phase 1 case; extra selected databases
    # are ignored rather than rejected.
    payload = json.loads(result)
    assert payload["status"] == "completed"
    assert payload["mode"] == "fixture"
    assert (
        tmp_path / "tasks" / "task_tool_extra_dbs" / "artifacts" / "run_manifest.json"
    ).exists()


@pytest.mark.asyncio
async def test_pipeline_function_tool_forwards_run_cancellation_token(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    context = RunContext(task_id="task_tool_cancel_token")
    context._work_dir = create_task_workdir(  # noqa: SLF001
        context.task_id,
        base_dir=str(tmp_path / "tasks"),
    )
    tool_context = ToolContext(
        context=context,
        tool_name="run_research_pipeline",
        tool_call_id="call_cancel",
        tool_arguments="{}",
    )
    captured: dict[str, object] = {}

    class FakeRunner:
        def __init__(self, **kwargs) -> None:
            captured.update(kwargs)

        async def run(self):
            return SimpleNamespace(
                task_id=context.task_id,
                task_state=SimpleNamespace(value="completed"),
                validation=SimpleNamespace(status="valid"),
                artifacts=[],
            )

    monkeypatch.setattr(pipeline_tool_module, "PipelineRunner", FakeRunner)

    await run_research_pipeline.on_invoke_tool(
        tool_context,
        json.dumps(
            {
                "topic": "cancellation token",
                "databases": ["pubmed", "geo"],
                "mode": "fixture",
            }
        ),
    )

    assert captured["cancellation_requested"] is context.cancellation_requested
