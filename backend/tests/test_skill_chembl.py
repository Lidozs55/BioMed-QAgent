"""ChEMBL discovery skill tests (B4 — Agent-only research source)."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from unittest.mock import AsyncMock, Mock, patch

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin import builtin_skill_records
from app.skills.builtin.discovery.chembl import (
    SKILL_CATEGORY,
    SKILL_DESCRIPTION,
    SKILL_NAME,
    SKILL_TOOLS,
    SUPPORTED_SOURCES,
    search_chembl,
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
            tool_name="chembl",
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


def test_search_chembl_returns_structured_records_from_api() -> None:
    context, facade = _context("chembl_search")
    result = FetchResult(
        url="https://www.ebi.ac.uk/chembl/api/data/molecule/search?q=aspirin",
        content=json.dumps(
            {
                "molecules": [
                    {
                        "molecule_chembl_id": "CHEMBL25",
                        "pref_name": "Aspirin",
                        "molecule_type": "Small molecule",
                        "max_phase": 4,
                    }
                ],
                "page_meta": {"total_count": 1},
            }
        ),
        status_code=200,
        elapsed_ms=2,
        method_used="api",
        attempts=(_attempt("api"),),
    )

    with patch(
        "app.skills.builtin.discovery.chembl.fetch_with_fallback",
        new=AsyncMock(return_value=result),
    ) as fallback:
        payload = asyncio.run(
            search_chembl.on_invoke_tool(
                context, json.dumps({"query": "aspirin"})
            )
        )

    data = json.loads(payload)
    assert data["source"] == "chembl"
    assert data["count"] == 1
    assert data["records"][0]["chembl_id"] == "CHEMBL25"
    assert data["records"][0]["preferred_name"] == "Aspirin"
    assert fallback.await_args.args[0].startswith(
        "https://www.ebi.ac.uk/chembl/api/data/molecule/search"
    )
    assert fallback.await_args.kwargs["facade"] is facade


def test_search_chembl_page_fallback_when_api_returns_non_json() -> None:
    context, _ = _context("chembl_page")
    result = FetchResult(
        url="https://www.ebi.ac.uk/chembl/g",
        content="<html>render me</html>",
        status_code=200,
        elapsed_ms=3,
        method_used="crawl",
        attempts=(_attempt("crawl"),),
    )

    with patch(
        "app.skills.builtin.discovery.chembl.fetch_with_fallback",
        new=AsyncMock(return_value=result),
    ) as fallback:
        payload = asyncio.run(
            search_chembl.on_invoke_tool(
                context, json.dumps({"query": "aspirin"})
            )
        )

    data = json.loads(payload)
    assert data["status"] == "page_fallback"
    assert data["method_used"] == "crawl"
    assert "chembl" in fallback.await_args.args[1]


def test_chembl_skill_exports_the_direct_tool_table() -> None:
    records = builtin_skill_records()
    record = records["chembl"]
    assert record.supported_sources == ("chembl",)
    # Agent-only research source: selectable for investigation, never
    # pipeline-supported for dataset builds.
    assert record.user_selectable is True
    assert record.pipeline_supported is False
    assert record.tool_names == ("search_chembl",)
    assert SKILL_NAME == "chembl"
    assert SKILL_CATEGORY.value == "discovery"
    assert SKILL_DESCRIPTION
    assert SUPPORTED_SOURCES == ["chembl"]
    assert [tool.name for tool in SKILL_TOOLS] == ["search_chembl"]
