"""Reactome skill tests for the unified async fallback chain."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock, Mock, patch

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.reactome import get_pathway, search_reactome
from app.tools.crawler import CrawlAttempt, FetchResult


def _context(task_id: str) -> tuple[ToolContext, Mock]:
    facade = Mock()
    facade.api = AsyncMock()
    run_context = RunContext(task_id=task_id)
    run_context.bind_crawler_facade(facade)
    return (
        ToolContext(
            context=run_context,
            tool_name="reactome",
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


def test_search_reactome_uses_one_audited_fallback_call() -> None:
    context, facade = _context("reactome_search")
    result = FetchResult(
        url="https://api.example/data",
        content=json.dumps(
            {
                "results": [
                    {
                        "entries": [
                            {
                                "stId": "R-HSA-169893",
                                "name": '<span class="highlighting">Apoptosis</span>',
                                "species": ["Homo sapiens"],
                                "summation": "Programmed cell death",
                                "exactType": "Pathway",
                            }
                        ]
                    }
                ],
                "numberOfMatches": 1,
            }
        ),
        status_code=200,
        elapsed_ms=2,
        method_used="api",
        attempts=(_attempt("api"),),
    )

    with patch(
        "app.skills.builtin.acquisition.reactome.fetch_with_fallback",
        new=AsyncMock(return_value=result),
    ) as fallback:
        payload = asyncio.run(
            search_reactome.on_invoke_tool(
                context,
                json.dumps({"term": "apoptosis"}),
            )
        )

    data = json.loads(payload)
    assert data["records"][0]["name"] == "Apoptosis"
    assert data["attempts"][0]["method"] == "api"
    assert fallback.await_args.args[0].startswith(
        "https://reactome.org/ContentService/search/query"
    )
    assert fallback.await_args.args[1].startswith("https://reactome.org/content/query")
    assert fallback.await_args.kwargs["facade"] is facade
    predicate = fallback.await_args.kwargs["accept_result"]
    assert predicate(result)
    assert not predicate(
        FetchResult(
            url="https://api.example/error",
            content='{"error": "not found"}',
            status_code=200,
            elapsed_ms=1,
            method_used="api",
        )
    )


def test_search_reactome_enrichment_uses_bound_async_facade() -> None:
    context, facade = _context("reactome_enrichment")
    search_result = FetchResult(
        url="https://api.example/data",
        content=json.dumps(
            {
                "results": [
                    {
                        "entries": [
                            {
                                "stId": "R-HSA-169893",
                                "name": "Apoptosis",
                                "species": ["Homo sapiens"],
                                "exactType": "Pathway",
                            }
                        ]
                    }
                ],
                "numberOfMatches": 1,
            }
        ),
        status_code=200,
        elapsed_ms=2,
        method_used="api",
        attempts=(_attempt("api"),),
    )
    facade.api.return_value = FetchResult(
        url="https://reactome.org/summation",
        content=json.dumps([{"text": "Programmed cell death."}]),
        status_code=200,
        elapsed_ms=1,
        method_used="api",
    )

    with patch(
        "app.skills.builtin.acquisition.reactome.fetch_with_fallback",
        new=AsyncMock(return_value=search_result),
    ):
        payload = asyncio.run(
            search_reactome.on_invoke_tool(
                context,
                json.dumps({"term": "apoptosis"}),
            )
        )

    assert json.loads(payload)["records"][0]["summary"] == "Programmed cell death."
    facade.api.assert_awaited_once_with(
        "https://reactome.org/ContentService/data/pathways/R-HSA-169893/summation"
    )


def test_reactome_static_html_fallback_preserves_attempt_audit() -> None:
    context, _ = _context("reactome_fallback")
    result = FetchResult(
        url="https://reactome.org/content/query?q=apoptosis",
        content="<html><body>Visible pathway</body></html>",
        status_code=200,
        elapsed_ms=2,
        method_used="httpx",
        attempts=(
            _attempt("api", status="failed"),
            _attempt("html"),
        ),
    )

    with patch(
        "app.skills.builtin.acquisition.reactome.fetch_with_fallback",
        new=AsyncMock(return_value=result),
    ):
        payload = asyncio.run(
            search_reactome.on_invoke_tool(
                context,
                json.dumps({"term": "apoptosis"}),
            )
        )

    data = json.loads(payload)
    assert data["status"] == "page_fallback"
    assert [attempt["method"] for attempt in data["attempts"]] == ["api", "html"]


def test_get_pathway_api_success_adds_source_provenance() -> None:
    context, _ = _context("reactome_get")
    result = FetchResult(
        url="https://api.example/data",
        content=json.dumps(
            {
                "stId": "R-HSA-169893",
                "name": ["Apoptosis"],
                "speciesName": "Homo sapiens",
                "hasDiagram": True,
            }
        ),
        status_code=200,
        elapsed_ms=2,
        method_used="api",
        attempts=(_attempt("api"),),
    )

    with patch(
        "app.skills.builtin.acquisition.reactome.fetch_with_fallback",
        new=AsyncMock(return_value=result),
    ):
        payload = asyncio.run(
            get_pathway.on_invoke_tool(
                context,
                json.dumps({"pathway_id": "R-HSA-169893"}),
            )
        )

    assert json.loads(payload)["record"]["name"] == "Apoptosis"
    assert context.context.sources[0].accession == "R-HSA-169893"
