from __future__ import annotations

from types import SimpleNamespace

import pytest
from app.agent_loop.context import RunContext
from app.agent_loop.runner import AgentRunExecutor
from app.domain.contracts import SubagentRequest, SubagentStatus, SubagentType
from app.model_config import RunModelSettings
from app.runtime.repository import TaskRepository
from app.subagents.agents import ChildAgentFactory
from app.subagents.supervisor import SubagentSupervisor


def test_child_agent_has_no_pipeline_or_delegation_tools(
    runnable_agent_model_settings,
) -> None:
    child = ChildAgentFactory().build_source_research_agent()

    assert [tool.name for tool in child.tools] == ["find_skill", "invoke_skill"]


def test_skill_builder_has_only_recipe_and_guarded_discovery_tools(
    runnable_agent_model_settings,
) -> None:
    child = ChildAgentFactory().build_skill_builder_agent()

    assert [tool.name for tool in child.tools] == [
        "find_skill",
        "invoke_skill",
        "create_skill",
    ]


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
    assert observed["context"].work_dir.root == parent.work_dir.root
    assert observed["max_turns"] == 10
    assert observed["session"].session_id == "subagent:child-1"


def test_agent_executor_binds_children_after_parent_model_is_frozen(tmp_path) -> None:
    from app.skills.catalog import SkillCatalog

    catalog = SkillCatalog()
    supervisor = SubagentSupervisor()
    sink = object()
    context = RunContext(task_id="parent", base_dir=tmp_path, managed_run_id="run-1")
    frozen_settings = RunModelSettings.default()
    context.bind_model_settings(frozen_settings)
    executor = AgentRunExecutor(TaskRepository(tmp_path / "output"), skill_catalog=catalog)
    executor.attach_subagent_runtime(supervisor=supervisor, event_sink=sink)
    executor._bind_subagent_runtime(SimpleNamespace(context=context))

    child_runner = context.subagent_runtime.runner
    assert child_runner._source._factory._model_settings is frozen_settings
    assert child_runner._source._factory._catalog is catalog


def test_child_contexts_share_parent_create_skill_reservations(tmp_path) -> None:
    parent = RunContext(task_id="parent", base_dir=tmp_path)
    first = parent.create_child_context("child-one")
    second = parent.create_child_context("child-two")

    with (
        first.reserve_create_skill("GEO", "source_research"),
        pytest.raises(ValueError, match="already developed"),
        second.reserve_create_skill("geo", "SOURCE_RESEARCH"),
    ):
        pass

    with (
        pytest.raises(RuntimeError, match="retry"),
        first.reserve_create_skill("geo", "another_capability"),
    ):
        raise RuntimeError("retry")

    with second.reserve_create_skill("geo", "another_capability"):
        pass
