from __future__ import annotations

import asyncio
from dataclasses import FrozenInstanceError

import pytest
from agents import RunContextWrapper, function_tool
from agents.tool_context import ToolContext
from app.agent_loop.agent import INSTRUCTIONS, AgentBuild, build_agent
from app.agent_loop.context import RunContext
from app.skills.catalog import SkillCatalog, SkillDescriptor
from app.skills.registry import SkillCategory, SkillDef

pytestmark = pytest.mark.usefixtures("runnable_agent_model_settings")


def test_agent_build_owns_immutable_skill_and_model_metadata() -> None:
    build = build_agent(databases=[])

    assert isinstance(build, AgentBuild)
    assert isinstance(build.skill_names, tuple)
    assert build.model is build.agent.model
    with pytest.raises(FrozenInstanceError):
        build.skill_names = ()


@pytest.mark.asyncio
async def test_concurrent_agent_builds_keep_skill_and_model_ownership_isolated() -> (
    None
):
    catalog = SkillCatalog()
    geo_build, pdb_build = await asyncio.gather(
        asyncio.to_thread(build_agent, catalog, ["geo"]),
        asyncio.to_thread(build_agent, catalog, ["pdb"]),
    )

    assert geo_build.catalog is catalog
    assert pdb_build.catalog is catalog
    assert geo_build.model is not pdb_build.model


def test_agent_exposes_only_gateway_and_core_runtime_tools() -> None:
    build = build_agent(SkillCatalog(), databases=["pubmed", "geo"])

    assert [tool.name for tool in build.agent.tools] == [
        "find_skill",
        "invoke_skill",
        "run_research_pipeline",
        "read_file",
        "write_file",
        "list_files",
        "compress_query_log",
        "review_query_strategy",
    ]


def test_agent_instructions_require_dynamic_skill_discovery_protocol() -> None:
    # agent.instructions is a dynamic callable (query_log injection); validate
    # the base content via the module-level INSTRUCTIONS constant.
    build_agent(SkillCatalog())

    assert "find_skill" in INSTRUCTIONS
    assert "invoke_skill" in INSTRUCTIONS
    assert "技能目录更新后" in INSTRUCTIONS
    assert "每个被选中的数据库必须至少调用一次" not in INSTRUCTIONS


@pytest.mark.asyncio
async def test_existing_agent_gateway_observes_catalog_hot_add() -> None:
    @function_tool
    async def fetch_demo(ctx: RunContextWrapper[RunContext]) -> str:
        return "demo"

    catalog = SkillCatalog()
    build = build_agent(catalog, databases=["demo_db"])
    find_skill = next(tool for tool in build.agent.tools if tool.name == "find_skill")
    context = ToolContext(
        context=RunContext(preferred_sources=["demo_db"]),
        tool_name="find_skill",
        tool_call_id="call-find",
        tool_arguments='{"text":"demo_db"}',
    )

    before = await find_skill.on_invoke_tool(
        context,
        '{"text":"demo_db","category":null,"source":null}',
    )
    catalog.register(
        SkillDescriptor.from_skill_def(
            SkillDef(
                name="demo_db",
                category=SkillCategory.ACQUISITION,
                description="Demo DB.",
                tools=[fetch_demo],
                supported_sources=["demo_db"],
            )
        )
    )
    after = await find_skill.on_invoke_tool(
        context,
        '{"text":"demo_db","category":null,"source":null}',
    )

    assert '"skills": []' in before
    assert '"name": "demo_db"' in after


@pytest.mark.asyncio
async def test_concurrent_agent_builds_pass_each_owned_model_to_compress_tool() -> None:
    builds = await asyncio.gather(
        asyncio.to_thread(build_agent, ["geo"]),
        asyncio.to_thread(build_agent, ["pdb"]),
    )
    try:
        context_manager_agents = []
        for build in builds:
            compress_tool = next(
                tool for tool in build.agent.tools if tool.name == "compress_query_log"
            )
            context_manager_agent = compress_tool._agent_instance
            context_manager_agents.append(context_manager_agent)
            assert context_manager_agent.model is build.model
            assert build.agent.model is build.model

        assert builds[0].model is not builds[1].model
        assert context_manager_agents[0] is not context_manager_agents[1]
    finally:
        await asyncio.gather(*(build.model.close() for build in builds))
