"""Tests for the research_data_guidance skill — topic-routed SOP documents.

REVIEW_2026-08-09-task-3eb85407 §7.2: the main Agent loads topic-specific
research-data instructions on demand via the skill gateway instead of carrying
them all in the system prompt.
"""

from __future__ import annotations

import asyncio
import json

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.analysis.research_data_guidance import (
    get_research_data_guidance,
)
from app.skills.registry import SkillCategory, skill_registry

_TOPICS = (
    "strategy",
    "expression_omics",
    "clinical",
    "structure_pathway_compound",
    "cleaning",
    "reproducibility",
)


def _ctx(task_id: str = "test_guidance") -> ToolContext:
    return ToolContext(
        context=RunContext(task_id=task_id),
        tool_name="get_research_data_guidance",
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


def test_skill_registered_and_discoverable() -> None:
    """The skill is registered as an analysis skill with the documented ops."""
    skill = skill_registry.get("research_data_guidance")
    assert skill is not None
    assert skill.category is SkillCategory.ANALYSIS
    assert skill.enabled
    assert any(
        getattr(tool, "name", None) == "get_research_data_guidance"
        for tool in skill.tools
    )


def test_index_route_returns_routing_table() -> None:
    """topic='index' returns the routing table and names every topic."""
    result = asyncio.run(get_research_data_guidance.on_invoke_tool(
        _ctx(), json.dumps({"topic": "index"}),
    ))
    for topic in _TOPICS:
        assert f"`{topic}`" in result


def test_each_topic_returns_its_own_document() -> None:
    """Every topic returns a non-empty doc mentioning the topic by name."""
    for topic in _TOPICS:
        result = asyncio.run(get_research_data_guidance.on_invoke_tool(
            _ctx(f"test_guidance_{topic}"), json.dumps({"topic": topic}),
        ))
        assert topic in result
        assert "research_data_guidance" in result
        assert len(result) > 500, f"{topic} document is too short"


def test_unknown_topic_falls_back_to_index() -> None:
    """Unknown topics route to the index instead of failing."""
    result = asyncio.run(get_research_data_guidance.on_invoke_tool(
        _ctx(), json.dumps({"topic": "does_not_exist"}),
    ))
    assert "`strategy`" in result
    assert "`reproducibility`" in result


def test_topic_alias_normalization() -> None:
    """Hyphenated/space aliases map to the canonical document."""
    result = asyncio.run(get_research_data_guidance.on_invoke_tool(
        _ctx(), json.dumps({"topic": "expression-omics"}),
    ))
    assert "expression_omics" in result
