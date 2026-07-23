"""Focused tests for deterministic skill search ranking."""

from __future__ import annotations

from typing import Any

from agents import RunContextWrapper, function_tool
from app.agent_loop.context import RunContext
from app.skills.catalog import SkillDescriptor
from app.skills.registry import SkillCategory, SkillDef
from app.skills.search import LexicalSkillSearchStrategy


@function_tool
async def demo_operation(
    ctx: RunContextWrapper[RunContext],
) -> dict[str, Any]:
    """Return deterministic test data."""
    return {"task_id": ctx.context.task_id}


def _descriptor(
    name: str,
    description: str,
    *,
    sources: list[str],
    category: SkillCategory = SkillCategory.ACQUISITION,
) -> SkillDescriptor:
    return SkillDescriptor.from_skill_def(
        SkillDef(
            name=name,
            category=category,
            description=description,
            supported_sources=sources,
            tools=[demo_operation],
        ),
    )


def test_multi_term_query_matches_non_contiguous_metadata() -> None:
    strategy = LexicalSkillSearchStrategy()
    geo = _descriptor(
        "geo",
        "Search and download Gene Expression Omnibus datasets.",
        sources=["geo", "ncbi_geo"],
    )
    analysis = _descriptor(
        "analysis",
        "Statistical analysis of expression tables.",
        sources=[],
        category=SkillCategory.ANALYSIS,
    )

    result = strategy.search((analysis, geo), "search GEO expression datasets")

    assert [item.name for item in result] == ["geo", "analysis"]


def test_chinese_domain_intent_expands_to_english_metadata() -> None:
    strategy = LexicalSkillSearchStrategy()
    pubmed = _descriptor(
        "pubmed",
        "Search biomedical literature and research papers.",
        sources=["pubmed"],
        category=SkillCategory.DISCOVERY,
    )
    pdb = _descriptor(
        "pdb",
        "Search and download protein structures and 3D models.",
        sources=["pdb", "rcsb_pdb"],
    )

    literature = strategy.search((pdb, pubmed), "检索相关文献")
    structure = strategy.search((pubmed, pdb), "查找蛋白结构")

    assert [item.name for item in literature] == ["pubmed"]
    assert [item.name for item in structure] == ["pdb"]


def test_search_intent_ranks_retrieval_above_title_analysis() -> None:
    strategy = LexicalSkillSearchStrategy()
    understanding = _descriptor(
        "literature_understanding",
        "Analyze paper titles to identify databases and accessions.",
        sources=["pubmed"],
        category=SkillCategory.DISCOVERY,
    )
    pubmed = _descriptor(
        "pubmed",
        "Search biomedical literature and research papers.",
        sources=["pubmed"],
        category=SkillCategory.DISCOVERY,
    )
    reactome = _descriptor(
        "reactome",
        "Search biological pathways and literature references.",
        sources=["reactome"],
    )

    candidates = (understanding, reactome, pubmed)
    english = strategy.search(candidates, "literature search")
    chinese = strategy.search(candidates, "检索相关文献")

    assert english[0].name == "pubmed"
    assert chinese[0].name == "pubmed"


def test_identity_fields_rank_above_description_only_matches() -> None:
    strategy = LexicalSkillSearchStrategy()
    source_match = _descriptor(
        "geo",
        "Repository datasets.",
        sources=["gene_expression"],
    )
    description_match = _descriptor(
        "generic",
        "Analyze gene expression datasets.",
        sources=["generic"],
    )

    result = strategy.search(
        (description_match, source_match),
        "gene expression",
    )

    assert [item.name for item in result] == ["geo", "generic"]


def test_empty_or_generic_query_preserves_catalog_order() -> None:
    strategy = LexicalSkillSearchStrategy()
    first = _descriptor("first", "First capability.", sources=["first"])
    second = _descriptor("second", "Second capability.", sources=["second"])

    assert strategy.search((first, second), "") == (first, second)
    assert strategy.search((first, second), "search skill") == (first, second)


def test_equal_scores_preserve_catalog_order() -> None:
    strategy = LexicalSkillSearchStrategy()
    first = _descriptor("first", "Pathway records.", sources=["first"])
    second = _descriptor("second", "Pathway records.", sources=["second"])

    result = strategy.search((second, first), "pathway")

    assert result == (second, first)
