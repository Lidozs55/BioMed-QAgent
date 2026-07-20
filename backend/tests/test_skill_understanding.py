"""Tests for the literature_understanding skill — analyze_papers regex extraction.

Updated for the title-only interface: ``analyze_papers`` now accepts
``titles: list[str]`` instead of ``papers_json: str`` with full records.
Extraction quality is lower (title-only, no abstract) but parameter volume
is dramatically reduced — see problem #2 fix.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.discovery.understanding import analyze_papers


def _make_ctx(task_id: str = "test_understanding") -> ToolContext:
    rc = RunContext(task_id=task_id)
    return ToolContext(
        context=rc,
        tool_name="analyze_papers",
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


def _call(titles: list[str]) -> dict[str, Any]:
    ctx = _make_ctx()
    args = json.dumps({"titles": titles})
    result = asyncio.run(analyze_papers.on_invoke_tool(ctx, args))
    return json.loads(result)


def test_empty_titles_returns_empty_findings() -> None:
    data = _call([])
    assert data["papers_analyzed"] == 0
    assert data["findings"] == []
    assert data["summary"]["databases_referenced"] == []
    assert data["summary"]["total_accessions_found"] == 0


def test_geo_accession_extraction_from_title() -> None:
    """Title containing a GSE accession should be extracted."""
    data = _call(["GEO series GSE178352: gene expression study of osteoporosis"])
    assert data["papers_analyzed"] == 1
    finding = data["findings"][0]
    db_names = [db["name"] for db in finding["databases_found"]]
    assert "GEO" in db_names
    geo_db = next(db for db in finding["databases_found"] if db["name"] == "GEO")
    assert "GSE178352" in geo_db["accessions"]
    assert data["summary"]["total_accessions_found"] >= 1


def test_pdb_accession_extraction_no_false_positives() -> None:
    """PDB ID pattern (digit + 3 alnum) must NOT match common 4-letter words."""
    data = _call([
        "PDB structure 1AFT reveals protein binding site",
        "Analysis of this with from here pathway",
    ])
    # First title: 1AFT should be extracted
    finding0 = data["findings"][0]
    pdb_db = next(
        (db for db in finding0["databases_found"] if db["name"] == "PDB"), None
    )
    assert pdb_db is not None, "PDB database should be detected"
    assert "1AFT" in pdb_db["accessions"]
    # Common words should not appear in any accessions
    for finding in data["findings"]:
        for db in finding["databases_found"]:
            for word in ("this", "with", "from", "here"):
                assert word not in db["accessions"], (
                    f"'{word}' should not be matched as PDB ID"
                )


def test_multiple_databases_in_one_title() -> None:
    """A title mentioning multiple databases should extract all of them."""
    data = _call([
        "Multi-omics study: GEO GSE12345, PDB 1CBS, SRA SRR12345678 analysis",
    ])
    finding = data["findings"][0]
    db_names = {db["name"] for db in finding["databases_found"]}
    assert {"GEO", "PDB", "SRA"}.issubset(db_names)


def test_data_type_extraction_from_title() -> None:
    """Data types like RNA-seq mentioned in title should be extracted."""
    data = _call(["RNA-seq analysis of Alzheimer's disease mouse model"])
    finding = data["findings"][0]
    assert "RNA-seq" in finding["data_types"]


def test_query_log_recorded() -> None:
    ctx = _make_ctx()
    args = json.dumps({"titles": ["Test paper title"]})
    asyncio.run(analyze_papers.on_invoke_tool(ctx, args))
    assert len(ctx.context.query_log) == 1
    entry = ctx.context.query_log[0]
    assert entry["source"] == "literature_understanding"
    assert entry["status"] == "success"
    assert entry["records_count"] == 1


def test_empty_title_string_handled_gracefully() -> None:
    """Empty title strings should produce empty findings, not crash."""
    data = _call([""])
    assert data["papers_analyzed"] == 1
    assert data["findings"][0]["databases_found"] == []


def test_title_field_in_finding() -> None:
    """Each finding should include the title as identifier."""
    title = "Study of osteocalcin in bone metabolism"
    data = _call([title])
    assert data["findings"][0]["title"] == title


def test_summary_aggregates_across_titles() -> None:
    """Summary should aggregate databases and data types across all titles."""
    data = _call([
        "GEO GSE111 analysis of RNA-seq data",
        "PDB 2XYZ protein structure study",
    ])
    assert data["papers_analyzed"] == 2
    db_refs = set(data["summary"]["databases_referenced"])
    assert {"GEO", "PDB"}.issubset(db_refs)
    assert "RNA-seq" in data["summary"]["primary_data_types"]
