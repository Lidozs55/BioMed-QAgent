"""Tests for Agent creation (Sprint 0).

Validates:
  - Agent name is "BioMedResearcher"
  - Instructions contain required domain key phrases
  - Tools list is non-empty
  - Model is configured
"""

from __future__ import annotations

from app.agent_loop.agent import create_agent, get_loaded_skill_names


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


# ---------------------------------------------------------------------------
# Database filtering (TODO §11 line 329)
# ---------------------------------------------------------------------------

# Acquisition skills that should be filtered by database selection.
_ACQUISITION_SKILLS = {"geo", "gdc", "pdb", "xena", "reactome", "pubchem", "browser_fallback"}


def test_database_filter_loads_only_selected_acquisition_skills() -> None:
    """When databases=["pubmed", "geo"], only the geo acquisition skill loads."""
    create_agent(databases=["pubmed", "geo"])
    loaded = set(get_loaded_skill_names())
    # geo acquisition skill must be loaded.
    assert "geo" in loaded
    # Other acquisition skills must NOT be loaded.
    excluded = _ACQUISITION_SKILLS - {"geo"}
    assert not (loaded & excluded), (
        f"unselected acquisition skills loaded: {loaded & excluded}"
    )


def test_database_filter_loads_multiple_acquisition_skills() -> None:
    """When databases includes multiple sources, all matching acquisition skills load."""
    create_agent(databases=["pubmed", "geo", "pdb"])
    loaded = set(get_loaded_skill_names())
    assert "geo" in loaded
    assert "pdb" in loaded
    # Unselected acquisition skills must NOT be loaded.
    excluded = _ACQUISITION_SKILLS - {"geo", "pdb"}
    assert not (loaded & excluded), (
        f"unselected acquisition skills loaded: {loaded & excluded}"
    )


def test_database_filter_none_loads_all_skills() -> None:
    """When databases=None, all enabled acquisition skills load (no filtering)."""
    create_agent(databases=None)
    loaded = set(get_loaded_skill_names())
    # All acquisition skills should be present when no filtering is applied.
    assert "geo" in loaded
    assert "gdc" in loaded
    assert "pdb" in loaded


def test_database_filter_always_loads_non_acquisition_skills() -> None:
    """Non-acquisition skills (discovery, processing, analysis) load regardless of databases."""
    create_agent(databases=["geo"])
    loaded = set(get_loaded_skill_names())
    # pubmed is a discovery skill and must always be loaded.
    assert "pubmed" in loaded
    # literature_understanding is a discovery skill.
    assert "literature_understanding" in loaded
