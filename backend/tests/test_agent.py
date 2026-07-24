"""Tests for Agent creation (Sprint 0).

Validates:
  - Agent name is "BioMedResearcher"
  - Instructions contain required domain key phrases
  - Tools list is non-empty
  - Model is configured
"""

from __future__ import annotations

from pathlib import Path

import pytest
from agents import RunContextWrapper
from app.agent_loop.agent import INSTRUCTIONS, build_agent
from app.agent_loop.context import RunContext

pytestmark = pytest.mark.usefixtures("runnable_agent_model_settings")


def test_agent_has_correct_name() -> None:
    """Agent must be named BioMedResearcher."""
    agent = build_agent().agent
    assert agent.name == "BioMedResearcher"


def test_instructions_contain_required_keywords() -> None:
    """Base instructions must mention structured data, source tracking, and CSV output."""
    # agent.instructions is a dynamic callable (query_log injection); validate
    # the base content via the module-level INSTRUCTIONS constant.
    assert "CSV" in INSTRUCTIONS, (
        "instructions should mention CSV as output format"
    )
    assert "结构化" in INSTRUCTIONS, (
        "instructions should mention structured output (结构化)"
    )
    assert "来源" in INSTRUCTIONS, (
        "instructions should mention source tracking (来源)"
    )


def test_agent_instructions_are_non_empty() -> None:
    """Agent must have a non-empty instructions callable backed by a substantial base."""
    agent = build_agent().agent
    # instructions is now a callable that appends query_log sections to INSTRUCTIONS.
    assert callable(agent.instructions), (
        "instructions should be a callable for dynamic query_log injection"
    )
    assert len(INSTRUCTIONS) > 100, (
        "base instructions should be substantial ( > 100 chars )"
    )


@pytest.mark.asyncio
async def test_dynamic_instructions_resolve_through_sdk(tmp_path: Path) -> None:
    """SDK instruction resolution must accept and render the run context."""
    run_context = RunContext(task_id="dynamic-instructions", base_dir=tmp_path)
    query = "fixture-query-that-must-be-injected"
    run_context.log_query(query, "pubmed", "success", records_count=3)

    prompt = await build_agent().agent.get_system_prompt(RunContextWrapper(run_context))

    assert prompt is not None
    assert prompt.count(query) == 1


def test_tools_list_is_non_empty() -> None:
    """Agent must be loaded with at least one tool."""
    agent = build_agent().agent
    assert len(agent.tools) > 0, "agent should have at least one tool loaded"


def test_model_is_configured() -> None:
    """Agent must have a non-None model attribute."""
    agent = build_agent().agent
    assert agent.model is not None, "agent.model must not be None"


# ---------------------------------------------------------------------------
# Database filtering (TODO §11 line 329)
# ---------------------------------------------------------------------------

# Acquisition skills that should be filtered by database selection.
_ACQUISITION_SKILLS = {"geo", "gdc", "pdb", "xena", "reactome", "pubchem", "browser_fallback"}


def test_database_filter_loads_only_selected_acquisition_skills() -> None:
    """When databases=["pubmed", "geo"], only the geo acquisition skill loads."""
    build = build_agent(databases=["pubmed", "geo"])
    loaded = set(build.skill_names)
    # geo acquisition skill must be loaded.
    assert "geo" in loaded
    # Other acquisition skills must NOT be loaded.
    excluded = _ACQUISITION_SKILLS - {"geo"}
    assert not (loaded & excluded), (
        f"unselected acquisition skills loaded: {loaded & excluded}"
    )


def test_database_filter_loads_multiple_acquisition_skills() -> None:
    """When databases includes multiple sources, all matching acquisition skills load."""
    build = build_agent(databases=["pubmed", "geo", "pdb"])
    loaded = set(build.skill_names)
    assert "geo" in loaded
    assert "pdb" in loaded
    # Unselected acquisition skills must NOT be loaded.
    excluded = _ACQUISITION_SKILLS - {"geo", "pdb"}
    assert not (loaded & excluded), (
        f"unselected acquisition skills loaded: {loaded & excluded}"
    )


def test_database_filter_none_loads_all_skills() -> None:
    """When databases=None, all enabled acquisition skills load (no filtering)."""
    build = build_agent(databases=None)
    loaded = set(build.skill_names)
    # All acquisition skills should be present when no filtering is applied.
    assert "geo" in loaded
    assert "gdc" in loaded
    assert "pdb" in loaded


def test_database_filter_always_loads_non_acquisition_skills() -> None:
    """Non-acquisition skills (discovery, processing, analysis) load regardless of databases."""
    build = build_agent(databases=["geo"])
    loaded = set(build.skill_names)
    # pubmed is a discovery skill and must always be loaded.
    assert "pubmed" in loaded
    # literature_understanding is a discovery skill.
    assert "literature_understanding" in loaded
