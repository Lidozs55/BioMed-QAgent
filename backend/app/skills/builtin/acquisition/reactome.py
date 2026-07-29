"""Reactome acquisition skill — search and fetch biological pathway data.

Reactome is a free, open-source, curated and peer-reviewed pathway database.
This skill uses the three-tier fallback chain (api > httpx > crawl):

    1. API first: Reactome ContentService REST API (structured JSON)
    2. httpx second: direct page fetch with browser UA
    3. crawl fallback: Playwright-rendered visible page text

Reactome REST API docs: https://reactome.org/ContentService
"""

from __future__ import annotations

import json
import logging
import re
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

from agents import RunContextWrapper, function_tool
from bs4 import BeautifulSoup

from app.agent_loop.context import RunContext
from app.domain.contracts import Database, QueryStatus, SourceRecord, make_source_id
from app.skills.registry import SkillCategory, SkillDef, skill_registry
from app.tools.crawler import CrawlAttempt, CrawlError, FetchResult, fetch_with_fallback

logger = logging.getLogger(__name__)

_REACTOME_API_BASE = "https://reactome.org/ContentService"
_REACTOME_PAGE_BASE = "https://reactome.org/content/detail"

# 匹配 Reactome 搜索结果中的高亮 span 标签
_HIGHLIGHT_RE = re.compile(r"<[^>]+>")
_MAX_BODY_CHARS = 5000

#: search_reactome 内部对前 N 条无 summary 的结果调用 /data/pathways/{id}/summation
#: 补全,避免 N+1 查询阻塞 agent loop。
_SUMMATION_BATCH_LIMIT = 3


def _visible_text(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "head", "noscript"]):
        tag.decompose()
    return " ".join(soup.get_text(separator=" ", strip=True).split())


def _reactome_api_document(result: FetchResult) -> dict[str, object] | None:
    if result.method_used == "api":
        try:
            document = json.loads(result.content)
        except (json.JSONDecodeError, TypeError):
            return None
        return document if isinstance(document, dict) else None
    return None


def _accept_reactome_search_result(result: FetchResult) -> bool:
    document = _reactome_api_document(result)
    if document is not None:
        return isinstance(document.get("results"), list)
    return bool(_visible_text(result.content))


def _accept_reactome_pathway_result(result: FetchResult) -> bool:
    document = _reactome_api_document(result)
    if document is not None:
        return isinstance(document.get("stId"), str)
    return bool(_visible_text(result.content))


def _attempt_audit(attempts: tuple[CrawlAttempt, ...]) -> list[dict[str, object]]:
    return [
        {
            "method": attempt.method,
            "url": attempt.url,
            "status": attempt.status,
            "status_code": attempt.status_code,
            "reason": attempt.reason,
            "fallback_reason": attempt.fallback_reason,
        }
        for attempt in attempts
    ]


def _page_fallback(source: str, page_url: str, result: FetchResult) -> str:
    return json.dumps(
        {
            "status": "page_fallback",
            "source": source,
            "method_used": result.method_used,
            "page_url": page_url,
            "body_text_preview": _visible_text(result.content)[:_MAX_BODY_CHARS],
            "attempts": _attempt_audit(result.attempts),
        },
        ensure_ascii=False,
    )


def _fallback_error(source: str, page_url: str, error: CrawlError) -> str:
    return json.dumps(
        {
            "status": "error",
            "source": source,
            "page_url": page_url,
            "attempted_methods": ["api", "httpx", "crawl"],
            "attempts": _attempt_audit(error.attempts),
            "error": str(error),
        },
        ensure_ascii=False,
    )


def _strip_html(text: str) -> str:
    """移除 Reactome 搜索结果中的 HTML 高亮标签。

    Reactome ContentService 搜索 API 会在 name/summation 字段中返回
    形如 ``<span class="highlighting">apoptosis</span>`` 的高亮标签,
    需要清洗后才能呈现给用户。
    """
    if not text:
        return ""
    return _HIGHLIGHT_RE.sub("", text).strip()


