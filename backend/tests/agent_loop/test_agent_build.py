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
