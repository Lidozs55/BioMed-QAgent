"""Explicit live acceptance tests for official Reactome and PubChem APIs."""
from __future__ import annotations

import asyncio
import json

import pytest
from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.pubchem import get_compound
from app.skills.builtin.acquisition.reactome import search_reactome

pytestmark = pytest.mark.live


def _context(tool_name: str) -> ToolContext:
    return ToolContext(
        context=RunContext(task_id=f"live_{tool_name}"),
        tool_name=tool_name,
        tool_call_id="live_call",
        tool_arguments="{}",
    )


def test_search_reactome_live_returns_human_pathway() -> None:
    result = asyncio.run(search_reactome.on_invoke_tool(
        _context("search_reactome"),
        json.dumps({"term": "apoptosis", "max_results": 3}),
    ))
    data = json.loads(result)

    assert data["method_used"] == "api"
    assert data["count"] >= 1
    assert any(record["pathway_id"].startswith("R-HSA-") for record in data["records"])


def test_get_compound_live_returns_aspirin() -> None:
    result = asyncio.run(get_compound.on_invoke_tool(
        _context("get_compound"),
        json.dumps({"cid": 2244}),
    ))
    data = json.loads(result)

    assert data["method_used"] == "api"
    assert data["record"]["cid"] == 2244
    assert data["record"]["molecular_formula"]
