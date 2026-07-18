"""Tests for the self_evolution skill and evolution engine.

Tests both the agent-facing tools (save_workflow_as_skill, list_my_learned_skills)
and the underlying evolution engine (save_learned_skill, list_learned_skills,
load_learned_skill).

Uses monkeypatch to redirect _LEARNED_BASE to a tmp_path so tests don't
pollute the real learned/ directory.
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills import evolution as evo_mod
from app.skills.builtin.processing.self_evolution import (
    list_my_learned_skills,
    save_workflow_as_skill,
)
from app.skills.evolution import (
    list_learned_skills,
    load_learned_skill,
    save_learned_skill,
    validate_skill_code,
    validate_skill_name,
)

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def learned_base(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Redirect _LEARNED_BASE to a tmp_path/learned directory."""
    base = tmp_path / "learned"
    base.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(evo_mod, "_LEARNED_BASE", base)
    return base


def _make_ctx(task_id: str = "test_evo") -> ToolContext:
    rc = RunContext(task_id=task_id)
    return ToolContext(
        context=rc,
        tool_name="save_workflow_as_skill",
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


_SAMPLE_SKILL_CODE = '''\
"""Sample learned skill for testing."""
from app.skills.registry import SkillDef, SkillCategory, skill_registry

test_skill = SkillDef(
    name="test_skill",
    category=SkillCategory.PROCESSING,
    description="A test learned skill.",
    instructions="Use test_skill for testing.",
    tools=[],
    supported_sources=["*"],
    version="0.1.0",
)
skill_registry.register(test_skill)
'''


# ---------------------------------------------------------------------------
# evolution.py — save_learned_skill
# ---------------------------------------------------------------------------


def test_save_learned_skill_success(learned_base: Path) -> None:
    """save_learned_skill writes .py + EVOLUTION.md + __init__.py."""
    skill_path = save_learned_skill(
        name="my_test_skill",
        category="processing",
        code=_SAMPLE_SKILL_CODE,
        description="A test skill.",
        instructions="Use my_test_skill for testing.",
        source_url="https://example.com/data",
        task_id="task-123",
    )

    assert skill_path.exists()
    assert skill_path.name == "my_test_skill.py"
    assert _SAMPLE_SKILL_CODE in skill_path.read_text(encoding="utf-8")

    # EVOLUTION.md should be created
    evo_md = skill_path.parent / "EVOLUTION.md"
    assert evo_md.exists()
    md_content = evo_md.read_text(encoding="utf-8")
    assert "my_test_skill" in md_content
    assert "processing" in md_content
    assert "https://example.com/data" in md_content
    assert "task-123" in md_content

    # __init__.py should be created
    init_file = skill_path.parent / "__init__.py"
    assert init_file.exists()


def test_save_learned_skill_invalid_category_raises(learned_base: Path) -> None:
    """save_learned_skill raises ValueError for invalid category."""
    with pytest.raises(ValueError, match="Invalid category"):
        save_learned_skill(
            name="bad_skill",
            category="invalid_category",
            code="# code",
            description="bad",
            instructions="bad",
            source_url="https://example.com",
            task_id="task-456",
        )


# ---------------------------------------------------------------------------
# evolution.py — list_learned_skills
# ---------------------------------------------------------------------------


def test_list_learned_skills_returns_saved(learned_base: Path) -> None:
    """list_learned_skills returns skills saved to the learned directory."""
    save_learned_skill(
        name="skill_a",
        category="discovery",
        code="# skill a",
        description="Skill A",
        instructions="Use skill A",
        source_url="https://a.example.com",
        task_id="task-a",
    )
    save_learned_skill(
        name="skill_b",
        category="acquisition",
        code="# skill b",
        description="Skill B",
        instructions="Use skill B",
        source_url="https://b.example.com",
        task_id="task-b",
    )

    skills = list_learned_skills()
    assert len(skills) == 2
    names = {s["name"] for s in skills}
    assert "skill_a" in names
    assert "skill_b" in names

    # Each should report has_evolution_md and has_code
    for s in skills:
        assert s["has_evolution_md"] is True
        assert s["has_code"] is True


def test_list_learned_skills_empty(learned_base: Path) -> None:
    """list_learned_skills returns empty list when no skills saved."""
    skills = list_learned_skills()
    assert skills == []


# ---------------------------------------------------------------------------
# evolution.py — load_learned_skill
# ---------------------------------------------------------------------------


def test_load_learned_skill_invalid_category_returns_none(learned_base: Path) -> None:
    """load_learned_skill returns None for invalid category."""
    result = load_learned_skill("some_skill", "invalid_cat")
    assert result is None


def test_load_learned_skill_not_found_returns_none(learned_base: Path) -> None:
    """load_learned_skill returns None when module doesn't exist."""
    result = load_learned_skill("nonexistent_skill", "processing")
    assert result is None


# ---------------------------------------------------------------------------
# self_evolution.py — save_workflow_as_skill tool
# ---------------------------------------------------------------------------


def test_save_workflow_as_skill_tool_success(learned_base: Path) -> None:
    """save_workflow_as_skill tool returns ok JSON and saves to disk."""
    ctx = _make_ctx(task_id="test_evo_save")
    args = json.dumps({
        "name": "web_scraper",
        "category": "acquisition",
        "code": "# scraper code",
        "description": "Scrapes data from a website.",
        "source_url": "https://example.com/scrape",
    })
    result = asyncio.run(save_workflow_as_skill.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["status"] == "ok"
    assert data["skill_name"] == "web_scraper"
    assert data["category"] == "acquisition"
    assert "skill_path" in data

    # File should exist on disk
    skill_file = Path(data["skill_path"])
    assert skill_file.exists()


def test_save_workflow_as_skill_tool_invalid_category(learned_base: Path) -> None:
    """save_workflow_as_skill tool returns error JSON for invalid category."""
    ctx = _make_ctx(task_id="test_evo_bad_cat")
    args = json.dumps({
        "name": "bad_skill",
        "category": "not_a_category",
        "code": "# code",
        "description": "bad",
        "source_url": "https://example.com",
    })
    result = asyncio.run(save_workflow_as_skill.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["status"] == "error"
    assert "Invalid category" in data["error"]


# ---------------------------------------------------------------------------
# self_evolution.py — list_my_learned_skills tool
# ---------------------------------------------------------------------------


def test_list_my_learned_skills_tool_returns_skills(learned_base: Path) -> None:
    """list_my_learned_skills tool returns JSON list of saved skills."""
    save_learned_skill(
        name="listable_skill",
        category="analysis",
        code="# code",
        description="test",
        instructions="test",
        source_url="https://example.com",
        task_id="task-list",
    )

    ctx = _make_ctx(task_id="test_evo_list")
    ctx.tool_name = "list_my_learned_skills"
    result = asyncio.run(list_my_learned_skills.on_invoke_tool(ctx, "{}"))

    data = json.loads(result)
    assert data["status"] == "ok"
    assert data["count"] >= 1
    assert any(s["name"] == "listable_skill" for s in data["skills"])


# ---------------------------------------------------------------------------
# Security regression tests (BLOCKER fix — docs/REVIEW_2026-07-18.md §17.3 #6)
#
# save_workflow_as_skill is an LLM-facing @function_tool. ``name`` and
# ``code`` are attacker-controlled via prompt injection. These tests pin the
# path-traversal regex and the AST code validator so the RCE chain stays
# blocked across future refactors.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "bad_name",
    [
        "../escape",           # path traversal
        "..\\escape",          # windows path traversal
        "/abs/path",           # absolute path
        "evil.py",             # file extension injection
        "MySkill",             # uppercase
        "123skill",            # starts with digit
        "skill-name",          # hyphen
        "skill name",          # space
        "",                    # empty
        "skill.with.dots",     # dots
    ],
)
def test_validate_skill_name_rejects_invalid_formats(bad_name: str) -> None:
    """validate_skill_name rejects path-traversal and non-identifier names."""
    with pytest.raises(ValueError, match="Invalid skill name"):
        validate_skill_name(bad_name)


@pytest.mark.parametrize(
    "good_name",
    ["s", "skill", "my_skill", "skill123", "a_b_c_123"],
)
def test_validate_skill_name_accepts_valid_formats(good_name: str) -> None:
    """validate_skill_name accepts lowercase identifiers."""
    validate_skill_name(good_name)  # must not raise


def test_validate_skill_code_accepts_sample_skill_code() -> None:
    """The existing sample skill code passes AST validation."""
    validate_skill_code(_SAMPLE_SKILL_CODE)  # must not raise


@pytest.mark.parametrize(
    "bad_code",
    [
        "import os\n",                       # bare import
        "import subprocess\n",               # bare import (subprocess)
        "from os import system\n",           # non-whitelisted from import
        "from subprocess import run\n",      # non-whitelisted from import
        "from pathlib import Path\n",        # non-whitelisted (path traversal)
        "exec('print(1)')\n",                # exec
        "eval('1+1')\n",                     # eval
        "compile('x', '<s>', 'exec')\n",     # compile
        "open('/etc/passwd').read()\n",      # open
        "__import__('os')\n",                # __import__ call
        "globals()\n",                       # globals
        "locals()\n",                        # locals
        "vars()\n",                          # vars
        "breakpoint()\n",                    # breakpoint
        "obj.__class__\n",                   # dunder attribute access
        "obj.__subclasses__()\n",            # dunder attribute (subclasses escape)
        "x = __builtins__\n",                # dunder name
    ],
)
def test_validate_skill_code_rejects_dangerous_constructs(
    bad_code: str,
) -> None:
    """validate_skill_code blocks RCE primitives and sandbox escapes."""
    with pytest.raises(ValueError):
        validate_skill_code(bad_code)


def test_validate_skill_code_reports_line_number() -> None:
    """Error message includes the offending line number for triage."""
    code = "x = 1\nexec('boom')\n"
    with pytest.raises(ValueError, match="line 2"):
        validate_skill_code(code)


def test_save_learned_skill_rejects_path_traversal_name(
    learned_base: Path,
) -> None:
    """save_learned_skill refuses names that would escape learned/."""
    with pytest.raises(ValueError, match="Invalid skill name"):
        save_learned_skill(
            name="../malicious",
            category="processing",
            code="# stub\n",
            description="bad",
            instructions="bad",
            source_url="https://example.com",
            task_id="task-evil",
        )
    # Nothing should have been written outside learned/
    assert not (learned_base.parent / "malicious").exists()


def test_save_learned_skill_rejects_dangerous_code(
    learned_base: Path,
) -> None:
    """save_learned_skill refuses code containing exec()."""
    with pytest.raises(ValueError, match="forbidden"):
        save_learned_skill(
            name="ok_name",
            category="processing",
            code="exec('rm -rf /')\n",
            description="bad",
            instructions="bad",
            source_url="https://example.com",
            task_id="task-evil",
        )


def test_load_learned_skill_rejects_path_traversal_name(
    learned_base: Path,
) -> None:
    """load_learned_skill returns None for path-traversal names (no raise)."""
    result = load_learned_skill("../escape", "processing")
    assert result is None


def test_load_learned_skill_rejects_tampered_code(
    learned_base: Path,
) -> None:
    """If a .py file is tampered post-save to add exec(), load refuses it."""
    # Save a valid skill first.
    save_learned_skill(
        name="tampered_skill",
        category="processing",
        code=_SAMPLE_SKILL_CODE,
        description="ok",
        instructions="ok",
        source_url="https://example.com",
        task_id="task-tamper",
    )
    # Tamper with the on-disk file to inject a forbidden call.
    skill_file = learned_base / "processing" / "tampered_skill" / "tampered_skill.py"
    skill_file.write_text(
        skill_file.read_text(encoding="utf-8") + "\nexec('evil')\n",
        encoding="utf-8",
    )
    # load_learned_skill must refuse to import the tampered file.
    result = load_learned_skill("tampered_skill", "processing")
    assert result is None


def test_save_workflow_as_skill_tool_rejects_path_traversal(
    learned_base: Path,
) -> None:
    """End-to-end: the LLM-facing tool returns status='error' for bad names."""
    ctx = _make_ctx(task_id="test_evo_evil")
    args = json.dumps({
        "name": "../malicious",
        "category": "processing",
        "code": "# stub\n",
        "description": "evil",
        "source_url": "https://example.com",
    })
    result = asyncio.run(save_workflow_as_skill.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["status"] == "error"
    assert "Invalid skill name" in data["error"]

    # Ensure nothing was written outside learned/.
    assert not (learned_base.parent / "malicious").exists()


def test_save_workflow_as_skill_tool_rejects_dangerous_code(
    learned_base: Path,
) -> None:
    """End-to-end: the LLM-facing tool returns status='error' for exec()."""
    ctx = _make_ctx(task_id="test_evo_exec")
    args = json.dumps({
        "name": "evil_skill",
        "category": "processing",
        "code": "exec('rm -rf /')\n",
        "description": "evil",
        "source_url": "https://example.com",
    })
    result = asyncio.run(save_workflow_as_skill.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["status"] == "error"
    assert "forbidden" in data["error"] or "exec" in data["error"]
