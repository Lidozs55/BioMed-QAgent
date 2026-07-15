"""SkillRegistry 单元测试 — 注册、查询、按类别/数据源筛选、enabled/disabled、按需加载。"""
from __future__ import annotations

import logging

import pytest
from app.skills.registry import (
    HARD_MAX_TOOLS,
    SUGGESTED_MAX_TOOLS,
    SkillCategory,
    SkillDef,
    SkillRegistry,
    build_agent_config,
)


def _make_tool(name: str):
    """构造带 name 属性的 mock tool，模拟 function_tool 装饰后的对象。"""

    class _Tool:
        pass

    t = _Tool()
    t.name = name  # type: ignore[attr-defined]
    return t


# ---------------------------------------------------------------------------
# SkillDef 校验
# ---------------------------------------------------------------------------


def test_skilldef_minimal_fields() -> None:
    skill = SkillDef(
        name="lit_search",
        category=SkillCategory.DISCOVERY,
        description="检索 PubMed 和 Europe PMC 论文",
    )
    assert skill.name == "lit_search"
    assert skill.category == SkillCategory.DISCOVERY
    assert skill.tools == []
    assert skill.supported_sources == []
    assert skill.version == "0.1.0"
    assert skill.enabled is True


def test_skilldef_tool_count_over_hard_max_raises() -> None:
    tools = [_make_tool(f"tool_{i}") for i in range(HARD_MAX_TOOLS + 1)]
    with pytest.raises(ValueError, match="超过上限"):
        SkillDef(
            name="too_big",
            category=SkillCategory.ACQUISITION,
            description="too many tools",
            tools=tools,
        )


def test_skilldef_tool_count_over_suggested_warns(
    caplog: pytest.LogCaptureFixture,
) -> None:
    tools = [_make_tool(f"tool_{i}") for i in range(SUGGESTED_MAX_TOOLS + 1)]
    with caplog.at_level(logging.WARNING):
        SkillDef(
            name="big",
            category=SkillCategory.ACQUISITION,
            description="many tools",
            tools=tools,
        )
    assert any("超过建议值" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# 注册 / 查询
# ---------------------------------------------------------------------------


def _build_registry() -> SkillRegistry:
    reg = SkillRegistry()
    reg.register(SkillDef(
        name="literature_search",
        category=SkillCategory.DISCOVERY,
        description="检索论文",
        instructions="使用文献检索工具查找相关论文。",
        supported_sources=["pubmed", "europepmc"],
        tools=[_make_tool("search_literature")],
    ))
    reg.register(SkillDef(
        name="geo_acquisition",
        category=SkillCategory.ACQUISITION,
        description="GEO 数据集检索与下载",
        instructions="从 GEO 检索和下载数据集。",
        supported_sources=["geo"],
        tools=[_make_tool("search_geo"), _make_tool("download_geo")],
    ))
    reg.register(SkillDef(
        name="pdb_acquisition",
        category=SkillCategory.ACQUISITION,
        description="PDB 结构检索与下载",
        supported_sources=["pdb"],
        tools=[_make_tool("search_pdb")],
        enabled=False,
    ))
    reg.register(SkillDef(
        name="tabular_parsing",
        category=SkillCategory.PROCESSING,
        description="CSV/TSV/Excel 解析",
        tools=[_make_tool("parse_csv")],
    ))
    return reg


def test_register_and_get() -> None:
    reg = _build_registry()
    assert reg.get("literature_search") is not None
    assert reg.get("nonexistent") is None


def test_list_returns_all_names() -> None:
    reg = _build_registry()
    names = set(reg.names())
    assert names == {"literature_search", "geo_acquisition", "pdb_acquisition", "tabular_parsing"}


def test_list_by_category() -> None:
    reg = _build_registry()
    acq = reg.list_by_category(SkillCategory.ACQUISITION)
    assert {s.name for s in acq} == {"geo_acquisition", "pdb_acquisition"}

    discovery = reg.list_by_category(SkillCategory.DISCOVERY)
    assert {s.name for s in discovery} == {"literature_search"}


def test_list_by_source() -> None:
    reg = _build_registry()
    geo_skills = reg.list_by_source("geo")
    assert {s.name for s in geo_skills} == {"geo_acquisition"}

    pubmed_skills = reg.list_by_source("pubmed")
    assert {s.name for s in pubmed_skills} == {"literature_search"}


def test_list_enabled_excludes_disabled() -> None:
    reg = _build_registry()
    enabled = reg.list_enabled()
    names = {s.name for s in enabled}
    assert "pdb_acquisition" not in names
    assert "geo_acquisition" in names


# ---------------------------------------------------------------------------
# acquisition 按用户数据库过滤
# ---------------------------------------------------------------------------


def test_get_acquisition_skills_no_filter_returns_all_enabled() -> None:
    reg = _build_registry()
    skills = reg.get_acquisition_skills(user_sources=None)
    assert {s.name for s in skills} == {"geo_acquisition"}


def test_get_acquisition_skills_filtered_by_user_sources() -> None:
    reg = _build_registry()
    # 用户只选了 pdb —— 但 pdb_acquisition 是 disabled，应返回空
    skills = reg.get_acquisition_skills(user_sources=["pdb"])
    assert skills == []

    # 用户选了 geo
    skills = reg.get_acquisition_skills(user_sources=["geo"])
    assert {s.name for s in skills} == {"geo_acquisition"}


# ---------------------------------------------------------------------------
# build_agent_config — 合并 instructions + 去重 tools
# ---------------------------------------------------------------------------


def test_build_agent_config_merges_instructions() -> None:
    skills = [
        SkillDef(
            name="a",
            category=SkillCategory.DISCOVERY,
            description="a",
            instructions="指令A",
        ),
        SkillDef(
            name="b",
            category=SkillCategory.DISCOVERY,
            description="b",
            instructions="指令B",
        ),
    ]
    instructions, _ = build_agent_config(skills)
    assert "指令A" in instructions
    assert "指令B" in instructions


def test_build_agent_config_dedups_tools() -> None:
    shared_tool = _make_tool("search_literature")
    skills = [
        SkillDef(
            name="a",
            category=SkillCategory.DISCOVERY,
            description="a",
            tools=[shared_tool, _make_tool("tool_x")],
        ),
        SkillDef(
            name="b",
            category=SkillCategory.DISCOVERY,
            description="b",
            tools=[_make_tool("tool_x"), _make_tool("tool_y")],
        ),
    ]
    _, tools = build_agent_config(skills)
    names = [getattr(t, "name", str(t)) for t in tools]
    assert names == ["search_literature", "tool_x", "tool_y"]


def test_build_agent_config_skips_disabled() -> None:
    skills = [
        SkillDef(
            name="enabled_skill",
            category=SkillCategory.DISCOVERY,
            description="enabled",
            instructions="保留",
            tools=[_make_tool("keep_tool")],
        ),
        SkillDef(
            name="disabled_skill",
            category=SkillCategory.DISCOVERY,
            description="disabled",
            instructions="丢弃",
            tools=[_make_tool("drop_tool")],
            enabled=False,
        ),
    ]
    instructions, tools = build_agent_config(skills)
    assert "保留" in instructions
    assert "丢弃" not in instructions
    names = [getattr(t, "name", str(t)) for t in tools]
    assert "keep_tool" in names
    assert "drop_tool" not in names
