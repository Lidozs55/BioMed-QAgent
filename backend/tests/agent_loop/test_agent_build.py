from __future__ import annotations

import asyncio
from dataclasses import FrozenInstanceError

import pytest

from app.agent_loop.agent import AgentBuild, build_agent


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
    geo_build, pdb_build = await asyncio.gather(
        asyncio.to_thread(build_agent, ["geo"]),
        asyncio.to_thread(build_agent, ["pdb"]),
    )

    assert "geo" in geo_build.skill_names
    assert "pdb" not in geo_build.skill_names
    assert "pdb" in pdb_build.skill_names
    assert "geo" not in pdb_build.skill_names
    assert geo_build.model is not pdb_build.model


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