async def _fetch_pathway_summation(
    run_ctx: RunContext,
    pathway_id: str,
) -> str:
    """Fetch the summation text for a single pathway.

    Reactome ContentService ``/data/pathways/{stId}/summation`` 端点返回
    形如 ``[{"text": "...", "releaseDate": "..."}]`` 的数组;多段按顺序拼接。

    Returns:
        空字符串表示获取失败或无 summation;非空字符串为清洗 HTML 后的
        多段拼接结果。
    """
    if not pathway_id:
        return ""
    url = f"{_REACTOME_API_BASE}/data/pathways/{pathway_id}/summation"
    result = await run_ctx.crawler_facade.api(url)
    if not result.ok:
        return ""
    try:
        data = json.loads(result.content)
    except (json.JSONDecodeError, ValueError):
        return ""
    if not isinstance(data, list):
        return ""
    texts: list[str] = []
    for item in data:
        if isinstance(item, dict):
            text = item.get("text", "")
            if text:
                texts.append(_strip_html(text))
    return "\n".join(texts)


@function_tool(
    description_override=(
        "Search Reactome for biological pathways matching a keyword. "
        "Parameters: ``term`` (required, search keyword like 'apoptosis' "
        "or 'Alzheimer'), ``max_results`` (optional, default 20). "
        "Returns JSON with source, count, and pathway records "
        "(pathway_id, name, species, etc.). Use ``get_pathway`` to "
        "fetch detailed molecule lists for a specific pathway_id."
    ),
)
async def search_reactome(
    ctx: RunContextWrapper[Any],
    term: str,
    max_results: int = 20,
) -> str:
    """Search Reactome for biological pathways matching a keyword.

    Queries the Reactome ContentService REST API first. If it is unavailable
    or cannot be parsed, returns useful static or Playwright-rendered page text.

    Args:
        ctx: Agent SDK run context wrapper.
        term: Search keyword (e.g. "BRCA", "apoptosis", "cell cycle").
        max_results: Maximum number of pathways to return (default 20).

    Returns:
        JSON string with keys: source, term, count, records.
        On page fallback: JSON with status="page_fallback".
        On failure: JSON with status="error" and attempted methods.
    """
    run_ctx: RunContext = ctx.context
    encoded_term = quote(term)
    # Reactome ContentService search/query 使用 startIndex/pageSize 分页
    api_url = (
        f"{_REACTOME_API_BASE}/search/query?query={encoded_term}"
        f"&species=Homo+sapiens&startIndex=0&pageSize={max_results}"
    )

    page_url = f"https://reactome.org/content/query?q={encoded_term}"
    try:
        result = await fetch_with_fallback(
            api_url,
            page_url,
            source_name="reactome",
            accept_result=_accept_reactome_search_result,
            facade=run_ctx.crawler_facade,
        )
    except CrawlError as exc:
        run_ctx.log_query(term, "reactome", QueryStatus.FAILED, 0)
        return _fallback_error("reactome", page_url, exc)
    if result.method_used == "api":
        try:
            data = json.loads(result.content)
            # 响应结构: {results: [{entries: [...], typeName, ...}], numberOfMatches, ...}
            # results 按 typeName 分组,每组含 entries 列表;需拍平并截断到 max_results
            groups = data.get("results", [])
            entries: list[dict] = []
            for group in groups:
                entries.extend(group.get("entries", []))
            # 截断到 max_results 后再补全 summary,避免对全量 entries 调用 N+1
            truncated = entries[:max_results]
            enrich_limit = min(len(truncated), _SUMMATION_BATCH_LIMIT)
            records: list[dict[str, Any]] = []
            for index, e in enumerate(truncated):
                summary = _strip_html(e.get("summation", ""))
                # 前 N 条:若 search API 未返回非空 summation,调用
                # /data/pathways/{stId}/summation 端点补全
                if not summary and index < enrich_limit:
                    summary = await _fetch_pathway_summation(
                        run_ctx,
                        e.get("stId", ""),
                    )
                record = {
                    "pathway_id": e.get("stId", ""),
                    "name": _strip_html(e.get("name", "")),
                    "species": (
                        ", ".join(e.get("species", []))
                        if isinstance(e.get("species"), list)
                        else str(e.get("species", ""))
                    ),
                    "summary": summary,
                    "type": e.get("exactType", e.get("type", "")),
                    "url": f"{_REACTOME_PAGE_BASE}/{e.get('stId', '')}",
                }
                records.append(record)
            run_ctx.log_query(term, "reactome", QueryStatus.SUCCESS, len(records))
            return json.dumps(
                {
                    "source": "reactome",
                    "term": term,
                    "count": len(records),
                    "total_matches": data.get("numberOfMatches", len(records)),
                    "records": records,
                    "enriched_count": enrich_limit,
                    "method_used": "api",
                    "attempts": _attempt_audit(result.attempts),
                },
                ensure_ascii=False,
            )
        except (json.JSONDecodeError, AttributeError, KeyError, TypeError) as exc:
            logger.warning("Failed to parse Reactome API response: %s", exc)
    run_ctx.log_query(term, "reactome", QueryStatus.PAGE_FALLBACK, 0)
    return _page_fallback("reactome", page_url, result)


