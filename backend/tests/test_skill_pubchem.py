"""PubChem skill tests for the unified async fallback chain."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock, Mock, patch

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.pubchem import get_compound, search_pubchem
from app.tools.crawler import CrawlAttempt, CrawlError, FetchResult


def _context(task_id: str) -> tuple[ToolContext, Mock]:
    facade = Mock()
    run_context = RunContext(task_id=task_id)
    run_context.bind_crawler_facade(facade)
    return (
        ToolContext(
            context=run_context,
            tool_name="pubchem",
            tool_call_id="call_1",
            tool_arguments="{}",
        ),
        facade,
    )


def _attempt(method: str, *, status: str = "succeeded") -> CrawlAttempt:
    return CrawlAttempt(
        method=method,
        url=f"https://{method}.example/data",
        started_at=datetime.now(UTC),
        status=status,
        status_code=200 if status == "succeeded" else 500,
    )


def test_search_pubchem_runs_api_and_page_through_one_audited_call() -> None:
    context, facade = _context("pubchem_search")
    result = FetchResult(
        url="https://api.example/data",
        content=json.dumps(
            {
                "PropertyTable": {
                    "Properties": [
                        {
                            "CID": 2244,
                            "MolecularFormula": "C9H8O4",
                            "MolecularWeight": 180.16,
                            "IUPACName": "aspirin",
                            "CanonicalSMILES": "CC(=O)O",
                        }
                    ]
                }
            }
        ),
        status_code=200,
        elapsed_ms=2,
        method_used="api",
        attempts=(_attempt("api"),),
    )

    with patch(
        "app.skills.builtin.acquisition.pubchem.fetch_with_fallback",
        new=AsyncMock(return_value=result),
    ) as fallback:
        payload = asyncio.run(
            search_pubchem.on_invoke_tool(
                context,
                json.dumps({"term": "aspirin"}),
            )
        )

    data = json.loads(payload)
    assert data["records"][0]["cid"] == 2244
    assert data["attempts"][0]["method"] == "api"
    assert fallback.await_args.args[0].startswith("https://pubchem.ncbi.nlm.nih.gov/rest/pug/")
    assert fallback.await_args.args[1].startswith("https://pubchem.ncbi.nlm.nih.gov/#query=")
    assert fallback.await_args.kwargs["facade"] is facade
    predicate = fallback.await_args.kwargs["accept_result"]
    assert predicate(result)
    assert not predicate(
        FetchResult(
            url="https://api.example/error",
            content='{"Fault": {"Message": "not found"}}',
            status_code=200,
            elapsed_ms=1,
            method_used="api",
        )
    )


def test_search_pubchem_page_fallback_preserves_full_attempt_audit() -> None:
    context, _ = _context("pubchem_fallback")
    result = FetchResult(
        url="https://pubchem.ncbi.nlm.nih.gov/#query=aspirin",
        content="<html><body>Aspirin rendered result</body></html>",
        status_code=200,
        elapsed_ms=2,
        method_used="crawl",
        attempts=(
            _attempt("api", status="failed"),
            _attempt("html", status="failed"),
            _attempt("browser"),
        ),
    )

    with patch(
        "app.skills.builtin.acquisition.pubchem.fetch_with_fallback",
        new=AsyncMock(return_value=result),
    ):
        payload = asyncio.run(
            search_pubchem.on_invoke_tool(
                context,
                json.dumps({"term": "aspirin"}),
            )
        )

    data = json.loads(payload)
    assert data["status"] == "page_fallback"
    assert [attempt["method"] for attempt in data["attempts"]] == [
        "api",
        "html",
        "browser",
    ]


def test_get_compound_api_success_adds_source_provenance() -> None:
    context, _ = _context("pubchem_compound")
    result = FetchResult(
        url="https://api.example/data",
        content=json.dumps(
            {
                "PropertyTable": {
                    "Properties": [
                        {
                            "CID": 2244,
                            "MolecularFormula": "C9H8O4",
                            "MolecularWeight": 180.16,
                            "IUPACName": "aspirin",
                            "CanonicalSMILES": "CC(=O)O",
                            "InChIKey": "KEY",
                            "InChI": "InChI=1",
                        }
                    ]
                }
            }
        ),
        status_code=200,
        elapsed_ms=2,
        method_used="api",
        attempts=(_attempt("api"),),
    )

    with patch(
        "app.skills.builtin.acquisition.pubchem.fetch_with_fallback",
        new=AsyncMock(return_value=result),
    ):
        payload = asyncio.run(
            get_compound.on_invoke_tool(
                context,
                json.dumps({"cid": 2244}),
            )
        )

    assert json.loads(payload)["record"]["cid"] == 2244
    assert context.context.sources[0].accession == "2244"


def test_pubchem_all_tiers_failed_returns_audited_error() -> None:
    context, _ = _context("pubchem_error")
    error = CrawlError(
        "all tiers failed",
        attempts=(
            _attempt("api", status="failed"),
            _attempt("html", status="failed"),
            _attempt("browser", status="failed"),
        ),
    )

    with patch(
        "app.skills.builtin.acquisition.pubchem.fetch_with_fallback",
        new=AsyncMock(side_effect=error),
    ):
        payload = asyncio.run(
            search_pubchem.on_invoke_tool(
                context,
                json.dumps({"term": "missing"}),
            )
        )

    data = json.loads(payload)
    assert data["status"] == "error"
    assert len(data["attempts"]) == 3
