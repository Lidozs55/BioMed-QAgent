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
from typing import Any
from urllib.parse import quote

from agents import RunContextWrapper, function_tool

from app.agent_loop.context import RunContext
from app.domain.output import SourceRecord
from app.skills.registry import SkillCategory, SkillDef, skill_registry
from app.tools.crawler import api_fetch, httpx_fetch
from app.tools.crawl_signal import requires_crawl_json

logger = logging.getLogger(__name__)

_REACTOME_API_BASE = "https://reactome.org/ContentService"
_REACTOME_PAGE_BASE = "https://reactome.org/content/detail"


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
    api_url = (
        f"{_REACTOME_API_BASE}/search/query?query={encoded_term}"
        f"&species=Homo+sapiens&start=0&rows={max_results}"
    )

    # Tier 1: API
    result = api_fetch(api_url)
    if result.ok:
        try:
            data = json.loads(result.content)
            entries = data.get("entries", [])
            records = [
                {
                    "pathway_id": e.get("stId", ""),
                    "name": e.get("name", ""),
                    "species": e.get("species", ""),
                    "summary": e.get("summary", ""),
                    "url": f"{_REACTOME_PAGE_BASE}/{e.get('stId', '')}",
                }
                for e in entries
            ]
            run_ctx.log_query(term, "reactome", "ok", len(records))
            return json.dumps({
                "source": "reactome",
                "term": term,
                "count": len(records),
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
        reason=f"Reactome API and httpx both failed: api={result.error or result.status_code}, httpx={page_result.error or page_result.status_code}",
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
    api_url = f"{_REACTOME_API_BASE}/data/pathway/{pathway_id}"

    # Tier 1: API
    result = api_fetch(api_url)
    if result.ok:
        try:
            data = json.loads(result.content)
            record = {
                "pathway_id": data.get("stId", pathway_id),
                "name": data.get("name", ""),
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
