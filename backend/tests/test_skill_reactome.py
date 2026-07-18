"""Tests for the reactome skill — search_reactome and get_pathway.

Tests the three-tier fallback chain (api > httpx > crawl) using
mocked crawler functions.
"""
from __future__ import annotations

import asyncio
import json
from unittest.mock import patch

from agents.tool_context import ToolContext
from app.agent_loop.context import RunContext
from app.skills.builtin.acquisition.reactome import (
    get_pathway,
    search_reactome,
)
from app.tools.crawler import CrawlError, FetchResult


def _make_ctx(task_id: str = "test_reactome") -> ToolContext:
    rc = RunContext(task_id=task_id)
    return ToolContext(
        context=rc,
        tool_name="search_reactome",
        tool_call_id="test_call_1",
        tool_arguments="{}",
    )


def _api_result(content: str, status_code: int = 200) -> FetchResult:
    return FetchResult(
        url="https://reactome.org",
        content=content,
        status_code=status_code,
        elapsed_ms=50,
        method_used="api",
        error=None if status_code == 200 else "error",
    )


# ---------------------------------------------------------------------------
# search_reactome
# ---------------------------------------------------------------------------


def test_search_reactome_api_success() -> None:
    """search_reactome returns records when API succeeds."""
    # 真实 Reactome API 结构:results 分组,每组含 entries;name/summation 含高亮 span
    api_response = json.dumps({
        "results": [
            {
                "typeName": "Pathway",
                "entriesCount": 2,
                "entries": [
                    {
                        "stId": "R-HSA-169893",
                        "name": '<span class="highlighting">Apoptosis</span>',
                        "species": ["Homo sapiens"],
                        "summation": '<span class="highlighting">Apoptosis</span> is programmed cell death',
                        "exactType": "Pathway",
                    },
                    {
                        "stId": "R-HSA-109582",
                        "name": "Hemostasis",
                        "species": ["Homo sapiens"],
                        "summation": "Blood clotting",
                        "exactType": "Pathway",
                    },
                ],
            }
        ],
        "numberOfMatches": 894,
    })
    api_result = _api_result(api_response)

    ctx = _make_ctx(task_id="test_reactome_search")
    with patch("app.skills.builtin.acquisition.reactome.api_fetch", return_value=api_result):
        args = json.dumps({"term": "apoptosis", "max_results": 10})
        result = asyncio.run(search_reactome.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "reactome"
    assert data["term"] == "apoptosis"
    assert data["count"] == 2
    assert data["total_matches"] == 894
    assert data["method_used"] == "api"
    assert len(data["records"]) == 2
    assert data["records"][0]["pathway_id"] == "R-HSA-169893"
    # HTML 高亮标签应被清洗
    assert data["records"][0]["name"] == "Apoptosis"
    assert "highlighting" not in data["records"][0]["summary"]
    assert data["records"][0]["species"] == "Homo sapiens"
    assert data["records"][0]["type"] == "Pathway"

    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "success"


def test_search_reactome_enriches_missing_summation_via_pathways_endpoint() -> None:
    """search_reactome 补全缺失的 summary 字段。

    真实 Reactome ContentService ``/search/query`` 的 entries 不一定包含
    ``summation`` 字段;search_reactome 应对前 N 条调用
    ``/data/pathways/{stId}/summation`` 端点补全。
    """
    # search/query 返回的 entries 没有 summation 字段
    search_response = json.dumps({
        "results": [
            {
                "typeName": "Pathway",
                "entriesCount": 1,
                "entries": [
                    {
                        "stId": "R-HSA-169893",
                        "name": "Apoptosis",
                        "species": ["Homo sapiens"],
                        "exactType": "Pathway",
                    }
                ],
            }
        ],
        "numberOfMatches": 1,
    })
    summation_response = json.dumps([
        {"text": "Programmed cell death pathway.", "releaseDate": "2024-01-01"},
        {"text": "Regulated by caspases and Bcl-2 family."},
    ])

    search_result = _api_result(search_response)
    summation_result = _api_result(summation_response)

    ctx = _make_ctx(task_id="test_reactome_enrich")
    # search_reactome 先调 search/query,再调 /data/pathways/{id}/summation
    with patch(
        "app.skills.builtin.acquisition.reactome.api_fetch",
        side_effect=[search_result, summation_result],
    ):
        args = json.dumps({"term": "apoptosis", "max_results": 10})
        result = asyncio.run(search_reactome.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "reactome"
    assert data["count"] == 1
    assert data["enriched_count"] == 1
    rec0 = data["records"][0]
    assert rec0["pathway_id"] == "R-HSA-169893"
    # summary 应包含两段拼接
    assert "Programmed cell death pathway." in rec0["summary"]
    assert "Regulated by caspases and Bcl-2 family." in rec0["summary"]

    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "success"


def test_search_reactome_summation_fetch_failure_keeps_empty_summary() -> None:
    """search_reactome 在 summation 端点失败时保留空 summary,不抛异常。"""
    search_response = json.dumps({
        "results": [
            {
                "typeName": "Pathway",
                "entriesCount": 1,
                "entries": [
                    {
                        "stId": "R-HSA-169893",
                        "name": "Apoptosis",
                        "species": ["Homo sapiens"],
                        "exactType": "Pathway",
                    }
                ],
            }
        ],
        "numberOfMatches": 1,
    })
    search_result = _api_result(search_response)
    # summation 端点返回 500
    summation_failed = _api_result("", status_code=500)

    ctx = _make_ctx(task_id="test_reactome_summation_fail")
    with patch(
        "app.skills.builtin.acquisition.reactome.api_fetch",
        side_effect=[search_result, summation_failed],
    ):
        args = json.dumps({"term": "apoptosis", "max_results": 10})
        result = asyncio.run(search_reactome.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["count"] == 1
    assert data["records"][0]["summary"] == ""


def test_search_reactome_parse_failure_accepts_useful_static_html() -> None:
    """Reactome can use useful visible static HTML without Playwright."""
    api_result = _api_result("[]")
    httpx_result = FetchResult(
        url="https://reactome.org",
        content="<html><body>Apoptosis pathway details</body></html>",
        status_code=200,
        elapsed_ms=100,
        method_used="httpx",
    )

    ctx = _make_ctx(task_id="test_reactome_httpx")
    with (
        patch("app.skills.builtin.acquisition.reactome.api_fetch", return_value=api_result),
        patch("app.tools.crawler.httpx_fetch", return_value=httpx_result),
        patch("app.tools.crawler.playwright_fetch") as crawl,
    ):
        args = json.dumps({"term": "BRCA"})
        result = asyncio.run(search_reactome.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "reactome"
    assert data["status"] == "page_fallback"
    assert data["method_used"] == "httpx"
    assert data["body_text_preview"] == "Apoptosis pathway details"
    crawl.assert_not_called()


def test_search_reactome_all_fail_returns_structured_error() -> None:
    """Reactome reports all attempted methods when page fallback fails."""
    api_result = _api_result("", status_code=500)
    ctx = _make_ctx(task_id="test_reactome_crawl")
    with (
        patch("app.skills.builtin.acquisition.reactome.api_fetch", return_value=api_result),
        patch(
            "app.skills.builtin.acquisition.reactome.fetch_with_fallback",
            side_effect=CrawlError("All fetch tiers failed. Tried: httpx, crawl"),
        ),
    ):
        args = json.dumps({"term": "cell cycle"})
        result = asyncio.run(search_reactome.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["status"] == "error"
    assert data["source"] == "reactome"
    assert data["attempted_methods"] == ["api", "httpx", "crawl"]

    rc: RunContext = ctx.context
    assert len(rc.query_log) == 1
    assert rc.query_log[0]["status"] == "failed"


# ---------------------------------------------------------------------------
# get_pathway
# ---------------------------------------------------------------------------


def test_get_pathway_api_success() -> None:
    """get_pathway returns pathway details when API succeeds."""
    # 真实 Reactome /data/query/{stId} 端点返回 name 可为数组
    api_response = json.dumps({
        "stId": "R-HSA-169893",
        "name": ["Apoptosis"],
        "speciesName": "Homo sapiens",
        "hasDiagram": True,
        "summation": "Programmed cell death pathway",
        "releaseDate": "2024-01-01",
    })
    api_result = _api_result(api_response)

    ctx = _make_ctx(task_id="test_reactome_get")
    ctx.tool_name = "get_pathway"
    with patch("app.skills.builtin.acquisition.reactome.api_fetch", return_value=api_result):
        args = json.dumps({"pathway_id": "R-HSA-169893"})
        result = asyncio.run(get_pathway.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["source"] == "reactome"
    assert data["pathway_id"] == "R-HSA-169893"
    assert data["method_used"] == "api"
    # name 数组应取首项
    assert data["record"]["name"] == "Apoptosis"
    assert data["record"]["has_diagram"] is True
    assert data["record"]["species"] == "Homo sapiens"

    rc: RunContext = ctx.context
    assert len(rc.sources) == 1
    assert rc.sources[0].database.value == "reactome"
    assert rc.sources[0].accession == "R-HSA-169893"


def test_get_pathway_name_as_string() -> None:
    """get_pathway handles name field as plain string (not array)."""
    api_response = json.dumps({
        "stId": "R-HSA-109582",
        "name": "Hemostasis",
        "speciesName": "Homo sapiens",
        "hasDiagram": True,
    })
    api_result = _api_result(api_response)

    ctx = _make_ctx(task_id="test_reactome_get_str")
    ctx.tool_name = "get_pathway"
    with patch("app.skills.builtin.acquisition.reactome.api_fetch", return_value=api_result):
        args = json.dumps({"pathway_id": "R-HSA-109582"})
        result = asyncio.run(get_pathway.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["record"]["name"] == "Hemostasis"


def test_get_pathway_page_fallback_returns_visible_text() -> None:
    """get_pathway strips non-visible HTML from its page fallback."""
    api_result = _api_result("", status_code=404)
    ctx = _make_ctx(task_id="test_reactome_get_fail")
    ctx.tool_name = "get_pathway"
    fallback_result = FetchResult(
        url="https://reactome.org/content/detail/R-HSA-999999",
        content="<html><head><style>hidden</style></head><body>Visible pathway</body></html>",
        status_code=200,
        elapsed_ms=10,
        method_used="httpx",
    )
    with (
        patch("app.skills.builtin.acquisition.reactome.api_fetch", return_value=api_result),
        patch(
            "app.skills.builtin.acquisition.reactome.fetch_with_fallback",
            return_value=fallback_result,
        ),
    ):
        args = json.dumps({"pathway_id": "R-HSA-999999"})
        result = asyncio.run(get_pathway.on_invoke_tool(ctx, args))

    data = json.loads(result)
    assert data["status"] == "page_fallback"
    assert data["source"] == "reactome"
    assert data["body_text_preview"] == "Visible pathway"
