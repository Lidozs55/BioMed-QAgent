"""Tests for Agent creation (Sprint 0).

Validates:
  - Agent name is "BioMedResearcher"
  - Instructions contain required domain key phrases
  - Tools list is non-empty
  - Model is configured
"""

from __future__ import annotations

from app.agent_loop.agent import create_agent


def test_agent_has_correct_name() -> None:
    """Agent must be named BioMedResearcher."""
    agent = create_agent()
    assert agent.name == "BioMedResearcher"


def test_instructions_contain_required_keywords() -> None:
    """Instructions must mention structured data, source tracking, and CSV output."""
    agent = create_agent()

    # 检查结构化数据关键词
    assert "CSV" in agent.instructions, (
        "instructions should mention CSV as output format"
    )
    # 结构化产物/结构化数据
    assert "结构化" in agent.instructions, (
        "instructions should mention structured output (结构化)"
    )
    # 来源记录/来源清单
    assert "来源" in agent.instructions, (
        "instructions should mention source tracking (来源)"
    )


def test_agent_instructions_are_non_empty() -> None:
    """Agent must have non-empty instructions string."""
    agent = create_agent()
    assert isinstance(agent.instructions, str)
    assert len(agent.instructions) > 100, (
        "instructions should be substantial ( > 100 chars )"
    )


def test_tools_list_is_non_empty() -> None:
    """Agent must be loaded with at least one tool."""
    agent = create_agent()
    assert len(agent.tools) > 0, "agent should have at least one tool loaded"


def test_model_is_configured() -> None:
    """Agent must have a non-None model attribute."""
    agent = create_agent()
    assert agent.model is not None, "agent.model must not be None"