@function_tool
async def get_pathway(
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
        On page fallback: JSON with status="page_fallback".
        On failure: JSON with status="error" and attempted methods.
    """
    run_ctx: RunContext = ctx.context
    # Reactome ContentService 详情端点:/data/query/{stId}(不是 /data/pathway/)
    api_url = f"{_REACTOME_API_BASE}/data/query/{pathway_id}"

    page_url = f"{_REACTOME_PAGE_BASE}/{pathway_id}"
    try:
        result = await fetch_with_fallback(
            api_url,
            page_url,
            source_name="reactome",
            accept_result=_accept_reactome_pathway_result,
            facade=run_ctx.crawler_facade,
        )
    except CrawlError as exc:
        run_ctx.log_query(pathway_id, "reactome", QueryStatus.FAILED, 0)
        return _fallback_error("reactome", page_url, exc)
    if result.method_used == "api":
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
                "name": _strip_html(name),
                "species": data.get("speciesName", ""),
                "has_diagram": data.get("hasDiagram", False),
                "url": f"{_REACTOME_PAGE_BASE}/{data.get('stId', pathway_id)}",
                "summation": _strip_html(data.get("summation", "")),
                "release_date": data.get("releaseDate", ""),
            }
            run_ctx.log_query(pathway_id, "reactome", QueryStatus.SUCCESS, 1)

            source_record = SourceRecord(
                source_id=make_source_id(Database.REACTOME, pathway_id, api_url),
                database=Database.REACTOME,
                accession=pathway_id,
                url=api_url,
                title=f"Reactome pathway {pathway_id}",
                retrieved_at=datetime.now(UTC),
            )
            run_ctx.add_source(source_record)

            return json.dumps(
                {
                    "source": "reactome",
                    "pathway_id": pathway_id,
                    "record": record,
                    "method_used": "api",
                    "attempts": _attempt_audit(result.attempts),
                },
                ensure_ascii=False,
            )
        except (json.JSONDecodeError, AttributeError, KeyError, TypeError) as exc:
            logger.warning("Failed to parse Reactome pathway response: %s", exc)
    run_ctx.log_query(pathway_id, "reactome", QueryStatus.PAGE_FALLBACK, 0)
    return _page_fallback("reactome", page_url, result)


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
        "(e.g. 'R-HSA-169893'). API failures automatically use direct page "
        "fallback and return a bounded visible-text preview."
    ),
    tools=[search_reactome, get_pathway],
    supported_sources=["reactome"],
    version="0.1.0",
)

skill_registry.register(reactome_skill)
