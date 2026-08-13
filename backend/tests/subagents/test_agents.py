from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from app.agent_loop.context import RunContext
from app.agent_loop.runner import AgentRunExecutor
from app.domain.contracts import (
    QueryStatus,
    SubagentErrorCode,
    SubagentRequest,
    SubagentStatus,
    SubagentType,
)
from app.model_config import RunModelSettings, UserSettings
from app.runtime.repository import TaskRepository
from app.subagents.agents import ChildAgentFactory
from app.subagents.input_broker import SubagentInputBroker
from app.subagents.supervisor import SubagentSupervisor


def test_child_agent_has_direct_discovery_and_acquisition_tools_only(
    runnable_agent_model_settings,
) -> None:
    child = ChildAgentFactory().build_source_research_agent()

    names = [tool.name for tool in child.tools]
    assert "find_skill" not in names
    assert "invoke_skill" not in names
    assert "create_skill" not in names
    for expected in ("search_pubmed", "search_geo", "download_geo", "search_gdc"):
        assert expected in names, expected
    for forbidden in (
        "validate_dataset_build_spec",
        "execute_dataset_build",
        "delegate_research",
        "get_research_data_guidance",
        "extract_pdf_tables",
        "run_differential_expression",
    ):
        assert forbidden not in names, forbidden


def test_child_agent_respects_disabled_databases_and_user_tools() -> None:
    from agents import FunctionTool

    user_tool = FunctionTool(
        name="query_demo",
        description="Demo declarative tool.",
        params_json_schema={"type": "object", "properties": {}},
        on_invoke_tool=lambda _ctx, _args: "done",
    )
    child = ChildAgentFactory(
        disabled_databases=frozenset({"pubmed"}),
        user_http_tools=[user_tool],
    ).build_source_research_agent()

    names = [tool.name for tool in child.tools]
    assert "search_pubmed" not in names
    assert "query_demo" in names
    assert "search_geo" in names


def test_skill_builder_agent_is_retired() -> None:
    factory = ChildAgentFactory()

    assert not hasattr(factory, "build_skill_builder_agent")


