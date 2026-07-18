"""Tests for the pubchem skill — search_pubchem and get_compound.

Tests the three-tier fallback chain (api > httpx > crawl) using
mocked crawler functions.
"""
from __future__ import annotations

import asyncio
import json
from unittest.mock import patch

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.pubchem import (
    get_compound,
    search_pubchem,
)
from app.tools.crawler import CrawlError, FetchResult


def _make_ctx(task_id: str = "test_pubchem") -> ToolContext:
    rc = RunContext(task_id=task_id)
    return ToolContext(
        context=rc,
        tool_name="search_pubchem",
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


def _api_result(content: str, status_code: int = 200) -> FetchResult:
    return FetchResult(
        url="https://pubchem.ncbi.nlm.nih.gov",
        content=content,
        status_code=status_code,
        elapsed_ms=50,
        method_used="api",
        error=None if status_code == 200 else "error",
    )


# ---------------------------------------------------------------------------
# search_pubchem
# ---------------------------------------------------------------------------


def test_search_pubchem_api_success() -> None:
    """search_pubchem returns compounds when API succeeds."""
    api_response = json.dumps({
        "PropertyTable": {
            "Properties": [
                {
                    "CID": 2244,
                    "MolecularFormula": "C9H8O4",
                    "MolecularWeight": 180.16,
                    "IUPACName": "2-acetyloxybenzoic acid",
                    "CanonicalSMILES": "CC(=O)OC1=CC=CC=C1C(=O)O",
                },
                {
                    "CID": 5281607,
                    "MolecularFormula": "C21H20O6",
                    "MolecularWeight": 368.38,
                    "IUPACName": "(1E,6E)-1,7-bis(4-hydroxy-3-methoxyphenyl)hepta-1,6-diene-3,5-dione",
                    "CanonicalSMILES": "COc1cc(/C=C/C(=O)CC(=O)/C=C/c2ccc(O)c(OC)c2)ccc1O",
                },
            ]
        }
    })
    api_result = _api_result(api_response)

    ctx = _make_ctx(task_id="test_pubchem_search")
    with patch("app.skills.builtin.acquisition.pubchem.api_fetch", return_value=api_result):
        args = json.dumps({"term": "aspirin", "max_results": 10})
        result = asyncio.run(search_pubchem.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "pubchem"
    assert data["term"] == "aspirin"
    assert data["count"] == 2
    assert data["method_used"] == "api"
    assert len(data["records"]) == 2
    assert data["records"][0]["cid"] == 2244
    assert data["records"][0]["molecular_formula"] == "C9H8O4"
    assert data["records"][0]["canonical_smiles"] == "CC(=O)OC1=CC=CC=C1C(=O)O"

    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "success"


def test_search_pubchem_parse_failure_rejects_shell_and_uses_playwright() -> None:
    """PubChem shell HTML is rejected until rendered content is available."""
    api_result = _api_result("[]")
    httpx_result = FetchResult(
        url="https://pubchem.ncbi.nlm.nih.gov",
        content="<html><body><div id='root'></div></body></html>",
        status_code=200,
        elapsed_ms=100,
        method_used="httpx",
    )
    crawl_result = FetchResult(
        url="https://pubchem.ncbi.nlm.nih.gov",
        content="<html><body>Aspirin compound results</body></html>",
        status_code=200,
        elapsed_ms=200,
        method_used="crawl",
    )

    ctx = _make_ctx(task_id="test_pubchem_httpx")
    with (
        patch("app.skills.builtin.acquisition.pubchem.api_fetch", return_value=api_result),
        patch("app.tools.crawler.httpx_fetch", return_value=httpx_result),
        patch("app.tools.crawler.playwright_fetch", return_value=crawl_result) as crawl,
    ):
        args = json.dumps({"term": "curcumin"})
        result = asyncio.run(search_pubchem.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["status"] == "page_fallback"
    assert data["method_used"] == "crawl"
    assert "Aspirin compound results" in data["body_text_preview"]
    crawl.assert_called_once()


def test_search_pubchem_all_fail_returns_structured_error() -> None:
    """All fallback failures return attempted methods instead of mock success."""
    api_result = _api_result("", status_code=500)

    ctx = _make_ctx(task_id="test_pubchem_crawl")
    with (
        patch("app.skills.builtin.acquisition.pubchem.api_fetch", return_value=api_result),
        patch(
            "app.skills.builtin.acquisition.pubchem.fetch_with_fallback",
            side_effect=CrawlError("All fetch tiers failed. Tried: httpx, crawl"),
        ),
    ):
        args = json.dumps({"term": "aspirin"})
        result = asyncio.run(search_pubchem.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["status"] == "error"
    assert data["source"] == "pubchem"
    assert data["attempted_methods"] == ["api", "httpx", "crawl"]

    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "failed"


# ---------------------------------------------------------------------------
# get_compound
# ---------------------------------------------------------------------------


def test_get_compound_api_success() -> None:
    """get_compound returns compound details when API succeeds."""
    api_response = json.dumps({
        "PropertyTable": {
            "Properties": [
                {
                    "CID": 2244,
                    "MolecularFormula": "C9H8O4",
                    "MolecularWeight": 180.16,
                    "IUPACName": "2-acetyloxybenzoic acid",
                    "CanonicalSMILES": "CC(=O)OC1=CC=CC=C1C(=O)O",
                    "InChIKey": "BSYNRYMUTXBXSQ-UHFFFAOYSA-N",
                    "InChI": "InChI=1S/C9H8O4/c1-6(10)13-8-5-3-2-4-7(8)9(11)12/h2-5H,1H3,(H,11,12)",
                }
            ]
        }
    })
    api_result = _api_result(api_response)

    ctx = _make_ctx(task_id="test_pubchem_get")
    ctx.tool_name = "get_compound"
    with patch("app.skills.builtin.acquisition.pubchem.api_fetch", return_value=api_result):
        args = json.dumps({"cid": 2244})
        result = asyncio.run(get_compound.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "pubchem"
    assert data["cid"] == 2244
    assert data["method_used"] == "api"
    assert data["record"]["molecular_formula"] == "C9H8O4"
    assert data["record"]["inchi_key"] == "BSYNRYMUTXBXSQ-UHFFFAOYSA-N"

    rc: RunContext = ctx.context
    assert len(rc.sources) == 1
    assert rc.sources[0].database.value == "pubchem"
    assert rc.sources[0].accession == "2244"


def test_get_compound_page_fallback_is_bounded() -> None:
    """get_compound returns no more than 5000 visible-text characters."""
    api_result = _api_result("", status_code=404)
    ctx = _make_ctx(task_id="test_pubchem_get_fail")
    ctx.tool_name = "get_compound"
    fallback_result = FetchResult(
        url="https://pubchem.ncbi.nlm.nih.gov/compound/99999999",
        content=f"<html><body>{'visible ' * 1200}</body></html>",
        status_code=200,
        elapsed_ms=10,
        method_used="crawl",
    )
    with (
        patch("app.skills.builtin.acquisition.pubchem.api_fetch", return_value=api_result),
        patch(
            "app.skills.builtin.acquisition.pubchem.fetch_with_fallback",
            return_value=fallback_result,
        ),
    ):
        args = json.dumps({"cid": 99999999})
        result = asyncio.run(get_compound.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["status"] == "page_fallback"
    assert data["source"] == "pubchem"
    assert len(data["body_text_preview"]) == 5000
