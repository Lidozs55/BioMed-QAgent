"""UniProt discovery skill tests (B4 — Agent-only research source)."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock, Mock, patch

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin import builtin_skill_records
from app.skills.builtin.discovery.uniprot import (
    SKILL_CATEGORY,
    SKILL_DESCRIPTION,
    SKILL_NAME,
    SKILL_TOOLS,
    SUPPORTED_SOURCES,
    search_uniprot,
)
from app.tools.crawler import CrawlAttempt, FetchResult


def _context(task_id: str) -> tuple[ToolContext, Mock]:
    facade = Mock()
    facade.api = AsyncMock()
    run_context = RunContext(task_id=task_id)
    run_context.bind_crawler_facade(facade)
    return (
        ToolContext(
            context=run_context,
            tool_name="uniprot",
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


def test_search_uniprot_returns_structured_records_from_api() -> None:
    context, facade = _context("uniprot_search")
    result = FetchResult(
        url="https://rest.uniprot.org/uniprotkb/search?query=TP53",
        content=json.dumps(
            {
                "results": [
                    {
                        "primaryAccession": "P04637",
                        "uniProtkbId": "P53_HUMAN",
                        "reviewed": True,
                        "proteinDescription": {
                            "recommendedName": {
                                "fullName": {"value": "Cellular tumor antigen p53"}
                            }
                        },
                        "genes": [{"geneName": {"value": "TP53"}}],
                        "organism": {"scientificName": "Homo sapiens"},
                    }
                ],
                "totalResults": 1,
            }
        ),
        status_code=200,
        elapsed_ms=2,
        method_used="api",
        attempts=(_attempt("api"),),
    )

    with patch(
        "app.skills.builtin.discovery.uniprot.fetch_with_fallback",
        new=AsyncMock(return_value=result),
    ) as fallback:
        payload = asyncio.run(
            search_uniprot.on_invoke_tool(
                context, json.dumps({"query": "TP53"})
            )
        )

    data = json.loads(payload)
    assert data["source"] == "uniprot"
    assert data["count"] == 1
    assert data["records"][0]["accession"] == "P04637"
    assert data["records"][0]["gene"] == "TP53"
    assert data["records"][0]["protein_name"] == "Cellular tumor antigen p53"
    assert fallback.await_args.args[0].startswith(
        "https://rest.uniprot.org/uniprotkb/search"
    )
    assert fallback.await_args.kwargs["facade"] is facade


def test_search_uniprot_page_fallback_when_api_returns_non_json() -> None:
    context, _ = _context("uniprot_page")
    result = FetchResult(
        url="https://www.uniprot.org/uniprotkb?query=TP53",
        content="<html>render me</html>",
        status_code=200,
        elapsed_ms=3,
        method_used="crawl",
        attempts=(_attempt("crawl"),),
    )

    with patch(
        "app.skills.builtin.discovery.uniprot.fetch_with_fallback",
        new=AsyncMock(return_value=result),
    ) as fallback:
        payload = asyncio.run(
            search_uniprot.on_invoke_tool(
                context, json.dumps({"query": "TP53"})
            )
        )

    data = json.loads(payload)
    assert data["status"] == "page_fallback"
    assert data["method_used"] == "crawl"
    assert fallback.await_args.args[1].startswith(
        "https://www.uniprot.org/uniprotkb"
    )


def test_uniprot_skill_exports_the_direct_tool_table() -> None:
    records = builtin_skill_records()
    record = records["uniprot"]
    assert record.supported_sources == ("uniprot",)
    # Agent-only research source: selectable for investigation, never
    # pipeline-supported for dataset builds.
    assert record.user_selectable is True
    assert record.pipeline_supported is False
    assert record.tool_names == ("search_uniprot",)
    assert SKILL_NAME == "uniprot"
    assert SKILL_CATEGORY.value == "discovery"
    assert SKILL_DESCRIPTION
    assert SUPPORTED_SOURCES == ["uniprot"]
    assert [tool.name for tool in SKILL_TOOLS] == ["search_uniprot"]
