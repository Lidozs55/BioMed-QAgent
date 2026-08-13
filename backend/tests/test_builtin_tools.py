"""Phase 2: builtin skills expose direct tools — no catalog, no gateway.

The stable Skill ↔ Tool mapping lives in the TS side
(server/src/agent/skills/skill-tool-map.ts); this file pins the Python-side
mirror so the two cannot drift while both runtimes exist.
"""

from __future__ import annotations

from app.skills.builtin import (
    builtin_skill_modules,
    builtin_skill_records,
    load_builtin_tools,
)
from app.skills.categories import SkillCategory

EXPECTED_TOOLS: dict[str, set[str]] = {
    "pubmed": {"search_pubmed", "download_supplementary"},
    "chembl": {"search_chembl"},
    "uniprot": {"search_uniprot"},
    "literature_understanding": {"analyze_papers"},
    "geo": {
        "search_geo",
        "describe_geo",
        "list_geo_supplementary_files",
        "download_geo",
        "download_geo_platform_annotation",
    },
    "gdc": {"search_gdc", "describe_gdc", "download_gdc"},
    "xena": {"search_xena", "download_xena"},
    "pdb": {"search_pdb", "describe_pdb", "download_pdb"},
    "pubchem": {"search_pubchem", "get_compound", "download_pubchem"},
    "reactome": {"search_reactome", "get_pathway", "download_reactome"},
    "browser_fallback": {"navigate_page", "download_from_page"},
    "local_cache": {"search_local_cache", "describe_local_cache", "get_cache_dataset"},
    "web_visual_capture": {"capture_web_page", "capture_page_section"},
    "pdf_extraction": {"extract_pdf_tables", "extract_pdf_metadata"},
    "extract_chart_data_vlm": {"extract_chart_data_vlm"},
    "analysis": {
        "run_differential_expression",
        "generate_heatmap",
        "basic_statistics",
        "generate_correlation_matrix",
    },
    "research_data_guidance": {"get_research_data_guidance"},
}

EXPECTED_CATEGORIES: dict[str, SkillCategory] = {
    "pubmed": SkillCategory.DISCOVERY,
    "chembl": SkillCategory.DISCOVERY,
    "uniprot": SkillCategory.DISCOVERY,
    "literature_understanding": SkillCategory.DISCOVERY,
    "geo": SkillCategory.ACQUISITION,
    "gdc": SkillCategory.ACQUISITION,
    "xena": SkillCategory.ACQUISITION,
    "pdb": SkillCategory.ACQUISITION,
    "pubchem": SkillCategory.ACQUISITION,
    "reactome": SkillCategory.ACQUISITION,
    "browser_fallback": SkillCategory.ACQUISITION,
    "local_cache": SkillCategory.ACQUISITION,
    "web_visual_capture": SkillCategory.ACQUISITION,
    "pdf_extraction": SkillCategory.PROCESSING,
    "extract_chart_data_vlm": SkillCategory.PROCESSING,
    "analysis": SkillCategory.ANALYSIS,
    "research_data_guidance": SkillCategory.ANALYSIS,
}

EXPECTED_USER_SELECTABLE = {
    "pubmed",
    "chembl",
    "uniprot",
    "geo",
    "gdc",
    "xena",
    "pdb",
    "pubchem",
    "reactome",
}

EXPECTED_PIPELINE_SUPPORTED = {"pubmed", "geo", "gdc", "xena", "reactome"}


def test_load_builtin_tools_returns_the_direct_tool_union():
    tools = load_builtin_tools()
    names = [tool.name for tool in tools]
    expected = {name for group in EXPECTED_TOOLS.values() for name in group}

    assert set(names) == expected
    assert len(names) == len(set(names)), "tool names must be unique"
    assert "find_skill" not in names
    assert "invoke_skill" not in names
    assert "create_skill" not in names


def test_builtin_skill_records_cover_exactly_the_migrated_skills():
    records = builtin_skill_records()

    assert set(records) == set(EXPECTED_TOOLS)
    for name, record in records.items():
        assert record.category is EXPECTED_CATEGORIES[name]
        assert set(record.tool_names) == EXPECTED_TOOLS[name]
        assert record.description, name
        assert record.version, name


def test_user_selectable_and_pipeline_supported_projection():
    records = builtin_skill_records()

    selectable = {name for name, record in records.items() if record.user_selectable}
    pipeline = {name for name, record in records.items() if record.pipeline_supported}

    assert selectable == EXPECTED_USER_SELECTABLE
    assert pipeline == EXPECTED_PIPELINE_SUPPORTED


def test_builtin_module_discovery_excludes_create_skill_and_learned():
    modules = builtin_skill_modules()

    assert not any("create_skill" in name for name in modules)
    assert not any("learned" in name for name in modules)
    assert len(modules) == len(EXPECTED_TOOLS)