@pytest.mark.asyncio
async def test_child_runner_uses_new_context_session_and_turn_cap(
    tmp_path,
    runnable_agent_model_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.subagents.agents as agents_module
    from app.subagents.agents import SourceResearchAgentRunner

    parent = RunContext(task_id="parent", base_dir=tmp_path)
    runner = SourceResearchAgentRunner(parent, ChildAgentFactory())
    observed: dict[str, object] = {}

    async def fake_run(agent, prompt, *, context, session, max_turns):
        context.record_source_asset_id("asset_verified")
        observed.update(
            agent=agent,
            prompt=prompt,
            context=context,
            session=session,
            max_turns=max_turns,
        )
        return SimpleNamespace(final_output="verified source")

    monkeypatch.setattr(agents_module.Runner, "run", fake_run)
    result = await runner.run(
        SubagentRequest(
            agent_type=SubagentType.SOURCE_RESEARCH,
            objective="Find GEO data",
            domain="geo",
            capability="source_research",
        ),
        subagent_id="child-1",
        task_id="parent",
        run_id="run-1",
    )

    assert result.status is SubagentStatus.COMPLETED
    assert observed["context"] is not parent
    assert observed["context"].task_id == parent.task_id
    assert observed["context"].work_dir.root == (
        parent.work_dir.staging / "subagents" / "child-1"
    )
    assert observed["max_turns"] == agents_module.CHILD_AGENT_MAX_TURNS
    assert observed["session"].session_id == "subagent:child-1"


@pytest.mark.asyncio
async def test_child_runner_rejects_normal_output_without_verifiable_evidence(
    tmp_path,
    runnable_agent_model_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.subagents.agents as agents_module
    from app.subagents.agents import SourceResearchAgentRunner

    parent = RunContext(task_id="parent", base_dir=tmp_path)
    runner = SourceResearchAgentRunner(parent, ChildAgentFactory())

    async def fake_run(agent, prompt, *, context, session, max_turns):
        del agent, prompt, context, session, max_turns
        return SimpleNamespace(final_output="I found something plausible")

    monkeypatch.setattr(agents_module.Runner, "run", fake_run)
    result = await runner.run(
        SubagentRequest(
            agent_type=SubagentType.SOURCE_RESEARCH,
            objective="Find GEO data",
            domain="geo",
            capability="source_research",
        ),
        subagent_id="child-no-evidence",
        task_id="parent",
        run_id="run-1",
    )

    assert result.status is SubagentStatus.FAILED
    assert result.error_code is SubagentErrorCode.EXTRACTION_FAILED
    assert result.source_asset_ids == []
    assert result.recipe_id is None


@pytest.mark.asyncio
async def test_child_runner_returns_collected_source_recipe_and_warning_metadata(
    tmp_path,
    runnable_agent_model_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.subagents.agents as agents_module
    from app.subagents.agents import SourceResearchAgentRunner

    parent = RunContext(task_id="parent", base_dir=tmp_path)
    runner = SourceResearchAgentRunner(parent, ChildAgentFactory())

    async def fake_run(agent, prompt, *, context, session, max_turns):
        del agent, prompt, session, max_turns
        context.record_source_asset_id("asset_child")
        context.record_recipe("recipe_child")
        context.record_warning("bounded warning")
        return SimpleNamespace(final_output="verified source")

    monkeypatch.setattr(agents_module.Runner, "run", fake_run)
    result = await runner.run(
        SubagentRequest(
            agent_type=SubagentType.SOURCE_RESEARCH,
            objective="Find GEO data",
            domain="geo",
            capability="source_research",
        ),
        subagent_id="child-1",
        task_id="parent",
        run_id="run-1",
    )

    assert result.source_asset_ids == ["asset_child"]
    assert result.recipe_id == "recipe_child"
    assert result.warnings == ["bounded warning"]


@pytest.mark.asyncio
async def test_child_runner_redacts_known_key_and_bounds_model_output(
    tmp_path,
    runnable_agent_model_settings,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import app.subagents.agents as agents_module
    from app.subagents.agents import SourceResearchAgentRunner

    secret = "sk-child-secret-exact-value"
    parent = RunContext(task_id="parent", base_dir=tmp_path)
    parent.bind_model_settings(
        RunModelSettings.from_user_settings(
            UserSettings(
                api_key=secret,
                context_window=65_536,
            )
        )
    )
    runner = SourceResearchAgentRunner(parent, ChildAgentFactory())

    async def fake_run(agent, prompt, *, context, session, max_turns):
        del agent, prompt, session, max_turns
        context.record_source_asset_id("asset_child")
        for index in range(25):
            context.record_warning(f"warning {index} Bearer warning-secret " + "w" * 700)
        return SimpleNamespace(
            final_output=f"raw key {secret}; api_key=second-secret " + "x" * 6_000
        )

    monkeypatch.setattr(agents_module.Runner, "run", fake_run)
    result = await runner.run(
        SubagentRequest(
            agent_type=SubagentType.SOURCE_RESEARCH,
            objective="Find GEO data",
            domain="geo",
            capability="source_research",
        ),
        subagent_id="child-safe-result",
        task_id="parent",
        run_id="run-1",
    )

    serialized = result.model_dump_json()
    assert secret not in serialized
    assert "second-secret" not in serialized
    assert "warning-secret" not in serialized
    assert len(result.summary) <= 4_096
    assert result.summary.endswith("...[truncated]")
    assert len(result.warnings) == 20
    assert all(len(warning) <= 512 for warning in result.warnings)


def test_agent_executor_binds_children_after_parent_model_is_frozen(tmp_path) -> None:
    supervisor = SubagentSupervisor()
    sink = object()
    context = RunContext(task_id="parent", base_dir=tmp_path, managed_run_id="run-1")
    frozen_settings = RunModelSettings.default()
    context.bind_model_settings(frozen_settings)
    executor = AgentRunExecutor(TaskRepository(tmp_path / "output"))
    executor.attach_subagent_runtime(supervisor=supervisor, event_sink=sink)
    executor._bind_subagent_runtime(SimpleNamespace(context=context))

    child_runner = context.subagent_runtime.runner
    assert child_runner._source._factory._model_settings is frozen_settings


@pytest.mark.asyncio
async def test_production_child_context_supports_immediate_credential_resume(
    tmp_path,
) -> None:
    """A real child inherits its Run and is resumable as soon as HIL is visible."""
    broker = SubagentInputBroker()
    resume_observed: list[bool] = []

    class ImmediateResumeSink:
        async def emit(self, *, payload, task_id, run_id, **_kwargs) -> None:
            if payload.type != "subagent_input_required":
                return
            resume_observed.append(
                await broker.try_resume(
                    task_id=task_id,
                    run_id=run_id,
                    request_id=payload.request_id,
                    decision="approve",
                )
            )

    parent = RunContext(
        task_id="parent",
        base_dir=tmp_path,
        managed_run_id="run-parent",
    )
    parent.bind_subagent_runtime(
        supervisor=object(),
        runner=object(),
        event_sink=ImmediateResumeSink(),
        input_broker=broker,
    )
    child = parent.create_child_context("child-one")

    resumed = await asyncio.wait_for(
        child.request_subagent_input(
            summary="Approve protected source",
            prompt_kind="api_key_or_credential",
        ),
        timeout=1.0,
    )

    assert child.managed_run_id == "run-parent"
    assert resume_observed == [True]
    assert resumed.decision == "approve"


def test_child_context_seeds_parent_query_log_and_summary(tmp_path) -> None:
    """C1: child context inherits parent's completed-searches knowledge so a
    re-dispatched child does not repeat parent searches."""
    parent = RunContext(task_id="parent", base_dir=tmp_path)
    parent.log_query("cancer", "pubmed", QueryStatus.SUCCESS, 5)
    parent.query_log_summary = "压缩摘要"

    child = parent.create_child_context(
        "child-one",
        parent_query_log=parent.query_log,
        parent_query_log_summary=parent.query_log_summary,
    )

    assert child.query_log == parent.query_log
    assert child.query_log_summary == "压缩摘要"
