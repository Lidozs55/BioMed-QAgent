"""Reactome acquisition skill — search and fetch biological pathway data.

Reactome is a free, open-source, curated and peer-reviewed pathway database.
This skill uses the three-tier fallback chain (api > httpx > crawl):

    1. API first: Reactome ContentService REST API (structured JSON)
    2. httpx second: direct page fetch with browser UA
    3. crawl fallback: return requires_crawl signal for Playwright

Reactome REST API docs: https://reactome.org/ContentService
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any
from urllib.parse import quote

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.output import SourceRecord
from app.skills.registry import SkillCategory, SkillDef, skill_registry
from app.tools.crawl_signal import requires_crawl_json
from app.tools.crawler import api_fetch, httpx_fetch

logger = logging.getLogger(__name__)

_REACTOME_API_BASE = "https://reactome.org/ContentService"
_REACTOME_PAGE_BASE = "https://reactome.org/content/detail"

# 匹配 Reactome 搜索结果中的高亮 span 标签
_HIGHLIGHT_RE = re.compile(r"<[^>]+>")


def _strip_html(text: str) -> str:
    """移除 Reactome 搜索结果中的 HTML 高亮标签。

    Reactome ContentService 搜索 API 会在 name/summation 字段中返回
    形如 ``<span class="highlighting">apoptosis</span>`` 的高亮标签,
    需要清洗后才能呈现给用户。
    """
    if not text:
        return ""
    return _HIGHLIGHT_RE.sub("", text).strip()


@function_tool
def search_reactome(
    ctx: RunContextWrapper[Any],
    term: str,
    max_results: int = 20,
) -> str:
    """Search Reactome for biological pathways matching a keyword.

    Queries the Reactome ContentService REST API (tier 1). If the API is
    unavailable, falls back to httpx page fetch (tier 2). If both fail,
    returns a ``requires_crawl`` signal so the agent can use Playwright.

    Args:
        ctx: Agent SDK run context wrapper.
        term: Search keyword (e.g. "BRCA", "apoptosis", "cell cycle").
        max_results: Maximum number of pathways to return (default 20).

    Returns:
        JSON string with keys: source, term, count, records.
        On failure: JSON with status="requires_crawl".
    """
    run_ctx: RunContext = ctx.context
    encoded_term = quote(term)
    # Reactome ContentService search/query 使用 startIndex/pageSize 分页
    api_url = (
        f"{_REACTOME_API_BASE}/search/query?query={encoded_term}"
        f"&species=Homo+sapiens&startIndex=0&pageSize={max_results}"
    )

    # Tier 1: API
    result = api_fetch(api_url)
    if result.ok:
        try:
            data = json.loads(result.content)
            # 响应结构: {results: [{entries: [...], typeName, ...}], numberOfMatches, ...}
            # results 按 typeName 分组,每组含 entries 列表;需拍平并截断到 max_results
            groups = data.get("results", [])
            entries: list[dict] = []
            for group in groups:
                entries.extend(group.get("entries", []))
            records = [
                {
                    "pathway_id": e.get("stId", ""),
                    "name": _strip_html(e.get("name", "")),
                    "species": (
                        ", ".join(e.get("species", []))
                        if isinstance(e.get("species"), list)
                        else str(e.get("species", ""))
                    ),
                    "summary": _strip_html(e.get("summation", "")),
                    "type": e.get("exactType", e.get("type", "")),
                    "url": f"{_REACTOME_PAGE_BASE}/{e.get('stId', '')}",
                }
                for e in entries[:max_results]
            ]
            run_ctx.log_query(term, "reactome", "ok", len(records))
            return json.dumps({
                "source": "reactome",
                "term": term,
                "count": len(records),
                "total_matches": data.get("numberOfMatches", len(records)),
                "records": records,
                "method_used": "api",
            }, ensure_ascii=False)
        except (json.JSONDecodeError, KeyError) as exc:
            logger.warning("Failed to parse Reactome API response: %s", exc)

    # Tier 2: httpx (page fetch — limited parsing)
    page_url = f"https://reactome.org/content/query?q={encoded_term}"
    page_result = httpx_fetch(page_url)
    if page_result.ok:
        # Page fetch returns HTML; we can only confirm reachability
        run_ctx.log_query(term, "reactome", "ok", 0)
        return json.dumps({
            "source": "reactome",
            "term": term,
            "count": 0,
            "records": [],
            "method_used": "httpx",
            "note": "API unavailable; page fetched but requires HTML parsing",
            "page_url": page_url,
        }, ensure_ascii=False)

    # Tier 3: requires_crawl signal
    run_ctx.log_query(term, "reactome", "error", 0)
    return requires_crawl_json(
        source="reactome",
        reason=(
            f"Reactome API and httpx both failed: api={result.error or result.status_code}, "
            f"httpx={page_result.error or page_result.status_code}"
        ),
        tried_methods=["api", "httpx"],
        target_url=page_url,
    )


@function_tool
def get_pathway(
    ctx: RunContextWrapper[Any],
    pathway_id: str,
) -> str:
    """Get detailed information about a specific Reactome pathway.

    Queries the Reactome ContentService REST API for pathway details,
    including participants, events, and literature references.

    Args:
        ctx: Agent SDK run context wrapper.
        pathway_id: Reactome stable ID (e.g. "R-HSA-169893").

    Returns:
        JSON string with pathway details: pathway_id, name, species,
        has_diagram, url, and participants count.
        On failure: JSON with status="requires_crawl".
    """
    run_ctx: RunContext = ctx.context
    # Reactome ContentService 详情端点:/data/query/{stId}(不是 /data/pathway/)
    api_url = f"{_REACTOME_API_BASE}/data/query/{pathway_id}"

    # Tier 1: API
    result = api_fetch(api_url)
    if result.ok:
        try:
            data = json.loads(result.content)
            # name 字段在某些端点返回数组(如 ['Hemostasis', 'Blood coagulation']),
            # 取首项作为主名;speciesName 是字符串
            raw_name = data.get("name", "")
            if isinstance(raw_name, list):
                name = raw_name[0] if raw_name else ""
            else:
                name = str(raw_name)
            record = {
                "pathway_id": data.get("stId", pathway_id),
                "name": name,
                "species": data.get("speciesName", ""),
                "has_diagram": data.get("hasDiagram", False),
                "url": f"{_REACTOME_PAGE_BASE}/{data.get('stId', pathway_id)}",
                "summation": data.get("summation", ""),
                "release_date": data.get("releaseDate", ""),
            }
            run_ctx.log_query(pathway_id, "reactome", "ok", 1)

            source_record = SourceRecord(
                source="reactome",
                accession=pathway_id,
                source_url=api_url,
                local_files=[],
                format_hint="reactome_json",
            )
            run_ctx.add_source(source_record)

            return json.dumps({
                "source": "reactome",
                "pathway_id": pathway_id,
                "record": record,
                "method_used": "api",
            }, ensure_ascii=False)
        except (json.JSONDecodeError, KeyError) as exc:
            logger.warning("Failed to parse Reactome pathway response: %s", exc)

    # Tier 2: httpx
    page_url = f"{_REACTOME_PAGE_BASE}/{pathway_id}"
    page_result = httpx_fetch(page_url)
    if page_result.ok:
        run_ctx.log_query(pathway_id, "reactome", "ok", 1)
        return json.dumps({
            "source": "reactome",
            "pathway_id": pathway_id,
            "method_used": "httpx",
            "page_url": page_url,
            "note": "API unavailable; page fetched but requires HTML parsing",
        }, ensure_ascii=False)

    # Tier 3: requires_crawl
    run_ctx.log_query(pathway_id, "reactome", "error", 0)
    return requires_crawl_json(
        source="reactome",
        reason=f"Reactome pathway API and httpx both failed for {pathway_id}",
        tried_methods=["api", "httpx"],
        target_url=page_url,
    )


reactome_skill = SkillDef(
    name="reactome",
    category=SkillCategory.ACQUISITION,
    description=(
        "Search and fetch biological pathway data from Reactome. "
        "Use when the user asks about pathways, Reactome, biological processes, "
        "or needs pathway participants and literature references."
    ),
    instructions=(
        "Use search_reactome to find pathways by keyword (e.g. 'apoptosis', 'BRCA'). "
        "Use get_pathway to fetch details for a specific pathway by its stable ID "
        "(e.g. 'R-HSA-169893'). If a requires_crawl signal is returned, use the "
        "browser skill's navigate_page tool to fetch the page with Playwright."
    ),
    tools=[search_reactome, get_pathway],
    supported_sources=["reactome"],
    version="0.1.0",
)

skill_registry.register(reactome_skill)
