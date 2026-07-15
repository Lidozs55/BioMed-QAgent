"""Tests for the literature_understanding skill — analyze_papers regex extraction."""
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


def _call(papers_json: str) -> dict[str, Any]:
    ctx = _make_ctx()
    args = json.dumps({"papers_json": papers_json})
    result = asyncio.run(analyze_papers.on_invoke_tool(ctx, args))
    return json.loads(result)


def test_empty_records_returns_empty_findings() -> None:
    payload = json.dumps({"records": []})
    data = _call(payload)
    assert data["papers_analyzed"] == 0
    assert data["findings"] == []
    assert data["summary"]["databases_referenced"] == []
    assert data["summary"]["total_accessions_found"] == 0


def test_invalid_json_returns_error() -> None:
    data = _call("not valid json")
    assert "error" in data


def test_geo_accession_extraction() -> None:
    payload = json.dumps({
        "records": [
            {
                "pmid": "123",
                "title": "Gene expression study",
                "abstract": "Data deposited in GEO with accession GSE178352.",
            }
        ]
    })
    data = _call(payload)
    assert data["papers_analyzed"] == 1
    finding = data["findings"][0]
    db_names = [db["name"] for db in finding["databases_found"]]
    assert "GEO" in db_names
    geo_db = next(db for db in finding["databases_found"] if db["name"] == "GEO")
    assert "GSE178352" in geo_db["accessions"]
    assert data["summary"]["total_accessions_found"] >= 1


def test_pdb_accession_extraction_no_false_positives() -> None:
    """PDB ID pattern (digit + 3 alnum) must NOT match common 4-letter words."""
    payload = json.dumps({
        "records": [
            {
                "pmid": "456",
                "title": "Protein structure analysis",
                "abstract": (
                    "The crystal structure was solved with PDB accession 1AFT. "
                    "This work shows that data with this link can be found. "
                    "Note that words like this, with, from, here should NOT "
                    "be matched as PDB IDs."
                ),
            }
        ]
    })
    data = _call(payload)
    finding = data["findings"][0]
    pdb_db = next(
        (db for db in finding["databases_found"] if db["name"] == "PDB"), None
    )
    assert pdb_db is not None, "PDB database should be detected"
    # Should match 1AFT (digit + 3 alnum) but not "this"/"with"/"from"/"here"
    assert "1AFT" in pdb_db["accessions"]
    # None of these common 4-letter words should be in accessions
    for word in ("this", "with", "from", "here"):
        assert word not in pdb_db["accessions"], (
            f"'{word}' should not be matched as PDB ID"
        )


def test_multiple_databases_in_one_paper() -> None:
    payload = json.dumps({
        "records": [
            {
                "pmid": "789",
                "title": "Multi-omics study",
                "abstract": (
                    "RNA-seq data available at GEO (GSE12345). "
                    "Protein structures in PDB (1CBS). "
                    "Raw reads deposited in SRA (SRR12345678)."
                ),
            }
        ]
    })
    data = _call(payload)
    finding = data["findings"][0]
    db_names = {db["name"] for db in finding["databases_found"]}
    assert {"GEO", "PDB", "SRA"}.issubset(db_names)
    assert "RNA-seq" in finding["data_types"]


def test_query_log_recorded() -> None:
    ctx = _make_ctx()
    payload = json.dumps({"records": [{"title": "Test", "abstract": "GSE1"}]})
    args = json.dumps({"papers_json": payload})
    asyncio.run(analyze_papers.on_invoke_tool(ctx, args))
    assert len(ctx.context.query_log) == 1
    entry = ctx.context.query_log[0]
    assert entry["source"] == "literature_understanding"
    assert entry["status"] == "completed"
    assert entry["records_count"] == 1


def test_missing_fields_handled_gracefully() -> None:
    """Records without title/abstract should produce empty findings, not crash."""
    payload = json.dumps({"records": [{"pmid": "1"}]})
    data = _call(payload)
    assert data["papers_analyzed"] == 1
    assert data["findings"][0]["databases_found"] == []
