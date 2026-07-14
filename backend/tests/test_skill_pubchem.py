"""Tests for the pubchem skill — search_pubchem and get_compound.

Tests the three-tier fallback chain (api > httpx > requires_crawl) using
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
from app.tools.crawler import FetchResult


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
    assert rc.query_log[0]["status"] == "ok"


def test_search_pubchem_api_fail_httpx_fallback() -> None:
    """search_pubchem falls back to httpx when API fails."""
    api_result = _api_result("", status_code=500)
    httpx_result = FetchResult(
        url="https://pubchem.ncbi.nlm.nih.gov",
        content="<html>page</html>",
        status_code=200,
        elapsed_ms=100,
        method_used="httpx",
    )

    ctx = _make_ctx(task_id="test_pubchem_httpx")
    with patch("app.skills.builtin.acquisition.pubchem.api_fetch", return_value=api_result), \
         patch("app.skills.builtin.acquisition.pubchem.httpx_fetch", return_value=httpx_result):
        args = json.dumps({"term": "curcumin"})
        result = asyncio.run(search_pubchem.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "pubchem"
    assert data["method_used"] == "httpx"
    assert data["count"] == 0


def test_search_pubchem_all_fail_returns_requires_crawl() -> None:
    """search_pubchem returns requires_crawl signal when all tiers fail."""
    api_result = _api_result("", status_code=500)
    httpx_result = FetchResult(
        url="", content="", status_code=0, elapsed_ms=0,
        method_used="httpx", error="403 Forbidden",
    )

    ctx = _make_ctx(task_id="test_pubchem_crawl")
    with patch("app.skills.builtin.acquisition.pubchem.api_fetch", return_value=api_result), \
         patch("app.skills.builtin.acquisition.pubchem.httpx_fetch", return_value=httpx_result):
        args = json.dumps({"term": "aspirin"})
        result = asyncio.run(search_pubchem.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["status"] == "requires_crawl"
    assert data["source"] == "pubchem"
    assert "api" in data["tried_methods"]
    assert "httpx" in data["tried_methods"]
    assert "target_url" in data

    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "error"


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
    assert rc.sources[0].source == "pubchem"
    assert rc.sources[0].accession == "2244"


def test_get_compound_all_fail_returns_requires_crawl() -> None:
    """get_compound returns requires_crawl when all tiers fail."""
    api_result = _api_result("", status_code=404)
    httpx_result = FetchResult(
        url="", content="", status_code=0, elapsed_ms=0,
        method_used="httpx", error="403",
    )

    ctx = _make_ctx(task_id="test_pubchem_get_fail")
    ctx.tool_name = "get_compound"
    with patch("app.skills.builtin.acquisition.pubchem.api_fetch", return_value=api_result), \
         patch("app.skills.builtin.acquisition.pubchem.httpx_fetch", return_value=httpx_result):
        args = json.dumps({"cid": 99999999})
        result = asyncio.run(get_compound.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["status"] == "requires_crawl"
    assert data["source"] == "pubchem"
